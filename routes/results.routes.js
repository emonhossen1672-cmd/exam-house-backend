const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');

// POST /api/results — public, submitted when a participant finishes an exam
// body: { exam_id, participant_name, participant_phone, answers: { "12": "A", "13": "C" } }
router.post('/', async (req, res) => {
  const { exam_id, participant_name, participant_phone, answers } = req.body;
  if (!exam_id || !participant_name || !answers) {
    return res.status(400).json({ error: 'নাম ও উত্তর প্রয়োজন' });
  }

  const qRes = await pool.query(
    `SELECT q.id, q.correct_option FROM exam_questions eq
     JOIN questions q ON q.id = eq.question_id WHERE eq.exam_id=$1`,
    [exam_id]
  );

  let correct = 0, wrong = 0, skipped = 0;
  qRes.rows.forEach(q => {
    const given = answers[q.id];
    if (!given) skipped++;
    else if (given.toUpperCase() === q.correct_option) correct++;
    else wrong++;
  });
  const total = qRes.rows.length || 1;
  const score = Math.round((correct / total) * 10000) / 100;

  const { rows } = await pool.query(
    `INSERT INTO results (exam_id, participant_name, participant_phone, answers, correct_count, wrong_count, skipped_count, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [exam_id, participant_name, participant_phone || null, JSON.stringify(answers), correct, wrong, skipped, score]
  );

  res.status(201).json(rows[0]);
});

// GET /api/results/exam/:examId — merit list / leaderboard, public
router.get('/exam/:examId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, participant_name, correct_count, wrong_count, skipped_count, score, submitted_at
     FROM results WHERE exam_id=$1 ORDER BY score DESC, submitted_at ASC`,
    [req.params.examId]
  );
  res.json(rows);
});

// GET /api/results/admin/exam/:examId — full detail including phone, for admin
router.get('/admin/exam/:examId', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM results WHERE exam_id=$1 ORDER BY score DESC, submitted_at ASC`,
    [req.params.examId]
  );
  res.json(rows);
});

module.exports = router;
