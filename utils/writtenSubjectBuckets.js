// utils/writtenSubjectBuckets.js
//
// রিটেন জব সলুশন (মন্ত্রণালয় → বিষয় → প্রশ্ন) always shows exactly these 4
// subject buttons inside a ministry. Whatever text was typed in the
// `subject` column at upload time is auto-sorted into one of them at read
// time — nothing in the database is rewritten and nothing is ever hidden:
// a subject that fits none of the first three (ভূগোল, ইসলাম শিক্ষা, বিজ্ঞান,
// ICT, ...) lands in সাধারণ জ্ঞান.
const { normalizeSubject } = require('./subjectMap');

const WRITTEN_SUBJECTS = ['বাংলা', 'ইংরেজি', 'গণিত', 'সাধারণ জ্ঞান'];

function writtenSubjectBucket(raw) {
  const canon = normalizeSubject(raw); // handles the 14 exact subjects + বাংলা/ইংরেজি/গণিত… prefixes
  if (canon === 'বাংলা' || canon === 'ইংরেজি' || canon === 'গণিত') return canon;
  const low = String(raw || '').trim().toLowerCase();
  if (low.startsWith('english')) return 'ইংরেজি';
  if (low.startsWith('math') || low.startsWith('mental') || low.startsWith('মানসিক')) return 'গণিত';
  if (low.startsWith('bangla') || low.startsWith('bengali')) return 'বাংলা';
  return 'সাধারণ জ্ঞান';
}

module.exports = { WRITTEN_SUBJECTS, writtenSubjectBucket };
