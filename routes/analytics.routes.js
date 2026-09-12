// routes/analytics.routes.js — admin-only growth/retention/revenue
// dashboard. One consolidated endpoint (GET /api/analytics/dashboard) so the
// admin page makes a single call instead of five, per the existing app's own
// pattern (see e.g. exams.routes.js public/list combining several joins into
// one response).
//
// DAU/WAU/MAU reuse users.last_activity_date, which is already maintained
// for the streak system (see schema.sql) — no new activity-tracking table
// needed. "Active" here means "did something that bumps a streak", which is
// already the app's own definition of a student's daily activity.
//
// Exam counts (top-exams, submissions) exclude is_duel/is_daily/is_practice/
// is_auto_subject rows, same filter the homepage tabs and routes/seo.routes.js
// already use — those are internal/generated exams, not real content.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const REAL_EXAM_FILTER = `
  e.is_duel = false AND e.is_daily = false AND e.is_practice = false
  AND e.is_auto_subject = false
`;

// Zero-filled daily series for the last `days` days (including today), so a
// chart doesn't show gaps as missing data points on days with zero activity.
function dailySeriesQuery(countSubquery, castType) {
  const cast = castType || 'int';
  return `
    SELECT to_char(d, 'YYYY-MM-DD') AS date, COALESCE(s.cnt, 0)::${cast} AS count
    FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day') d
    LEFT JOIN (${countSubquery}) s ON s.day = d::date
    ORDER BY d
  `;
}

router.get('/dashboard', requireAdmin, asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 180);

  const [
    overviewRes,
    signupsRes,
    submissionsRes,
    revenueRes,
    topExamsRes,
    funnelRes,
    topReferrersRes,
  ] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
        (SELECT COUNT(*) FROM users WHERE last_activity_date = CURRENT_DATE) AS dau,
        (SELECT COUNT(*) FROM users WHERE last_activity_date >= CURRENT_DATE - 6) AS wau,
        (SELECT COUNT(*) FROM users WHERE last_activity_date >= CURRENT_DATE - 29) AS mau,
        (SELECT COUNT(*) FROM results r JOIN exams e ON e.id = r.exam_id WHERE ${REAL_EXAM_FILTER}) AS total_submissions,
        (SELECT COUNT(*) FROM results r JOIN exams e ON e.id = r.exam_id WHERE ${REAL_EXAM_FILTER} AND r.submitted_at >= NOW() - INTERVAL '7 days') AS submissions_7d,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='approved' AND created_at >= date_trunc('month', CURRENT_DATE)) AS revenue_this_month,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='approved'
          AND created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
          AND created_at < date_trunc('month', CURRENT_DATE)) AS revenue_last_month,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='approved') AS revenue_all_time,
        (SELECT COUNT(*) FROM payments WHERE status='pending') AS pending_payments
    `),
    pool.query(dailySeriesQuery(
      `SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM users GROUP BY DATE(created_at)`
    ), [days]),
    pool.query(dailySeriesQuery(
      `SELECT DATE(r.submitted_at) AS day, COUNT(*) AS cnt
       FROM results r JOIN exams e ON e.id = r.exam_id
       WHERE ${REAL_EXAM_FILTER} GROUP BY DATE(r.submitted_at)`
    ), [days]),
    pool.query(dailySeriesQuery(
      `SELECT DATE(COALESCE(reviewed_at, created_at)) AS day, SUM(amount) AS cnt
       FROM payments WHERE status='approved' GROUP BY DATE(COALESCE(reviewed_at, created_at))`,
      'numeric'
    ), [days]),
    pool.query(`
      SELECT e.id, e.title, COUNT(r.id)::int AS attempts
      FROM exams e JOIN results r ON r.exam_id = e.id
      WHERE ${REAL_EXAM_FILTER}
      GROUP BY e.id, e.title
      ORDER BY attempts DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS signed_up,
        (SELECT COUNT(DISTINCT user_id) FROM results WHERE user_id IS NOT NULL) AS took_exam,
        (SELECT COUNT(DISTINCT user_id) FROM payments WHERE status='approved') AS purchased
    `),
    pool.query(`
      SELECT u.name, u.student_code, COUNT(r.id)::int AS referred_count
      FROM users u JOIN users r ON r.referred_by = u.id
      GROUP BY u.id, u.name, u.student_code
      ORDER BY referred_count DESC
      LIMIT 10
    `),
  ]);

  res.json({
    overview: overviewRes.rows[0],
    signups_by_day: signupsRes.rows,
    submissions_by_day: submissionsRes.rows,
    revenue_by_day: revenueRes.rows.map(r => ({ date: r.date, amount: Number(r.count) })),
    top_exams: topExamsRes.rows,
    funnel: funnelRes.rows[0],
    top_referrers: topReferrersRes.rows,
  });
}));

module.exports = router;
