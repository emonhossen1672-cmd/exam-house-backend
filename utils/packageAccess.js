// utils/packageAccess.js — shared logic for the package/monetization gate.
// Used by both routes/exams.routes.js (blocks opening a locked exam's
// questions) and routes/results.routes.js (defense in depth: blocks
// submitting an answer set for a locked exam directly, in case someone
// bypasses the frontend and calls the API straight).
const pool = require('../db');

// Product decision (2026-09): only real live exams and admin-curated model
// exams are premium. Practice, daily quiz, duel, auto-generated
// বিষয়ভিত্তিক buckets, repeated-question bank, and written exams stay free
// for everyone. Adjust here if that scope ever changes — this is the single
// place both routes call into.
function isPremiumExam(exam) {
  if (!exam) return false;
  if (exam.type === 'live') return true;
  if (exam.type === 'model') {
    return !exam.is_practice && !exam.is_duel && !exam.is_daily &&
      !exam.is_auto_subject && !exam.is_repeated_bank;
  }
  return false; // 'written' and anything else stays free for now
}

// Returns the user's currently-active package row (already expiry-checked),
// or null. Does NOT mutate the user row — expiry cleanup happens lazily the
// next time an admin approves a payment or via a periodic tick if one is
// added later; reading here is always safe either way since we check the
// expiry live rather than trusting the cached flag.
async function getActivePackage(userId) {
  const { rows } = await pool.query(
    `SELECT u.active_package_id, u.active_package_started_at, u.active_package_expires_at,
            p.id AS package_id, p.name, p.tier, p.live_exam_limit, p.model_test_limit
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
    return { allowed: false, reason: 'এই লাইভ পরীক্ষা/মডেল টেস্টের জন্য সক্রিয় প্যাকেজ প্রয়োজন। প্রোফাইল থেকে প্যাকেজ কিনুন।' };
  }

  const limitField = exam.type === 'live' ? 'live_exam_limit' : 'model_test_limit';
  const limit = pkg[limitField];
  if (limit == null) return { allowed: true }; // unlimited on this package

  const usedRes = await pool.query(
    `SELECT COUNT(*)::int AS used
     FROM results r JOIN exams e ON e.id = r.exam_id
     WHERE r.user_id = $1 AND e.type = $2
       AND ($3::timestamp IS NULL OR r.created_at >= $3)
       AND e.is_practice = false AND e.is_duel = false AND e.is_daily = false
       AND e.is_auto_subject = false AND e.is_repeated_bank = false`,
    [userId, exam.type, pkg.active_package_started_at]
  );
  const used = usedRes.rows[0].used;
  if (used >= limit) {
    const label = exam.type === 'live' ? 'লাইভ পরীক্ষা' : 'মডেল টেস্ট';
    return {
      allowed: false,
      reason: `আপনার প্যাকেজে এই মেয়াদে ${label} দেওয়ার সীমা (${limit}টি) শেষ হয়ে গেছে। বেশি ${label} দিতে আপগ্রেড করুন।`
    };
  }
  return { allowed: true };
}

module.exports = { isPremiumExam, getActivePackage, checkExamAccess };
