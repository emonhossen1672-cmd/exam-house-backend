const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { TOPIC_JOB_SUBJECTS } = require('../utils/topicJobSubjects');
const { checkExamAccess } = require('../utils/packageAccess');

function genSerial(type) {
  const prefix = type === 'live' ? 'EH-LV' : 'EH-MT';
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Fix: a live exam was flipping to "আর্কাইভ" (and showing up in the central
// archive) the instant its own duration_minutes elapsed — a 20-minute exam
// vanished from "লাইভ" just 20 minutes after it started, which is too fast
// for students to even notice it happened. duration_minutes is meant to be
// how long ONE student's attempt/timer runs once they open the exam — not
// how long the exam stays visible/"live" in the app for everyone. So the
// live/archive WINDOW now uses whichever is longer: the exam's own duration,
// or this fixed minimum. The per-attempt countdown a student sees after
// clicking in (public-site/index.html's CURRENT_EXAM timer) still uses the
// real duration_minutes untouched.
const LIVE_WINDOW_MIN_MINUTES = 12 * 60; // 12 hours

// SQL snippet: the effective number of minutes an exam counts as "live" for,
// given its own duration_minutes column (aliased/qualified by the caller).
function liveWindowMinutesSql(col) {
  return `GREATEST(${col}, ${LIVE_WINDOW_MIN_MINUTES})`;
}

// ---------- ADMIN ----------

// POST /api/exams — create an exam and attach questions
// body: { title, type: 'live'|'model'|'written', ministry_id, post_name, subject, grade, duration_minutes, start_time,
//         question_ids: [1,2,3] (live/model),  OR  written_question_ids + grading_mode (written) }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, question_ids, negative_marks,
          application_deadline, exam_probable_date, circular_url, routine_category, written_question_ids, grading_mode } = req.body;

  const isWritten = type === 'written';
  const idsForType = isWritten ? written_question_ids : question_ids;
  if (!title || !type || !idsForType || !idsForType.length) {
    return res.status(400).json({ error: 'টাইটেল, টাইপ এবং অন্তত একটি প্রশ্ন দরকার' });
  }
  if (type === 'live' && !start_time) {
    return res.status(400).json({ error: 'লাইভ পরীক্ষার জন্য শুরুর সময় দিন' });
  }
  if (isWritten && !['self_check', 'manual', 'ai'].includes(grading_mode)) {
    return res.status(400).json({ error: 'রিটেন পরীক্ষার জন্য মূল্যায়ন পদ্ধতি (grading_mode) বাছাই করুন' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const serial = genSerial(type === 'written' ? 'model' : type); // written shares 'model'-style serial prefix
    const examResult = await client.query(
      `INSERT INTO exams (title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time, serial, status, negative_marks,
         application_deadline, exam_probable_date, circular_url, routine_category, grading_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [title, type, ministry_id || null, post_name || null, subject || null, grade || null, duration_minutes || 60,
       type === 'live' ? start_time : null, serial, 'scheduled', negative_marks || 0,
       application_deadline || null, exam_probable_date || null, circular_url || null, routine_category || null,
       isWritten ? grading_mode : null]
    );
    const exam = examResult.rows[0];

    for (let i = 0; i < idsForType.length; i++) {
      if (isWritten) {
        await client.query(
          'INSERT INTO exam_written_questions (exam_id, written_question_id, position) VALUES ($1,$2,$3)',
          [exam.id, idsForType[i], i + 1]
        );
      } else {
        await client.query(
          'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
          [exam.id, idsForType[i], i + 1]
        );
      }
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
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id)
        + (SELECT COUNT(*) FROM exam_written_questions ewq WHERE ewq.exam_id = e.id) AS question_count,
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
  // Custom model tests are personal (see POST /public/custom) — they never
  // belong in the shared list every student sees; a student finds their own
  // via GET /public/custom/mine instead.
  clauses.push('e.is_custom = false');
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  params.push(req.user ? req.user.id : null);
  const userParamIdx = params.length;
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.type, e.post_name, e.subject, e.grade, e.duration_minutes, e.start_time, e.status, e.serial, e.negative_marks,
      e.is_daily, e.is_practice, e.is_duel, e.is_auto_subject, e.is_repeated_bank, e.ministry_id, e.routine_category,
      e.topics_summary, e.routine_note,
      m.name AS ministry_name,
      CASE WHEN e.type = 'written'
        THEN (SELECT COUNT(*) FROM exam_written_questions ewq WHERE ewq.exam_id = e.id)
        ELSE (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id)
      END AS question_count,
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

// ---------- CUSTOM MODEL TEST (ইউজার নিজে বানানো মডেল টেস্ট) ----------
// Product decision (2026-09): competitor apps (e.g. Ultimate Job Solutions)
// let a student pick question count + negative-marking scheme + subject(s)
// and get an instant model test, instead of only taking admin-curated ones.
// This mirrors the daily-quiz pattern above — it inserts a REAL 'model' exam
// row + exam_questions, so taking/submitting/reviewing it all reuse the
// normal exam flow (results.routes.js, /public/:id/questions, /public/:id/
// archive) with zero extra code there. is_custom=true keeps it OUT of the
// package/monetization gate (see utils/packageAccess.js) and out of the
// general /public/list (it's personal, not something to show every student).
const CUSTOM_TEST_MIN_QUESTIONS = 5;
const CUSTOM_TEST_MAX_QUESTIONS = 100;
const CUSTOM_TEST_ALLOWED_NEGATIVE_MARKS = [0, 0.25, 0.5];

// POST /api/exams/public/custom — body: { question_count, negative_marks, subjects?: string[] }
// subjects is optional; when omitted/empty, questions are drawn from the
// whole bank. When given, must match utils/topicJobSubjects.js's fixed list
// (the same 12 subjects already used by /public/subjects, Reading List, and
// Duel mode) so one "সাবজেক্ট" tag works everywhere.
router.post('/public/custom', requireUser, asyncHandler(async (req, res) => {
  const { question_count, negative_marks, subjects } = req.body;

  const count = parseInt(question_count, 10);
  if (!Number.isInteger(count) || count < CUSTOM_TEST_MIN_QUESTIONS || count > CUSTOM_TEST_MAX_QUESTIONS) {
    return res.status(400).json({
      error: `প্রশ্ন সংখ্যা ${CUSTOM_TEST_MIN_QUESTIONS} থেকে ${CUSTOM_TEST_MAX_QUESTIONS}-এর মধ্যে হতে হবে`
    });
  }
  const negMarks = negative_marks === undefined || negative_marks === null ? 0 : Number(negative_marks);
  if (!CUSTOM_TEST_ALLOWED_NEGATIVE_MARKS.includes(negMarks)) {
    return res.status(400).json({
      error: `নেগেটিভ মার্কিং ${CUSTOM_TEST_ALLOWED_NEGATIVE_MARKS.join('/')} — এর একটি হতে হবে`
    });
  }
  let subjectList = null;
  if (Array.isArray(subjects) && subjects.length) {
    subjectList = subjects.filter(s => TOPIC_JOB_SUBJECTS.includes(s));
    if (!subjectList.length) {
      return res.status(400).json({ error: 'বৈধ সাবজেক্ট বেছে নিন' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const qParams = [];
    let qWhere = '';
    if (subjectList) {
      qParams.push(subjectList);
      qWhere = `WHERE subject = ANY($${qParams.length})`;
    }
    qParams.push(count);
    const qRes = await client.query(
      `SELECT id FROM questions ${qWhere} ORDER BY RANDOM() LIMIT $${qParams.length}`,
      qParams
    );
    if (!qRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'এই ফিল্টারে এখনো কোনো প্রশ্ন যোগ করা হয়নি' });
    }

    const serial = genSerial('model');
    const subjectLabel = subjectList ? subjectList.join(', ') : 'সকল বিষয়';
    const title = `কাস্টম মডেল টেস্ট — ${subjectLabel} (${qRes.rows.length} প্রশ্ন)`;
    // ~50 seconds/question, minimum 10 minutes — a rough default; the
    // per-attempt countdown a student sees just uses this like any other exam.
    const durationMinutes = Math.max(10, Math.round(qRes.rows.length * 50 / 60));

    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, serial, status, negative_marks, is_custom, created_by_user_id, subject)
       VALUES ($1,'model',$2,$3,'active',$4,true,$5,$6) RETURNING *`,
      [title, durationMinutes, serial, negMarks, req.user.id, subjectList ? subjectLabel : null]
    );
    const exam = examResult.rows[0];

    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].id, i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({
      ...exam,
      question_count: qRes.rows.length,
      requested_question_count: count // lets the frontend note "চাওয়া হয়েছিল ৩০টি, পাওয়া গেছে ১৮টি" if the bank came up short
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// GET /api/exams/public/custom/mine — a student's own past custom tests, most
// recent first, so they can revisit/retake one instead of only ever creating
// new ones from scratch.
router.get('/public/custom/mine', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.subject, e.negative_marks, e.duration_minutes, e.serial, e.created_at,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
      EXISTS(SELECT 1 FROM results r WHERE r.exam_id = e.id AND r.user_id = $1) AS attempted
    FROM exams e
    WHERE e.is_custom = true AND e.created_by_user_id = $1
    ORDER BY e.created_at DESC
    LIMIT 50
  `, [req.user.id]);
  res.json(rows);
}));

// ---------- অধ্যায়ভিত্তিক (টপিক-ভিত্তিক) মডেল টেস্ট ----------
// "পড়ালেখা" সেকশনের বিষয়ভিত্তিক প্রস্তুতি → অধ্যায়ভিত্তিক প্রস্তুতি ড্রিলডাউনের
// শেষ ধাপ: একটা নির্দিষ্ট সাবজেক্ট+টপিকের (অধ্যায়) জন্য কমপক্ষে
// MODEL_TESTS_MIN_PER_TOPIC-টা রেডিমেড মডেল টেস্ট (utils/topicModelTestGen.js
// এর চাঙ্কিং হিসাব অনুযায়ী)। GET হলে lazily তৈরি হয় (প্রথমবার কেউ ট্যাবটা
// খুললে) — কোনো cron দরকার নেই, ঠিক daily-quiz প্যাটার্নের মতোই।
const { buildTopicTestChunks } = require('../utils/topicModelTestGen');

// একটা subject+topic-এর জন্য is_auto_topic মডেল টেস্ট তৈরি করে (যদি প্রশ্ন
// থাকে)। কলার নিশ্চিত করবে আগের auto টেস্ট থাকলে সেগুলো আগে থেকেই মুছে
// দিয়েছে বা এখনো নেই — এই ফাংশন শুধু নতুন করে বানায়, ডুপ্লিকেট চেক করে না।
async function generateTopicModelTests(client, subject, topic) {
  const qRes = await client.query(
    `SELECT id FROM questions WHERE subject = $1 AND TRIM(topic) = TRIM($2)`,
    [subject, topic]
  );
  const questionIds = qRes.rows.map(r => r.id);
  const chunks = buildTopicTestChunks(questionIds);
  if (!chunks.length) return 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const serial = genSerial('model');
    const title = `${topic} — অধ্যায় মডেল টেস্ট ${i + 1}`;
    const durationMinutes = Math.max(10, Math.round(chunk.length * 50 / 60));
    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, serial, status, negative_marks, subject, topic, is_auto_topic)
       VALUES ($1,'model',$2,$3,'active',0,$4,$5,true) RETURNING id`,
      [title, durationMinutes, serial, subject, topic]
    );
    const examId = examResult.rows[0].id;
    for (let pos = 0; pos < chunk.length; pos++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [examId, chunk[pos], pos + 1]
      );
    }
  }
  return chunks.length;
}

// GET /api/exams/public/topic-model-tests?subject=X&topic=Y — this topic's
// model-test cards (auto-generated + any admin-created ones sharing the
// same subject+topic tag). Auto-generates on first request if none exist
// yet; if questions were added later and an admin wants a fresh batch, use
// the regenerate endpoint below instead (this endpoint never deletes/rebuilds
// existing tests on its own, so admin hand-edits to individual tests stick).
router.get('/public/topic-model-tests', optionalUser, asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const topic = (req.query.topic || '').trim();
  if (!subject || !topic) {
    return res.status(400).json({ error: 'বিষয় ও অধ্যায় নির্বাচন করুন' });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT id FROM exams WHERE is_auto_topic = true AND subject = $1 AND topic = $2 LIMIT 1`,
      [subject, topic]
    );
    if (!existing.rows.length) {
      await client.query('BEGIN');
      await generateTopicModelTests(client, subject, topic);
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  const userId = req.user ? req.user.id : null;
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.subject, e.topic, e.negative_marks, e.duration_minutes, e.serial,
            e.is_auto_topic, e.created_at,
            (SELECT COUNT(*)::int FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
            EXISTS(SELECT 1 FROM results r WHERE r.exam_id = e.id AND r.user_id = $3) AS attempted
     FROM exams e
     WHERE e.type = 'model' AND e.subject = $1 AND e.topic = $2
       AND (e.is_auto_topic = true OR e.is_custom = false)
     ORDER BY e.is_auto_topic DESC, e.id ASC`,
    [subject, topic, userId]
  );
  res.json({ subject, topic, model_test_count: rows.length, model_tests: rows });
}));

// POST /api/exams/admin/topic-model-tests/regenerate — body: { subject?, topic? }
// Force-rebuilds is_auto_topic tests from the CURRENT question bank:
//   { subject, topic } -> just that one chapter
//   { subject }        -> every topic under that subject
//   {}                 -> every subject+topic combo in the whole question bank
// Deletes the old auto batch for the targeted scope first (exam_questions
// cascades), then regenerates — safe to call anytime, e.g. right after a
// bulk question upload. Admin edits made directly on individual generated
// exams (via the normal PUT /api/exams/:id) are lost for whichever scope
// gets regenerated, same tradeoff as /sync-subject-tests above.
router.post('/admin/topic-model-tests/regenerate', requireAdmin, asyncHandler(async (req, res) => {
  const subject = (req.body.subject || '').trim() || null;
  const topic = (req.body.topic || '').trim() || null;
  if (topic && !subject) {
    return res.status(400).json({ error: 'শুধু টপিক দিয়ে regenerate করা যাবে না, সাবজেক্টও দিন' });
  }

  let pairs;
  if (subject && topic) {
    pairs = [{ subject, topic }];
  } else if (subject) {
    const { rows } = await pool.query(
      `SELECT DISTINCT TRIM(topic) AS topic FROM questions
       WHERE subject = $1 AND TRIM(COALESCE(topic, '')) <> ''`,
      [subject]
    );
    pairs = rows.map(r => ({ subject, topic: r.topic }));
  } else {
    const { rows } = await pool.query(
      `SELECT DISTINCT subject, TRIM(topic) AS topic FROM questions
       WHERE TRIM(COALESCE(topic, '')) <> ''`
    );
    pairs = rows.map(r => ({ subject: r.subject, topic: r.topic }));
  }

  const client = await pool.connect();
  const results = [];
  try {
    for (const pair of pairs) {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM exams WHERE is_auto_topic = true AND subject = $1 AND topic = $2`,
        [pair.subject, pair.topic]
      );
      const testsCreated = await generateTopicModelTests(client, pair.subject, pair.topic);
      await client.query('COMMIT');
      results.push({ subject: pair.subject, topic: pair.topic, tests_created: testsCreated });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  res.json({ topics_processed: results.length, results });
}));

// GET /api/exams/public/:id/questions — questions WITHOUT correct answers (for taking the exam)
router.get('/public/:id/questions', optionalUser, asyncHandler(async (req, res) => {
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

  // Monetization gate: live exams and real (non-practice/duel/auto) model
  // exams require an active package with remaining quota. See
  // utils/packageAccess.js for exactly what counts as "premium".
  const access = await checkExamAccess(req.user ? req.user.id : null, exam);
  if (!access.allowed) {
    return res.status(402).json({ error: access.reason, code: 'PACKAGE_REQUIRED' });
  }

  const { rows } = await pool.query(`
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, eq.position, eq.tag
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1 ORDER BY eq.position
  `, [req.params.id]);

  res.json({ exam, questions: rows });
}));

// GET /api/exams/public/:id/written-questions — question_text + marks only,
// model_answer withheld while the exam is being taken (mirrors
// /public/:id/questions above, for type='written' exams).
router.get('/public/:id/written-questions', optionalUser, asyncHandler(async (req, res) => {
  const examRes = await pool.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];
  if (exam.type !== 'written') return res.status(400).json({ error: 'এটি রিটেন পরীক্ষা নয়' });

  if (exam.status === 'closed') {
    return res.status(403).json({ error: 'পরীক্ষাটি বন্ধ করে দেওয়া হয়েছে' });
  }
  if (exam.start_time && new Date(exam.start_time) > new Date()) {
    return res.status(403).json({ error: 'পরীক্ষা এখনো শুরু হয়নি' });
  }

  // Monetization gate: written exams are free now (isPremiumExam returns
  // false for type='written') — see utils/packageAccess.js.
  const access = await checkExamAccess(req.user ? req.user.id : null, exam);
  if (!access.allowed) {
    return res.status(402).json({ error: access.reason, code: 'PACKAGE_REQUIRED' });
  }

  const { rows } = await pool.query(`
    SELECT wq.id, wq.subject, wq.question_text, wq.marks, ewq.position
    FROM exam_written_questions ewq JOIN written_questions wq ON wq.id = ewq.written_question_id
    WHERE ewq.exam_id = $1 ORDER BY ewq.position
  `, [req.params.id]);

  res.json({ exam, questions: rows });
}));

// GET /api/exams/public/:id/archive — WITH correct answers, but only once the exam window has closed
router.get('/public/:id/archive', asyncHandler(async (req, res) => {
  const examRes = await pool.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];

  // Note: this uses the exam's REAL duration_minutes, not the extended
  // LIVE_WINDOW_MIN_MINUTES below — a student's own answer key should unlock
  // the moment their actual attempt window ends, not 12 hours later. The
  // 12-hour minimum only controls how long the exam stays tagged "লাইভ"
  // and out of the central archive list, not when solutions become visible.
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

// GET /api/exams/public/archive/list — closed/expired live exams, most recent
// first. Purely time-computed (start_time + live-window < now) — nothing to
// "move" into the archive, an exam just starts appearing here once its live
// window ends (see LIVE_WINDOW_MIN_MINUTES above — at least 12 hours after
// start_time, even for a short exam, so it doesn't vanish from "লাইভ
// পরীক্ষা" into here within minutes of starting). Capped at 300 so this
// stays fast as exams pile up over time; the client can add ?limit=/&offset=
// pagination later if needed.
router.get('/public/archive/list', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.title, e.grade, e.duration_minutes, e.start_time, e.serial, 'live' AS type,
      m.name AS ministry_name,
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM results r WHERE r.exam_id = e.id) AS attempt_count
    FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
    WHERE e.type = 'live' AND e.start_time IS NOT NULL
      AND e.start_time + (${liveWindowMinutesSql('e.duration_minutes')} || ' minutes')::interval < NOW()
    ORDER BY e.start_time DESC
    LIMIT 300
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

// GET /api/exams/public/subjects — the 12 fixed টপিকভিত্তিক জব সলুশন subjects
// with their question counts, used by Reading List / Duel mode / Smart
// Practice to list subjects to pick from. Reading List and টপিকভিত্তিক জব
// সলুশন now share the exact same 12-subject list (utils/topicJobSubjects.js)
// so a question only needs one subject tag to be findable from both places —
// see routes/questions.routes.js for how topic-tagging decides which of the
// two views a question actually shows up in. Always returns all 12 (even
// with 0 questions yet) so the buttons never disappear, matching
// /api/questions/public/topic-job-subjects's behavior.
router.get('/public/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count
     FROM questions WHERE subject = ANY($1) GROUP BY subject`,
    [TOPIC_JOB_SUBJECTS]
  );
  const bySubject = new Map(rows.map(r => [r.subject, r.question_count]));
  const result = TOPIC_JOB_SUBJECTS.map(subject => ({
    subject,
    question_count: bySubject.get(subject) || 0
  }));
  res.json(result);
}));

// The fixed 12 subject buttons shown on the সাবজেক্ট অনুযায়ী প্রস্তুতি landing
// screen, in this exact order — same idea as routines.routes.js's CATEGORIES:
// one source of truth, always shown even before any exam exists for a
// subject yet. An admin exam's `subject` column has to match one of these
// strings exactly (see the datalist in the admin panel) for it to count
// toward that button's exam_count / is_live badge.
const FIXED_SUBJECTS = [
  'বাংলা ব্যাকরণ',
  'বাংলা সাহিত্য',
  'ইংরেজি ব্যাকরণ',
  'ইংরেজি সাহিত্য',
  'ভোকাবুলারি',
  'গণিত',
  'বাংলাদেশ',
  'আন্তর্জাতিক',
  'বিজ্ঞান',
  'তথ্য ও যোগাযোগ প্রযুক্তি',
  'ভূগোল, পরিবেশ ও ব্যবস্থাপনা',
  'নৈতিকতা, মূল্যবোধ ও সুশাসন',
];

// GET /api/exams/public/subject-list — the 12 fixed subject buttons for the
// সাবজেক্ট অনুযায়ী প্রস্তুতি (subject-wise prep) landing screen, always
// returned in the same order — with 0/false counts for any subject that has
// no matching exam yet, so the buttons never disappear.
router.get('/public/subject-list', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.subject,
      COUNT(*)::int AS exam_count,
      BOOL_OR(
        e.type = 'live' AND e.start_time IS NOT NULL
        AND e.start_time <= NOW()
        AND e.start_time + (${liveWindowMinutesSql('e.duration_minutes')} || ' minutes')::interval >= NOW()
      ) AS is_live
    FROM exams e
    WHERE e.subject = ANY($1)
    GROUP BY e.subject`, [FIXED_SUBJECTS]);
  const bySubject = new Map(rows.map(r => [r.subject, r]));
  const result = FIXED_SUBJECTS.map(s => bySubject.get(s) || { subject: s, exam_count: 0, is_live: false });
  return res.json(result);
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

// POST /api/exams/public/:id/retake — an archived (window-closed) live exam's
// "পরীক্ষা দিন" button hits this instead of starting the original exam again.
// The original is type='live', which POST /api/results permanently blocks a
// second submission on (by design — one official attempt while it's actually
// live). This clones the exam's own questions, in the same order, into a
// fresh type='model' + is_practice=true exam — same question set, same
// duration/negative marks, but unlimited repeatable attempts, each one
// separately scored and saved to history (exactly like any other model
// test). The original archived exam and its one-time result are untouched.
router.post('/public/:id/retake', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const origRes = await client.query(`SELECT * FROM exams WHERE id = $1`, [req.params.id]);
    if (!origRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
    const orig = origRes.rows[0];

    const qRes = await client.query(
      `SELECT question_id FROM exam_questions WHERE exam_id = $1 ORDER BY position`,
      [orig.id]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'এই পরীক্ষায় কোনো প্রশ্ন নেই' });

    await client.query('BEGIN');
    const serial = genSerial('model');
    const examResult = await client.query(
      `INSERT INTO exams (title, type, subject, duration_minutes, negative_marks, status, serial, is_practice)
       VALUES ($1,'model',$2,$3,$4,'active',$5,true) RETURNING *`,
      [`পুনরায় দিন: ${orig.title}`, orig.subject, orig.duration_minutes, orig.negative_marks || 0, serial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].question_id, i + 1]
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

// শেয়ার্ড হেলপার: subject → topic লেভেলে এই ইউজারের weak/unexplored টপিক বের করে।
// GET /public/weak-topics আর GET /public/study-coach দুটোই একই কম্পিউটেশন
// লাগে (দ্বিতীয়টা শুধু প্রথমটার সংখ্যাগুলোকে AI দিয়ে এক প্যারাগ্রাফ
// উপদেশে বদলায়), তাই কোয়েরি ডুপ্লিকেট না করে একবারই লেখা হলো।
const MIN_TOPIC_ATTEMPTS = 3; // এর কম অ্যাটেম্পটে accuracy অনির্ভরযোগ্য, তাই "explore" এ রাখি

async function computeWeakTopics(userId) {
  const statsRes = await pool.query(`
    SELECT q.subject, q.topic,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE qa.is_correct)::int AS correct,
      MAX(qa.attempted_at) AS last_attempt
    FROM question_attempts qa
    JOIN questions q ON q.id = qa.question_id
    WHERE qa.user_id = $1 AND q.topic IS NOT NULL AND q.topic <> ''
    GROUP BY q.subject, q.topic
  `, [userId]);

  const bankRes = await pool.query(`
    SELECT subject, topic, COUNT(*)::int AS bank_count
    FROM questions
    WHERE topic IS NOT NULL AND topic <> ''
    GROUP BY subject, topic
  `);

  const statsByKey = new Map(statsRes.rows.map(r => [`${r.subject}::${r.topic}`, r]));

  const weak = [];
  const unexplored = [];
  for (const b of bankRes.rows) {
    const key = `${b.subject}::${b.topic}`;
    const s = statsByKey.get(key);
    if (!s || s.total < MIN_TOPIC_ATTEMPTS) {
      unexplored.push({ subject: b.subject, topic: b.topic, bank_count: b.bank_count, attempts: s ? s.total : 0 });
    } else {
      weak.push({
        subject: b.subject, topic: b.topic, bank_count: b.bank_count,
        attempts: s.total, accuracy: Math.round((s.correct / s.total) * 100),
        last_attempt: s.last_attempt,
      });
    }
  }
  weak.sort((a, b) => a.accuracy - b.accuracy);

  return { weak, unexplored };
}

// GET /api/exams/public/weak-topics — টপিক/সাবটপিক-লেভেলে ইউজারের দুর্বলতা।
// smart-practice শুধু subject-লেভেলে accuracy দেখে; এখানে question_attempts
// আর questions.topic/subtopic জয়েন করে আরও সূক্ষ্ম (subject → topic) লেভেলে
// accuracy বের করা হয়, যাতে ইউজার ঠিক কোন টপিকে দুর্বল সেটা দেখতে পায়।
// শুধু topic সেট করা প্রশ্নগুলোই ধরা হয় (পুরনো topic-বিহীন প্রশ্ন বাদ)।
router.get('/public/weak-topics', requireUser, asyncHandler(async (req, res) => {
  const { weak, unexplored } = await computeWeakTopics(req.user.id);
  res.json({
    weak_topics: weak.slice(0, 10),
    unexplored_topics: unexplored.slice(0, 10),
  });
}));

// GET /api/exams/public/study-coach — weak-topics-এর কাঁচা সংখ্যাগুলোকে
// (accuracy %, attempts) একটা ছোট বাংলা উপদেশ-প্যারাগ্রাফে বদলায় Gemini
// দিয়ে ("বাংলা ব্যাকরণে তোমার accuracy কম, আজ ওখান থেকে শুরু করো..."),
// যাতে ছাত্রকে নিজে সংখ্যা দেখে বুঝে নিতে না হয়।
//
// দিনে একবারই generate হয় (ai_study_coach_cache, UNIQUE user_id+coach_date) —
// একই দিনের পরের রিকোয়েস্টগুলো cache থেকেই সার্ভ হয়, খরচ কমাতে আর উপদেশটা
// সারাদিন স্থির রাখতে (বার বার রিফ্রেশ করলে বদলে যাবে না)।
// AI ব্যর্থ হলে (কী নেই / Gemini ডাউন) fail-soft: সংখ্যা থেকে বানানো একটা
// সাদামাটা (নন-AI) বাক্য ফেরত যায়, is_ai_generated:false সহ — কখনো 500 না।
router.get('/public/study-coach', requireUser, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cachedRes = await pool.query(
    `SELECT advice_text FROM ai_study_coach_cache WHERE user_id = $1 AND coach_date = CURRENT_DATE`,
    [userId]
  );
  if (cachedRes.rows.length) {
    return res.json({ advice_text: cachedRes.rows[0].advice_text, is_ai_generated: true, cached: true });
  }

  const { weak, unexplored } = await computeWeakTopics(userId);
  const weakTop = weak.slice(0, 5);
  const unexploredTop = unexplored.slice(0, 5);

  if (!weakTop.length && !unexploredTop.length) {
    return res.json({
      advice_text: 'এখনো পর্যাপ্ত প্রশ্ন সমাধান করা হয়নি — কয়েকটা প্র্যাকটিস কুইজ দাও, তারপর তোমার জন্য ব্যক্তিগত পরামর্শ তৈরি হবে।',
      is_ai_generated: false,
      cached: false,
    });
  }

  let adviceText;
  let isAiGenerated = true;
  try {
    const { generateStudyAdvice } = require('../services/aiStudyCoach');
    adviceText = await generateStudyAdvice({ weakTopics: weakTop, unexploredTopics: unexploredTop });
  } catch (err) {
    isAiGenerated = false;
    if (weakTop.length) {
      const w = weakTop[0];
      adviceText = `তোমার সবচেয়ে দুর্বল জায়গা হলো ${w.subject} বিষয়ের "${w.topic}" টপিক — accuracy মাত্র ${w.accuracy}% (${w.attempts}টা চেষ্টায়)। আজ এখান থেকে কিছু প্রশ্ন প্র্যাকটিস করে শুরু করো।`;
    } else {
      const u = unexploredTop[0];
      adviceText = `"${u.subject}" বিষয়ের "${u.topic}" টপিকে তুমি এখনো তেমন চেষ্টা করোনি — আজ এখান থেকে কিছু প্রশ্ন সমাধান করে দেখো কেমন লাগে।`;
    }
  }

  await pool.query(
    `INSERT INTO ai_study_coach_cache (user_id, coach_date, advice_text)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_id, coach_date) DO UPDATE SET advice_text = EXCLUDED.advice_text`,
    [userId, adviceText]
  );

  res.json({ advice_text: adviceText, is_ai_generated: isAiGenerated, cached: false });
}));

// GET /api/exams/public/weak-topic-practice — weak-topics এর accuracy দিয়ে
// ওয়েটেড র‍্যান্ডম প্র্যাকটিস এক্সাম বানায় (দুর্বল টপিক থেকে বেশি প্রশ্ন)।
// একদম নতুন/কম-অ্যাটেম্পটেড টপিককেও মাঝারি ওয়েট দেওয়া হয় (explore), যাতে
// শুধু পুরনো ভুলেই আটকে না থেকে নতুন টপিকও কভার হয়।
router.get('/public/weak-topic-practice', requireUser, asyncHandler(async (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count < 5) count = 15;
  if (count > 30) count = 30;

  const client = await pool.connect();
  try {
    const statsRes = await client.query(`
      SELECT q.subject, q.topic,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE qa.is_correct)::int AS correct
      FROM question_attempts qa
      JOIN questions q ON q.id = qa.question_id
      WHERE qa.user_id = $1 AND q.topic IS NOT NULL AND q.topic <> ''
      GROUP BY q.subject, q.topic
    `, [req.user.id]);

    const bankRes = await client.query(`
      SELECT subject, topic, COUNT(*)::int AS bank_count
      FROM questions
      WHERE topic IS NOT NULL AND topic <> ''
      GROUP BY subject, topic
    `);
    if (!bankRes.rows.length) {
      return res.status(404).json({ error: 'এখনো কোনো টপিক-ট্যাগড প্রশ্ন যোগ করা হয়নি' });
    }

    const statsByKey = new Map(statsRes.rows.map(r => [`${r.subject}::${r.topic}`, r]));
    const EXPLORE_WEIGHT = 0.6; // অ্যাটেম্পট না থাকা টপিকের জন্য ডিফল্ট ওয়েট
    const weighted = bankRes.rows.map(b => {
      const s = statsByKey.get(`${b.subject}::${b.topic}`);
      const weight = (!s || s.total < 3) ? EXPLORE_WEIGHT : Math.max(0.1, 1 - s.correct / s.total);
      return { subject: b.subject, topic: b.topic, bankCount: b.bank_count, weight };
    });
    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);

    let remaining = count;
    const allocation = weighted.map((w, i) => {
      const isLast = i === weighted.length - 1;
      const share = isLast ? remaining : Math.min(remaining, Math.max(0, Math.round((w.weight / totalWeight) * count)));
      remaining -= share;
      return { subject: w.subject, topic: w.topic, take: Math.min(share, w.bankCount) };
    }).filter(a => a.take > 0);

    let questionIds = [];
    for (const a of allocation) {
      const qRes = await client.query(
        `SELECT id FROM questions WHERE subject=$1 AND topic=$2 ORDER BY RANDOM() LIMIT $3`,
        [a.subject, a.topic, a.take]
      );
      questionIds.push(...qRes.rows.map(r => r.id));
    }
    if (questionIds.length < count) {
      const topUp = await client.query(
        `SELECT id FROM questions WHERE topic IS NOT NULL AND topic <> '' AND id != ALL($1::int[]) ORDER BY RANDOM() LIMIT $2`,
        [questionIds.length ? questionIds : [0], count - questionIds.length]
      );
      questionIds.push(...topUp.rows.map(r => r.id));
    }
    for (let i = questionIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questionIds[i], questionIds[j]] = [questionIds[j], questionIds[i]];
    }

    await client.query('BEGIN');
    const serial = 'EH-WT-' + Math.floor(1000 + Math.random() * 9000);
    const durationMinutes = Math.max(5, questionIds.length);
    const examResult = await client.query(
      `INSERT INTO exams (title, type, duration_minutes, status, serial, is_practice)
       VALUES ($1,'model',$2,'active',$3,true) RETURNING *`,
      ['দুর্বল টপিক প্র্যাকটিস', durationMinutes, serial]
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
