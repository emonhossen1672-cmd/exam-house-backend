// utils/topicJobSubjects.js
//
// Fixed subject list for টপিকভিত্তিক জব সলুশন (Subject → Topic → Subtopic →
// Questions). Unlike utils/subjectMap.js (used by রিডিং লিস্ট/ডুয়েল
// মোড/স্মার্ট প্র্যাকটিস, which auto-buckets raw subject text into 5 broad
// groups), this feature needs an EXACT match — a question only shows up
// under one of these 12 buttons if its `subject` column is set to exactly
// one of these strings. Set it via the admin form's dropdown (offers
// exactly these 12 values) or fix old mismatched data with the bulk-retag
// tool / PUT /admin/rename-subject.
const TOPIC_JOB_SUBJECTS = [
  'বাংলা ব্যাকরণ',
  'বাংলা সাহিত্য',
  'ইংরেজি ব্যাকরণ',
  'ইংরেজি সাহিত্য',
  'ভোকাবুলারি',
  'গণিত',
  'বাংলাদেশ',
  'আন্তর্জাতিক',
  'বিজ্ঞান',
  'তথ্য ও যোগাযোগ প্রযুক্তি',
  'ভূগোল, পরিবেশ ও ব্যবস্থাপনা',
  'নৈতিকতা, মূল্যবোধ ও সুশাসন'
];

const UNTAGGED_TOPIC = 'অন্যান্য';
const UNTAGGED_SUBTOPIC = 'অন্যান্য';

// normalizeText — cleans up subject/topic/subtopic text before it's saved,
// so invisible differences (which are extremely common with Bengali text
// typed on a phone keyboard or edited in a mobile spreadsheet app — e.g. a
// non-breaking space, doubled spaces, or the same glyph stored as a
// different Unicode sequence/NFD vs NFC) don't silently break the EXACT
// string match that টপিকভিত্তিক জব সলুশন relies on. Without this, a CSV
// row can look identical on screen to "বাংলা ব্যাকরণ" and still fail the
// `subject = 'বাংলা ব্যাকরণ'` check — the question then only shows up in
// রিডিং লিস্ট (which matches loosely via subjectMap.js) and never appears
// under the topic/subtopic drill-down.
function normalizeText(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFC')                 // collapse Bengali glyphs to one canonical byte sequence
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ') // NBSP/zero-width/BOM chars -> space
    .replace(/\s+/g, ' ')             // collapse runs of whitespace
    .trim();
}

// Pre-normalized lookup so we can snap a nearly-matching subject (extra
// space, stray invisible char, NFD form, etc.) back onto the exact one of
// the 12 canonical strings the topic-job feature checks against.
const NORMALIZED_TO_FIXED = new Map(TOPIC_JOB_SUBJECTS.map(s => [normalizeText(s), s]));

// snapToFixedSubject — normalizes `raw`, and if the cleaned-up text matches
// one of the 12 fixed subjects, returns that EXACT canonical string (byte
// for byte) so it satisfies the topic-job feature's strict equality check.
// If it doesn't match any of the 12 (a genuinely different subject), it
// still returns the cleaned-up text rather than the raw one, so at least
// stray whitespace/invisible characters don't linger in the database.
function snapToFixedSubject(raw) {
  const cleaned = normalizeText(raw);
  if (!cleaned) return '';
  return NORMALIZED_TO_FIXED.get(cleaned) || cleaned;
}

module.exports = { TOPIC_JOB_SUBJECTS, UNTAGGED_TOPIC, UNTAGGED_SUBTOPIC, normalizeText, snapToFixedSubject };
