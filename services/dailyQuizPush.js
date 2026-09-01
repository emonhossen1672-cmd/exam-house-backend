// services/dailyQuizPush.js — once a day, pushes a nudge to every student who
// opted in (profile screen toggle, see routes/push.routes.js) telling them
// today's "আজকের কুইজ" is ready. Deliberately does NOT create the daily quiz
// exam itself — GET /api/exams/public/daily-quiz (routes/exams.routes.js)
// already lazily creates it the moment anyone opens the app, so the push
// just needs to know the question bank isn't empty and point students back
// into the app, same as every other notification here.
//
// Runs on the same setInterval-inside-the-web-process approach as
// services/reminderScheduler.js, with the same Render-free-tier caveat noted
// there (an instance asleep past the send hour won't fire until woken by a
// request). daily_push_log (schema.sql) guards against sending twice if the
// process restarts later the same day.
const pool = require('../db');
const push = require('./push');

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes
const SEND_HOUR_UTC = 3; // 03:00 UTC ≈ 09:00 Asia/Dhaka (UTC+6) — a normal study-morning time

async function maybeSendDailyPush() {
  try {
    const nowUtcHour = new Date().getUTCHours();
    if (nowUtcHour < SEND_HOUR_UTC) return;

    const already = await pool.query('SELECT 1 FROM daily_push_log WHERE quiz_date = CURRENT_DATE');
    if (already.rows.length) return;

    const bankRes = await pool.query('SELECT 1 FROM questions LIMIT 1');
    if (!bankRes.rows.length) return; // nothing to quiz on yet

    // Claim today's send slot first (before the (possibly slow) push fan-out)
    // so a second scheduler tick that starts while this one is still running
    // can't also pass the "already sent" check above and double-send.
    await pool.query('INSERT INTO daily_push_log (quiz_date) VALUES (CURRENT_DATE) ON CONFLICT DO NOTHING');

    const { rows: users } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN push_subscriptions ps ON ps.user_id = u.id
       WHERE u.push_daily_quiz_opt_in = true`
    );

    let sent = 0;
    for (const u of users) {
      const result = await push.sendToUser(u.id, {
        title: 'আজকের কুইজ প্রস্তুত 📖',
        body: 'দশটি প্রশ্ন, মাত্র ১৫ মিনিট — আজকের স্ট্রিক ধরে রাখুন!',
        url: '/'
      });
      if (result.sent > 0) sent++;
    }
    console.log(`🔔 Daily quiz push sent to ${sent}/${users.length} opted-in students`);
  } catch (err) {
    console.error('❌ dailyQuizPush failed:', err.message);
  }
}

function startDailyQuizPush() {
  maybeSendDailyPush(); // in case the process was already past SEND_HOUR_UTC when it booted
  setInterval(maybeSendDailyPush, CHECK_INTERVAL_MS);
}

module.exports = { startDailyQuizPush, maybeSendDailyPush };
