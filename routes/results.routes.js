const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/results — submitted when a participant finishes an exam.
// Works for guests (participant_name/phone in body) AND logged-in users
// (Authorization header) — if logged in, the result is linked to their account.
router.post('/', submitLimiter, optionalUser, asyncHandler(async (req, res) => {
  const { exam_id, participant_name, participant_phone, answers } = req.body;
  const userId = req.user ? req.user.id : null;
  const name = req.user ? req.user.name : participant_name;
  const phone = req.user ? req.user.phone : (participant_phone || null);

  if (!exam_id || !name || !answers) {
    return res.status(400).json({ error: 'নাম ও উত্তর প্রয়োজন' });
  }

  const examRes = await pool.query('SELECT type, status, negative_marks FROM exams WHERE id=$1', [exam_id]);
  if (!examRes.rows.length) {
    return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  }
  const exam = examRes.rows[0];
  const negativeMarks = Number(exam.negative_marks) || 0;

  // Fix: a logged-in user could previously submit the same LIVE exam
  // unlimited times, each one counted separately toward the per-exam merit
  // list and the site-wide leaderboard total. Model/practice/daily-quiz exams
  // are still retakable on purpose (that's how revision/practice works) — this
  // only blocks a second official submission for a real live exam.
  if (userId && exam.type === 'live') {
    const dup = await pool.query('SELECT id FROM results WHERE exam_id=$1 AND user_id=$2 LIMIT 1', [exam_id, userId]);
    if (dup.rows.length) {
      return res.status(409).json({ error: 'আপনি এই পরীক্ষা আগেই সাবমিট করেছেন' });
    }
  }
  // Same fix for guests: a guest could resubmit the same live exam unlimited
  // times to game the merit list, since only user_id was checked before. We
  // can only key this on the phone number they typed in — if a guest leaves
  // phone blank there's no reliable identity to dedupe on, so this narrows
  // but doesn't fully close the gap. Encouraging login for live exams (where
  // this matters most) remains the strongest fix.
  if (!userId && exam.type === 'live' && phone) {
    const dup = await pool.query(
      'SELECT id FROM results WHERE exam_id=$1 AND user_id IS NULL AND participant_phone=$2 LIMIT 1',
      [exam_id, phone]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: 'এই মোবাইল নম্বর দিয়ে আপনি এই পরীক্ষা আগেই সাবমিট করেছেন' });
    }
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

  // Rank/percentile within this exam: how this result compares to everyone
  // else who has submitted the same exam, so far. Rank = 1 + how many
  // scored strictly higher (ties share the same rank). Recomputed fresh
  // each submission, so it's always accurate as of "right now".
  const rankRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE score > $2)::int + 1 AS rank,
       COUNT(*)::int AS total_participants
     FROM results WHERE exam_id = $1`,
    [exam_id, score]
  );
  const { rank, total_participants } = rankRes.rows[0];
  const percentile = total_participants > 1
    ? Math.round(((total_participants - rank) / (total_participants - 1)) * 10000) / 100
    : 100;
  const rankInfo = { rank, total_participants, percentile };

  res.status(201).json({ ...rows[0], review, streak, rank_info: rankInfo });
}));

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
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.id, r.exam_id, e.title AS exam_title, e.type AS exam_type,
      r.correct_count, r.wrong_count, r.skipped_count, r.score, r.submitted_at
    FROM results r JOIN exams e ON e.id = r.exam_id
    WHERE r.user_id = $1 ORDER BY r.submitted_at DESC
  `, [req.user.id]);
  res.json(rows);
}));

// GET /api/results/me/subject-stats — subject-wise accuracy across ALL of this
// user's submitted exams, so they can see which subjects need more work.
router.get('/me/subject-stats', requireUser, asyncHandler(async (req, res) => {
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
}));

// GET /api/results/me/wrong-questions — every question this user has ever
// answered incorrectly (deduped, most recent attempt wins), for a revision quiz.
router.get('/me/wrong-questions', requireUser, asyncHandler(async (req, res) => {
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
}));

// GET /api/results/:id/review — per-question breakdown (with explanations) for
// a specific past result, so the student can review it again later.
router.get('/:id/review', requireUser, asyncHandler(async (req, res) => {
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
}));

// GET /api/results/me/achievements — badges/milestones for the logged-in
// student. Nothing is stored for this — every badge is derived fresh from
// existing data (results + users.longest_streak) on each call, so there's
// no separate table to keep in sync.
router.get('/me/achievements', requireUser, asyncHandler(async (req, res) => {
  const statsRes = await pool.query(`
    SELECT
      u.longest_streak,
      COALESCE(SUM(r.correct_count + r.wrong_count), 0)::int AS questions_answered,
      COUNT(r.id)::int AS exams_taken,
      MIN(er.rank) AS best_exam_rank
    FROM users u
    LEFT JOIN results r ON r.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE r2.score > r.score)::int + 1 AS rank
      FROM results r2 WHERE r2.exam_id = r.exam_id
    ) er ON true
    WHERE u.id = $1
    GROUP BY u.id
  `, [req.user.id]);
  const stats = statsRes.rows[0] || { longest_streak: 0, questions_answered: 0, exams_taken: 0, best_exam_rank: null };

  const overallRes = await pool.query(`
    SELECT rank FROM (
      SELECT u.id AS user_id, RANK() OVER (ORDER BY SUM(r.score) DESC) AS rank
      FROM results r JOIN users u ON u.id = r.user_id
      WHERE r.user_id IS NOT NULL
      GROUP BY u.id
    ) t WHERE user_id = $1
  `, [req.user.id]);
  const overallRank = overallRes.rows[0] ? overallRes.rows[0].rank : null;

  const streakBadges = [3, 7, 15, 30, 60].map(n => ({
    id: `streak_${n}`, group: 'streak', emoji: '🔥',
    title: `${n} দিনের স্ট্রিক`,
    earned: stats.longest_streak >= n,
    target: n, progress: Math.min(stats.longest_streak, n)
  }));

  const questionBadges = [50, 100, 250, 500, 1000].map(n => ({
    id: `questions_${n}`, group: 'questions', emoji: '📚',
    title: `${n} প্রশ্ন সমাধান`,
    earned: stats.questions_answered >= n,
    target: n, progress: Math.min(stats.questions_answered, n)
  }));

  const examBadges = [5, 10, 25, 50].map(n => ({
    id: `exams_${n}`, group: 'exams', emoji: '📝',
    title: `${n}টি পরীক্ষা সম্পন্ন`,
    earned: stats.exams_taken >= n,
    target: n, progress: Math.min(stats.exams_taken, n)
  }));

  const rankBadges = [
    { id: 'top_1', group: 'rank', emoji: '🥇', title: 'কোনো পরীক্ষায় ১ম স্থান',
      earned: stats.best_exam_rank === 1 },
    { id: 'top_10', group: 'rank', emoji: '🏅', title: 'কোনো পরীক্ষায় টপ ১০',
      earned: stats.best_exam_rank !== null && stats.best_exam_rank <= 10 },
    { id: 'top_100_overall', group: 'rank', emoji: '🏆', title: 'সার্বিক লিডারবোর্ডে টপ ১০০',
      earned: overallRank !== null && overallRank <= 100 },
  ];

  const badges = [...streakBadges, ...questionBadges, ...examBadges, ...rankBadges];
  res.json({
    badges,
    earned_count: badges.filter(b => b.earned).length,
    total_count: badges.length,
    stats: { ...stats, overall_rank: overallRank }
  });
}));

// GET /api/results/leaderboard/overall — site-wide ranking across ALL exams,
// so users can see how they compare beyond a single exam. Ranked by total
// score summed across every exam they've taken (rewards both accuracy and
// consistency). Public — no login required to view.
router.get('/leaderboard/overall', asyncHandler(async (req, res) => {
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
}));

// GET /api/results/exam/:examId — merit list for ONE exam, public. Ties share
// the same rank (RANK(), not ROW_NUMBER()) since two identical scores tying
// for 2nd place in a live exam is a very real case. If the caller is a
// logged-in user, also returns their own rank even when it falls outside the
// returned page (computed separately, so it's always accurate).
router.get('/exam/:examId', optionalUser, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
    `SELECT id, participant_name, correct_count, wrong_count, skipped_count, score, submitted_at,
       RANK() OVER (ORDER BY score DESC, submitted_at ASC)::int AS rank,
       COUNT(*) OVER ()::int AS total_participants
     FROM results WHERE exam_id=$1
     ORDER BY score DESC, submitted_at ASC
     LIMIT $2`,
    [req.params.examId, limit]
  );

  let myResult = null;
  if (req.user) {
    const mine = await pool.query(
      `SELECT id, score FROM results WHERE exam_id=$1 AND user_id=$2 ORDER BY submitted_at DESC LIMIT 1`,
      [req.params.examId, req.user.id]
    );
    if (mine.rows.length) {
      const full = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE score > $2)::int + 1 AS rank, COUNT(*)::int AS total_participants
         FROM results WHERE exam_id=$1`,
        [req.params.examId, mine.rows[0].score]
      );
      myResult = {
        result_id: mine.rows[0].id,
        score: mine.rows[0].score,
        rank: full.rows[0].rank,
        total_participants: full.rows[0].total_participants
      };
    }
  }

  res.json({ leaderboard: rows, my_result: myResult });
}));

// GET /api/results/:id/share-card — public JSON for a shareable result card
// (name, score, rank, exam info). No auth required — this is meant to be
// shared outside the site — and it exposes nothing beyond what's already on
// the public merit list above (no phone number).
router.get('/:id/share-card', asyncHandler(async (req, res) => {
  const rRes = await pool.query(
    `SELECT r.id, r.participant_name, r.correct_count, r.wrong_count, r.skipped_count,
       r.score, r.submitted_at, e.title AS exam_title, e.type AS exam_type,
       m.name AS ministry_name, e.grade
     FROM results r
     JOIN exams e ON e.id = r.exam_id
     LEFT JOIN ministries m ON m.id = e.ministry_id
     WHERE r.id=$1`,
    [req.params.id]
  );
  if (!rRes.rows.length) return res.status(404).json({ error: 'ফলাফল পাওয়া যায়নি' });
  const r = rRes.rows[0];

  const rankRes = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE score > $2)::int + 1 AS rank, COUNT(*)::int AS total_participants
     FROM results WHERE exam_id = (SELECT exam_id FROM results WHERE id=$1)`,
    [req.params.id, r.score]
  );
  const { rank, total_participants } = rankRes.rows[0];
  const percentile = total_participants > 1
    ? Math.round(((total_participants - rank) / (total_participants - 1)) * 10000) / 100
    : 100;

  res.json({
    result_id: r.id,
    participant_name: r.participant_name,
    exam_title: r.exam_title,
    exam_type: r.exam_type,
    ministry_name: r.ministry_name,
    grade: r.grade,
    correct_count: r.correct_count,
    wrong_count: r.wrong_count,
    skipped_count: r.skipped_count,
    score: r.score,
    rank, total_participants, percentile,
    submitted_at: r.submitted_at,
    share_image_url: `/api/results/${r.id}/share-card.svg`
  });
}));

// GET /api/results/:id/share-card.svg — the same data rendered as a
// downloadable/shareable image (1200x630 — the standard social-share size).
// Pure string templating, no image library or native dependency: the SVG's
// <text> elements get rasterized by whatever renders it (browser, image
// tag, share sheet), which already has Bengali fonts available.
router.get('/:id/share-card.svg', asyncHandler(async (req, res) => {
  const rRes = await pool.query(
    `SELECT r.id, r.participant_name, r.correct_count, r.wrong_count, r.skipped_count,
       r.score, e.title AS exam_title, m.name AS ministry_name, e.grade
     FROM results r
     JOIN exams e ON e.id = r.exam_id
     LEFT JOIN ministries m ON m.id = e.ministry_id
     WHERE r.id=$1`,
    [req.params.id]
  );
  if (!rRes.rows.length) return res.status(404).send('Not found');
  const r = rRes.rows[0];

  const rankRes = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE score > $2)::int + 1 AS rank, COUNT(*)::int AS total_participants
     FROM results WHERE exam_id = (SELECT exam_id FROM results WHERE id=$1)`,
    [req.params.id, r.score]
  );
  const { rank, total_participants } = rankRes.rows[0];

  // Escape everything going into the SVG — participant_name and exam_title
  // are user-supplied text, so this isn't optional.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7f1d1d"/>
      <stop offset="100%" stop-color="#450a0a"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="60" y="90" font-family="sans-serif" font-size="40" font-weight="bold" fill="#fbbf24">Exam House</text>
  <text x="60" y="200" font-family="sans-serif" font-size="34" fill="#ffffff">${esc(r.exam_title)}</text>
  <text x="60" y="245" font-family="sans-serif" font-size="24" fill="#fca5a5">${esc(r.ministry_name || '')}${r.grade ? ' • গ্রেড-' + esc(r.grade) : ''}</text>

  <text x="60" y="340" font-family="sans-serif" font-size="30" fill="#ffffff">${esc(r.participant_name)}</text>

  <text x="60" y="450" font-family="sans-serif" font-size="90" font-weight="bold" fill="#fbbf24">${esc(r.score)}%</text>
  <text x="60" y="495" font-family="sans-serif" font-size="26" fill="#fed7aa">স্কোর</text>

  <text x="450" y="450" font-family="sans-serif" font-size="90" font-weight="bold" fill="#4ade80">#${esc(rank)}</text>
  <text x="450" y="495" font-family="sans-serif" font-size="26" fill="#fed7aa">মেধাক্রম (${esc(total_participants)} জনের মধ্যে)</text>

  <text x="60" y="580" font-family="sans-serif" font-size="22" fill="#ffffff">সঠিক: ${esc(r.correct_count)}   ভুল: ${esc(r.wrong_count)}   বাদ: ${esc(r.skipped_count)}</text>
</svg>`;

  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(svg);
}));

// GET /api/results/admin/exam/:examId — full detail including phone, for admin
router.get('/admin/exam/:examId', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM results WHERE exam_id=$1 ORDER BY score DESC, submitted_at ASC`,
    [req.params.examId]
  );
  res.json(rows);
}));

module.exports = router;
