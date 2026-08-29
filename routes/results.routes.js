const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');

// POST /api/results — submitted when a participant finishes an exam.
// Works for guests (participant_name/phone in body) AND logged-in users
// (Authorization header) — if logged in, the result is linked to their account.
router.post('/', optionalUser, async (req, res) => {
  const { exam_id, participant_name, participant_phone, answers } = req.body;
  const userId = req.user ? req.user.id : null;
  const name = req.user ? req.user.name : participant_name;
  const phone = req.user ? req.user.phone : (participant_phone || null);

  if (!exam_id || !name || !answers) {
    return res.status(400).json({ error: 'নাম ও উত্তর প্রয়োজন' });
  }

  const qRes = await pool.query(
    `SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, eq.position
     FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
     WHERE eq.exam_id=$1 ORDER BY eq.position`,
    [exam_id]
  );

  let correct = 0, wrong = 0, skipped = 0;
  const review = qRes.rows.map(q => {
    const given = answers[q.id] ? String(answers[q.id]).toUpperCase() : null;
    let status;
    if (!given) { skipped++; status = 'skipped'; }
    else if (given === q.correct_option) { correct++; status = 'correct'; }
    else { wrong++; status = 'wrong'; }
    return {
      id: q.id, subject: q.subject, question_text: q.question_text,
      option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
      correct_option: q.correct_option, explanation: q.explanation,
      given, status
    };
  });
  const total = qRes.rows.length || 1;
  const score = Math.round((correct / total) * 10000) / 100;

  const { rows } = await pool.query(
    `INSERT INTO results (exam_id, user_id, participant_name, participant_phone, answers, correct_count, wrong_count, skipped_count, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [exam_id, userId, name, phone, JSON.stringify(answers), correct, wrong, skipped, score]
  );

  res.status(201).json({ ...rows[0], review });
});

// GET /api/results/me — logged-in student's own exam history, across all exams
router.get('/me', requireUser, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.id, r.exam_id, e.title AS exam_title, e.type AS exam_type,
      r.correct_count, r.wrong_count, r.skipped_count, r.score, r.submitted_at
    FROM results r JOIN exams e ON e.id = r.exam_id
    WHERE r.user_id = $1 ORDER BY r.submitted_at DESC
  `, [req.user.id]);
  res.json(rows);
});

// GET /api/results/me/subject-stats — subject-wise accuracy across ALL of this
// user's submitted exams, so they can see which subjects need more work.
router.get('/me/subject-stats', requireUser, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT q.subject,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ans.given IS NOT NULL AND UPPER(ans.given) = q.correct_option)::int AS correct,
      COUNT(*) FILTER (WHERE ans.given IS NOT NULL AND UPPER(ans.given) != q.correct_option)::int AS wrong,
      COUNT(*) FILTER (WHERE ans.given IS NULL)::int AS skipped
    FROM results r
    JOIN exam_questions eq ON eq.exam_id = r.exam_id
    JOIN questions q ON q.id = eq.question_id
    LEFT JOIN LATERAL (SELECT r.answers->>(eq.question_id::text) AS given) ans ON true
    WHERE r.user_id = $1
    GROUP BY q.subject
    ORDER BY total DESC
  `, [req.user.id]);
  res.json(rows);
});

// GET /api/results/:id/review — per-question breakdown (with explanations) for
// a specific past result, so the student can review it again later.
router.get('/:id/review', requireUser, async (req, res) => {
  const rRes = await pool.query('SELECT * FROM results WHERE id=$1', [req.params.id]);
  if (!rRes.rows.length) return res.status(404).json({ error: 'ফলাফল পাওয়া যায়নি' });
  const result = rRes.rows[0];
  if (result.user_id !== req.user.id) return res.status(403).json({ error: 'অনুমতি নেই' });

  const qRes = await pool.query(`
    SELECT q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, eq.position
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id=$1 ORDER BY eq.position
  `, [result.exam_id]);

  const answers = result.answers || {};
  const review = qRes.rows.map(q => {
    const given = answers[q.id] ? String(answers[q.id]).toUpperCase() : null;
    const status = !given ? 'skipped' : (given === q.correct_option ? 'correct' : 'wrong');
    return {
      id: q.id, subject: q.subject, question_text: q.question_text,
      option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
      correct_option: q.correct_option, explanation: q.explanation, given, status
    };
  });
  res.json({ result, review });
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
