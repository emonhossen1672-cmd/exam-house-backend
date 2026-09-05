// routes/writtenQuestions.routes.js — the রিটেন জব সলুশন question bank.
// Unlike routes/questions.routes.js (MCQ, auto-graded), each row here is a
// free-text question + a model_answer, used two ways:
//   1. Read directly as study content (GET /public/library) — the "রিটেন জব
//      সলুশন" reading feature, model_answer included, no exam involved.
//   2. Pulled into an actual written EXAM via routes/exams.routes.js, where
//      model_answer is hidden from students until grading/archive — see
//      exam_written_questions + written_answers in schema.sql.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { normalizeText } = require('../utils/topicJobSubjects');

// ---------- ADMIN ----------

// GET /api/written-questions?ministry_id=&grade=&subject=&topic=&subtopic=&search=
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, search } = req.query;
  const clauses = [];
  const params = [];
  if (ministry_id) { params.push(ministry_id); clauses.push(`wq.ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`wq.grade = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`wq.subject = $${params.length}`); }
  if (topic) { params.push(topic); clauses.push(`wq.topic = $${params.length}`); }
  if (subtopic) { params.push(subtopic); clauses.push(`wq.subtopic = $${params.length}`); }
  if (search) { params.push(`%${search}%`); clauses.push(`wq.question_text ILIKE $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT wq.*, m.name AS ministry_name FROM written_questions wq
     LEFT JOIN ministries m ON m.id = wq.ministry_id
     ${where} ORDER BY wq.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

// POST /api/written-questions — add one
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks } = req.body;
  if (!subject || !question_text || !model_answer) {
    return res.status(400).json({ error: 'বিষয়, প্রশ্ন ও আদর্শ উত্তর দিতে হবে' });
  }
  const { rows } = await pool.query(
    `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), normalizeText(topic) || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, question_text, model_answer, marks || 10]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/written-questions/:id
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks } = req.body;
  const { rows } = await pool.query(
    `UPDATE written_questions SET ministry_id=$1, grade=$2, subject=$3, topic=$4, subtopic=$5,
       post_name=$6, question_text=$7, model_answer=$8, marks=$9
     WHERE id=$10 RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), normalizeText(topic) || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, question_text, model_answer, marks || 10, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/written-questions/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM written_questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// POST /api/written-questions/bulk — paste many at once.
// body: { questions: [{ ministry_id, grade, subject, topic, subtopic, question_text, model_answer, marks }] }
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'কোনো প্রশ্ন পাওয়া যায়নি' });
  }
  const client = await pool.connect();
  let added = 0;
  const errors = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.subject || !q.question_text || !q.model_answer) {
        errors.push(`প্রশ্ন ${i + 1}: বিষয়, প্রশ্ন বা আদর্শ উত্তর অনুপস্থিত`);
        continue;
      }
      await client.query(
        `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [q.ministry_id || null, q.grade || null, normalizeText(q.subject), normalizeText(q.topic) || null,
         normalizeText(q.subtopic) || null, (q.post_name || '').toString().trim() || null, q.question_text, q.model_answer, q.marks || 10]
      );
      added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
  res.json({ added, failed: errors.length, errors });
}));

// GET /api/written-questions/admin/subjects — distinct subjects + counts, for
// the admin panel's filter dropdown.
router.get('/admin/subjects', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count FROM written_questions GROUP BY subject ORDER BY subject`
  );
  res.json(rows);
}));

// ---------- PUBLIC (রিটেন জব সলুশন reading feature — model_answer included) ----------

// GET /api/written-questions/public/subjects — subject list with counts, for
// the রিটেন জব সলুশন landing screen.
router.get('/public/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count FROM written_questions GROUP BY subject ORDER BY subject`
  );
  res.json(rows);
}));

// GET /api/written-questions/public/library?subject=&topic=&subtopic= — full
// reading list (question + model answer), most recent first.
router.get('/public/library', asyncHandler(async (req, res) => {
  const { subject, topic, subtopic } = req.query;
  const clauses = [];
  const params = [];
  if (subject) { params.push(subject); clauses.push(`subject = $${params.length}`); }
  if (topic) { params.push(topic); clauses.push(`topic = $${params.length}`); }
  if (subtopic) { params.push(subtopic); clauses.push(`subtopic = $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT id, subject, topic, subtopic, question_text, model_answer, marks, created_at
     FROM written_questions ${where} ORDER BY created_at DESC LIMIT 300`,
    params
  );
  res.json(rows);
}));

module.exports = router;
