const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { loginLimiter } = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const { JWT_SECRET } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const { runSeed } = require('../scripts/seedStudyPlan');

// POST /api/admin/login
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ইউজারনেম ও পাসওয়ার্ড দিন' });

  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
  if (rows.length === 0) return res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });

  const token = jwt.sign(
    { id: rows[0].id, username: rows[0].username, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, username: rows[0].username });
}));

// POST /api/admin/seed-study-plan — runs the same logic as
// `node scripts/seedStudyPlan.js`, exposed over HTTP because the free
// Render plan has no Shell access to run the script directly. Safe to call
// more than once (wipes and rebuilds only 'bcs-200' and 'job-solution').
router.post('/seed-study-plan', requireAdmin, asyncHandler(async (req, res) => {
  const result = await runSeed(pool);
  res.json(result);
}));

module.exports = router;
