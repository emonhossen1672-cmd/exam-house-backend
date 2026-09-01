// Load and validate required env vars FIRST — this exits the process
// immediately with a clear message if JWT_SECRET / ADMIN_PASSWORD aren't set,
// instead of silently running with insecure defaults.
require('./config');

const express = require('express');
const cors = require('cors');
const path = require('path');

const { generalLimiter } = require('./middleware/rateLimit');

const app = express();

// Render sits in front of this app behind a reverse proxy, which adds an
// X-Forwarded-For header on every request. Without telling Express it's
// behind a trusted proxy, express-rate-limit can't safely determine the
// real client IP and throws (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR), crashing
// every /api/ request. '1' = trust exactly one hop (Render's own proxy).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// main student-facing website — served at "/"
app.use(express.static(path.join(__dirname, 'public-site')));

// admin panel — served at "/admin"
app.use('/admin', express.static(path.join(__dirname, 'public')));

// general safety-net rate limit for all API traffic; stricter per-route
// limiters (login, OTP, submissions) are applied inside their own route files
app.use('/api/', generalLimiter);

app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'Exam House API' });
});

app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/bulk-upload', require('./routes/bulkUpload.routes'));
app.use('/api/questions', require('./routes/questions.routes'));
app.use('/api/exams', require('./routes/exams.routes'));
app.use('/api/results', require('./routes/results.routes'));
app.use('/api/bookmarks', require('./routes/bookmarks.routes'));
app.use('/api/reports', require('./routes/reports.routes'));
app.use('/api/syllabus', require('./routes/syllabus.routes'));
app.use('/api/duels', require('./routes/duels.routes'));
app.use('/api/push', require('./routes/push.routes'));

// ----- 404 handler — any /api/* route that didn't match above -----
app.use('/api/', (req, res) => {
  res.status(404).json({ error: 'এই এপিআই পাওয়া যায়নি' });
});

// ----- Global error handler -----
// Catches any error passed to next(err) — including every error forwarded by
// asyncHandler() in the route files — so a DB failure or bug returns a clean
// JSON 500 instead of hanging the request or crashing the process.
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'সার্ভার সমস্যা হয়েছে, একটু পরে আবার চেষ্টা করুন' });
});

const PORT = process.env.PORT || 4000;

const autoInit = require('./autoInit');
const { startReminderScheduler } = require('./services/reminderScheduler');
const { startDailyQuizPush } = require('./services/dailyQuizPush');
autoInit().finally(() => {
  app.listen(PORT, () => console.log(`Exam House API running on port ${PORT}`));
  startReminderScheduler();
  startDailyQuizPush();
});

// ----- Process-level safety nets -----
// If something still slips through as a truly unhandled rejection/exception,
// log it instead of letting the process die silently (or crash-loop on Render
// without a useful log message).
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});
