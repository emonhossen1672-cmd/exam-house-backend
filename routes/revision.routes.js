// routes/revision.routes.js — spaced-repetition revision deck.
//
// Cards are enrolled automatically elsewhere (a wrong exam answer, or a
// bookmark — see results.routes.js POST / and bookmarks.routes.js POST /).
// This file only covers reviewing the deck: what's due, marking a card
// reviewed (which reschedules it via utils/spacedRepetition), and removing
// a card the student no longer wants tracked.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { schedule } = require('../utils/spacedRepetition');

// GET /api/revision/due — cards due for review today (or overdue), with full
// question detail, most-overdue first. ?subject= optionally narrows to one
// subject (mirrors the ?subject= pattern used by bookmarks/wrong-questions).
router.get('/due', requireUser, asyncHandler(async (req, res) => {
  const { subject } = req.query;
  const params = [req.user.id];
  let extraClause = '';
  if (subject) { params.push(subject); extraClause = 'AND q.subject = $2'; }
  const { rows } = await pool.query(`
    SELECT rc.question_id AS id, q.subject, q.question_text, q.option_a, q.option_b,
      q.option_c, q.option_d, q.correct_option, q.explanation,
      rc.repetitions, rc.interval_days, rc.due_date, rc.last_result, rc.source
    FROM revision_cards rc
    JOIN questions q ON q.id = rc.question_id
    WHERE rc.user_id = $1 AND rc.due_date <= CURRENT_DATE ${extraClause}
    ORDER BY rc.due_date ASC, rc.updated_at ASC
    LIMIT 50
  `, params);
  res.json(rows);
}));

// GET /api/revision/count — just the due count, for a lightweight nav badge.
router.get('/count', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS due_count FROM revision_cards WHERE user_id=$1 AND due_date <= CURRENT_DATE',
    [req.user.id]
  );
  res.json(rows[0]);
}));

// GET /api/revision/stats — small dashboard widget: total cards being
// tracked, how many are due right now, and how many have "graduated"
// (interval_days >= 21 — i.e. reliably known, rarely resurfacing).
router.get('/stats', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_cards,
      COUNT(*) FILTER (WHERE due_date <= CURRENT_DATE)::int AS due_now,
      COUNT(*) FILTER (WHERE interval_days >= 21)::int AS mastered
    FROM revision_cards WHERE user_id=$1
  `, [req.user.id]);
  res.json(rows[0]);
}));

// POST /api/revision/:questionId/review — body: { result: 'correct'|'wrong' }.
// Reschedules the card (or creates one, if the student is reviewing a
// question straight from the bookmark/wrong-question list that hasn't been
// added to the deck yet). Returns the updated card so the client can show
// "পরের বার দেখাবো: ৬ দিন পর"-style feedback immediately.
router.post('/:questionId/review', requireUser, asyncHandler(async (req, res) => {
  const { result } = req.body;
  const questionId = req.params.questionId;
  if (result !== 'correct' && result !== 'wrong') {
    return res.status(400).json({ error: "result 'correct' অথবা 'wrong' হতে হবে" });
  }

  const existing = await pool.query(
    'SELECT repetitions, ease_factor, interval_days FROM revision_cards WHERE user_id=$1 AND question_id=$2',
    [req.user.id, questionId]
  );
  const current = existing.rows[0] || { repetitions: 0, ease_factor: 2.5, interval_days: 0 };
  const next = schedule(current, result);

  const { rows } = await pool.query(`
    INSERT INTO revision_cards (user_id, question_id, repetitions, ease_factor, interval_days, due_date, last_result, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7, 'wrong')
    ON CONFLICT (user_id, question_id) DO UPDATE SET
      repetitions=$3, ease_factor=$4, interval_days=$5, due_date=$6, last_result=$7, updated_at=NOW()
    RETURNING question_id AS id, repetitions, ease_factor, interval_days, due_date, last_result
  `, [req.user.id, questionId, next.repetitions, next.ease_factor, next.interval_days, next.due_date, result]);

  res.json(rows[0]);
}));

// DELETE /api/revision/:questionId — student no longer wants this question
// tracked for revision (e.g. "আর দেখাবেন না" / already confident about it).
router.delete('/:questionId', requireUser, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM revision_cards WHERE user_id=$1 AND question_id=$2', [req.user.id, req.params.questionId]);
  res.json({ ok: true });
}));

module.exports = router;
