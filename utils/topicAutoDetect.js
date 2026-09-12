// utils/topicAutoDetect.js
//
// Auto-detects a টপিক for রিটেন প্রশ্ন (written questions) straight from the
// question text, when the admin/CSV row doesn't set one explicitly. Without
// this, a CSV full of "পদ নির্ণয়", "কারক নির্ণয়", "শুদ্ধ বানান লিখুন",
// "Make a sentence with the idiom ..." etc. — all mixed under one
// subject/post_name — reads as one long undifferentiated list. With this,
// they split into their own topic buckets (পদ প্রকরণ, কারক ও বিভক্তি,
// বানান শুদ্ধিকরণ, Idioms & Phrases, ...) so students can study one grammar
// category — one "সমগ্র" — at a time.
//
// Deliberately simple pattern matching, not an AI call: the question *types*
// in these job-solution question banks are a small, well-known, recurring
// set (the same handful of instruction phrases repeated across thousands of
// rows), so a fixed rule list catches nearly everything, is instant, and
// costs nothing per upload. If nothing matches, the caller just keeps
// whatever topic it already had (usually none/"অন্যান্য") — this never
// guesses wrong on unfamiliar phrasing, it just declines to guess.
//
// Order matters: more specific patterns are listed before broader ones
// (e.g. "idiom" is checked before any generic English-grammar catch-alls).
const RULES = [
  // --- বাংলা ব্যাকরণ ---
  { test: /পদ\s*নির্ণয়/, topic: 'পদ প্রকরণ' },
  { test: /কারক(\s*ও\s*বিভক্তি)?\s*নির্ণয়/, topic: 'কারক ও বিভক্তি' },
  { test: /সমাস\s*নির্ণয়|কোন\s*সমাস|সমাসের\s*নাম|ব্যাসবাক্য/, topic: 'সমাস' },
  { test: /সন্ধি\s*বিচ্ছেদ|সন্ধি\s*নির্ণয়/, topic: 'সন্ধি' },
  { test: /শুদ্ধ\s*বানান/, topic: 'বানান শুদ্ধিকরণ' },
  { test: /বাগধারা/, topic: 'বাগধারা ও প্রবাদ' },
  { test: /প্রতিশব্দ|সমার্থক\s*শব্দ/, topic: 'প্রতিশব্দ ও সমার্থক শব্দ' },
  { test: /বিপরীত(ার্থক)?\s*শব্দ/, topic: 'বিপরীত শব্দ' },
  { test: /এক\s*কথায়\s*প্রকাশ/, topic: 'এক কথায় প্রকাশ' },
  { test: /উপসর্গ/, topic: 'উপসর্গ' },
  { test: /প্রত্যয়/, topic: 'প্রত্যয়' },
  { test: /ণ.ত্ব.{0,6}ষ.ত্ব/, topic: 'ণ-ত্ব ও ষ-ত্ব বিধান' },
  { test: /বাক্য\s*সংকোচন/, topic: 'বাক্য সংকোচন' },
  { test: /বাচ্য\s*পরিবর্তন/, topic: 'বাচ্য' },

  // --- ইংরেজি ব্যাকরণ (checked case-insensitively) ---
  { test: /\bidiom(s)?\b/i, topic: 'Idioms & Phrases' },
  { test: /translate\s+into\s+english/i, topic: 'Translation (বাংলা → English)' },
  { test: /translate\s+into\s+(bengali|bangla)/i, topic: 'Translation (English → বাংলা)' },
  { test: /fill\s+in\s+the\s+blank/i, topic: 'Fill in the Blanks' },
  { test: /passive\s+voice|active\s+to\s+passive|change\s+the\s+voice/i, topic: 'Voice' },
  { test: /narration|direct\s+to\s+indirect/i, topic: 'Narration' },
  { test: /\btense\b/i, topic: 'Tense' },
  { test: /correct\s+the\s+sentence|sentence\s+correction/i, topic: 'Correction' },
  { test: /synonym|antonym/i, topic: 'Synonym & Antonym' },
  { test: /preposition/i, topic: 'Preposition' },
  { test: /\barticle\b/i, topic: 'Article (a/an/the)' },
];

// autoDetectTopic — returns a topic string if the question text matches a
// known pattern, otherwise null.
function autoDetectTopic(questionText) {
  const text = String(questionText || '');
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.topic;
  }
  return null;
}

// resolveTopic — if `providedTopic` (already normalized/trimmed by the
// caller) is non-empty, use it as-is; otherwise try to auto-detect one from
// the question text. Returns '' when neither is available (caller decides
// what that means — usually null/"অন্যান্য").
function resolveTopic(providedTopic, questionText) {
  const cleaned = (providedTopic || '').toString().trim();
  if (cleaned) return cleaned;
  return autoDetectTopic(questionText) || '';
}

module.exports = { autoDetectTopic, resolveTopic };
