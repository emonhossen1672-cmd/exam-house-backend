// services/bkash.js — talks to bKash's "Tokenized Checkout" Payment Gateway
// (PGW) REST API so a student's payment is verified automatically instead of
// an admin eyeballing a TrxID. Flow (see routes/bkashPayment.routes.js for
// the HTTP side that drives this):
//
//   1. grantToken()      — logs in with app key/secret + username/password,
//                           gets a short-lived id_token to authorize the
//                           next two calls. Cached in memory and refreshed
//                           automatically when it's about to expire.
//   2. createPayment()   — tells bKash "a student owes this much"; bKash
//                           returns a bkashURL to redirect the student's
//                           browser to (their own checkout page — we never
//                           see the student's bKash PIN).
//   3. executePayment()  — after the student finishes paying on bKash's
//                           page and bKash redirects back to our callback,
//                           this confirms the transaction actually completed
//                           and is the ONLY step that should mark a payment
//                           'approved' — never trust the redirect's query
//                           params alone, since those are just for the
//                           browser and aren't signed.
//
// isConfigured is false until all four credentials are set — same pattern
// as services/google.js / services/sms.js — so the server still starts and
// the manual bKash/Nagad flow in routes/packages.routes.js keeps working
// without this.
const {
  BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD, BKASH_BASE_URL
} = require('../config');

const isConfigured = Boolean(BKASH_APP_KEY && BKASH_APP_SECRET && BKASH_USERNAME && BKASH_PASSWORD);

// In-memory token cache. A single admin-style app credential is shared by
// the whole server (this isn't a per-student OAuth token), so one cached
// value for the whole process is correct — no per-request grant needed.
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function bkashFetch(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BKASH_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token
        ? { Authorization: token, 'X-App-Key': BKASH_APP_KEY }
        : { username: BKASH_USERNAME, password: BKASH_PASSWORD })
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.errorMessage || data?.message || `bKash API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Returns a valid id_token, reusing the cached one if it still has more than
// a minute of life left. bKash tokens are typically valid ~1 hour.
async function grantToken() {
  if (!isConfigured) throw new Error('bKash গেটওয়ে কনফিগার করা নেই');
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;

  const data = await bkashFetch('/tokenized/checkout/token/grant', {
    method: 'POST',
    body: { app_key: BKASH_APP_KEY, app_secret: BKASH_APP_SECRET }
  });
  if (!data.id_token) throw new Error('bKash থেকে টোকেন পাওয়া যায়নি');

  cachedToken = data.id_token;
  // expires_in is in seconds; default to 55 minutes if bKash omits it.
  cachedTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3300) * 1000;
  return cachedToken;
}

// Starts a checkout session for one payment. `invoiceRef` should be unique
// per attempt (we use the local `payments` row id) — bKash uses it purely
// for their own reconciliation, our own uniqueness guarantee is the
// gateway_payment_id column back in Postgres.
// Returns { bkashURL, paymentID } — redirect the student's browser to
// bkashURL and remember paymentID (already saved by the caller) to execute
// later.
async function createPayment({ amount, invoiceRef, callbackURL }) {
  const token = await grantToken();
  const data = await bkashFetch('/tokenized/checkout/create', {
    method: 'POST',
    token,
    body: {
      mode: '0011', // tokenized checkout, single payment
      payerReference: String(invoiceRef),
      callbackURL,
      amount: String(amount),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: String(invoiceRef)
    }
  });
  if (!data.bkashURL || !data.paymentID) {
    throw new Error(data.statusMessage || 'bKash পেমেন্ট শুরু করা যায়নি');
  }
  return { bkashURL: data.bkashURL, paymentID: data.paymentID };
}

// Confirms a payment after the student returns from bKash's checkout page.
// This is the step that actually moves money-verification from "the
// student says so" to "bKash says so" — routes/bkashPayment.routes.js only
// marks a payment approved when this returns transactionStatus 'Completed'.
// Safe to call once per paymentID; bKash rejects a second execute for an
// already-completed payment, which the route treats as "already handled".
async function executePayment(paymentID) {
  const token = await grantToken();
  return bkashFetch('/tokenized/checkout/execute', {
    method: 'POST',
    token,
    body: { paymentID }
  });
}

// Used if a student's browser never makes it back to our callback (closed
// tab, network drop) — lets an admin or a retry job ask bKash directly
// "did this paymentID actually complete?" without double-charging.
async function queryPayment(paymentID) {
  const token = await grantToken();
  return bkashFetch('/tokenized/checkout/payment/status', {
    method: 'POST',
    token,
    body: { paymentID }
  });
}

module.exports = { isConfigured, createPayment, executePayment, queryPayment };
