// services/sms.js — thin wrapper around an SMS gateway (e.g. BulkSMSBD, Alpha SMS).
// Configure via env vars:
//   SMS_API_URL    e.g. http://bulksmsbd.net/api/smsapi
//   SMS_API_KEY    your gateway API key
//   SMS_SENDER_ID  your approved sender ID
//
// If these aren't set, sendSMS() falls back to logging the message to the
// console instead of failing — so OTP flows are still testable locally /
// before a gateway contract is set up. In that fallback mode the OTP code is
// also echoed back in the API response (see auth.routes.js) so it can be used
// without a real phone.

const SMS_API_URL = process.env.SMS_API_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID;

const isConfigured = Boolean(SMS_API_URL && SMS_API_KEY);

async function sendSMS(phone, message) {
  if (!isConfigured) {
    console.log(`📱 [DEV MODE — SMS gateway not configured] To: ${phone} | Message: ${message}`);
    return { ok: true, dev: true };
  }

  try {
    const url = `${SMS_API_URL}?api_key=${encodeURIComponent(SMS_API_KEY)}&type=text&number=${encodeURIComponent(phone)}` +
      `${SMS_SENDER_ID ? `&senderid=${encodeURIComponent(SMS_SENDER_ID)}` : ''}&message=${encodeURIComponent(message)}`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      console.error('SMS gateway returned non-OK status:', res.status, text);
      return { ok: false, error: `gateway status ${res.status}` };
    }
    return { ok: true, response: text };
  } catch (err) {
    console.error('SMS send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendSMS, isConfigured };
