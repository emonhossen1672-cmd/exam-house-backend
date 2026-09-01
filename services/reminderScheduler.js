// services/reminderScheduler.js — polls for live exams starting soon and
// reminds everyone who opted in via the 🔔 "মনে করিয়ে দিন" button on the site.
// Sends both channels, independently: SMS (if a gateway is configured, see
// services/sms.js) and web push (if this browser/device has a subscription,
// see services/push.js) — a student gets whichever one(s) are actually set
// up for them, neither channel blocks the other.
//
// NOTE on hosting: this runs on a simple setInterval inside the same process
// as the web server — no separate cron service needed, good enough for this
// app's scale. But if this is deployed on a Render FREE web service, the
// instance spins down after ~15 minutes of no incoming requests, and a
// reminder that comes due while it's asleep won't fire until the next
// request wakes it up again. For guaranteed on-time delivery either:
//   (a) upgrade to an always-on (paid) instance, or
//   (b) remove this scheduler and instead call sendDueReminders() from a
//       dedicated route hit by an external cron (e.g. cron-job.org) every
//       few minutes.
const pool = require('../db');
const { sendSMS } = require('./sms');
const push = require('./push');

const CHECK_INTERVAL_MS = 60 * 1000; // check every minute
const REMIND_WINDOW_MINUTES = 30; // send once the exam is due within this many minutes

async function sendDueReminders() {
  try {
    const { rows } = await pool.query(`
      SELECT er.id AS reminder_id, er.user_id, u.phone, u.name, e.title, e.start_time
      FROM exam_reminders er
      JOIN exams e ON e.id = er.exam_id
      JOIN users u ON u.id = er.user_id
      WHERE er.sent_at IS NULL
        AND e.type = 'live'
        AND e.status != 'closed'
        AND e.start_time IS NOT NULL
        AND e.start_time > NOW()
        AND e.start_time <= NOW() + ($1 || ' minutes')::interval
    `, [REMIND_WINDOW_MINUTES]);

    for (const r of rows) {
      const minutesLeft = Math.max(1, Math.round((new Date(r.start_time).getTime() - Date.now()) / 60000));
      const message = `${r.name}, আপনার "${r.title}" পরীক্ষাটি প্রায় ${minutesLeft} মিনিট পরে শুরু হবে। প্রস্তুত থাকুন — Exam House`;

      const smsResult = await sendSMS(r.phone, message);
      const pushResult = await push.sendToUser(r.user_id, {
        title: 'পরীক্ষা শুরু হতে চলেছে ⏰',
        body: `"${r.title}" প্রায় ${minutesLeft} মিনিট পরে শুরু হবে।`,
        url: '/'
      });

      // Mark as sent as long as at least one channel actually delivered (or
      // was a dev-mode no-op) — a student with only push (or only SMS) set
      // up shouldn't get skipped just because the other channel isn't configured.
      if (smsResult.ok || pushResult.sent > 0 || pushResult.total === 0) {
        await pool.query('UPDATE exam_reminders SET sent_at=NOW() WHERE id=$1', [r.reminder_id]);
      } else {
        console.error(`❌ Reminder delivery failed on all channels for reminder #${r.reminder_id}`);
      }
    }
  } catch (err) {
    console.error('❌ reminderScheduler failed:', err.message);
  }
}

function startReminderScheduler() {
  sendDueReminders(); // run once immediately on boot, then on the interval
  setInterval(sendDueReminders, CHECK_INTERVAL_MS);
}

module.exports = { startReminderScheduler, sendDueReminders };
