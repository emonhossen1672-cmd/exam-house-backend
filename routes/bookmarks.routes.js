const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/bookmarks — save a question for later revision. body: { question_id }
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { question_id } = req.body;
  if (!question_id) return res.status(400).json({ error: 'question_id প্রয়োজন' });
  await pool.query(
    'INSERT INTO bookmarks (user_id, question_id) VALUES ($1,$2) ON CONFLICT (user_id, question_id) DO NOTHING',
    [req.user.id, question_id]
  );
  res.status(201).json({ ok: true });
}));

// DELETE /api/bookmarks/:questionId — remove a saved question
router.delete('/:questionId', requireUser, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM bookmarks WHERE user_id=$1 AND question_id=$2',
    [req.user.id, req.params.questionId]
  );
  res.json({ ok: true });
}));

// GET /api/bookmarks — this user's saved questions (with full question detail, for a revision quiz).
// ?category= optionally restricts this to questions that appear in at least
// one exam tagged with that routine_category (used by the per-category
// "ফেভারিট" button). A bookmarked question with no matching exam in this
// category is left out, even if it's bookmarked site-wide.
router.get('/', requireUser, asyncHandler(async (req, res) => {
  const { category } = req.query;
  if (category) {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (q.id)
        q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
        q.correct_option, q.explanation, b.created_at AS bookmarked_at
      FROM bookmarks b
      JOIN questions q ON q.id = b.question_id
      JOIN exam_questions eq ON eq.question_id = q.id
      JOIN exams e ON e.id = eq.exam_id AND e.routine_category = $2
      WHERE b.user_id = $1
      ORDER BY q.id, b.created_at DESC
    `, [req.user.id, category]);
    return res.json(rows);
  }
  const { rows } = await pool.query(`
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, b.created_at AS bookmarked_at
    FROM bookmarks b JOIN questions q ON q.id = b.question_id
    WHERE b.user_id = $1
    ORDER BY b.created_at DESC
  `, [req.user.id]);
  res.json(rows);
}));

// GET /api/bookmarks/ids — just the bookmarked question IDs (fast, for the exam UI
// to mark a bookmark icon as filled/empty without fetching full question text)
router.get('/ids', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT question_id FROM bookmarks WHERE user_id=$1', [req.user.id]);
  res.json(rows.map(r => r.question_id));
}));

module.exports = router;
