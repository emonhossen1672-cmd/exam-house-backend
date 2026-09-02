const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendSMS } = require('../services/sms');
const { verifyGoogleToken, isConfigured: googleConfigured } = require('../services/google');
const { loginLimiter, otpLimiter } = require('../middleware/rateLimit');
const { JWT_SECRET, IS_PRODUCTION } = require('../config');
const asyncHandler = require('../utils/asyncHandler');

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
const OTP_PURPOSES = ['register', 'reset_password', 'login'];

router.post('/otp/send', otpLimiter, asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const purpose = OTP_PURPOSES.includes(req.body.purpose) ? req.body.purpose : 'register';

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
  if (smsResult.dev && !IS_PRODUCTION) response.dev_code = code;
  res.json(response);
}));

// POST /api/auth/otp/verify — body: { phone, code, purpose? }
router.post('/otp/verify', asyncHandler(async (req, res) => {
  const { phone, code } = req.body;
  const purpose = OTP_PURPOSES.includes(req.body.purpose) ? req.body.purpose : 'register';
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
}));

// POST /api/auth/register — requires a phone already verified via /otp/verify
router.post('/register', asyncHandler(async (req, res) => {
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
    const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, JWT_SECRET, { expiresIn: '90d' });
    res.status(201).json({ token, user });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// POST /api/auth/login
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'মোবাইল নম্বর ও পাসওয়ার্ড দিন' });

  const { rows } = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
  if (!rows.length) return res.status(401).json({ error: 'ভুল মোবাইল নম্বর বা পাসওয়ার্ড' });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'ভুল মোবাইল নম্বর বা পাসওয়ার্ড' });

  const token = jwt.sign({ id: rows[0].id, name: rows[0].name, phone: rows[0].phone, role: 'user' }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ token, user: { id: rows[0].id, name: rows[0].name, phone: rows[0].phone } });
}));

// POST /api/auth/login-otp — passwordless login. Call /api/auth/otp/send with
// purpose:'login' first to get a code, then this to exchange it for a token.
router.post('/login-otp', loginLimiter, asyncHandler(async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'মোবাইল নম্বর ও কোড দিন' });

  const { rows } = await pool.query(
    `SELECT * FROM otp_codes
     WHERE phone=$1 AND purpose='login' AND expires_at > NOW() AND consumed_at IS NULL
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

  const userRes = await pool.query('SELECT id, name, phone FROM users WHERE phone=$1', [phone]);
  if (!userRes.rows.length) return res.status(404).json({ error: 'এই মোবাইল নম্বরে কোনো অ্যাকাউন্ট নেই' });
  const user = userRes.rows[0];

  await pool.query('UPDATE otp_codes SET verified_at = NOW(), consumed_at = NOW() WHERE id=$1', [otp.id]);
  await pool.query('UPDATE users SET phone_verified = true WHERE id=$1', [user.id]);

  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ token, user });
}));

// POST /api/auth/google — body: { credential }  (the ID token Google's Sign
// In button hands back on the frontend). Verifies it against Google's own
// keys, then finds a matching account by google_id, links an existing
// account with the same email, or creates a brand-new one. New Google
// accounts have no phone number yet — that's fine, phone stays nullable
// (see schema.sql) and the person can add it later from their profile.
router.post('/google', asyncHandler(async (req, res) => {
  if (!googleConfigured) {
    return res.status(500).json({ error: 'গুগল সাইন-ইন এখনো সেটআপ করা হয়নি — কিছুক্ষণ পর আবার চেষ্টা করুন' });
  }
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'গুগল টোকেন পাওয়া যায়নি' });

  let payload;
  try {
    payload = await verifyGoogleToken(credential);
  } catch (err) {
    return res.status(401).json({ error: 'গুগল সাইন-ইন যাচাই ব্যর্থ হয়েছে' });
  }

  const { sub: googleId, email, name, picture } = payload;
  if (!email) return res.status(400).json({ error: 'গুগল অ্যাকাউন্টে ইমেইল পাওয়া যায়নি' });

  let user;
  const byGoogleId = await pool.query('SELECT * FROM users WHERE google_id=$1', [googleId]);
  if (byGoogleId.rows.length) {
    user = byGoogleId.rows[0];
  } else {
    const byEmail = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (byEmail.rows.length) {
      const updated = await pool.query(
        'UPDATE users SET google_id=$1, avatar_url=COALESCE(avatar_url,$2) WHERE id=$3 RETURNING *',
        [googleId, picture || null, byEmail.rows[0].id]
      );
      user = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (name, email, google_id, avatar_url, phone_verified)
         VALUES ($1,$2,$3,$4,false) RETURNING *`,
        [name || 'শিক্ষার্থী', email, googleId, picture || null]
      );
      user = inserted.rows[0];
    }
  }

  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, avatar_url: user.avatar_url } });
}));

// POST /api/auth/reset-password — body: { phone, code, new_password }
router.post('/reset-password', asyncHandler(async (req, res) => {
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
}));

// GET /api/auth/me — current logged-in student's profile
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT current_streak, longest_streak, email, avatar_url FROM users WHERE id=$1',
    [req.user.id]
  );
  const info = rows[0] || {};
  res.json({
    id: req.user.id, name: req.user.name, phone: req.user.phone,
    email: info.email || null, avatar_url: info.avatar_url || null,
    current_streak: info.current_streak || 0, longest_streak: info.longest_streak || 0
  });
}));

module.exports = router;
