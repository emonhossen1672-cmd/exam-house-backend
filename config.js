// config.js — central place for required environment variables.
//
// Previously, JWT_SECRET and ADMIN_PASSWORD silently fell back to hardcoded
// defaults ('dev-secret-change-me', 'changeme123') if the env vars weren't
// set. That's fine for local dev, but dangerous in production: if you forget
// to set them on Render, anyone who reads this public source code could
// forge a valid admin JWT or log in with the default password.
//
// This module makes that impossible to forget silently — the server now
// refuses to start at all if these aren't set, with a clear error message
// telling you exactly what to set and where.
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`\n❌ Missing required environment variable: ${name}`);
    console.error('   Set this in your Render dashboard (Environment tab) — or in a local .env file for dev —');
    console.error('   before starting the server. Refusing to start with an insecure default.\n');
    process.exit(1);
  }
  return value;
}

const JWT_SECRET = required('JWT_SECRET');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = required('ADMIN_PASSWORD');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Optional — "Sign in with Google" only works once this is set (Google Cloud
// Console → APIs & Services → Credentials → OAuth client ID → Web application).
// Left optional (not `required()`) so the server still starts for sites that
// don't want Google sign-in; the /api/auth/google route just returns a clear
// error until it's configured. The same value must also be pasted into
// public-site/index.html (GOOGLE_CLIENT_ID near the top of the <script>).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Optional — powers AI-assisted grading for written (রিটেন) exams
// (services/aiGrading.js). Left optional so the server still starts and
// self_check/manual written exams still work without it; an exam using
// grading_mode='ai' just falls back to leaving submissions 'pending' for a
// human to grade until this is set.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// Optional — powers on-demand AI explanations for MCQ questions
// (services/aiExplanation.js, GET /api/questions/public/:id/explanation).
// Uses Google's Gemini API instead of Anthropic because Gemini has a
// genuinely free tier (no billing/card required) via Google AI Studio
// (aistudio.google.com → "Get API key") — appropriate for this
// low-stakes, rate-limited, cacheable-per-question use case. Left
// optional so the server still starts without it; that route just
// returns a friendly "not configured yet" error until this is set.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Optional — powers real image upload (camera/gallery) for handwritten
// রিটেন answers (services/imageUpload.js + routes/upload.routes.js). Left
// optional so the server still starts without it; /api/upload/image just
// returns a clear error until all three are set, and students can still
// fall back to pasting an image link manually.
// Get these from your free Cloudinary dashboard (cloudinary.com → Console)
// — no code changes needed, just set these 3 env vars on Render.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// Optional — short prefix for the public-facing student ID shown on the
// profile screen (e.g. "EH1024"). Defaults to 'EH' (Exam House) if unset.
const STUDENT_ID_PREFIX = process.env.STUDENT_ID_PREFIX || 'EH';

// Optional — shared secret for POST /api/internal/tick (routes/internal.routes.js).
// All four background schedulers (exam reminders, daily quiz push, exam
// templates, routine exams) run on setInterval inside this same web
// process. On a Render FREE web service the process spins down after ~15
// minutes with no incoming HTTP traffic, so a due reminder/push/template
// just sits there until some student's request happens to wake the app back
// up. Setting CRON_SECRET and pointing a free external cron (e.g.
// cron-job.org, every 5 minutes) at POST /api/internal/tick with header
// `x-cron-secret: <value>` keeps the process awake and runs all four checks
// on a reliable schedule instead of hoping for organic traffic. Left
// optional so the server still starts without it — the route just responds
// 503 until this is set, and the existing in-process intervals keep running
// as a fallback either way.
const CRON_SECRET = process.env.CRON_SECRET || '';

// Optional — manual payment instructions shown to the student on the
// packages screen (routes/packages.routes.js GET /public/payment-info).
// Left optional so the server still starts without these set; the packages
// screen just shows "শীঘ্রই" for manual payment until at least one number is
// configured. Set the *_TYPE to 'personal' or 'merchant' — a merchant bKash
// number needs the student to dial the Payment flow instead of Send Money,
// so the frontend shows different instructions depending on which it is.
const PAYMENT_BKASH_NUMBER = process.env.PAYMENT_BKASH_NUMBER || '';
const PAYMENT_BKASH_TYPE = process.env.PAYMENT_BKASH_TYPE || 'personal';
const PAYMENT_NAGAD_NUMBER = process.env.PAYMENT_NAGAD_NUMBER || '';
const PAYMENT_NAGAD_TYPE = process.env.PAYMENT_NAGAD_TYPE || 'personal';

module.exports = {
  JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, IS_PRODUCTION, GOOGLE_CLIENT_ID,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL, GEMINI_API_KEY, GEMINI_MODEL,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
  STUDENT_ID_PREFIX, CRON_SECRET,
  PAYMENT_BKASH_NUMBER, PAYMENT_BKASH_TYPE, PAYMENT_NAGAD_NUMBER, PAYMENT_NAGAD_TYPE
};
