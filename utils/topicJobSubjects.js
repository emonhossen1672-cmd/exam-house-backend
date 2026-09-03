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

module.exports = { TOPIC_JOB_SUBJECTS, UNTAGGED_TOPIC, UNTAGGED_SUBTOPIC };
