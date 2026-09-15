// routes/bkashPayment.routes.js — automated bKash checkout, the "gateway"
// path referenced in routes/packages.routes.js (manual bKash/Nagad + admin
// approval queue lives there and keeps working unchanged; this file is
// purely additive). Two-step flow:
//
//   1. POST /create    — student picks a package → we open a bKash checkout
//                         session and hand back a bkashURL for the frontend
//                         to redirect to.
//   2. GET  /callback   — bKash redirects the student's browser back here
//                         after they pay (or cancel) on bKash's own page.
//                         We confirm the transaction server-to-server with
//                         bKash (never trusting the redirect's query params
//                         alone) before activating anything, then bounce the
//                         browser on to FRONTEND_URL with a plain
//                         ?payment=success|failed so the app can show a
//                         result screen.
//
// A payments row exists from the moment /create is called (status
// 'initiated') so every attempt — including ones a student abandons on
// bKash's page — is visible in the admin payments list, same table as the
// manual flow.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const bkash = require('../services/bkash');
const { activatePackage } = require('../utils/packageAccess');
const { FRONTEND_URL } = require('../config');

// Builds the "go back to the app" URL for the callback to redirect to. Falls
// back to a plain JSON response if FRONTEND_URL isn't set, so this doesn't
// silently 404 during initial setup.
function redirectTarget(result) {
  if (!FRONTEND_URL) return null;
  const sep = FRONTEND_URL.includes('?') ? '&' : '?';
  return `${FRONTEND_URL}${sep}payment=${result}`;
}

// POST /api/payments/bkash/create — body: { package_id }
router.post('/create', submitLimiter, requireUser, asyncHandler(async (req, res) => {
  if (!bkash.isConfigured) {
    return res.status(503).json({ error: 'অটোমেটিক bKash পেমেন্ট এখনও চালু করা হয়নি। ম্যানুয়াল পেমেন্ট ব্যবহার করুন।' });
  }
  const { package_id } = req.body;
  if (!package_id) return res.status(400).json({ error: 'প্যাকেজ নির্বাচন করুন' });

  const pkgRes = await pool.query('SELECT * FROM packages WHERE id=$1 AND is_active=true', [package_id]);
  if (!pkgRes.rows.length) return res.status(404).json({ error: 'প্যাকেজ পাওয়া যায়নি' });
  const pkg = pkgRes.rows[0];

  // Row created up front (before we even talk to bKash) so an abandoned
  // checkout still shows up as 'initiated' in the admin payments list
  // instead of vanishing with no trace.
  const paymentRes = await pool.query(
    `INSERT INTO payments (user_id, package_id, amount, method, status)
     VALUES ($1,$2,$3,'bkash_gateway','initiated') RETURNING id`,
    [req.user.id, package_id, pkg.price]
  );
  const paymentRowId = paymentRes.rows[0].id;

  const callbackURL = `${req.protocol}://${req.get('host')}/api/payments/bkash/callback`;

  try {
    const { bkashURL, paymentID } = await bkash.createPayment({
      amount: pkg.price,
      invoiceRef: paymentRowId,
      callbackURL
    });
    await pool.query('UPDATE payments SET gateway_payment_id=$1 WHERE id=$2', [paymentID, paymentRowId]);
    res.status(201).json({ bkashURL });
  } catch (err) {
    // bKash session never opened — reject the row immediately rather than
    // leaving a permanently-stuck 'initiated' payment behind.
    await pool.query(
      `UPDATE payments SET status='rejected', admin_note=$1 WHERE id=$2`,
      [String(err.message || err).slice(0, 500), paymentRowId]
    );
    throw err;
  }
}));

// GET /api/payments/bkash/callback?paymentID=...&status=success|failure|cancel
// bKash calls this by redirecting the student's browser — it is NOT an
// authenticated request (no session cookie/JWT guaranteed), so everything
// here is looked up by gateway_payment_id and confirmed against bKash
// itself, never taken on faith from the query string.
router.get('/callback', asyncHandler(async (req, res) => {
  const { paymentID, status } = req.query;
  if (!paymentID) return res.status(400).send('অবৈধ কলব্যাক — paymentID পাওয়া যায়নি');

  const payRes = await pool.query('SELECT * FROM payments WHERE gateway_payment_id=$1', [paymentID]);
  const payment = payRes.rows[0];
  if (!payment) return res.status(404).send('পেমেন্ট রেকর্ড পাওয়া যায়নি');

  // Already handled — student's browser bounced back twice, or they hit
  // refresh on the result page. Don't execute the same paymentID again.
  if (payment.status === 'approved') {
    const target = redirectTarget('success');
    return target ? res.redirect(target) : res.json({ ok: true, already: true });
  }
  if (payment.status !== 'initiated') {
    const target = redirectTarget('failed');
    return target ? res.redirect(target) : res.json({ ok: false, already: true });
  }

  if (status !== 'success') {
    // Student cancelled or bKash reported failure before execute was even
    // relevant — nothing to confirm, just close out the row.
    await pool.query(`UPDATE payments SET status='rejected', admin_note='student cancelled or bKash reported failure' WHERE id=$1`, [payment.id]);
    const target = redirectTarget('failed');
    return target ? res.redirect(target) : res.json({ ok: false });
  }

  try {
    const result = await bkash.executePayment(paymentID);
    if (result.transactionStatus === 'Completed') {
      await activatePackage(payment.user_id, payment.package_id);
      await pool.query(
        `UPDATE payments SET status='approved', trx_id=$1, reviewed_at=NOW() WHERE id=$2`,
        [result.trxID || null, payment.id]
      );
      const target = redirectTarget('success');
      return target ? res.redirect(target) : res.json({ ok: true });
    }
    await pool.query(
      `UPDATE payments SET status='rejected', admin_note=$1 WHERE id=$2`,
      [`execute returned: ${result.transactionStatus || result.statusMessage || 'unknown'}`, payment.id]
    );
    const target = redirectTarget('failed');
    return target ? res.redirect(target) : res.json({ ok: false });
  } catch (err) {
    await pool.query(
      `UPDATE payments SET status='rejected', admin_note=$1 WHERE id=$2`,
      [String(err.message || err).slice(0, 500), payment.id]
    );
    const target = redirectTarget('failed');
    return target ? res.redirect(target) : res.status(502).json({ error: 'bKash যাচাই ব্যর্থ হয়েছে' });
  }
}));

module.exports = router;
