const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { generateFromTemplate } = require('../services/examTemplateScheduler');

// ---------- ADMIN: exam_templates CRUD ----------
// A template replaces the old "recreate the same live exam by hand every
// week" workflow. Admin fills this in ONCE; services/examTemplateScheduler.js
// then creates a real exams row automatically every time it's due, with the
// correct duration_minutes/start_time every single time.

// GET /api/exam-templates/admin/list
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*, m.name AS ministry_name,
      (SELECT COUNT(*) FROM exams e WHERE e.exam_template_id = t.id) AS generated_count
    FROM exam_templates t LEFT JOIN ministries m ON m.id = t.ministry_id
    ORDER BY t.created_at DESC
  `);
  res.json(rows);
}));

// GET /api/exam-templates/admin/:id/history — exams this template has generated
router.get('/admin/:id/history', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, start_time, duration_minutes, status, serial
     FROM exams WHERE exam_template_id = $1 ORDER BY start_time DESC LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
}));

// POST /api/exam-templates — create a template
// body: { title_pattern, ministry_id, post_name, subject, grade, routine_category,
//         question_count, duration_minutes, negative_marks, weekdays: [0-6], run_time: 'HH:MM' }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title_pattern, ministry_id, post_name, subject, topic, subtopic, grade, routine_category,
          question_count, duration_minutes, negative_marks, weekdays, run_time, exam_type, grading_mode } = req.body;

  if (!title_pattern || !question_count || !duration_minutes || !Array.isArray(weekdays) || !weekdays.length || !run_time) {
    return res.status(400).json({ error: 'টাইটেল, প্রশ্ন সংখ্যা, সময়কাল, সপ্তাহের দিন ও শুরুর সময় দরকার' });
  }
  const type = exam_type === 'written' ? 'written' : 'live';
  if (type === 'written' && !['self_check', 'manual', 'ai'].includes(grading_mode)) {
    return res.status(400).json({ error: 'রিটেন টেমপ্লেটের জন্য মূল্যায়ন পদ্ধতি (grading_mode) বাছাই করুন' });
  }

  const { rows } = await pool.query(
    `INSERT INTO exam_templates
       (title_pattern, ministry_id, post_name, subject, topic, subtopic, grade, routine_category,
        question_count, duration_minutes, negative_marks, weekdays, run_time, active, exam_type, grading_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15) RETURNING *`,
    [title_pattern, ministry_id || null, post_name || null, subject || null, topic || null, subtopic || null, grade || null,
     routine_category || null, question_count, duration_minutes, negative_marks || 0, weekdays, run_time,
     type, type === 'written' ? grading_mode : null]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/exam-templates/:id — edit a template (same body shape as create; also accepts { active })
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { title_pattern, ministry_id, post_name, subject, topic, subtopic, grade, routine_category,
          question_count, duration_minutes, negative_marks, weekdays, run_time, active, exam_type, grading_mode } = req.body;

  const { rows } = await pool.query(
    `UPDATE exam_templates SET
       title_pattern = COALESCE($1, title_pattern),
       ministry_id = $2,
       post_name = $3,
       subject = $4,
       topic = $5,
       subtopic = $6,
       grade = $7,
       routine_category = $8,
       question_count = COALESCE($9, question_count),
       duration_minutes = COALESCE($10, duration_minutes),
       negative_marks = COALESCE($11, negative_marks),
       weekdays = COALESCE($12, weekdays),
       run_time = COALESCE($13, run_time),
       active = COALESCE($14, active),
       exam_type = COALESCE($16, exam_type),
       grading_mode = $17
     WHERE id = $15 RETURNING *`,
    [title_pattern || null, ministry_id ?? null, post_name ?? null, subject ?? null, topic ?? null, subtopic ?? null, grade ?? null,
     routine_category ?? null, question_count || null, duration_minutes || null, negative_marks ?? null,
     weekdays || null, run_time || null, active === undefined ? null : active, req.params.id,
     exam_type || null, grading_mode ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: 'টেমপ্লেট পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/exam-templates/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM exam_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// POST /api/exam-templates/:id/run-now — manually fire a template immediately
// (useful right after creating one, or to backfill a day the scheduler missed).
// Ignores weekdays/run_time/last_generated_date checks — always generates.
router.post('/:id/run-now', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM exam_templates WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'টেমপ্লেট পাওয়া যায়নি' });
  try {
    const exam = await generateFromTemplate(rows[0], { force: true });
    res.status(201).json(exam);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
