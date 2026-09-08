const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/notices — public list for the student site's floating bell
// overlay. Pinned notices always float to the top, then newest first.
// Also returns latest_id so the frontend can compare it against the
// last-seen id it keeps in localStorage to decide whether to show the
// unread badge, without needing a per-user read-tracking table.
router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const { rows } = await pool.query(
    `SELECT id, title, body, is_pinned, created_at
       FROM notices
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT $1`,
    [limit]
  );
  const latestIdResult = await pool.query('SELECT COALESCE(MAX(id), 0) AS latest_id FROM notices');
  res.json({ notices: rows, latest_id: latestIdResult.rows[0].latest_id });
}));

// POST /api/notices — admin only, create a new notice.
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, body, is_pinned } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'টাইটেল দিন' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'বিস্তারিত লিখুন' });

  const { rows } = await pool.query(
    `INSERT INTO notices (title, body, is_pinned)
     VALUES ($1, $2, $3)
     RETURNING id, title, body, is_pinned, created_at`,
    [title.trim(), body.trim(), !!is_pinned]
  );
  res.json({ notice: rows[0] });
}));

// PATCH /api/notices/:id/pin — admin only, toggle pinned state.
router.patch('/:id/pin', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE notices SET is_pinned = NOT is_pinned WHERE id=$1
     RETURNING id, title, body, is_pinned, created_at`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'নোটিশ পাওয়া যায়নি' });
  res.json({ notice: rows[0] });
}));

// DELETE /api/notices/:id — admin only.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM notices WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'নোটিশ পাওয়া যায়নি' });
  res.json({ success: true });
}));

module.exports = router;
