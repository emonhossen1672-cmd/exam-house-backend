// routes/flashNews.routes.js — short image-card current-affairs feed for
// the home screen's horizontal scroll strip (see Chorcha Jobs screenshot).
// Kept deliberately separate from routes/notices.routes.js — see the
// flash_news table comment in schema.sql for why.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/flash-news — public feed, active items only, newest first.
router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const { rows } = await pool.query(
    `SELECT id, title, body, image_url, source_url, created_at
       FROM flash_news
      WHERE is_active = true
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json({ flash_news: rows });
}));

// GET /api/flash-news/admin/list — admin sees inactive items too.
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM flash_news ORDER BY created_at DESC');
  res.json({ flash_news: rows });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, body, image_url, source_url } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'টাইটেল দিন' });

  const { rows } = await pool.query(
    `INSERT INTO flash_news (title, body, image_url, source_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [title.trim(), body || null, image_url || null, source_url || null]
  );
  res.json({ flash_news: rows[0] });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { title, body, image_url, source_url } = req.body;
  const { rows } = await pool.query(
    `UPDATE flash_news SET title=$1, body=$2, image_url=$3, source_url=$4
     WHERE id=$5 RETURNING *`,
    [title, body || null, image_url || null, source_url || null, req.params.id]
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

module.exports = router;
