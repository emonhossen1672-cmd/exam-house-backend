const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireUser } = require('../middleware/auth');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'নাম, মোবাইল নম্বর ও পাসওয়ার্ড দিন' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'এই মোবাইল নম্বর দিয়ে আগেই অ্যাকাউন্ট আছে — লগইন করুন' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (name, phone, password_hash) VALUES ($1,$2,$3) RETURNING id, name, phone',
    [name, phone, hash]
  );
  const user = rows[0];
  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, SECRET, { expiresIn: '90d' });
  res.status(201).json({ token, user });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'মোবাইল নম্বর ও পাসওয়ার্ড দিন' });

  const { rows } = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
  if (!rows.length) return res.status(401).json({ error: 'ভুল মোবাইল নম্বর বা পাসওয়ার্ড' });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'ভুল মোবাইল নম্বর বা পাসওয়ার্ড' });

  const token = jwt.sign({ id: rows[0].id, name: rows[0].name, phone: rows[0].phone, role: 'user' }, SECRET, { expiresIn: '90d' });
  res.json({ token, user: { id: rows[0].id, name: rows[0].name, phone: rows[0].phone } });
});

// GET /api/auth/me — current logged-in student's profile
router.get('/me', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT current_streak, longest_streak FROM users WHERE id=$1',
    [req.user.id]
  );
  const streak = rows[0] || { current_streak: 0, longest_streak: 0 };
  res.json({
    id: req.user.id, name: req.user.name, phone: req.user.phone,
    current_streak: streak.current_streak, longest_streak: streak.longest_streak
  });
});

module.exports = router;
