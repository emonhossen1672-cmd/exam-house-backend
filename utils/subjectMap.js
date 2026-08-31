// utils/subjectMap.js
//
// Canonical subject grouping shared by every backend endpoint that lists
// subjects to the public site (Reading List, Duel mode's subject picker,
// Smart Practice weighting). Mirrors the same rules used client-side on the
// বিষয়ভিত্তিক (Subject-wise Model Test) screen, so a student sees the same
// 5 subjects everywhere instead of "English"/"ইংরেজি" as two separate ones.
//
// This never rewrites data in the questions/exams tables — raw `subject`
// values stay exactly as admins entered them. This only decides how to
// group/label/filter them when showing lists.

const CANONICAL_SUBJECTS = ['বাংলা', 'ইংরেজি', 'গণিত', 'সাধারণ জ্ঞান', 'বিজ্ঞান ও প্রযুক্তি'];

function normalizeSubject(raw) {
  if (!raw) return null;
  const low = String(raw).trim().toLowerCase();
  if (!low || low === 'সব') return null;
  if (low.startsWith('বাংলা')) return 'বাংলা';
  if (low === 'english' || low.startsWith('ইংরেজি')) return 'ইংরেজি';
  if (low.startsWith('গণিত')) return 'গণিত';
  if (low.startsWith('সাধারণ জ্ঞান')) return 'সাধারণ জ্ঞান';
  if (low.startsWith('বিজ্ঞান')) return 'বিজ্ঞান ও প্রযুক্তি';
  return null; // anything else (ভূমি বিষয়ক, ইসলাম শিক্ষা, ...) — hidden from these lists
}

module.exports = { normalizeSubject, CANONICAL_SUBJECTS };
