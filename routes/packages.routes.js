// routes/packages.routes.js — monetization: packages a student can buy for
// live exam / model test access, plus the manual bKash/Nagad payment queue.
//
// Payment flow today is manual-only: a student sends money to the number
// shown by GET /public/payment-info, then submits the TransactionID here
// (POST /purchase). It sits in `payments` as status='pending' until an
// admin checks their bKash/Nagad app and approves/rejects it
// (POST /admin/:id/approve|reject). This is deliberately built so an
// automated gateway can be bolted on later without touching this table or
// the access-checking logic in utils/packageAccess.js — a gateway's webhook
// would just insert a payments row with a new `method` value and
// status='approved' directly, skipping the admin queue.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const {
  PAYMENT_BKASH_NUMBER, PAYMENT_BKASH_TYPE, PAYMENT_NAGAD_NUMBER, PAYMENT_NAGAD_TYPE,
  STUDENT_ID_PREFIX
} = require('../config');
const { getTrialStatus } = require('../utils/packageAccess');

// ---------- Student-facing ----------

// GET /api/packages/public/list — active packages, cheapest-first-by-order,
// for the packages screen.
router.get('/public/list', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, tier, price, duration_days, live_exam_limit, model_test_limit, description
     FROM packages WHERE is_active=true ORDER BY display_order ASC, price ASC`
  );
  res.json({ packages: rows });
}));

// GET /api/packages/public/payment-info — which manual methods are
// configured right now, and where to send money. Empty arrays mean no
// manual method is set up yet (frontend should show "শীঘ্রই" in that case).
router.get('/public/payment-info', (req, res) => {
  const methods = [];
  if (PAYMENT_BKASH_NUMBER) methods.push({ method: 'bkash', number: PAYMENT_BKASH_NUMBER, type: PAYMENT_BKASH_TYPE });
  if (PAYMENT_NAGAD_NUMBER) methods.push({ method: 'nagad', number: PAYMENT_NAGAD_NUMBER, type: PAYMENT_NAGAD_TYPE });
  res.json({ methods });
});

// POST /api/packages/purchase — student submits proof of a manual payment.
// body: { package_id, method: 'bkash'|'nagad', sender_number, trx_id }
router.post('/purchase', submitLimiter, requireUser, asyncHandler(async (req, res) => {
  const { package_id, method, sender_number, trx_id } = req.body;
  if (!package_id || !method || !trx_id) {
    return res.status(400).json({ error: 'প্যাকেজ, মাধ্যম ও ট্রানজেকশন আইডি দিন' });
  }
  if (!['bkash', 'nagad'].includes(method)) {
    return res.status(400).json({ error: 'অবৈধ পেমেন্ট মাধ্যম' });
  }

  const pkgRes = await pool.query('SELECT * FROM packages WHERE id=$1 AND is_active=true', [package_id]);
  if (!pkgRes.rows.length) return res.status(404).json({ error: 'প্যাকেজ পাওয়া যায়নি' });
  const pkg = pkgRes.rows[0];

  try {
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, package_id, amount, method, sender_number, trx_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, package_id, pkg.price, method, sender_number || null, String(trx_id).trim()]
    );
    res.status(201).json({ payment: rows[0] });
  } catch (err) {
    // Unique index on trx_id (manual methods) — someone already submitted this exact TrxID.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'এই ট্রানজেকশন আইডি আগেই ব্যবহার করা হয়েছে' });
    }
    throw err;
  }
}));

// GET /api/packages/me — student's own payment history + current package
// status, including remaining quota for the two limited resources. When
// there's no active package, `trial` carries their free-trial standing
// instead (see utils/packageAccess.js) so the packages screen can show
// "৫/২০ ব্যবহৃত" rather than a bare "no package" message.
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const userRes = await pool.query(
    `SELECT u.active_package_id, u.active_package_started_at, u.active_package_expires_at,
            u.referral_code, p.name, p.tier, p.live_exam_limit, p.model_test_limit
     FROM users u LEFT JOIN packages p ON p.id = u.active_package_id
     WHERE u.id=$1`,
    [req.user.id]
  );
  const info = userRes.rows[0] || {};
  // Backfill for accounts created before the referral system existed (this
  // migration adds the column as NULL for everyone already registered) —
  // generate one lazily the first time they load this screen.
  if (!info.referral_code) {
    info.referral_code = `${STUDENT_ID_PREFIX}R${1000 + req.user.id}`;
    await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL', [info.referral_code, req.user.id]);
  }
  const isExpired = info.active_package_expires_at && new Date(info.active_package_expires_at) < new Date();
  let active = null;
  let trial = null;
  if (info.active_package_id && !isExpired) {
    const usedRes = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE e.type='live')::int AS live_used,
        COUNT(*) FILTER (WHERE e.type='model')::int AS model_used
       FROM results r JOIN exams e ON e.id = r.exam_id
       WHERE r.user_id=$1 AND ($2::timestamp IS NULL OR r.created_at >= $2)
         AND e.is_practice=false AND e.is_duel=false AND e.is_daily=false
         AND e.is_auto_subject=false AND e.is_repeated_bank=false`,
      [req.user.id, info.active_package_started_at]
    );
    const used = usedRes.rows[0];
    active = {
      name: info.name, tier: info.tier, expires_at: info.active_package_expires_at,
      live_exam_limit: info.live_exam_limit, live_exam_used: used.live_used,
      model_test_limit: info.model_test_limit, model_test_used: used.model_used
    };
  } else {
    trial = await getTrialStatus(req.user.id);
  }

  const paymentsRes = await pool.query(
    `SELECT p.id, p.amount, p.method, p.status, p.admin_note, p.created_at, pk.name AS package_name
     FROM payments p JOIN packages pk ON pk.id = p.package_id
     WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 20`,
    [req.user.id]
  );

  const referralRes = await pool.query(
    'SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1',
    [req.user.id]
  );

  res.json({
    active_package: active,
    trial,
    referral: { code: info.referral_code || null, referred_count: referralRes.rows[0].count },
    payments: paymentsRes.rows
  });
}));

// ---------- Admin ----------

// GET /api/packages/admin/list — every package (active + inactive), for the admin panel.
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM packages ORDER BY display_order ASC, id ASC');
  res.json({ packages: rows });
}));

router.post('/admin', requireAdmin, asyncHandler(async (req, res) => {
  const { name, tier, price, duration_days, live_exam_limit, model_test_limit, description, display_order } = req.body;
  if (!name || price == null || !duration_days) {
    return res.status(400).json({ error: 'নাম, মূল্য ও মেয়াদ প্রয়োজন' });
  }
  const { rows } = await pool.query(
    `INSERT INTO packages (name, tier, price, duration_days, live_exam_limit, model_test_limit, description, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, tier || 'basic', price, duration_days, live_exam_limit ?? null, model_test_limit ?? null, description || null, display_order || 0]
  );
  res.status(201).json({ package: rows[0] });
}));

router.put('/admin/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, tier, price, duration_days, live_exam_limit, model_test_limit, description, display_order, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE packages SET
      name=COALESCE($1,name), tier=COALESCE($2,tier), price=COALESCE($3,price),
      duration_days=COALESCE($4,duration_days), live_exam_limit=$5, model_test_limit=$6,
      description=COALESCE($7,description), display_order=COALESCE($8,display_order),
      is_active=COALESCE($9,is_active)
     WHERE id=$10 RETURNING *`,
    [name, tier, price, duration_days, live_exam_limit ?? null, model_test_limit ?? null,
      description, display_order, is_active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'প্যাকেজ পাওয়া যায়নি' });
  res.json({ package: rows[0] });
}));

router.delete('/admin/:id', requireAdmin, asyncHandler(async (req, res) => {
  // Soft-delete only (is_active=false) — a payments row may already reference
  // this package_id, and hard-deleting would either fail the FK or orphan
  // that payment's history for no benefit.
  await pool.query('UPDATE packages SET is_active=false WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// GET /api/packages/admin/payments?status=pending — the approval queue.
router.get('/admin/payments', requireAdmin, asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS user_name, u.phone AS user_phone, pk.name AS package_name, pk.duration_days
     FROM payments p JOIN users u ON u.id = p.user_id JOIN packages pk ON pk.id = p.package_id
     WHERE p.status=$1 ORDER BY p.created_at ASC`,
    [status]
  );
  res.json({ payments: rows });
}));

// POST /api/packages/admin/:id/approve — activates/extends the student's
// package. If they already have this-or-any package still running, the new
// duration is added on top of the existing expiry (a renewal doesn't waste
// remaining paid time); otherwise it starts from now.
router.post('/admin/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
  const payRes = await pool.query(
    `SELECT p.*, pk.name AS package_name, pk.duration_days
     FROM payments p JOIN packages pk ON pk.id = p.package_id WHERE p.id=$1`,
    [req.params.id]
  );
  if (!payRes.rows.length) return res.status(404).json({ error: 'পেমেন্ট পাওয়া যায়নি' });
  const payment = payRes.rows[0];
  if (payment.status !== 'pending') {
    return res.status(400).json({ error: 'এই পেমেন্ট আগেই প্রসেস করা হয়েছে' });
  }

  const userRes = await pool.query('SELECT active_package_expires_at FROM users WHERE id=$1', [payment.user_id]);
  const currentExpiry = userRes.rows[0]?.active_package_expires_at;
  const stillActive = currentExpiry && new Date(currentExpiry) > new Date();
  const baseDate = stillActive ? new Date(currentExpiry) : new Date();
  const newExpiry = new Date(baseDate.getTime() + payment.duration_days * 24 * 60 * 60 * 1000);

  await pool.query(
    `UPDATE users SET active_package_id=$1, active_package_name=$2, active_package_expires_at=$3,
       active_package_started_at = CASE WHEN $4 THEN active_package_started_at ELSE NOW() END
     WHERE id=$5`,
    [payment.package_id, payment.package_name, newExpiry, stillActive, payment.user_id]
  );
  await pool.query(
    `UPDATE payments SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2`,
    [req.admin.id, req.params.id]
  );
  res.json({ ok: true, expires_at: newExpiry });
}));

router.post('/admin/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
  const { note } = req.body;
  const { rows } = await pool.query(
    `UPDATE payments SET status='rejected', admin_note=$1, reviewed_by=$2, reviewed_at=NOW()
     WHERE id=$3 AND status='pending' RETURNING id`,
    [note || null, req.admin.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'পেমেন্ট পাওয়া যায়নি বা আগেই প্রসেস করা হয়েছে' });
  res.json({ ok: true });
}));

module.exports = router;
