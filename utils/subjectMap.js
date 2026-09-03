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

// Exact map from the 12 টপিকভিত্তিক জব সলুশন subjects (utils/topicJobSubjects.js)
// to their parent canonical group. Tagging a question with one of these 12
// exact values now satisfies BOTH the topic-job feature (exact match) and
// the reading list / duel / smart practice grouping (this map) in one go —
// no need to tag a question twice.
const TOPIC_JOB_TO_CANONICAL = {
  'বাংলা ব্যাকরণ': 'বাংলা',
  'বাংলা সাহিত্য': 'বাংলা',
  'ইংরেজি ব্যাকরণ': 'ইংরেজি',
  'ইংরেজি সাহিত্য': 'ইংরেজি',
  'ভোকাবুলারি': 'ইংরেজি',
  'গণিত': 'গণিত',
  'বাংলাদেশ': 'সাধারণ জ্ঞান',
  'আন্তর্জাতিক': 'সাধারণ জ্ঞান',
  'বিজ্ঞান': 'বিজ্ঞান ও প্রযুক্তি',
  'তথ্য ও যোগাযোগ প্রযুক্তি': 'বিজ্ঞান ও প্রযুক্তি',
  'ভূগোল, পরিবেশ ও ব্যবস্থাপনা': 'সাধারণ জ্ঞান',
  'নৈতিকতা, মূল্যবোধ ও সুশাসন': 'সাধারণ জ্ঞান',
};

function normalizeSubject(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // 1) Exact match against the 12 topic-job subjects — preferred path.
  if (TOPIC_JOB_TO_CANONICAL[trimmed]) return TOPIC_JOB_TO_CANONICAL[trimmed];

  // 2) Fallback prefix-matching for legacy free-text subject values that
  //    predate the 12-subject dropdown (e.g. plain "বাংলা", "English").
  //    Once old questions are retagged to one of the 12 exact values via
  //    rename-subject / bulk-retag, they'll hit rule (1) instead.
  const low = trimmed.toLowerCase();
  if (low === 'সব') return null;
  if (low.startsWith('বাংলা')) return 'বাংলা';
  if (low === 'english' || low.startsWith('ইংরেজি')) return 'ইংরেজি';
  if (low.startsWith('গণিত')) return 'গণিত';
  if (low.startsWith('সাধারণ জ্ঞান')) return 'সাধারণ জ্ঞান';
  if (low.startsWith('বিজ্ঞান')) return 'বিজ্ঞান ও প্রযুক্তি';
  return null; // anything else (ভূমি বিষয়ক, ইসলাম শিক্ষা, ...) — hidden from these lists
}

module.exports = { normalizeSubject, CANONICAL_SUBJECTS, TOPIC_JOB_TO_CANONICAL };
