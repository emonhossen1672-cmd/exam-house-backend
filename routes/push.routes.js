const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const push = require('../services/push');

// GET /api/push/public/vapid-key — the browser needs this to call
// PushManager.subscribe(). Public because it's not a secret — it's meant to
// be shipped to every client, same as any other VAPID public key.
router.get('/public/vapid-key', (req, res) => {
  if (!push.isConfigured) return res.status(503).json({ error: 'পুশ নোটিফিকেশন এখনো চালু করা হয়নি' });
  res.json({ publicKey: push.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — save (or refresh) this browser's push
// subscription for the logged-in student. ON CONFLICT lets the same browser
// re-subscribe (e.g. after clearing site data) without a duplicate-key error,
// and re-attaches it to whichever user is currently logged in.
router.post('/subscribe', requireUser, asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'সাবস্ক্রিপশন তথ্য অসম্পূর্ণ' });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ ok: true });
}));

// POST /api/push/unsubscribe — called when the student turns notifications
// off in-app (unsubscribing the browser itself happens client-side first).
router.post('/unsubscribe', requireUser, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint প্রয়োজন' });
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
  res.json({ ok: true });
}));

// PUT /api/push/daily-quiz-opt-in — turns the daily "আজকের কুইজ" push blast
// on/off for this student (services/dailyQuizPush.js reads this flag).
router.put('/daily-quiz-opt-in', requireUser, asyncHandler(async (req, res) => {
  const optIn = Boolean(req.body.opt_in);
  await pool.query('UPDATE users SET push_daily_quiz_opt_in=$1 WHERE id=$2', [optIn, req.user.id]);
  res.json({ ok: true, opt_in: optIn });
}));

// GET /api/push/settings — current notification prefs, so the profile
// screen's toggle can render its actual state on load.
router.get('/settings', requireUser, asyncHandler(async (req, res) => {
  const userRes = await pool.query('SELECT push_daily_quiz_opt_in FROM users WHERE id=$1', [req.user.id]);
  const subRes = await pool.query('SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  res.json({
    daily_quiz_opt_in: userRes.rows[0] ? userRes.rows[0].push_daily_quiz_opt_in : false,
    subscribed_devices: subRes.rows[0].count
  });
}));

// POST /api/push/test — sends a test push to every device this student is
// subscribed on, so the "নোটিফিকেশন চালু করুন" toggle can confirm it worked.
router.post('/test', requireUser, asyncHandler(async (req, res) => {
  const result = await push.sendToUser(req.user.id, {
    title: 'Exam House 🔔',
    body: 'নোটিফিকেশন চালু আছে! পরীক্ষার আগে এখানেই মনে করিয়ে দেব।',
    url: '/'
  });
  res.json({ ok: true, ...result });
}));

module.exports = router;
