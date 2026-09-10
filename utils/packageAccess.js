// utils/packageAccess.js — shared logic for the package/monetization gate.
// Used by both routes/exams.routes.js (blocks opening a locked exam's
// questions) and routes/results.routes.js (defense in depth: blocks
// submitting an answer set for a locked exam directly, in case someone
// bypasses the frontend and calls the API straight).
const pool = require('../db');

// Product decision (2026-09): live exams, admin-curated model exams, AND
// written (রিটেন) exams are premium. Practice, daily quiz, duel, and the
// auto-generated বিষয়ভিত্তিক / repeated-question buckets stay free for
// everyone. Adjust here if that scope ever changes — this is the single
// place both routes call into.
function isPremiumExam(exam) {
  if (!exam) return false;
  if (exam.type === 'live') return true;
  if (exam.type === 'model') {
    return !exam.is_practice && !exam.is_duel && !exam.is_daily &&
      !exam.is_auto_subject && !exam.is_repeated_bank;
  }
  if (exam.type === 'written') return true;
  return false;
}

// Returns the user's currently-active package row (already expiry-checked),
// or null. Does NOT mutate the user row — expiry cleanup happens lazily the
// next time an admin approves a payment or via a periodic tick if one is
// added later; reading here is always safe either way since we check the
// expiry live rather than trusting the cached flag.
async function getActivePackage(userId) {
  const { rows } = await pool.query(
    `SELECT u.active_package_id, u.active_package_started_at, u.active_package_expires_at,
            p.id AS package_id, p.name, p.tier, p.live_exam_limit, p.model_test_limit, p.written_test_limit
     FROM users u LEFT JOIN packages p ON p.id = u.active_package_id
     WHERE u.id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row || !row.package_id) return null;
  if (row.active_package_expires_at && new Date(row.active_package_expires_at) < new Date()) {
    return null; // expired — treated as no package until a new one is approved
  }
  return row;
}

// Free trial: every student gets this many premium exams for life (stretched
// by referral bonuses — see trial_bonus_exams), OR unlimited premium exams
// during their first TRIAL_WINDOW_DAYS after registering — whichever is more
// generous. Only consulted when the user has no active package.
const TRIAL_BASE_LIMIT = 20;
const TRIAL_WINDOW_DAYS = 7;

// Returns the user's free-trial status, or null if the user doesn't exist.
// `active` is true if the trial still covers a premium exam right now
// (either the exam count isn't used up, or they're still inside the
// new-account window) — checkExamAccess() is the only other place that
// should read this.
async function getTrialStatus(userId) {
  const { rows } = await pool.query(
    'SELECT created_at, trial_bonus_exams FROM users WHERE id = $1',
    [userId]
  );
  const u = rows[0];
  if (!u) return null;

  // 'written' results live in written_answers, not results — count both
  // premium resources together so the trial's shared 20-exam budget covers
  // either kind, same as it did before written went premium.
  const usedRes = await pool.query(
    `SELECT (
       (SELECT COUNT(*)::int FROM results r JOIN exams e ON e.id = r.exam_id
        WHERE r.user_id = $1 AND e.type IN ('live','model')
          AND e.is_practice = false AND e.is_duel = false AND e.is_daily = false
          AND e.is_auto_subject = false AND e.is_repeated_bank = false)
       +
       (SELECT COUNT(DISTINCT wa.exam_id)::int FROM written_answers wa JOIN exams e ON e.id = wa.exam_id
        WHERE wa.user_id = $1 AND e.type = 'written')
     ) AS used`,
    [userId]
  );
  const used = usedRes.rows[0].used;
  const limit = TRIAL_BASE_LIMIT + (u.trial_bonus_exams || 0);

  const daysSinceJoin = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
  const withinWindow = daysSinceJoin <= TRIAL_WINDOW_DAYS;
  const withinCount = used < limit;

  return {
    active: withinWindow || withinCount,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    within_window: withinWindow,
    days_left: withinWindow ? Math.max(0, Math.ceil(TRIAL_WINDOW_DAYS - daysSinceJoin)) : 0
  };
}

// Checks whether a logged-in user may open/submit a given (already
// premium-flagged) exam. Returns { allowed: true } or
// { allowed: false, reason: '<Bangla message>' }.
async function checkExamAccess(userId, exam) {
  if (!isPremiumExam(exam)) return { allowed: true };
  if (!userId) {
    return { allowed: false, reason: 'এই পরীক্ষাটি প্রিমিয়াম — দেখতে হলে লগইন করে একটি প্যাকেজ কিনুন।' };
  }
  const pkg = await getActivePackage(userId);
  if (!pkg) {
    const trial = await getTrialStatus(userId);
    if (trial && trial.active) return { allowed: true };
    return {
      allowed: false,
      reason: 'আপনার ফ্রি ট্রায়াল শেষ হয়ে গেছে (২০টি পরীক্ষা / নতুন অ্যাকাউন্টের প্রথম ৭ দিন)। লাইভ পরীক্ষা/মডেল টেস্ট চালিয়ে যেতে প্রোফাইল থেকে একটি প্যাকেজ কিনুন — অথবা বন্ধুকে রেফার করে ফ্রি ট্রায়াল বাড়িয়ে নিন।'
    };
  }

  const limitField = exam.type === 'live' ? 'live_exam_limit'
    : exam.type === 'written' ? 'written_test_limit'
    : 'model_test_limit';
  const limit = pkg[limitField];
  if (limit == null) return { allowed: true }; // unlimited on this package

  // written exams are answered per-question in written_answers (no `results`
  // row), so quota usage there is counted by distinct exam_id instead.
  let used;
  if (exam.type === 'written') {
    const usedRes = await pool.query(
      `SELECT COUNT(DISTINCT wa.exam_id)::int AS used
       FROM written_answers wa JOIN exams e ON e.id = wa.exam_id
       WHERE wa.user_id = $1 AND e.type = 'written'
         AND ($2::timestamp IS NULL OR wa.submitted_at >= $2)`,
      [userId, pkg.active_package_started_at]
    );
    used = usedRes.rows[0].used;
  } else {
    const usedRes = await pool.query(
      `SELECT COUNT(*)::int AS used
       FROM results r JOIN exams e ON e.id = r.exam_id
       WHERE r.user_id = $1 AND e.type = $2
         AND ($3::timestamp IS NULL OR r.created_at >= $3)
         AND e.is_practice = false AND e.is_duel = false AND e.is_daily = false
         AND e.is_auto_subject = false AND e.is_repeated_bank = false`,
      [userId, exam.type, pkg.active_package_started_at]
    );
    used = usedRes.rows[0].used;
  }
  if (used >= limit) {
    const label = exam.type === 'live' ? 'লাইভ পরীক্ষা' : exam.type === 'written' ? 'রিটেন পরীক্ষা' : 'মডেল টেস্ট';
    return {
      allowed: false,
      reason: `আপনার প্যাকেজে এই মেয়াদে ${label} দেওয়ার সীমা (${limit}টি) শেষ হয়ে গেছে। বেশি ${label} দিতে আপগ্রেড করুন।`
    };
  }
  return { allowed: true };
}

module.exports = { isPremiumExam, getActivePackage, getTrialStatus, checkExamAccess, TRIAL_BASE_LIMIT, TRIAL_WINDOW_DAYS };
