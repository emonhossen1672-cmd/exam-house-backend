// routes/internal.routes.js — one endpoint, hit by an external cron service,
// that runs every background scheduler's "check now" function directly.
//
// WHY THIS EXISTS: services/reminderScheduler.js, dailyQuizPush.js,
// examTemplateScheduler.js, and routineExamScheduler.js all run on
// setInterval inside this same web process. That's fine on an always-on
// server, but on a Render FREE web service the process spins down after
// ~15 minutes of no incoming HTTP requests — so a reminder/push/template
// that comes due while the app is asleep just waits until some student's
// request happens to wake it back up. That's silent and unpredictable: a
// student who set an exam reminder shouldn't miss it because nobody else
// visited the site in the last hour.
//
// FIX: point a free external cron (e.g. cron-job.org, UptimeRobot, or
// Render's own paid Cron Jobs) at this endpoint every 5 minutes. Each hit
// is a real HTTP request, so it (a) keeps the free instance awake and
// (b) runs all four due-checks immediately, instead of waiting on organic
// traffic or the in-process interval's next tick after a cold start.
//
// SETUP:
//   1. Set CRON_SECRET to some random string in Render's Environment tab.
//   2. On cron-job.org (or similar), create a job that sends:
//        POST https://exam-house-api.onrender.com/api/internal/tick
//        Header: x-cron-secret: <the same random string>
//      every 5 minutes.
// If CRON_SECRET is never set, this route just returns 503 — the existing
// in-process setInterval scheduling (started in server.js) keeps running
// regardless, so nothing breaks by leaving this unconfigured.
const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { CRON_SECRET } = require('../config');

const { sendDueReminders } = require('../services/reminderScheduler');
const { maybeSendDailyPush } = require('../services/dailyQuizPush');
const { runDueTemplates } = require('../services/examTemplateScheduler');
const { runDueRoutineExams } = require('../services/routineExamScheduler');

function requireCronSecret(req, res, next) {
  if (!CRON_SECRET) {
    return res.status(503).json({ error: 'CRON_SECRET সেট করা নেই — Render Environment ট্যাবে যোগ করুন' });
  }
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (provided !== CRON_SECRET) {
    return res.status(401).json({ error: 'ভুল বা অনুপস্থিত cron secret' });
  }
  next();
}

// POST (or GET, for cron services that only support GET pings) — runs all
// four schedulers' "check what's due right now" logic once, sequentially.
// Each function already catches and logs its own errors internally, so one
// failing check never stops the others from running.
router.post('/tick', requireCronSecret, asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  await sendDueReminders();
  await maybeSendDailyPush();
  await runDueTemplates();
  await runDueRoutineExams();
  res.json({ ok: true, ranMs: Date.now() - startedAt, at: new Date().toISOString() });
}));
router.get('/tick', requireCronSecret, asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  await sendDueReminders();
  await maybeSendDailyPush();
  await runDueTemplates();
  await runDueRoutineExams();
  res.json({ ok: true, ranMs: Date.now() - startedAt, at: new Date().toISOString() });
}));

module.exports = router;
