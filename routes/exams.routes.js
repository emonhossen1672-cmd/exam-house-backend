const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { normalizeSubject } = require('../utils/subjectMap');

function genSerial(type) {
  const prefix = type === 'live' ? 'EH-LV' : 'EH-MT';
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// ---------- ADMIN ----------

// POST /api/exams — create an exam and attach questions
// body: { title, type: 'live'|'model', ministry_id, post_name, subject, grade, duration_minutes, start_time, question_ids: [1,2,3] }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, question_ids, negative_marks,
          application_deadline, exam_probable_date, circular_url, routine_category } = req.body;
  if (!title || !type || !question_ids || !question_ids.length) {
    return res.status(400).json({ error: 'টাইটেল, টাইপ এবং অন্তত একটি প্রশ্ন দরকার' });
  }
  if (type === 'live' && !start_time) {
    return res.status(400).json({ error: 'লাইভ পরীক্ষার জন্য শুরুর সময় দিন' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const serial = genSerial(type);
    const examResult = await client.query(
      `INSERT INTO exams (title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, serial, status, negative_marks,
         application_deadline, exam_probable_date, circular_url, routine_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [title, type, ministry_id || null, post_name || null, subject || null, grade || null, duration_minutes || 60,
       type === 'live' ? start_time : null, serial, 'scheduled', negative_marks || 0,
       application_deadline || null, exam_probable_date || null, circular_url || null, routine_category || null]
    );
    const exam = examResult.rows[0];

    for (let i = 0; i < question_ids.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, question_ids[i], i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(exam);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// GET /api/exams/admin/list — full list for admin dashboard (with counts)
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.*, m.name AS ministry_name,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM results r WHERE r.exam_id = e.id) AS attempt_count
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    ORDER BY e.created_at DESC
  `);
  res.json(rows);
}));

// PUT /api/exams/:id — update exam fields. Partial updates are safe: any
// field left out of the request body keeps its current value (COALESCE),
// so e.g. sending only { negative_marks } won't wipe ministry_id/post_name/
// subject/grade/start_time like it used to.
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { title, ministry_id, post_name, subject, grade, duration_minutes, start_time, negative_marks,
          application_deadline, exam_probable_date, circular_url, routine_category } = req.body;
  const { rows } = await pool.query(
    `UPDATE exams SET
      title = COALESCE($1, title),
      ministry_id = COALESCE($2, ministry_id),
      post_name = COALESCE($3, post_name),
      subject = COALESCE($4, subject),
      grade = COALESCE($5, grade),
      duration_minutes = COALESCE($6, duration_minutes),
      start_time = COALESCE($7, start_time),
      negative_marks = COALESCE($9, negative_marks),
      application_deadline = COALESCE($10, application_deadline),
      exam_probable_date = COALESCE($11, exam_probable_date),
      circular_url = COALESCE($12, circular_url),
      routine_category = COALESCE($13, routine_category)
     WHERE id=$8 RETURNING *`,
    [title || null, ministry_id || null, post_name || null, subject || null, grade || null,
     duration_minutes || null, start_time || null, req.params.id,
     negative_marks === undefined ? null : negative_marks,
     application_deadline || null, exam_probable_date || null, circular_url || null, routine_category || null]
  );
  if (!rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// PUT /api/exams/:id/status — open/close an exam manually
router.put('/:id/status', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.body; // scheduled | active | closed
  const { rows } = await pool.query('UPDATE exams SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/exams/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM exams WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- PUBLIC (for the exam-taking frontend) ----------

// GET /api/exams/public/list?type=live|model — no correct answers included.
// optionalUser: if a valid student token is sent, each exam also gets a
// reminder_set flag showing whether *this* student has a pending 🔔
// reminder for it (so the button can render already-toggled-on).
router.get('/public/list', optionalUser, asyncHandler(async (req, res) => {
  const { type, routine_category } = req.query;
  const params = [];
  const clauses = [];
  if (type) { params.push(type); clauses.push(`e.type = $${params.length}`); }
  if (routine_category) { params.push(routine_category); clauses.push(`e.routine_category = $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  params.push(req.user ? req.user.id : null);
  const userParamIdx = params.length;
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.type, e.post_name, e.subject, e.grade, e.duration_minutes, e.start_time, e.status, e.serial, e.negative_marks,
      e.is_daily, e.is_practice, e.is_duel, e.is_auto_subject, e.is_repeated_bank, e.ministry_id, e.routine_category,
      m.name AS ministry_name,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
      EXISTS(
        SELECT 1 FROM exam_reminders er WHERE er.exam_id = e.id AND er.user_id = $${userParamIdx}
      ) AS reminder_set
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    ${where} ORDER BY e.start_time NULLS LAST, e.created_at DESC
  `, params);
  res.json(rows);
}));

// POST /api/exams/public/:id/remind — logged-in student opts in to an SMS
// reminder before this live exam starts. Actual sending happens later, in
// services/reminderScheduler.js.
router.post('/public/:id/remind', requireUser, asyncHandler(async (req, res) => {
  const examRes = await pool.query('SELECT id, type, start_time FROM exams WHERE id=$1', [req.params.id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];
  if (exam.type !== 'live' || !exam.start_time) {
    return res.status(400).json({ error: 'শুধু লাইভ পরীক্ষার জন্য রিমাইন্ডার সেট করা যায়' });
  }
  if (new Date(exam.start_time) <= new Date()) {
    return res.status(400).json({ error: 'পরীক্ষাটি ইতিমধ্যে শুরু হয়ে গেছে' });
  }
  await pool.query(
    `INSERT INTO exam_reminders (user_id, exam_id) VALUES ($1,$2)
     ON CONFLICT (user_id, exam_id) DO NOTHING`,
    [req.user.id, req.params.id]
  );
  res.json({ ok: true, reminder_set: true });
}));

// DELETE /api/exams/public/:id/remind — cancel a previously set reminder
router.delete('/public/:id/remind', requireUser, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM exam_reminders WHERE user_id=$1 AND exam_id=$2', [req.user.id, req.params.id]);
  res.json({ ok: true, reminder_set: false });
}));

// GET /api/exams/public/daily-quiz — auto-generated 10-question daily quiz.
// Reuses the normal exam/results flow: creates (or reuses, if already generated
// today) a real 'model' exam row so taking it, submitting, and reviewing it all
// work exactly like any other model test.
router.get('/public/daily-quiz', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT e.*, (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id)::int AS question_count
       FROM exams e WHERE e.is_daily = true AND e.quiz_date = CURRENT_DATE`
    );
    if (existing.rows.length) {
      return res.json(existing.rows[0]);
    }

    await client.query('BEGIN');
    const qRes = await client.query(
      `SELECT id FROM questions ORDER BY RANDOM() LIMIT 10`
    );
    if (!qRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'এখনো কোনো প্রশ্ন যোগ করা হয়নি' });
    }
    const serial = 'EH-DQ-' + Math.floor(1000 + Math.random() * 9000);
    const dateLabel = new Date().toLocaleDateString('bn-BD', { day: 'numeric', month: 'long' });
    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, status, serial, is_daily, quiz_date)
       VALUES ($1,'model',15,'active',$2,true,CURRENT_DATE) RETURNING *`,
      [`আজকের কুইজ — ${dateLabel}`, serial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].id, i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...exam, question_count: qRes.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// GET /api/exams/public/:id/questions — questions WITHOUT correct answers (for taking the exam)
router.get('/public/:id/questions', asyncHandler(async (req, res) => {
  const examRes = await pool.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];

  // Fix: previously only `start_time` was checked for live exams — an admin
  // manually closing an exam (status='closed') had no effect here, so
  // students could still open and take a closed exam. Now status is checked
  // for every exam type.
  if (exam.status === 'closed') {
    return res.status(403).json({ error: 'পরীক্ষাটি বন্ধ করে দেওয়া হয়েছে' });
  }
  if (exam.type === 'live' && exam.start_time && new Date(exam.start_time) > new Date()) {
    return res.status(403).json({ error: 'পরীক্ষা এখনো শুরু হয়নি' });
  }

  const { rows } = await pool.query(`
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, eq.position, eq.tag
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1 ORDER BY eq.position
  `, [req.params.id]);

  res.json({ exam, questions: rows });
}));

// GET /api/exams/public/:id/archive — WITH correct answers, but only once the exam window has closed
router.get('/public/:id/archive', asyncHandler(async (req, res) => {
  const examRes = await pool.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];

  if (exam.type === 'live' && exam.start_time) {
    const end = new Date(exam.start_time).getTime() + (exam.duration_minutes || 60) * 60000;
    if (Date.now() < end) {
      return res.status(403).json({ error: 'পরীক্ষা এখনো চলছে — শেষ হলে সমাধান দেখা যাবে' });
    }
  }
  if (exam.type === 'live' && !exam.start_time) {
    return res.status(403).json({ error: 'পরীক্ষার সময় এখনো নির্ধারিত হয়নি' });
  }

  const { rows } = await pool.query(`
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, eq.position, eq.tag
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1 ORDER BY eq.position
  `, [req.params.id]);

  res.json({ exam, questions: rows });
}));

// GET /api/exams/public/archive/list — closed/expired live exams, most recent first
router.get('/public/archive/list', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.grade, e.duration_minutes, e.start_time, e.serial,
      m.name AS ministry_name,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM results r WHERE r.exam_id = e.id) AS attempt_count
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    WHERE e.type = 'live' AND e.start_time IS NOT NULL
      AND e.start_time + (e.duration_minutes || ' minutes')::interval < NOW()
    ORDER BY e.start_time DESC
  `);
  res.json(rows);
}));

// GET /api/exams/public/circulars — countdown calendar: application deadline
// ও exam-এর সম্ভাব্য তারিখ থাকা exam/post-গুলো, deadline অনুযায়ী সাজানো।
// ?include_expired=1 দিলে মেয়াদ শেষ হওয়া সার্কুলারও (রেফারেন্সের জন্য) দেখাবে।
router.get('/public/circulars', asyncHandler(async (req, res) => {
  const includeExpired = req.query.include_expired === '1';
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.post_name, e.grade, e.serial,
      e.application_deadline, e.exam_probable_date, e.circular_url,
      m.name AS ministry_name,
      (e.application_deadline IS NOT NULL AND e.application_deadline < NOW()) AS deadline_passed,
      CASE WHEN e.application_deadline IS NOT NULL
        THEN CEIL(EXTRACT(EPOCH FROM (e.application_deadline - NOW())) / 86400)::int
        ELSE NULL END AS days_left
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    WHERE (e.application_deadline IS NOT NULL OR e.exam_probable_date IS NOT NULL)
      ${includeExpired ? '' : 'AND (e.application_deadline IS NULL OR e.application_deadline >= NOW())'}
    ORDER BY COALESCE(e.application_deadline, e.exam_probable_date::timestamp) ASC
  `);
  res.json(rows);
}));

// GET /api/exams/public/subjects — distinct subjects in the question bank with
// their question counts, so Reading List / Duel mode / Smart Practice can list
// them to pick from. Raw subject values entered inconsistently over time
// (English vs ইংরেজি, বাংলা vs বাংলা (ধ্বনি ও বর্ণ)) are merged into the 5
// canonical subjects here — counts are summed across every raw variant, and
// anything outside the 5 (ভূমি বিষয়ক, ইসলাম শিক্ষা, ...) is left out entirely.
router.get('/public/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT subject, COUNT(*)::int AS question_count
    FROM questions
    GROUP BY subject
  `);
  const merged = new Map();
  for (const row of rows) {
    const canonical = normalizeSubject(row.subject);
    if (!canonical) continue;
    merged.set(canonical, (merged.get(canonical) || 0) + row.question_count);
  }
  const result = [...merged.entries()]
    .map(([subject, question_count]) => ({ subject, question_count }))
    .sort((a, b) => b.question_count - a.question_count);
  res.json(result);
}));

// GET /api/exams/public/subject-list — every distinct raw subject that has
// at least one exam, for the সাবজেক্ট অনুযায়ী প্রস্তুতি (subject-wise prep)
// landing screen. Unlike /public/subjects (which merges everything down to
// the 5 canonical buckets for Reading List/Duel/Smart Practice), this keeps
// each admin-entered subject exactly as typed — e.g. "Bank Math Master" and
// "গণিত" stay separate rows — since this screen is meant to show the
// admin's own named subject programs, not a generic bucket.
router.get('/public/subject-list', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.subject,
      COUNT(*)::int AS exam_count,
      BOOL_OR(
        e.type = 'live' AND e.start_time IS NOT NULL
        AND e.start_time <= NOW()
        AND e.start_time + (e.duration_minutes || ' minutes')::interval >= NOW()
      ) AS is_live
    FROM exams e
    WHERE e.subject IS NOT NULL AND TRIM(e.subject) <> '' AND e.subject <> 'সব'
    GROUP BY e.subject
    ORDER BY e.subject
  `);
  res.json(rows);
}));


// fresh practice quiz: picks random questions for the chosen subject and wraps
// them in a real (but is_practice=true) 'model' exam row, so the rest of the
// app (taking it, submitting, subject-stats, streak, wrong-questions revision)
// all work automatically through the existing exam machinery — no separate code path.
router.get('/public/practice', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count < 5) count = 15;
  if (count > 30) count = 30;
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const client = await pool.connect();
  try {
    const qRes = await client.query(
      `SELECT id FROM questions WHERE subject=$1 ORDER BY RANDOM() LIMIT $2`,
      [subject, count]
    );
    if (!qRes.rows.length) {
      return res.status(404).json({ error: 'এই বিষয়ে এখনো কোনো প্রশ্ন যোগ করা হয়নি' });
    }

    await client.query('BEGIN');
    const serial = 'EH-PR-' + Math.floor(1000 + Math.random() * 9000);
    const durationMinutes = Math.max(5, qRes.rows.length); // ~1 minute per question
    const examResult = await client.query(
      `INSERT INTO exams (title, type, subject, duration_minutes, status, serial, is_practice)
       VALUES ($1,'model',$2,$3,'active',$4,true) RETURNING *`,
      [`অনুশীলন: ${subject}`, subject, durationMinutes, serial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].id, i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...exam, question_count: qRes.rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// POST /api/exams/public/reading-quiz  body: { question_ids: [...] } — after a student
// reads a 30-question রিডিং লিস্ট page, this builds a 5-minute, 10-question quiz
// drawn only from that page's questions (not the whole subject bank), wrapped in the
// same is_practice 'model' exam machinery as /public/practice so taking/submitting/
// results all work through the existing exam flow with no separate code path.
router.post('/public/reading-quiz', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.question_ids) ? req.body.question_ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: 'প্রশ্ন নির্বাচন করা যায়নি' });

  const client = await pool.connect();
  try {
    const qRes = await client.query(
      `SELECT id, subject FROM questions WHERE id = ANY($1::int[]) ORDER BY RANDOM() LIMIT 10`,
      [ids]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });

    await client.query('BEGIN');
    const subject = qRes.rows[0].subject;
    const serial = 'EH-RQ-' + Math.floor(1000 + Math.random() * 9000);
    const examResult = await client.query(
      `INSERT INTO exams (title, type, subject, duration_minutes, status, serial, is_practice)
       VALUES ($1,'model',$2,5,'active',$3,true) RETURNING *`,
      [`রিডিং কুইজ: ${subject}`, subject, serial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].id, i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...exam, question_count: qRes.rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// GET /api/exams/public/smart-practice?count=15 — auto-generates a MIXED
// practice quiz weighted toward this student's weakest subjects (based on
// their accuracy in /api/results/me/subject-stats), instead of making them
// pick one subject. A subject they've never attempted counts as fully weak
// (gets the most questions) so new subjects get surfaced too. Falls back to
// a plain random mix if the student has no history yet.
router.get('/public/smart-practice', requireUser, asyncHandler(async (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count < 5) count = 15;
  if (count > 30) count = 30;

  const client = await pool.connect();
  try {
    const statsRes = await client.query(`
      SELECT q.subject,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ans.given IS NOT NULL AND UPPER(ans.given) = q.correct_option)::int AS correct
      FROM results r
      JOIN exam_questions eq ON eq.exam_id = r.exam_id
      JOIN questions q ON q.id = eq.question_id
      LEFT JOIN LATERAL (SELECT r.answers->>(eq.question_id::text) AS given) ans ON true
      WHERE r.user_id = $1
      GROUP BY q.subject
    `, [req.user.id]);

    const allSubjectsRes = await client.query(
      `SELECT subject, COUNT(*)::int AS bank_count FROM questions GROUP BY subject`
    );
    if (!allSubjectsRes.rows.length) {
      return res.status(404).json({ error: 'এখনো কোনো প্রশ্ন যোগ করা হয়নি' });
    }

    const accuracyBySubject = new Map(statsRes.rows.map(s => [s.subject, s.total ? s.correct / s.total : 0]));
    const weighted = allSubjectsRes.rows.map(s => {
      const acc = accuracyBySubject.has(s.subject) ? accuracyBySubject.get(s.subject) : 0;
      const weight = Math.max(0.1, 1 - acc);
      return { subject: s.subject, bankCount: s.bank_count, weight };
    });
    const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0);

    let remaining = count;
    const allocation = weighted.map((s, i) => {
      const isLast = i === weighted.length - 1;
      const share = isLast ? remaining : Math.min(remaining, Math.max(1, Math.round((s.weight / totalWeight) * count)));
      remaining -= share;
      return { subject: s.subject, take: Math.min(share, s.bankCount) };
    }).filter(a => a.take > 0);

    let questionIds = [];
    for (const a of allocation) {
      const qRes = await client.query(
        `SELECT id FROM questions WHERE subject=$1 ORDER BY RANDOM() LIMIT $2`,
        [a.subject, a.take]
      );
      questionIds.push(...qRes.rows.map(r => r.id));
    }
    if (questionIds.length < count) {
      const topUp = await client.query(
        `SELECT id FROM questions WHERE id != ALL($1::int[]) ORDER BY RANDOM() LIMIT $2`,
        [questionIds.length ? questionIds : [0], count - questionIds.length]
      );
      questionIds.push(...topUp.rows.map(r => r.id));
    }
    for (let i = questionIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questionIds[i], questionIds[j]] = [questionIds[j], questionIds[i]];
    }

    await client.query('BEGIN');
    const serial = 'EH-SP-' + Math.floor(1000 + Math.random() * 9000);
    const durationMinutes = Math.max(5, questionIds.length);
    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, status, serial, is_practice)
       VALUES ($1,'model',$2,'active',$3,true) RETURNING *`,
      ['স্মার্ট প্র্যাকটিস — আপনার দুর্বল জায়গা অনুযায়ী', durationMinutes, serial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < questionIds.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, questionIds[i], i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...exam, question_count: questionIds.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// POST /api/exams/sync-subject-tests — regenerate all auto বিষয়ভিত্তিক model
// tests from the current question bank, grouped by subject.
router.post('/sync-subject-tests', requireAdmin, asyncHandler(async (req, res) => {
  const BATCH_SIZE = 25;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM exams WHERE is_auto_subject = true');

    const { rows: qs } = await client.query(`
      SELECT q.id, q.subject, q.grade, q.post_name, q.exam_year, m.name AS ministry_name
      FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
      WHERE q.subject IS NOT NULL AND q.subject <> ''
      ORDER BY q.subject, q.id
    `);

    const bySubject = new Map();
    qs.forEach(q => {
      if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
      bySubject.get(q.subject).push(q);
    });

    let examsCreated = 0, questionsPlaced = 0;
    for (const [subject, list] of bySubject.entries()) {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        const partNum = Math.floor(i / BATCH_SIZE) + 1;
        const title = `${subject} — অটো মডেল টেস্ট ${partNum}`;
        const serial = genSerial('model');
        const duration = Math.max(15, Math.round(batch.length * 0.8));
        const examResult = await client.query(
          `INSERT INTO exams (title, type, subject, duration_minutes, serial, status, is_auto_subject)
           VALUES ($1,'model',$2,$3,$4,'scheduled',true) RETURNING id`,
          [title, subject, duration, serial]
        );
        const examId = examResult.rows[0].id;
        examsCreated++;
        for (let pos = 0; pos < batch.length; pos++) {
          const q = batch[pos];
          const tagParts = [q.ministry_name, q.post_name, q.grade ? `গ্রেড ${q.grade}` : null, q.exam_year]
            .filter(Boolean);
          const tag = tagParts.length ? tagParts.join(' · ') : null;
          await client.query(
            'INSERT INTO exam_questions (exam_id, question_id, position, tag) VALUES ($1,$2,$3,$4)',
            [examId, q.id, pos + 1, tag]
          );
          questionsPlaced++;
        }
      }
    }

    await client.query('COMMIT');
    res.json({ subjects: bySubject.size, examsCreated, questionsPlaced });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সিঙ্ক ব্যর্থ: ' + err.message });
  } finally {
    client.release();
  }
}));

// POST /api/exams/sync-repeated-questions
router.post('/sync-repeated-questions', requireAdmin, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM exams WHERE is_repeated_bank = true');

    const { rows: qs } = await client.query(`
      SELECT q.id, q.question_text, q.subject, m.name AS ministry_name
      FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
      ORDER BY q.id DESC
    `);

    const groups = new Map();
    qs.forEach(q => {
      const key = q.question_text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    });

    const repeated = [...groups.values()].filter(g => g.length > 1);
    if (!repeated.length) {
      await client.query('COMMIT');
      return res.json({ found: 0, message: 'এখনো কোনো পুনরাবৃত্ত প্রশ্ন পাওয়া যায়নি' });
    }

    const serial = genSerial('model');
    const duration = Math.max(15, Math.round(repeated.length * 0.8));
    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, serial, status, is_repeated_bank)
       VALUES ('সর্বাধিক পুনরাবৃত্ত প্রশ্ন','model',$1,$2,'scheduled',true) RETURNING id`,
      [duration, serial]
    );
    const examId = examResult.rows[0].id;

    for (let pos = 0; pos < repeated.length; pos++) {
      const group = repeated[pos];
      const rep = group[0];
      const ministries = [...new Set(group.map(g => g.ministry_name).filter(Boolean))];
      const tag = `🔁 ${group.length} বার এসেছে` + (ministries.length ? ' — ' + ministries.join(', ') : '');
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position, tag) VALUES ($1,$2,$3,$4)',
        [examId, rep.id, pos + 1, tag]
      );
    }

    await client.query('COMMIT');
    res.json({ found: repeated.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সিঙ্ক ব্যর্থ: ' + err.message });
  } finally {
    client.release();
  }
}));

module.exports = router;
