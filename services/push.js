// services/push.js — thin wrapper around the Web Push API (via VAPID),
// mirroring services/sms.js's shape: if VAPID keys aren't configured, calls
// fall back to logging instead of failing, so the rest of the app (routes,
// scheduler) doesn't need its own "is this set up yet" branching.
//
// Configure via env vars:
//   VAPID_PUBLIC_KEY   — sent to browsers so they know who's allowed to push to them
//   VAPID_PRIVATE_KEY  — kept secret on the server, signs outgoing pushes
//   VAPID_SUBJECT       — mailto: or https: URL identifying this app to push services (optional, has a default)
//
// Generate a keypair with `npx web-push generate-vapid-keys` (or reuse the
// ones handed over alongside this feature) and set them in Render's
// Environment tab — same place SMS_API_KEY etc. already live.

const webpush = require('web-push');
const pool = require('../db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@examhouse.app';

const isConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Sends to one raw subscription object ({ endpoint, keys: { p256dh, auth } }).
// Returns { ok, dev? , error? }. A 404/410 response means the browser has
// unsubscribed or the subscription expired — caller should delete that row.
async function sendToSubscription(subscription, payload) {
  if (!isConfigured) {
    console.log(`🔔 [DEV MODE — VAPID keys not configured] Push to ${subscription.endpoint.slice(0, 60)}... | Payload:`, payload);
    return { ok: true, dev: true };
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const gone = err.statusCode === 404 || err.statusCode === 410;
    if (!gone) console.error('Push send failed:', err.statusCode, err.body || err.message);
    return { ok: false, gone, error: err.message };
  }
}

// Sends to every subscription a user has (phone, laptop, ...), deleting any
// that come back expired/unsubscribed along the way.
async function sendToUser(userId, payload) {
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1',
    [userId]
  );
  let sent = 0;
  for (const row of rows) {
    const result = await sendToSubscription(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      payload
    );
    if (result.ok) sent++;
    else if (result.gone) await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [row.id]);
  }
  return { sent, total: rows.length };
}

module.exports = { sendToSubscription, sendToUser, isConfigured, VAPID_PUBLIC_KEY };
