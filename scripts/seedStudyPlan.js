// scripts/seedStudyPlan.js
//
// Generates a real, syllabus-based study plan directly into routine_days
// for two categories:
//   - bcs-200      : 200-day BCS Preliminary prep, subject blocks sized to
//                    the actual BCS Preliminary mark distribution (200 marks
//                    total, ~1 day per mark), grouped so each of the 5
//                    canonical subjects (utils/subjectMap.js) finishes as a
//                    contiguous block — the last day of each block tells the
//                    student to sit that subject's মডেল টেস্ট (already a
//                    working feature; this script does not create exams).
//   - job-solution : 100-day রিভিশন/practice cycle over the same 12 topic-job
//                    subjects (utils/topicJobSubjects.js), same mark ratio
//                    halved, tasks point at টপিকভিত্তিক জব সলুশন practice sets.
//
// Also inserts one exam_templates row so সাপ্তাহিক মডেল টেস্ট keeps firing
// automatically every week (routine_category = 'weekly-model-test').
//
// This only touches routine_days rows whose category is 'bcs-200' or
// 'job-solution' (deletes + reinserts those two categories) and adds one
// exam_templates row if a matching one doesn't already exist. Nothing else
// in the database is touched.
//
// Run on Render (needs DATABASE_URL in the environment):
//   node scripts/seedStudyPlan.js
//
// Safe to re-run — it wipes and rebuilds only 'bcs-200' and 'job-solution'
// routine_days, and won't insert a duplicate exam_template.

require('dotenv').config();
const pool = require('../db');

// ---------- Subject blocks: [subject label, day count, topic list] ----------
// Topic lists are sized to match the day count for that subject exactly, so
// each day gets one concrete topic instead of a generic "study X" task.

const BANGLA_GRAMMAR = ['ভাষা ও বাংলা ভাষার উৎপত্তি', 'ধ্বনিতত্ত্ব', 'বর্ণ ও বর্ণ বিন্যাস', 'সন্ধি', 'সমাস',
  'উপসর্গ', 'প্রত্যয়', 'ধাতু', 'কারক ও বিভক্তি', 'পদ প্রকরণ (বিশেষ্য/সর্বনাম/বিশেষণ)', 'ক্রিয়া ও কাল',
  'বাচ্য', 'বাক্য গঠন', 'বাক্য সংকোচন', 'বিপরীত শব্দ', 'সমার্থক শব্দ', 'বাগধারা ও প্রবাদ',
  'বানান শুদ্ধিকরণ', 'বাক্য শুদ্ধিকরণ', 'বিরাম চিহ্ন, উচ্চারণ ও বিগত সালের প্রশ্ন চর্চা'];

const BANGLA_LIT = ['প্রাচীন ও মধ্যযুগের বাংলা সাহিত্য', 'চর্যাপদ', 'বৈষ্ণব পদাবলি', 'মঙ্গলকাব্য',
  'শাক্ত পদাবলি ও ইসলামি সাহিত্য', 'আধুনিক যুগের সূচনা', 'মাইকেল মধুসূদন দত্ত', 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়',
  'রবীন্দ্রনাথ ঠাকুর', 'কাজী নজরুল ইসলাম', 'জসীমউদ্দীন', 'জীবনানন্দ দাশ', 'শরৎচন্দ্র ও অন্যান্য ঔপন্যাসিক',
  'সাম্প্রতিক সাহিত্যিক ও পুরস্কার', 'বিগত সালের প্রশ্ন চর্চা'];

const ENG_GRAMMAR = ['Parts of Speech', 'Tense', 'Subject-Verb Agreement', 'Articles', 'Preposition',
  'Voice (Active-Passive)', 'Narration (Direct-Indirect)', 'Conditional Sentences', 'Modifiers',
  'Right Form of Verb', 'Sentence Correction', 'Transformation of Sentences', 'Synonyms & Antonyms',
  'Idioms & Phrases', 'One Word Substitution', 'Phrasal / Group Verbs', 'Punctuation', 'Spelling',
  'Clauses', 'Gap Filling & Cloze Test'];

const ENG_LIT = ['Old & Middle English Literature (Chaucer)', 'Elizabethan Age (Shakespeare)',
  'Metaphysical & Restoration Poets', 'Romantic Age (Wordsworth, Keats, Shelley, Byron)',
  'Victorian Age (Dickens, Tennyson, Hardy)', 'Modern Age (Eliot, Woolf, Orwell)',
  'American Literature Overview', 'Literary Terms & Figures of Speech'];

const VOCAB = ['Common Word Meanings', 'Synonyms', 'Antonyms', 'One Word Substitution',
  'Foreign Words & Phrases', 'Words Often Confused', 'Analogy'];

const MATH = ['সংখ্যা পদ্ধতি', 'ঐকিক নিয়ম', 'শতকরা', 'লাভ-ক্ষতি', 'সরল ও যৌগিক মুনাফা',
  'অনুপাত-সমানুপাত', 'বীজগণিত (সূচক-লগারিদম)', 'সমীকরণ', 'জ্যামিতি (কোণ-ত্রিভুজ)',
  'জ্যামিতি (বৃত্ত-চতুর্ভুজ)', 'ক্ষেত্রফল ও পরিসীমা', 'ঘন ও আয়তন', 'গড়-সংখ্যা', 'বিন্যাস ও সমাবেশ',
  'সম্ভাবনা', 'সাদৃশ্য (Analogy)', 'শ্রেণিভুক্তকরণ (Classification)', 'ধারা (Series)',
  'কোডিং-ডিকোডিং', 'দিক নির্ণয় (Direction)', 'রক্তসম্পর্ক (Blood Relation)',
  'বর্ণ ও সংখ্যাভিত্তিক যুক্তি', 'ভেন চিত্র', 'দর্পণ ও পানি প্রতিবিম্ব', 'যুক্তিভিত্তিক সিদ্ধান্ত',
  'ঘড়ি ও ক্যালেন্ডার', 'পাজল', 'বিগত সালের প্রশ্ন চর্চা (গাণিতিক যুক্তি)', 'মিশ্র গাণিতিক সমস্যা',
  'চূড়ান্ত রিভিউ'];

const BANGLADESH = ['বাংলাদেশের ভৌগোলিক পরিচিতি', 'প্রাচীন ও মধ্যযুগের ইতিহাস', 'ব্রিটিশ শাসনামল',
  'ভাষা আন্দোলন', 'ছয় দফা আন্দোলন', 'ঊনসত্তরের গণঅভ্যুত্থান', '১৯৭০ এর নির্বাচন',
  'মুক্তিযুদ্ধ (পটভূমি)', 'মুক্তিযুদ্ধ (সেক্টর ও যুদ্ধ)', 'মুজিবনগর সরকার', 'বিজয় দিবস ও পরবর্তী ঘটনা',
  'সংবিধান প্রণয়ন', 'সরকার কাঠামো (রাষ্ট্রপতি-প্রধানমন্ত্রী)', 'সংসদ ও নির্বাচন ব্যবস্থা',
  'স্থানীয় সরকার ব্যবস্থা', 'বৈদেশিক নীতি', 'অর্থনীতি (কৃষি)', 'অর্থনীতি (শিল্প ও রপ্তানি)',
  'অর্থনীতি (বাজেট ও পরিকল্পনা)', 'জনসংখ্যা ও জনমিতি', 'নদ-নদী ও জলবায়ু', 'প্রাকৃতিক সম্পদ',
  'শিক্ষা ব্যবস্থা', 'সামাজিক উন্নয়ন সূচক', 'সাংস্কৃতিক ঐতিহ্য', 'খেলাধুলা', 'বিখ্যাত ব্যক্তিত্ব',
  'সাম্প্রতিক সরকারি কর্মসূচি', 'পুরস্কার ও সম্মাননা', 'বিগত সালের প্রশ্ন চর্চা'];

const INTERNATIONAL = ['জাতিসংঘ ও অঙ্গসংস্থা', 'বিশ্বব্যাংক-আইএমএফ-ডব্লিউটিও', 'সার্ক ও বিমসটেক',
  'আসিয়ান ও অন্যান্য আঞ্চলিক জোট', 'ইউরোপীয় ইউনিয়ন', 'বিশ্ব রাজনীতি (মধ্যপ্রাচ্য)',
  'বিশ্ব রাজনীতি (এশিয়া-প্রশান্ত)', 'বিশ্বযুদ্ধ ও স্নায়ুযুদ্ধ', 'দুই বিশ্বযুদ্ধ পরবর্তী বিশ্ব',
  'বিভিন্ন দেশের রাজধানী-মুদ্রা', 'বিভিন্ন দেশের পার্লামেন্ট ও প্রধান', 'বিখ্যাত চুক্তি ও সম্মেলন',
  'আন্তর্জাতিক দিবস', 'নোবেল পুরস্কার', 'বৈশ্বিক সংকট (জলবায়ু-শরণার্থী)',
  'বিশ্ব সীমারেখা, প্রণালী, দ্বীপ ও মরুভূমি', 'ভূরাজনীতি (সাম্প্রতিক সংঘাত)',
  'সাম্প্রতিক আন্তর্জাতিক ঘটনা', 'আন্তর্জাতিক সংস্থার প্রধানগণ', 'বিগত সালের প্রশ্ন চর্চা'];

const GEO_ENV = ['বাংলাদেশের ভূপ্রকৃতি', 'বিশ্ব ভূগোল পরিচিতি', 'জলবায়ু পরিবর্তন',
  'দুর্যোগ ব্যবস্থাপনা (বন্যা-ঘূর্ণিঝড়)', 'দুর্যোগ ব্যবস্থাপনা (ভূমিকম্প-খরা)', 'পরিবেশ সংরক্ষণ আইন',
  'প্রাকৃতিক সম্পদ ব্যবস্থাপনা', 'বিশ্ব উষ্ণায়ন ও এর প্রভাব', 'টেকসই উন্নয়ন লক্ষ্যমাত্রা (SDG)',
  'বিগত সালের প্রশ্ন চর্চা'];

const ETHICS = ['নৈতিকতার ধারণা ও গুরুত্ব', 'মূল্যবোধের উপাদান', 'সুশাসনের ধারণা ও উপাদান',
  'দুর্নীতি প্রতিরোধ', 'সরকারি কর্মচারীর আচরণবিধি', 'মানবাধিকার', 'জেন্ডার সমতা',
  'সামাজিক ন্যায়বিচার', 'রাষ্ট্র ও নাগরিকের দায়িত্ব-কর্তব্য', 'বিগত সালের প্রশ্ন চর্চা'];

const SCIENCE = ['পদার্থবিজ্ঞান (বল ও গতি)', 'পদার্থবিজ্ঞান (তাপ-আলো-শব্দ)', 'পদার্থবিজ্ঞান (বিদ্যুৎ-চুম্বক)',
  'রসায়ন (মৌল ও যৌগ)', 'রসায়ন (অম্ল-ক্ষার-লবণ)', 'জীববিজ্ঞান (কোষ ও বংশগতি)',
  'জীববিজ্ঞান (মানবদেহ)', 'উদ্ভিদবিজ্ঞান', 'পরিবেশ বিজ্ঞান', 'নভোবিজ্ঞান (সৌরজগৎ)',
  'স্বাস্থ্যবিজ্ঞান ও রোগ', 'বিজ্ঞানের সাম্প্রতিক আবিষ্কার', 'বিজ্ঞানী ও তাদের আবিষ্কার',
  'দৈনন্দিন জীবনে বিজ্ঞান', 'বিগত সালের প্রশ্ন চর্চা'];

const ICT = ['কম্পিউটারের মৌলিক ধারণা', 'হার্ডওয়্যার ও সফটওয়্যার', 'নাম্বার সিস্টেম',
  'ইন্টারনেট ও নেটওয়ার্কিং', 'ই-মেইল ও ওয়েব', 'সাইবার সিকিউরিটি', 'প্রোগ্রামিং ভাষার ধারণা',
  'ডেটাবেজ মৌলিক ধারণা', 'মোবাইল ও যোগাযোগ প্রযুক্তি', 'সামাজিক যোগাযোগ মাধ্যম',
  'ডিজিটাল বাংলাদেশ ও স্মার্ট বাংলাদেশ', 'তথ্যপ্রযুক্তি আইন ও নিরাপত্তা',
  'সাম্প্রতিক প্রযুক্তি খাতের অগ্রগতি', 'সংক্ষিপ্ত রূপ (Abbreviation)', 'বিগত সালের প্রশ্ন চর্চা'];

// [topicJobSubjects.js key, topic list, canonical group it belongs to]
const SUBJECT_BLOCKS = [
  { subject: 'বাংলা ব্যাকরণ', topics: BANGLA_GRAMMAR, canonical: 'বাংলা' },
  { subject: 'বাংলা সাহিত্য', topics: BANGLA_LIT, canonical: 'বাংলা' },
  { subject: 'ইংরেজি ব্যাকরণ', topics: ENG_GRAMMAR, canonical: 'ইংরেজি' },
  { subject: 'ইংরেজি সাহিত্য', topics: ENG_LIT, canonical: 'ইংরেজি' },
  { subject: 'ভোকাবুলারি', topics: VOCAB, canonical: 'ইংরেজি' },
  { subject: 'গণিত', topics: MATH, canonical: 'গণিত' },
  { subject: 'বাংলাদেশ', topics: BANGLADESH, canonical: 'সাধারণ জ্ঞান' },
  { subject: 'আন্তর্জাতিক', topics: INTERNATIONAL, canonical: 'সাধারণ জ্ঞান' },
  { subject: 'ভূগোল, পরিবেশ ও ব্যবস্থাপনা', topics: GEO_ENV, canonical: 'সাধারণ জ্ঞান' },
  { subject: 'নৈতিকতা, মূল্যবোধ ও সুশাসন', topics: ETHICS, canonical: 'সাধারণ জ্ঞান' },
  { subject: 'বিজ্ঞান', topics: SCIENCE, canonical: 'বিজ্ঞান ও প্রযুক্তি' },
  { subject: 'তথ্য ও যোগাযোগ প্রযুক্তি', topics: ICT, canonical: 'বিজ্ঞান ও প্রযুক্তি' },
];

// Sanity check: every block's topic list length must equal its bcs-200 day
// count (SUBJECT_BLOCKS topics.length IS the bcs-200 day count for that
// subject — this doubles as both the day-count table and the content).
const TOTAL_BCS200_DAYS = SUBJECT_BLOCKS.reduce((sum, b) => sum + b.topics.length, 0);

function buildBcs200Days() {
  const days = [];
  let dayNumber = 0;
  for (let bi = 0; bi < SUBJECT_BLOCKS.length; bi++) {
    const block = SUBJECT_BLOCKS[bi];
    const isLastInCanonicalGroup =
      bi === SUBJECT_BLOCKS.length - 1 || SUBJECT_BLOCKS[bi + 1].canonical !== block.canonical;

    for (let ti = 0; ti < block.topics.length; ti++) {
      dayNumber++;
      const isLastDayOfBlock = ti === block.topics.length - 1;
      let tasks = `📘 বিষয়: ${block.subject}\n🎯 আজকের টপিক: ${block.topics[ti]}\n✅ টপিকভিত্তিক জব সলুশন থেকে এই টপিকের প্রশ্নগুলো সমাধান করুন।`;
      let autoExamSubject = null;
      let autoExamQuestionCount = null;
      let autoExamDuration = null;
      if (isLastDayOfBlock && isLastInCanonicalGroup) {
        tasks += `\n📝 আজ "${block.canonical}" বিষয়ে একটি পরীক্ষা স্বয়ংক্রিয়ভাবে চালু হবে (রুটিন থেকেই দেখা যাবে)।`;
        autoExamSubject = block.canonical;
        autoExamQuestionCount = 50;
        autoExamDuration = 45;
      } else if (isLastDayOfBlock) {
        tasks += `\n📝 "${block.subject}" ব্লক শেষ — আজ এই বিষয়ে একটি ছোট পরীক্ষা স্বয়ংক্রিয়ভাবে চালু হবে।`;
        autoExamSubject = block.subject;
        autoExamQuestionCount = 20;
        autoExamDuration = 20;
      }
      days.push({
        day_number: dayNumber,
        title: `দিন ${dayNumber} — ${block.subject}: ${block.topics[ti]}`,
        tasks,
        auto_exam_subject: autoExamSubject,
        auto_exam_question_count: autoExamQuestionCount,
        auto_exam_duration_minutes: autoExamDuration,
      });
    }
  }
  return days;
}

// job-solution: same subjects, roughly half the days, tasks focused on
// clearing the টপিকভিত্তিক জব সলুশন question bank rather than first-time study.
const JOB_SOLUTION_COUNTS = {
  'বাংলা ব্যাকরণ': 10, 'বাংলা সাহিত্য': 7, 'ইংরেজি ব্যাকরণ': 10, 'ইংরেজি সাহিত্য': 4,
  'ভোকাবুলারি': 4, 'গণিত': 15, 'বাংলাদেশ': 15, 'আন্তর্জাতিক': 10,
  'ভূগোল, পরিবেশ ও ব্যবস্থাপনা': 5, 'নৈতিকতা, মূল্যবোধ ও সুশাসন': 5,
  'বিজ্ঞান': 7, 'তথ্য ও যোগাযোগ প্রযুক্তি': 8,
};

function pickTopics(topics, count) {
  // Spread `count` picks evenly across the full topic list so a shorter
  // job-solution cycle still touches the full breadth of each subject
  // instead of just its first few topics.
  if (count >= topics.length) return topics.slice(0, count);
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(topics[Math.floor((i * topics.length) / count)]);
  }
  return picked;
}

function buildJobSolutionDays() {
  const days = [];
  let dayNumber = 0;
  for (const block of SUBJECT_BLOCKS) {
    const count = JOB_SOLUTION_COUNTS[block.subject] || 0;
    const picked = pickTopics(block.topics, count);
    for (let i = 0; i < picked.length; i++) {
      dayNumber++;
      const isLast = i === picked.length - 1;
      let tasks = `📘 বিষয়: ${block.subject}\n🎯 আজকের টপিক: ${picked[i]}\n✅ টপিকভিত্তিক জব সলুশন থেকে এই টপিকের ন্যূনতম ৫০টি প্রশ্ন সমাধান করুন।`;
      let autoExamSubject = null;
      if (isLast) {
        tasks += `\n📝 "${block.subject}" বিষয়ের জব সলুশন শেষ — আজ এই বিষয়ে একটি পরীক্ষা স্বয়ংক্রিয়ভাবে চালু হবে।`;
        autoExamSubject = block.subject;
      }
      days.push({
        day_number: dayNumber,
        title: `দিন ${dayNumber} — ${block.subject}: ${picked[i]}`,
        tasks,
        auto_exam_subject: autoExamSubject,
        auto_exam_question_count: autoExamSubject ? 20 : null,
        auto_exam_duration_minutes: autoExamSubject ? 20 : null,
      });
    }
  }
  return days;
}

async function seedCategory(client, category, days) {
  // Preserve scheduled_date across a reseed if this category was already
  // activated before — otherwise a re-run of this script (e.g. to fix a
  // typo in the content) would silently wipe out the admin's chosen
  // start_date and un-schedule every auto-exam.
  const { rows: existing } = await client.query(
    `SELECT day_number, scheduled_date FROM routine_days WHERE category = $1 AND scheduled_date IS NOT NULL`,
    [category]
  );
  const savedDates = Object.fromEntries(existing.map(r => [r.day_number, r.scheduled_date]));

  await client.query('DELETE FROM routine_days WHERE category = $1', [category]);
  for (const d of days) {
    await client.query(
      `INSERT INTO routine_days
         (category, day_number, title, tasks, exam_id, scheduled_date,
          auto_exam_subject, auto_exam_question_count, auto_exam_duration_minutes)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)`,
      [category, d.day_number, d.title, d.tasks, savedDates[d.day_number] || null,
       d.auto_exam_subject || null, d.auto_exam_question_count || null, d.auto_exam_duration_minutes || null]
    );
  }
  return days.length;
}

async function ensureWeeklyModelTestTemplate(client) {
  const { rows } = await client.query(
    `SELECT id FROM exam_templates WHERE routine_category = 'weekly-model-test' LIMIT 1`
  );
  if (rows.length) return false;
  await client.query(
    `INSERT INTO exam_templates
       (title_pattern, ministry_id, post_name, subject, grade, routine_category,
        question_count, duration_minutes, negative_marks, weekdays, run_time, active)
     VALUES
       ('সাপ্তাহিক মডেল টেস্ট', NULL, NULL, NULL, NULL, 'weekly-model-test',
        100, 90, 0.25, ARRAY[5]::smallint[], '20:00', true)`
  );
  return true;
}

async function main() {
  console.log(`bcs-200 total days from topic lists: ${TOTAL_BCS200_DAYS} (should be 200)`);
  const bcs200Days = buildBcs200Days();
  const jobSolutionDays = buildJobSolutionDays();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n1 = await seedCategory(client, 'bcs-200', bcs200Days);
    const n2 = await seedCategory(client, 'job-solution', jobSolutionDays);
    const createdTemplate = await ensureWeeklyModelTestTemplate(client);
    await client.query('COMMIT');
    console.log(`✅ bcs-200: inserted ${n1} routine days`);
    console.log(`✅ job-solution: inserted ${n2} routine days`);
    console.log(createdTemplate
      ? '✅ weekly-model-test exam_template created (every Friday 20:00, Asia/Dhaka)'
      : 'ℹ️ weekly-model-test exam_template already existed — left untouched');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
