// routes/flashNews.routes.js — colorful current-affairs "live ticker" for
// the home screen. Each item belongs to a category (আন্তর্জাতিক/অর্থনীতি/
// রাজনীতি/কৌশলগত...) and carries structured facts + practice MCQs, on top
// of the older title/body/image_url fields (kept for backward compatibility
// with any old rows). Kept deliberately separate from routes/notices.routes.js
// — see the flash_news table comment in schema.sql for why.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// Strip the answer key out of mcqs before sending to the public — grading
// happens server-side in POST /:id/mcq/:index/answer so a peek at the
// network tab can't hand out the correct answer.
function publicMcqs(mcqs) {
  if (!Array.isArray(mcqs)) return [];
  return mcqs.map(m => ({ question: m.question, options: m.options }));
}

// GET /api/flash-news — public feed, active items only, newest first.
// optionalUser: logged-in users get is_read + this item's MCQ progress;
// guests still get the full feed, just without that per-user state.
router.get('/', optionalUser, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const { rows } = await pool.query(
    `SELECT id, title, body, image_url, source_url, category, facts, mcqs, created_at
       FROM flash_news
      WHERE is_active = true
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );

  let readIds = new Set();
  let answerMap = new Map(); // flash_news_id -> {answered_count, correct_count}
  if (req.user && rows.length) {
    const ids = rows.map(r => r.id);
    const reads = await pool.query(
      `SELECT flash_news_id FROM flash_news_reads WHERE user_id=$1 AND flash_news_id = ANY($2)`,
      [req.user.id, ids]
    );
    readIds = new Set(reads.rows.map(r => r.flash_news_id));

    const answers = await pool.query(
      `SELECT flash_news_id,
              COUNT(*)::int AS answered_count,
              COUNT(*) FILTER (WHERE is_correct)::int AS correct_count
         FROM flash_news_answers
        WHERE user_id=$1 AND flash_news_id = ANY($2)
        GROUP BY flash_news_id`,
      [req.user.id, ids]
    );
    for (const a of answers.rows) answerMap.set(a.flash_news_id, a);
  }

  const flash_news = rows.map(n => ({
    id: n.id,
    title: n.title,
    body: n.body,
    image_url: n.image_url,
    source_url: n.source_url,
    category: n.category,
    facts: n.facts || [],
    mcqs: publicMcqs(n.mcqs),
    created_at: n.created_at,
    is_read: req.user ? readIds.has(n.id) : null,
    answered_count: req.user ? (answerMap.get(n.id)?.answered_count || 0) : null,
    correct_count: req.user ? (answerMap.get(n.id)?.correct_count || 0) : null,
  }));

  res.json({ flash_news });
}));

// GET /api/flash-news/categories — chip strip data: per-category item count
// + whether the logged-in user still has an unread item in that category.
// Guests get counts with has_unread always true (nothing's been read yet).
router.get('/categories', optionalUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category FROM flash_news WHERE is_active = true AND category IS NOT NULL`
  );

  let readIds = new Set();
  if (req.user && rows.length) {
    const reads = await pool.query(
      `SELECT flash_news_id FROM flash_news_reads WHERE user_id=$1 AND flash_news_id = ANY($2)`,
      [req.user.id, rows.map(r => r.id)]
    );
    readIds = new Set(reads.rows.map(r => r.flash_news_id));
  }

  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, { category: r.category, count: 0, has_unread: false });
    const c = byCat.get(r.category);
    c.count += 1;
    if (!req.user || !readIds.has(r.id)) c.has_unread = true;
  }

  res.json({ categories: Array.from(byCat.values()) });
}));

// GET /api/flash-news/admin/list — admin sees inactive items + full mcqs
// (including correct_index/explanation) for editing.
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM flash_news ORDER BY created_at DESC');
  res.json({ flash_news: rows });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, body, image_url, source_url, category, facts, mcqs } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'টাইটেল দিন' });

  const { rows } = await pool.query(
    `INSERT INTO flash_news (title, body, image_url, source_url, category, facts, mcqs)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      title.trim(),
      body || null,
      image_url || null,
      source_url || null,
      category || null,
      JSON.stringify(facts || []),
      JSON.stringify(mcqs || []),
    ]
  );
  res.json({ flash_news: rows[0] });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { title, body, image_url, source_url, category, facts, mcqs } = req.body;
  const { rows } = await pool.query(
    `UPDATE flash_news SET title=$1, body=$2, image_url=$3, source_url=$4,
            category=$5, facts=$6, mcqs=$7
     WHERE id=$8 RETURNING *`,
    [
      title,
      body || null,
      image_url || null,
      source_url || null,
      category || null,
      JSON.stringify(facts || []),
      JSON.stringify(mcqs || []),
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'আইটেম পাওয়া যায়নি' });
  res.json({ flash_news: rows[0] });
}));

// PATCH /api/flash-news/:id/toggle — publish/unpublish without deleting.
router.patch('/:id/toggle', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE flash_news SET is_active = NOT is_active WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'আইটেম পাওয়া যায়নি' });
  res.json({ flash_news: rows[0] });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM flash_news WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'আইটেম পাওয়া যায়নি' });
  res.json({ success: true });
}));

// POST /api/flash-news/:id/read — clears the unread dot for this item.
// Works for guests too, it just doesn't persist anything for them.
router.post('/:id/read', optionalUser, asyncHandler(async (req, res) => {
  if (req.user) {
    await pool.query(
      `INSERT INTO flash_news_reads (user_id, flash_news_id)
       VALUES ($1, $2) ON CONFLICT (user_id, flash_news_id) DO NOTHING`,
      [req.user.id, req.params.id]
    );
  }
  res.json({ success: true });
}));

// POST /api/flash-news/:id/mcq/:index/answer — server-side grading; the
// correct answer/explanation never left the server until this call.
router.post('/:id/mcq/:index/answer', optionalUser, asyncHandler(async (req, res) => {
  const { answer } = req.body;
  const index = parseInt(req.params.index);

  const { rows } = await pool.query('SELECT mcqs FROM flash_news WHERE id=$1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'আইটেম পাওয়া যায়নি' });

  const mcqs = rows[0].mcqs || [];
  const mcq = mcqs[index];
  if (!mcq) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });

  const isCorrect = parseInt(answer) === mcq.correct_index;

  if (req.user) {
    await pool.query(
      `INSERT INTO flash_news_answers (user_id, flash_news_id, mcq_index, is_correct)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, flash_news_id, mcq_index)
       DO UPDATE SET is_correct = EXCLUDED.is_correct, answered_at = NOW()`,
      [req.user.id, req.params.id, index, isCorrect]
    );
  }

  res.json({ correct: isCorrect, correct_index: mcq.correct_index, explanation: mcq.explanation || null });
}));

module.exports = router;
