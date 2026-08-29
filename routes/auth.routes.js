const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendSMS } = require('../services/sms');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const PHONE_RE = /^01[3-9]\d{8}$/; // Bangladeshi mobile number
const OTP_TTL_MINUTES = 5;
const OTP_MAX_PER_WINDOW = 3;   // max OTP requests per phone per window
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;     // max wrong-code tries per OTP row
const OTP_VERIFIED_VALID_MINUTES = 15; // how long a verified OTP stays usable for register

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// POST /api/auth/otp/send — body: { phone, purpose? }  purpose defaults to 'register'
router.post('/otp/send', async (req, res) => {
  const { phone } = req.body;
  const purpose = req.body.purpose === 'reset_password' ? 'reset_password' : 'register';

  if (!phone || !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)' });
  }

  if (purpose === 'register') {
    const existing = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'এই মোবাইল নম্বর দিয়ে আগেই অ্যাকাউন্ট আছে — লগইন করুন' });
    }
  } else {
    const existing = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'এই মোবাইল নম্বরে কোনো অ্যাকাউন্ট নেই' });
    }
  }

  // basic anti-spam: cap OTP requests per phone within a rolling window
  const recent = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM otp_codes
     WHERE phone=$1 AND purpose=$2 AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [phone, purpose, OTP_WINDOW_MINUTES]
  );
  if (recent.rows[0].cnt >= OTP_MAX_PER_WINDOW) {
    return res.status(429).json({ error: `অনেকবার চেষ্টা করা হয়েছে — ${OTP_WINDOW_MINUTES} মিনিট পর আবার চেষ্টা করুন` });
  }

  const code = genOtp();
  const codeHash = await bcrypt.hash(code, 10);
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, purpose, expires_at)
     VALUES ($1,$2,$3, NOW() + ($4 || ' minutes')::interval)`,
    [phone, codeHash, purpose, OTP_TTL_MINUTES]
  );

  const smsResult = await sendSMS(phone, `আপনার Exam House ভেরিফিকেশন কোড: ${code} — এটি ${OTP_TTL_MINUTES} মিনিটের জন্য বৈধ। কারো সাথে শেয়ার করবেন না।`);

  const response = { ok: true, expires_in_minutes: OTP_TTL_MINUTES };
  // Dev-mode convenience only: when no real SMS gateway is configured, echo the
  // code back so the flow can be tested without an actual phone.
  if (smsResult.dev) response.dev_code = code;
  res.json(response);
});

// POST /api/auth/otp/verify — body: { phone, code, purpose? }
router.post('/otp/verify', async (req, res) => {
  const { phone, code } = req.body;
  const purpose = req.body.purpose === 'reset_password' ? 'reset_password' : 'register';
  if (!phone || !code) return res.status(400).json({ error: 'মোবাইল নম্বর ও কোড দিন' });

  const { rows } = await pool.query(
    `SELECT * FROM otp_codes
     WHERE phone=$1 AND purpose=$2 AND expires_at > NOW() AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose]
  );
  if (!rows.length) {
    return res.status(400).json({ error: 'কোডের মেয়াদ শেষ হয়ে গেছে — নতুন কোড চান' });
  }
  const otp = rows[0];
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'অনেকবার ভুল চেষ্টা — নতুন কোড চান' });
  }

  const match = await bcrypt.compare(String(code), otp.code_hash);
  if (!match) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [otp.id]);
    return res.status(400).json({ error: 'ভুল কোড' });
  }

  await pool.query('UPDATE otp_codes SET verified_at = NOW() WHERE id=$1', [otp.id]);
  res.json({ verified: true });
});

// POST /api/auth/register — requires a phone already verified via /otp/verify
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

  const otpRes = await pool.query(
    `SELECT * FROM otp_codes
     WHERE phone=$1 AND purpose='register' AND verified_at IS NOT NULL AND consumed_at IS NULL
       AND verified_at > NOW() - ($2 || ' minutes')::interval
     ORDER BY verified_at DESC LIMIT 1`,
    [phone, OTP_VERIFIED_VALID_MINUTES]
  );
  if (!otpRes.rows.length) {
    return res.status(400).json({ error: 'প্রথমে মোবাইল নম্বর OTP দিয়ে ভেরিফাই করুন' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      'INSERT INTO users (name, phone, password_hash, phone_verified) VALUES ($1,$2,$3,true) RETURNING id, name, phone',
      [name, phone, hash]
    );
    await client.query('UPDATE otp_codes SET consumed_at = NOW() WHERE id=$1', [otpRes.rows[0].id]);
    await client.query('COMMIT');

    const user = rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, SECRET, { expiresIn: '90d' });
    res.status(201).json({ token, user });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
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

// POST /api/auth/reset-password — body: { phone, code, new_password }
// Requires a fresh, correct OTP for purpose 'reset_password' (checked directly
// here, same as /otp/verify, so this can be a single-step flow from the app).
router.post('/reset-password', async (req, res) => {
  const { phone, code, new_password } = req.body;
  if (!phone || !code || !new_password) {
    return res.status(400).json({ error: 'মোবাইল নম্বর, কোড ও নতুন পাসওয়ার্ড দিন' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  }

  const { rows } = await pool.query(
    `SELECT * FROM otp_codes
     WHERE phone=$1 AND purpose='reset_password' AND expires_at > NOW() AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return res.status(400).json({ error: 'কোডের মেয়াদ শেষ হয়ে গেছে — নতুন কোড চান' });
  const otp = rows[0];
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'অনেকবার ভুল চেষ্টা — নতুন কোড চান' });
  }

  const match = await bcrypt.compare(String(code), otp.code_hash);
  if (!match) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [otp.id]);
    return res.status(400).json({ error: 'ভুল কোড' });
  }

  const userRes = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
  if (!userRes.rows.length) return res.status(404).json({ error: 'এই মোবাইল নম্বরে কোনো অ্যাকাউন্ট নেই' });

  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userRes.rows[0].id]);
  await pool.query('UPDATE otp_codes SET verified_at = NOW(), consumed_at = NOW() WHERE id=$1', [otp.id]);

  res.json({ ok: true });
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
