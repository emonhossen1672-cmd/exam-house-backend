const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

function genSerial(type) {
  const prefix = type === 'live' ? 'EH-LV' : 'EH-MT';
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// ---------- ADMIN ----------

// POST /api/exams — create an exam and attach questions
// body: { title, type: 'live'|'model', ministry_id, post_name, subject, grade, duration_minutes, start_time, question_ids: [1,2,3] }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, question_ids, negative_marks } = req.body;
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
      `INSERT INTO exams (title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, serial, status, negative_marks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [title, type, ministry_id || null, post_name || null, subject || null, grade || null, duration_minutes || 60,
       type === 'live' ? start_time : null, serial, 'scheduled', negative_marks || 0]
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
  const { title, ministry_id, post_name, subject, grade, duration_minutes, start_time, negative_marks } = req.body;
  const { rows } = await pool.query(
    `UPDATE exams SET
      title = COALESCE($1, title),
      ministry_id = COALESCE($2, ministry_id),
      post_name = COALESCE($3, post_name),
      subject = COALESCE($4, subject),
      grade = COALESCE($5, grade),
      duration_minutes = COALESCE($6, duration_minutes),
      start_time = COALESCE($7, start_time),
      negative_marks = COALESCE($9, negative_marks)
     WHERE id=$8 RETURNING *`,
    [title || null, ministry_id || null, post_name || null, subject || null, grade || null,
     duration_minutes || null, start_time || null, req.params.id,
     negative_marks === undefined ? null : negative_marks]
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

// GET /api/exams/public/list?type=live|model — no correct answers included
router.get('/public/list', asyncHandler(async (req, res) => {
  const { type } = req.query;
  const params = [];
  let where = '';
  if (type) { params.push(type); where = 'WHERE e.type = $1'; }
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.type, e.post_name, e.subject, e.grade, e.duration_minutes, e.start_time, e.status, e.serial, e.negative_marks,
      e.is_daily, e.is_practice,
      m.name AS ministry_name,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    ${where} ORDER BY e.start_time NULLS LAST, e.created_at DESC
  `, params);
  res.json(rows);
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
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, eq.position
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
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, eq.position
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

// GET /api/exams/public/subjects — distinct subjects in the question bank with
// their question counts, so the practice-mode screen can list them to pick from.
router.get('/public/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT subject, COUNT(*)::int AS question_count
    FROM questions
    GROUP BY subject
    ORDER BY question_count DESC
  `);
  res.json(rows);
}));

// GET /api/exams/public/practice?subject=X&count=15 — instantly generates a
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

module.exports = router;
