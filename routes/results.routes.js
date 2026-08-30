const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');

// POST /api/results — submitted when a participant finishes an exam.
// Works for guests (participant_name/phone in body) AND logged-in users
// (Authorization header) — if logged in, the result is linked to their account.
router.post('/', submitLimiter, optionalUser, async (req, res) => {
  const { exam_id, participant_name, participant_phone, answers } = req.body;
  const userId = req.user ? req.user.id : null;
  const name = req.user ? req.user.name : participant_name;
  const phone = req.user ? req.user.phone : (participant_phone || null);

  if (!exam_id || !name || !answers) {
    return res.status(400).json({ error: 'নাম ও উত্তর প্রয়োজন' });
  }

  const examRes = await pool.query('SELECT negative_marks FROM exams WHERE id=$1', [exam_id]);
  const negativeMarks = examRes.rows.length ? Number(examRes.rows[0].negative_marks) || 0 : 0;

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
  // Negative marking: each wrong answer deducts `negative_marks` marks (out of 1 per question).
  // Score is still shown as a 0-100 percentage, clamped at 0 so it never goes negative.
  const rawMarks = correct - (wrong * negativeMarks);
  const score = Math.max(0, Math.round((rawMarks / total) * 10000) / 100);

  const { rows } = await pool.query(
    `INSERT INTO results (exam_id, user_id, participant_name, participant_phone, answers, correct_count, wrong_count, skipped_count, score, raw_marks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [exam_id, userId, name, phone, JSON.stringify(answers), correct, wrong, skipped, score, rawMarks]
  );

  let streak = null;
  if (userId) {
    streak = await updateStreak(userId);
  }

  res.status(201).json({ ...rows[0], review, streak });
});

// Updates a logged-in user's daily streak after they submit a result.
// Same day again -> unchanged. Consecutive day -> +1. Gap -> resets to 1.
async function updateStreak(userId) {
  const { rows } = await pool.query(
    'SELECT current_streak, longest_streak, last_activity_date FROM users WHERE id=$1',
    [userId]
  );
  if (!rows.length) return null;
  const u = rows[0];

  const todayRes = await pool.query("SELECT CURRENT_DATE AS today");
  const today = todayRes.rows[0].today;
  const todayStr = new Date(today).toDateString();
  const lastStr = u.last_activity_date ? new Date(u.last_activity_date).toDateString() : null;

  let newStreak = u.current_streak;
  if (lastStr === todayStr) {
    // already counted today — no change
  } else {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (lastStr === yesterday.toDateString()) {
      newStreak = u.current_streak + 1;
    } else {
      newStreak = 1;
    }
    const newLongest = Math.max(u.longest_streak, newStreak);
    await pool.query(
      'UPDATE users SET current_streak=$1, longest_streak=$2, last_activity_date=CURRENT_DATE WHERE id=$3',
      [newStreak, newLongest, userId]
    );
  }
  return { current_streak: newStreak, longest_streak: Math.max(u.longest_streak, newStreak) };
}

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

// GET /api/results/me/wrong-questions — every question this user has ever
// answered incorrectly (deduped, most recent attempt wins), for a revision quiz.
router.get('/me/wrong-questions', requireUser, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (q.id)
      q.id, q.subject, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, r.submitted_at
    FROM results r
    JOIN exam_questions eq ON eq.exam_id = r.exam_id
    JOIN questions q ON q.id = eq.question_id
    WHERE r.user_id = $1
      AND r.answers->>(eq.question_id::text) IS NOT NULL
      AND UPPER(r.answers->>(eq.question_id::text)) != q.correct_option
    ORDER BY q.id, r.submitted_at DESC
    LIMIT 100
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

// GET /api/results/leaderboard/overall — site-wide ranking across ALL exams,
// so users can see how they compare beyond a single exam. Ranked by total
// score summed across every exam they've taken (rewards both accuracy and
// consistency). Public — no login required to view.
router.get('/leaderboard/overall', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { rows } = await pool.query(`
    SELECT
      u.id AS user_id, u.name,
      COUNT(r.id)::int AS exams_taken,
      SUM(r.score)::numeric(10,2) AS total_score,
      ROUND(AVG(r.score)::numeric, 2) AS avg_score,
      SUM(r.correct_count)::int AS total_correct,
      RANK() OVER (ORDER BY SUM(r.score) DESC) AS rank
    FROM results r
    JOIN users u ON u.id = r.user_id
    WHERE r.user_id IS NOT NULL
    GROUP BY u.id, u.name
    ORDER BY total_score DESC
    LIMIT $1
  `, [limit]);
  res.json(rows);
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
