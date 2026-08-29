const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, optionalUser } = require('../middleware/auth');

// POST /api/reports — a student flags a question as wrong/unclear.
// Works for guests and logged-in users. body: { question_id, reason }
router.post('/', optionalUser, async (req, res) => {
  const { question_id, reason } = req.body;
  if (!question_id) return res.status(400).json({ error: 'question_id প্রয়োজন' });
  const userId = req.user ? req.user.id : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO question_reports (question_id, user_id, reason) VALUES ($1,$2,$3) RETURNING *`,
      [question_id, userId, (reason || '').trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  }
});

// GET /api/reports — admin: list reports (open by default), with the question text attached
router.get('/', requireAdmin, async (req, res) => {
  const status = req.query.status || 'open';
  const { rows } = await pool.query(`
    SELECT r.id, r.reason, r.status, r.created_at,
      q.id AS question_id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option
    FROM question_reports r JOIN questions q ON q.id = r.question_id
    WHERE r.status = $1
    ORDER BY r.created_at DESC
  `, [status]);
  res.json(rows);
});

// PUT /api/reports/:id/resolve — admin: mark a report as resolved (after fixing/removing the question)
router.put('/:id/resolve', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE question_reports SET status='resolved' WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'রিপোর্ট পাওয়া যায়নি' });
  res.json(rows[0]);
});

module.exports = router;
