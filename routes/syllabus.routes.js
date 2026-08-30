const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

// ===== Admin: manage the syllabus topic list =====

// GET /api/syllabus/admin/list?ministry_id=&grade= — every topic in this
// scope, for the admin edit screen.
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade } = req.query;
  const clauses = [];
  const params = [];
  if (ministry_id) { params.push(ministry_id); clauses.push(`ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`grade = $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT * FROM syllabus_topics ${where} ORDER BY subject, position, id`,
    params
  );
  res.json(rows);
}));

// POST /api/syllabus — add a single topic
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, position } = req.body;
  if (!subject || !topic) return res.status(400).json({ error: 'বিষয় ও টপিক দিন' });
  const { rows } = await pool.query(
    `INSERT INTO syllabus_topics (ministry_id, grade, subject, topic, position)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ministry_id || null, grade || null, subject, topic, position || 0]
  );
  res.status(201).json(rows[0]);
}));

// POST /api/syllabus/bulk — add many topics at once (one line per topic),
// so a full subject syllabus can be pasted in and added in one go.
// body: { ministry_id, grade, subject, topics: ["টপিক ১", "টপিক ২", ...] }
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topics } = req.body;
  if (!subject || !Array.isArray(topics) || !topics.length) {
    return res.status(400).json({ error: 'বিষয় ও টপিক তালিকা প্রয়োজন' });
  }

  const client = await pool.connect();
  let added = 0;
  try {
    await client.query('BEGIN');
    const startRes = await client.query(
      `SELECT COALESCE(MAX(position), 0) AS m FROM syllabus_topics
       WHERE ministry_id IS NOT DISTINCT FROM $1 AND grade IS NOT DISTINCT FROM $2 AND subject=$3`,
      [ministry_id || null, grade || null, subject]
    );
    let pos = startRes.rows[0].m;
    for (const t of topics) {
      const text = String(t || '').trim();
      if (!text) continue;
      pos += 1;
      await client.query(
        `INSERT INTO syllabus_topics (ministry_id, grade, subject, topic, position) VALUES ($1,$2,$3,$4,$5)`,
        [ministry_id || null, grade || null, subject, text, pos]
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
  res.json({ added });
}));

// PUT /api/syllabus/:id — edit a topic
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, position } = req.body;
  if (!subject || !topic) return res.status(400).json({ error: 'বিষয় ও টপিক দিন' });
  const { rows } = await pool.query(
    `UPDATE syllabus_topics SET ministry_id=$1, grade=$2, subject=$3, topic=$4, position=$5
     WHERE id=$6 RETURNING *`,
    [ministry_id || null, grade || null, subject, topic, position || 0, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'টপিক পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/syllabus/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM syllabus_topics WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ===== Student side =====

// GET /api/syllabus/public?ministry_id=&grade= — topics grouped by subject,
// each marked completed/not for the logged-in user (or all false for a
// guest — still viewable without login, just not checkable).
router.get('/public', optionalUser, asyncHandler(async (req, res) => {
  const { ministry_id, grade } = req.query;
  if (!ministry_id || !grade) {
    return res.status(400).json({ error: 'ministry_id ও grade প্রয়োজন' });
  }
  const userId = req.user ? req.user.id : null;
  const { rows } = await pool.query(
    `SELECT st.id, st.subject, st.topic, st.position,
       (usp.topic_id IS NOT NULL) AS completed
     FROM syllabus_topics st
     LEFT JOIN user_syllabus_progress usp ON usp.topic_id = st.id AND usp.user_id = $3
     WHERE st.ministry_id=$1 AND st.grade=$2
     ORDER BY st.subject, st.position, st.id`,
    [ministry_id, grade, userId]
  );

  const bySubject = {};
  for (const r of rows) {
    if (!bySubject[r.subject]) bySubject[r.subject] = [];
    bySubject[r.subject].push(r);
  }
  const total = rows.length;
  const done = rows.filter(r => r.completed).length;
  res.json({
    subjects: bySubject,
    total_topics: total,
    completed_topics: done,
    percent: total ? Math.round((done / total) * 10000) / 100 : 0
  });
}));

// POST /api/syllabus/:id/toggle — mark a topic done/undone for the logged-in
// user. Toggling, not separate mark/unmark endpoints, since the frontend
// checkbox only ever needs to flip the current state.
router.post('/:id/toggle', requireUser, asyncHandler(async (req, res) => {
  const topicId = req.params.id;
  const existing = await pool.query(
    'SELECT 1 FROM user_syllabus_progress WHERE user_id=$1 AND topic_id=$2',
    [req.user.id, topicId]
  );
  if (existing.rows.length) {
    await pool.query('DELETE FROM user_syllabus_progress WHERE user_id=$1 AND topic_id=$2', [req.user.id, topicId]);
    return res.json({ completed: false });
  }
  await pool.query(
    'INSERT INTO user_syllabus_progress (user_id, topic_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.user.id, topicId]
  );
  res.json({ completed: true });
}));

// GET /api/syllabus/me/summary — this user's completion % across every
// ministry+grade that has a syllabus defined, for a "your progress" overview.
router.get('/me/summary', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT st.ministry_id, m.name AS ministry_name, st.grade,
      COUNT(*)::int AS total_topics,
      COUNT(usp.topic_id)::int AS completed_topics
    FROM syllabus_topics st
    LEFT JOIN ministries m ON m.id = st.ministry_id
    LEFT JOIN user_syllabus_progress usp ON usp.topic_id = st.id AND usp.user_id = $1
    GROUP BY st.ministry_id, m.name, st.grade
    ORDER BY m.name, st.grade
  `, [req.user.id]);
  res.json(rows.map(r => ({
    ...r,
    percent: r.total_topics ? Math.round((r.completed_topics / r.total_topics) * 10000) / 100 : 0
  })));
}));

module.exports = router;
