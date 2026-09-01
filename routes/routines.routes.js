const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// The 5 fixed routine categories. Kept as one source of truth here — both the
// admin bulk-add endpoint and the public category-list endpoint validate
// against this list, and the frontend mirrors these same slugs/labels.
const CATEGORIES = [
  { slug: 'grade-syllabus', title: '১১-২০ গ্রেড প্রস্তুতির সিলেবাস', subtitle: '৬ মাসে পূর্ণাঙ্গ প্রস্তুতি', icon: '📚' },
  { slug: 'bcs-200', title: '২০০ দিনে বিসিএস প্রস্তুতি', subtitle: 'দিনভিত্তিক ধারাবাহিক প্রস্তুতি', icon: '🏛️' },
  { slug: 'subject-wise', title: 'সাবজেক্ট ভিত্তিক রুটিন', subtitle: 'একটা একটা বিষয় ধরে শেষ করুন', icon: '📘' },
  { slug: 'topic-wise', title: 'টপিকভিত্তিক রুটিন', subtitle: 'টপিক ধরে ধরে পরিকল্পিত পড়াশোনা', icon: '🗂️' },
  { slug: 'job-solution', title: 'জব সলুশন শেষ করার রুটিন', subtitle: 'নির্দিষ্ট সময়ে সম্পূর্ণ জব সলুশন', icon: '✅' },
];
const CATEGORY_SLUGS = CATEGORIES.map(c => c.slug);

// GET /api/routines/public/categories — the 5 tiles for লাইভ রুটিন, each with
// how many days are already published under it.
router.get('/public/categories', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT category, COUNT(*)::int AS day_count FROM routine_days GROUP BY category`
  );
  const counts = Object.fromEntries(rows.map(r => [r.category, r.day_count]));
  res.json(CATEGORIES.map(c => ({ ...c, day_count: counts[c.slug] || 0 })));
}));

// GET /api/routines/public/:category — ordered day list for one category.
// If logged in, also marks which days this user has checked off.
router.get('/public/:category', optionalUser, asyncHandler(async (req, res) => {
  const { category } = req.params;
  if (!CATEGORY_SLUGS.includes(category)) {
    return res.status(400).json({ error: 'অজানা রুটিন ক্যাটাগরি' });
  }
  const { rows } = await pool.query(
    `SELECT d.id, d.day_number, d.title, d.tasks, d.exam_id,
            e.title AS exam_title, e.start_time AS exam_start_time, e.type AS exam_type,
            EXISTS(
              SELECT 1 FROM user_routine_progress p
              WHERE p.routine_day_id = d.id AND p.user_id = $2
            ) AS completed
     FROM routine_days d LEFT JOIN exams e ON e.id = d.exam_id
     WHERE d.category = $1
     ORDER BY d.day_number ASC`,
    [category, req.user ? req.user.id : null]
  );
  const meta = CATEGORIES.find(c => c.slug === category);
  res.json({ category: meta, days: rows });
}));

// POST /api/routines/progress/:dayId — logged-in student checks/unchecks a day.
// body: { completed: true|false }
router.post('/progress/:dayId', requireUser, asyncHandler(async (req, res) => {
  const dayId = req.params.dayId;
  if (req.body.completed) {
    await pool.query(
      `INSERT INTO user_routine_progress (user_id, routine_day_id) VALUES ($1,$2)
       ON CONFLICT (user_id, routine_day_id) DO NOTHING`,
      [req.user.id, dayId]
    );
  } else {
    await pool.query(
      `DELETE FROM user_routine_progress WHERE user_id=$1 AND routine_day_id=$2`,
      [req.user.id, dayId]
    );
  }
  res.json({ ok: true });
}));

// ---------- ADMIN ----------

// GET /api/routines/admin/:category — full admin listing for one category
router.get('/admin/:category', requireAdmin, asyncHandler(async (req, res) => {
  const { category } = req.params;
  if (!CATEGORY_SLUGS.includes(category)) {
    return res.status(400).json({ error: 'অজানা রুটিন ক্যাটাগরি' });
  }
  const { rows } = await pool.query(
    `SELECT d.*, e.title AS exam_title FROM routine_days d
     LEFT JOIN exams e ON e.id = d.exam_id
     WHERE d.category = $1 ORDER BY d.day_number ASC`,
    [category]
  );
  res.json(rows);
}));

// POST /api/routines/bulk — add many days at once (admin)
// body: { category, days: [{ day_number, title, tasks, exam_id }] }
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const { category, days } = req.body;
  if (!CATEGORY_SLUGS.includes(category)) {
    return res.status(400).json({ error: 'অজানা রুটিন ক্যাটাগরি' });
  }
  if (!Array.isArray(days) || !days.length) {
    return res.status(400).json({ error: 'কোনো দিন পাওয়া যায়নি' });
  }

  const client = await pool.connect();
  let added = 0;
  const errors = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (!d.day_number || !d.title) {
        errors.push(`দিন ${i + 1}: দিন নম্বর বা শিরোনাম অনুপস্থিত`);
        continue;
      }
      await client.query(
        `INSERT INTO routine_days (category, day_number, title, tasks, exam_id) VALUES ($1,$2,$3,$4,$5)`,
        [category, d.day_number, d.title, d.tasks || null, d.exam_id || null]
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

// DELETE /api/routines/:id — remove a single day (admin)
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM routine_days WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
