const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ইউজারনেম ও পাসওয়ার্ড দিন' });

  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
  if (rows.length === 0) return res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });

  const token = jwt.sign(
    { id: rows[0].id, username: rows[0].username },
    process.env.JWT_SECRET || 'dev-secret-change-me',
    { expiresIn: '7d' }
  );
  res.json({ token, username: rows[0].username });
});

module.exports = router;
