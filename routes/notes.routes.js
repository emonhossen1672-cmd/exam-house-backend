// routes/notes.routes.js — লেকচার নোট / ই-বুক লাইব্রেরি.
// Files themselves are uploaded separately via POST /api/upload/note
// (admin-only, returns a Cloudinary URL) — this router just stores/serves
// the metadata rows that point at those URLs.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getActivePackage } = require('../utils/packageAccess');

// GET /api/notes?ministry_id=&subject=&search=&limit=&offset=
// Public list — logged out or logged in, everyone sees every note's title/
// description/thumbnail. Premium ones just don't include file_url unless
// the requester has an active package (checked per-request below), so the
// frontend can show a 🔒 badge without a second round trip.
router.get('/', optionalUser, asyncHandler(async (req, res) => {
  const { ministry_id, subject, search } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const offset = parseInt(req.query.offset) || 0;

  const params = [];
  const clauses = [];
  if (ministry_id) { params.push(ministry_id); clauses.push(`n.ministry_id = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`n.subject = $${params.length}`); }
  if (search) { params.push(`%${search}%`); clauses.push(`n.title ILIKE $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT n.id, n.title, n.subject, n.description, n.thumbnail_url, n.is_premium,
            n.view_count, n.created_at, m.name AS ministry_name
       FROM notes n
       LEFT JOIN ministries m ON m.id = n.ministry_id
       ${where}
      ORDER BY n.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // has_access is computed once per request (not per row) — a single
  // package covers every premium note, unlike exam quotas which are
  // per-exam-type. Guests (no req.user) never have access.
  let hasAccess = false;
  if (req.user) {
    const pkg = await getActivePackage(req.user.id);
    hasAccess = !!pkg;
  }

  const notes = rows.map((n) => ({ ...n, locked: n.is_premium && !hasAccess }));
  res.json({ notes });
}));

// GET /api/notes/:id — increments view_count on every fetch (simple
// popularity signal, no per-user dedupe table needed for this feature).
// Returns file_url only when the note is free, or premium+the requester
// has an active package; otherwise omits file_url and sets locked:true
// with a Bangla reason, same shape as checkExamAccess()'s denial message.
router.get('/:id', optionalUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.*, m.name AS ministry_name FROM notes n
     LEFT JOIN ministries m ON m.id = n.ministry_id
     WHERE n.id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'নোট পাওয়া যায়নি' });
  const note = rows[0];

  let hasAccess = !note.is_premium;
  if (note.is_premium && req.user) {
    const pkg = await getActivePackage(req.user.id);
    hasAccess = !!pkg;
  }

  if (!hasAccess) {
    delete note.file_url;
    return res.json({
      note: { ...note, locked: true },
      reason: req.user
        ? 'এই নোটটি প্রিমিয়াম — পড়তে হলে একটি প্যাকেজ কিনুন।'
        : 'এই নোটটি প্রিমিয়াম — দেখতে হলে লগইন করে একটি প্যাকেজ কিনুন।'
    });
  }

  await pool.query('UPDATE notes SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
  res.json({ note: { ...note, locked: false } });
}));

// ===================== Admin =====================

// GET /api/notes/admin/list — admin sees everything, file_url included,
// no premium gating.
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.*, m.name AS ministry_name FROM notes n
     LEFT JOIN ministries m ON m.id = n.ministry_id
     ORDER BY n.created_at DESC`
  );
  res.json({ notes: rows });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { title, ministry_id, subject, description, file_url, thumbnail_url, is_premium } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'টাইটেল দিন' });
  if (!file_url || !file_url.trim()) return res.status(400).json({ error: 'ফাইল আপলোড করুন (file_url প্রয়োজন)' });

  const { rows } = await pool.query(
    `INSERT INTO notes (title, ministry_id, subject, description, file_url, thumbnail_url, is_premium)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title.trim(), ministry_id || null, subject || null, description || null,
     file_url.trim(), thumbnail_url || null, !!is_premium]
  );
  res.json({ note: rows[0] });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { title, ministry_id, subject, description, file_url, thumbnail_url, is_premium } = req.body;
  const { rows } = await pool.query(
    `UPDATE notes SET title=$1, ministry_id=$2, subject=$3, description=$4,
            file_url=$5, thumbnail_url=$6, is_premium=$7
     WHERE id=$8 RETURNING *`,
    [title, ministry_id || null, subject || null, description || null,
     file_url, thumbnail_url || null, !!is_premium, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'নোট পাওয়া যায়নি' });
  res.json({ note: rows[0] });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM notes WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'নোট পাওয়া যায়নি' });
  res.json({ success: true });
}));

module.exports = router;
