const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendSMS } = require('../services/sms');
const { verifyGoogleToken, isConfigured: googleConfigured } = require('../services/google');
const { loginLimiter, otpLimiter } = require('../middleware/rateLimit');
const { JWT_SECRET, IS_PRODUCTION, STUDENT_ID_PREFIX } = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const { levelProgress } = require('../utils/leveling');

const PHONE_RE = /^01[3-9]\d{8}$/; // Bangladeshi mobile number
const OTP_TTL_MINUTES = 5;
const OTP_MAX_PER_WINDOW = 3;   // max OTP requests per phone per window
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;     // max wrong-code tries per OTP row
const OTP_VERIFIED_VALID_MINUTES = 15; // how long a verified OTP stays usable for register
// Referral bonuses — added on top of the base free-trial exam count in
// utils/packageAccess.js (trial_bonus_exams column). Referee gets a small
// welcome bonus for signing up via a code; the referrer gets the bigger
// bonus since they're doing the inviting, per product decision.
const REFERRAL_BONUS_REFEREE = 5;
const REFERRAL_BONUS_REFERRER = 10;

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
  // Dev-mode convenience only: when no real SMS gateway is configured AND
  // we're not running in production, echo the code back so the flow can be
  // tested without an actual phone. Gated on NODE_ENV so a forgotten
  // SMS_API_URL in production fails loudly (broken OTP flow) instead of
  // silently leaking every OTP code in the API response.
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

// POST /api/auth/register — requires a phone already verified via /otp/verify.
// Optional body field `ref`: another student's referral_code. If it matches,
// both accounts get a free-trial bonus (see utils/packageAccess.js) — an
// invalid/unknown code is ignored rather than rejecting the registration.
router.post('/register', asyncHandler(async (req, res) => {
  const { name, phone, password, ref } = req.body;
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
    // Assign the profile screen's public student ID (e.g. "EH1024") and this
    // account's own shareable referral code (e.g. "EHR1024") now that we
    // have the new row's id to base both on.
    const studentCode = `${STUDENT_ID_PREFIX}${1000 + rows[0].id}`;
    const referralCode = `${STUDENT_ID_PREFIX}R${1000 + rows[0].id}`;
    await client.query('UPDATE users SET student_code=$1, referral_code=$2 WHERE id=$3', [studentCode, referralCode, rows[0].id]);

    // If they signed up with a friend's referral code, credit both accounts
    // with bonus free-trial exams. An unrecognized code is silently ignored
    // — this shouldn't block registration.
    if (ref) {
      const refRes = await client.query('SELECT id FROM users WHERE referral_code=$1', [String(ref).trim().toUpperCase()]);
      if (refRes.rows.length) {
        const referrerId = refRes.rows[0].id;
        await client.query(
          'UPDATE users SET referred_by=$1, trial_bonus_exams = trial_bonus_exams + $2 WHERE id=$3',
          [referrerId, REFERRAL_BONUS_REFEREE, rows[0].id]
        );
        await client.query(
          'UPDATE users SET trial_bonus_exams = trial_bonus_exams + $1 WHERE id=$2',
          [REFERRAL_BONUS_REFERRER, referrerId]
        );
      }
    }

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
      // Same public student ID + referral code as phone registration (see
      // /register above). Google sign-up has no referral-code input field
      // today, so this just makes sure the account has one to share later.
      const studentCode = `${STUDENT_ID_PREFIX}${1000 + user.id}`;
      const referralCode = `${STUDENT_ID_PREFIX}R${1000 + user.id}`;
      await pool.query('UPDATE users SET student_code=$1, referral_code=$2 WHERE id=$3', [studentCode, referralCode, user.id]);
      user.student_code = studentCode;
    }
  }

  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: 'user' }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, avatar_url: user.avatar_url } });
}));

// POST /api/auth/reset-password — body: { phone, code, new_password }
// Requires a fresh, correct OTP for purpose 'reset_password' (checked directly
// here, same as /otp/verify, so this can be a single-step flow from the app).
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

// GET /api/auth/me — current logged-in student's full profile, matching the
// redesigned profile screen: identity/badge info, Level+Points progress,
// placeholder active package, and lifetime exam stats (Total Exam / Passed /
// Questions / Right / Wrong / Unanswered).
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT current_streak, longest_streak, email, avatar_url, created_at,
      student_code, study_group, preparing_for, points, google_id, phone_verified,
      active_package_name, active_package_expires_at, referral_code
     FROM users WHERE id=$1`,
    [req.user.id]
  );
  const info = rows[0] || {};

  const statsRes = await pool.query(
    `SELECT
      COUNT(*)::int AS total_exam,
      COUNT(*) FILTER (WHERE score >= 40)::int AS total_passed,
      COALESCE(SUM(correct_count + wrong_count + skipped_count), 0)::int AS total_questions,
      COALESCE(SUM(correct_count), 0)::int AS total_right,
      COALESCE(SUM(wrong_count), 0)::int AS total_wrong,
      COALESCE(SUM(skipped_count), 0)::int AS total_unanswered
     FROM results WHERE user_id=$1`,
    [req.user.id]
  );
  const stats = statsRes.rows[0];

  res.json({
    id: req.user.id, name: req.user.name, phone: req.user.phone,
    student_code: info.student_code || null,
    email: info.email || null, avatar_url: info.avatar_url || null,
    member_since: info.created_at || null,
    study_group: info.study_group || null,
    preparing_for: info.preparing_for || null,
    login_method: info.google_id ? 'Google' : 'Mobile',
    verified: !!(info.phone_verified || info.google_id),
    current_streak: info.current_streak || 0, longest_streak: info.longest_streak || 0,
    ...levelProgress(info.points || 0),
    points: info.points || 0,
    active_package: info.active_package_name
      ? { name: info.active_package_name, expires_at: info.active_package_expires_at }
      : null,
    referral_code: info.referral_code || null,
    stats
  });
}));

// PATCH /api/auth/me — lets a student edit the fields shown on their own
// profile screen ("Edit Profile" button). Only these three are editable
// here; phone/email changes go through their own verified flows.
router.patch('/me', requireUser, asyncHandler(async (req, res) => {
  const { name, study_group, preparing_for } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name=$${i++}`); values.push(name); }
  if (study_group !== undefined) { fields.push(`study_group=$${i++}`); values.push(study_group || null); }
  if (preparing_for !== undefined) { fields.push(`preparing_for=$${i++}`); values.push(preparing_for || null); }

  if (!fields.length) return res.status(400).json({ error: 'কোনো পরিবর্তনযোগ্য তথ্য দেওয়া হয়নি' });

  values.push(req.user.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id=$${i} RETURNING name, study_group, preparing_for`,
    values
  );
  res.json(rows[0]);
}));

module.exports = router;
