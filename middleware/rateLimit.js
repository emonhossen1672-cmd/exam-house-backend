// middleware/rateLimit.js — request-rate guards against brute-force and spam.
// Each limiter counts requests per IP within a time window; once the max is
// hit, further requests get a 429 response until the window resets.
const rateLimit = require('express-rate-limit');

// Safety net for all /api/* traffic in general.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেক বেশি রিকোয়েস্ট হয়েছে — একটু পরে আবার চেষ্টা করুন' }
});

// Strict limiter for login endpoints (student + admin) — blocks password brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেকবার লগইন চেষ্টা করা হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন' }
});

// IP-level limiter for OTP requests — on top of the phone-level limit already
// inside auth.routes.js, so one IP can't cycle through many phone numbers either.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেকবার চেষ্টা করা হয়েছে — কিছুক্ষণ পর আবার চেষ্টা করুন' }
});

// Limiter for exam result submissions — slows down scripted/spam submissions.
const submitLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেক বেশি সাবমিশন হয়েছে — একটু পরে আবার চেষ্টা করুন' }
});

module.exports = { generalLimiter, loginLimiter, otpLimiter, submitLimiter };
