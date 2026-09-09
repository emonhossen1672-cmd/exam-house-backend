// scripts/seedYearlyCycle.js
//
// Builds ONE self-repeating routine under category 'yearly-cycle', modeled
// directly on a real competitive-exam platform's ১৪ম-২০তম গ্রেড prep
// schedule (Live MCQ): an EXAM-BASED cycle, not a daily-study cycle.
//
//   - Every 2-4 days there is a subject exam (সাধারণ জ্ঞান / বাংলা সাহিত্য /
//     বাংলা ব্যাকরণ / English Grammar / English Literature / গণিত), cycling
//     through subjects in the same order the source schedule uses.
//   - Every 6th subject exam is followed by a রিভিশন পরীক্ষা covering those
//     6 exams, then a ফুল মডেল টেস্ট covering the full syllabু so far.
//   - The days BETWEEN exams are not blank — each one tells the student
//     which upcoming exam to prepare for and what its topics are, so
//     there's always a concrete task, exam day or not.
//   - The whole thing is CYCLE_LENGTH_DAYS days long (see below); once
//     services/yearlyCycleScheduler.js sees the last day's scheduled_date
//     has passed, it shifts every row forward by CYCLE_LENGTH_DAYS and
//     resets progress/exam_id, so day 1 becomes due again — same
//     auto-restart behaviour as before, it just reads the day count from
//     the DB dynamically so this file doesn't need to hardcode it anywhere
//     but EXAM_SCHEDULE below.
//
// রিভিশন ও ফুল মডেল টেস্ট days pull questions from ALL 12 টপিকভিত্তিক জব
// সলুশন subjects (the FULL_SYLLABUS_LABEL sentinel — see
// utils/topicJobSubjects.js and services/routineExamScheduler.js) since
// they're meant to be comprehensive, not subject-specific.
//
// Safe to re-run — wipes and rebuilds only 'yearly-cycle' routine_days,
// preserving each day_number's scheduled_date if it was already activated
// (so a content fix doesn't quietly un-schedule every auto-exam).
//
// Run on Render (needs DATABASE_URL in the environment):
//   node scripts/seedYearlyCycle.js

require('dotenv').config();
const pool = require('../db');
const { FULL_SYLLABUS_LABEL } = require('../utils/topicJobSubjects');

// ---------- Exam schedule, transcribed from the source platform's ৮০-পরীক্ষা
// রুটিন (১৪ম-২০তম গ্রেড), day-offsets kept exactly as their calendar gaps
// (0-indexed from the first exam) so the exam-every-2-4-days rhythm is
// preserved. subject: '__FULL__' means "pull from all 12 subjects"
// (রিভিশন/ফুল মডেল টেস্ট) — resolved to FULL_SYLLABUS_LABEL below. ----------
const EXAM_SCHEDULE = [
  {
    "offset": 0,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১",
    "topics": "প্রাচীন রাজবংশ (মৌর্য, গুপ্ত, গৌড়, পাল, সেন), প্রাচীন জনপদ (পুন্ড্র, বরেন্দ্র, বঙ্গ, সমতট, চন্দ্রদ্বীপ, গৌড়, রাঢ়, হরিকেল), উপমহাদেশের ইতিহাস (মুসলিম শাসন, মোগল শাসন, বারো ভুঁইয়া, নবাবী ও ব্রিটিশ শাসন)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 4,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-১",
    "topics": "বাংলা সাহিত্যের যুগ বিভাগ, প্রাচীন যুগ ও চর্যাপদ, সাহিত্য বিষয়ক পত্রিকা ও সম্পাদক",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 15,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-1 (Language and Grammar)",
    "topics": "Parts of Speech, Interchange of Different Parts of Speech, Gender and Number",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 18,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-১",
    "topics": "বাস্তব সংখ্যা, ল.সা.গু ও গ.সা.গু, অনুপাত ও সমানুপাত",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 22,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-২",
    "topics": "গুরুত্বপূর্ণ মহাদেশ ও দেশ (যুক্তরাষ্ট্র, যুক্তরাজ্য, ভারত, চীন, ফ্রান্স, রাশিয়া, মধ্যপ্রাচ্য, কানাডা, অস্ট্রেলিয়া, দক্ষিণ আফ্রিকা, জাপান) সম্পর্কিত সাধারণ তথ্য, ইতিহাস ও রাজনীতি, মুদ্রা, রাজধানী, জনসংখ্যা",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 26,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-২",
    "topics": "ভাষারীতি, ব্যাকরণ বিষয়ক গ্রন্থ ও ইতিহাস, পদ প্রকরণ, বচন ও লিঙ্গ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 28,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-১",
    "topics": "পরীক্ষা ১ থেকে ৬ এর সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 30,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-১",
    "topics": "সম্পূর্ণ সিলেবাস (পরীক্ষা ১-৬ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 32,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-2 (Language and Grammar)",
    "topics": "Vocabulary (Word Meaning, Synonym, Antonym, Spelling) A-H, Right form of Verb, Gerund/Participle/Infinitive",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 36,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-২",
    "topics": "লাভ-ক্ষতি, শতকরা, মুনাফা ও চক্রবৃদ্ধি মুনাফা",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 39,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৩",
    "topics": "[১৯৪৭-১৯৭০] ভাষা আন্দোলন, যুক্তফ্রন্ট, শাসনতন্ত্র আন্দোলন, শিক্ষা আন্দোলন, উনসত্তরের গণঅভ্যুত্থান, ১৯৭০ এর নির্বাচন",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 42,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-৩",
    "topics": "বাংলা সাহিত্যের অন্ধকার যুগ, মধ্যযুগের সাহিত্যধারা ও গুরুত্বপূর্ণ লেখকদের সাহিত্যকর্ম",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 46,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৪",
    "topics": "বৈশ্বিক ইতিহাস ও সভ্যতা (গুরুত্বপূর্ণ ইতিহাস, ব্যক্তিবর্গ, যুদ্ধ, বিপ্লবসমূহ)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 50,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৩",
    "topics": "দ্বি-ঘাত ও সরল সহ-সমীকরণ, অসমতা, বীজগাণিতিক সরলীকরণ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 53,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-২",
    "topics": "পরীক্ষা ৮ থেকে ১৩ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 55,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-২",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 58,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-৪",
    "topics": "শব্দ ও পদের গঠন, শব্দের প্রকারভেদ, নির্দেশক, দ্বিরুক্ত শব্দ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 61,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-3 (Language and Grammar)",
    "topics": "Vocabulary (I-R), Fill in Blanks - Sentence Completion, Voice change",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 64,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৫",
    "topics": "১৯৭১ এর অসহযোগ আন্দোলন ও মুক্তিযুদ্ধ সম্পর্কিত সকল গুরুত্বপূর্ণ বিষয়াবলি",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 68,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৪",
    "topics": "বৃত্ত ও বহুভুজ সংক্রান্ত সমাধান, সেট ও ফাংশন",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 72,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-৫",
    "topics": "রবীন্দ্রনাথ ঠাকুর, কাজী নজরুল ইসলাম, মাইকেল মধুসূদন দত্ত",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 75,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-4 (English Literature)",
    "topics": "Important Writers of the Different Ages (William Shakespeare, Charles Dickens, Ernest Hemingway, G.B Shaw, W.B Yeats)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 77,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৩",
    "topics": "পরীক্ষা ১৬ থেকে ২১ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 85,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৩",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 88,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৬",
    "topics": "আন্তর্জাতিক গুরুত্বপূর্ণ সংগঠন ও অর্থনৈতিক প্রতিষ্ঠান (UN, World Bank, IMF, UNESCO, UNICEF, UNFCC, UNEP, UNDP, ILO, WHO, WTO, FAO, EU, BRICS)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 92,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৫",
    "topics": "ত্রিকোণমিতি, সম্ভাব্যতা",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 95,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-৬",
    "topics": "ধ্বনি ও বর্ণ, ধ্বনি পরিবর্তন, বর্ণের উচ্চারণ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 98,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৭",
    "topics": "ভাষা আন্দোলন ও মুক্তিযুদ্ধভিত্তিক গান/চলচ্চিত্র/সাহিত্য, সমসাময়িক ইতিহাস, স্থাপত্য ও ভাস্কর্য, দেশের গুরুত্বপূর্ণ স্থান, নদ-নদী, জলাশয়, পাহাড়-পর্বত",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 102,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-5 (Language and Grammar)",
    "topics": "Vocabulary (S-Z), Sentence Transformation (Active-Passive, Affirmative-Negative, Assertive-Imperative-Interrogative-Optative-Exclamatory)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 105,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৬",
    "topics": "সমান্তর ও গুণোত্তর ধারা, সূচক ও লগারিদম",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 107,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৪",
    "topics": "পরীক্ষা ২৩ থেকে ২৮ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 109,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৪",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 111,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-৭",
    "topics": "শরৎচন্দ্র চট্টোপাধ্যায়, বঙ্কিমচন্দ্র চট্টোপাধ্যায়, রাজা রামমোহন রায়, মীর মশাররফ হোসেন, শামসুর রাহমান, জীবনানন্দ দাশ, সৈয়দ শামসুল হক, মুনির চৌধুরী, সুকান্ত ভট্টাচার্য",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 114,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-৮",
    "topics": "আন্তর্জাতিক গুরুত্বপূর্ণ জোট ও প্রতিষ্ঠান (ASEAN, NATO, Commonwealth, NAM, OIC, BIMSTEC, BRICS, CIRDAP, G-7, SAARC, Green Peace, Red Cross, Rotary International, Oxfam, Amnesty, Transparency International, Human Rights Watch)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 117,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-6 (English Literature)",
    "topics": "Important Writers of the Different Ages [The Neo-Classical Period - Victorian Period (Except Charles Dickens)]",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 120,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৭",
    "topics": "স্থানাংক জ্যামিতি, ঘড়ি ও সময় বিষয়ক সমস্যা, মানসিক দক্ষতা সংক্রান্ত সমস্যা সমাধান ও ধারা",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 123,
    "subject": "বিজ্ঞান ও প্রযুক্তি",
    "label": "সাধারণ জ্ঞান (বিজ্ঞান)",
    "title": "সাধারণ জ্ঞান (বিজ্ঞান): পরীক্ষা-১",
    "topics": "সাধারণ বিজ্ঞান — জীববিজ্ঞান: মানবদেহ, রোগ, খাদ্য ও পুষ্টি, ভিটামিন, ভাইরাস, ব্যাকটেরিয়া, আধুনিক চাষাবাদ পদ্ধতি (এপিকালচার, সেরিকালচার, পিসিকালচার)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 126,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-৮",
    "topics": "সন্ধি, ণ-ত্ব ও ষ-ত্ব বিধান, সমার্থক শব্দ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 128,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৫",
    "topics": "পরীক্ষা ৩০ থেকে ৩৬ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 130,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৫",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 132,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-7 (English Literature)",
    "topics": "Narration, Tag question, Proverb",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 135,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১০",
    "topics": "আন্তর্জাতিক গুরুত্বপূর্ণ চুক্তিসমূহ (দ্বিপাক্ষীয়, অর্থনৈতিক, বাণিজ্যিক, পরিবেশ ও নিরাপত্তা সংক্রান্ত)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 138,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-৯",
    "topics": "জসীমউদ্দিন, জহির রায়হান, মানিক বন্দ্যোপাধ্যায়, বেগম রোকেয়া, তারাশঙ্কর বন্দ্যোপাধ্যায়, সত্যেন্দ্রনাথ দত্ত; ডাক ও খনার বচন",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 142,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৮",
    "topics": "ঐকিক নিয়ম, গড়, পরিসংখ্যান",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 145,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১১",
    "topics": "বাংলাদেশের জাতীয় ও অর্থনৈতিক বিষয়াবলি (কৃষি, শিক্ষা, অর্থনীতি, জাতীয় গুরুত্বপূর্ণ প্রতিষ্ঠান)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 148,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-8 (English Literature)",
    "topics": "Important Writers of the Modern Ages (Except Ernest Hemingway, G.B Shaw, W.B Yeats)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 151,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৬",
    "topics": "পরীক্ষা ৩৮ থেকে ৪৩ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 153,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৬",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 155,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-১০",
    "topics": "সমাস, বাক্য প্রকরণ ও বাক্যের রূপান্তর, বানান ও বাক্যশুদ্ধি",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 159,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-৯",
    "topics": "বীজগাণিতিক রাশি, উৎপাদকে বিশ্লেষণ, বীজগাণিতিক ল.সা.গু ও গ.সা.গু, বীজগাণিতিক রাশিমালার যোগ-বিয়োগ-গুণ-ভাগ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 162,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১২",
    "topics": "জাতীয় ও আন্তর্জাতিক দিবস-প্রতিপাদ্য, বিখ্যাত ব্যক্তিদের গুরুত্বপূর্ণ সাহিত্যকর্ম, আন্তর্জাতিক গুরুত্বপূর্ণ পুরস্কারসমূহ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 165,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-9 (Language and Grammar)",
    "topics": "Sentence Correction, Translation (Bangla to English), Analogy",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 169,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-১১",
    "topics": "বাংলা সাহিত্যের পঞ্চপাণ্ডব, ভাষা আন্দোলন ও মুক্তিযুদ্ধ ভিত্তিক গান, সাহিত্য, চলচ্চিত্র",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 172,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১৩",
    "topics": "বাংলাদেশের জাতীয় অর্জনসমূহ এবং অন্যান্য (পদক, চিত্রকর্ম, পুরস্কার, খেলাধুলা)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 174,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৭",
    "topics": "পরীক্ষা ৪৬ থেকে ৫১ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 176,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৭",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 179,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-১০",
    "topics": "সরল রেখা, কোণ, ত্রিভুজ ও চতুর্ভুজ সংক্রান্ত সমস্যা সমাধান, পিথাগোরাসের উপপাদ্য",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 182,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-10 (Literature)",
    "topics": "Literary Terms, Characters and Quotations of Famous Literary Works (All Ages)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 186,
    "subject": "বিজ্ঞান ও প্রযুক্তি",
    "label": "সাধারণ জ্ঞান (বিজ্ঞান)",
    "title": "সাধারণ জ্ঞান (বিজ্ঞান): পরীক্ষা-২",
    "topics": "সাধারণ বিজ্ঞান — পদার্থবিজ্ঞান: দৈনন্দিন ব্যবহারিক বিজ্ঞান, মহাকর্ষ-অভিকর্ষ, আলো, তড়িৎ, চৌম্বক, নবায়নযোগ্য শক্তি, আবিষ্কার ও আবিষ্কারক, পরিমাপক যন্ত্র; রসায়ন: দৈনন্দিন ব্যবহারিক রসায়ন, রাসায়নিক নাম ও সংকেত, পদার্থের অবস্থা ও ধর্ম, পারমাণবিক গঠন, মৌলিক কণা, অণু ও পরমাণু",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 189,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-১২",
    "topics": "কারক-বিভক্তি, সংখ্যাবাচক শব্দ, যতিচিহ্ন",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 193,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-11 (Language and Grammar)",
    "topics": "Article and Determiner, Linking verb, Modals, Group verbs",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 196,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-১১",
    "topics": "ট্রেন, নৌকা, গতি, নল-চৌবাচ্চা, বয়স সংক্রান্ত সমস্যা ইত্যাদি",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 198,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৮",
    "topics": "পরীক্ষা ৫৩ থেকে ৫৮ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 200,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৮",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 202,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান (সংবিধান)",
    "title": "সাধারণ জ্ঞান (সংবিধান): পরীক্ষা-৯",
    "topics": "বাংলাদেশের সংবিধান — প্রস্তাবনা ও বৈশিষ্ট্য, রাষ্ট্র পরিচালনার মূলনীতিসমূহ, মৌলিক অধিকারসমূহ, গুরুত্বপূর্ণ অনুচ্ছেদ সমূহ, সংবিধানের সংশোধনীসমূহ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 205,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-১৩",
    "topics": "প্রকৃতি ও প্রত্যয়, বাগধারা, পরিভাষা, অনুবাদ (ইংরেজি থেকে বাংলা)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 208,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-12 (Language and Grammar)",
    "topics": "Tense, Appropriate preposition, Idioms and Phrases (A-M)",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 211,
    "subject": "তথ্য ও যোগাযোগ প্রযুক্তি",
    "label": "সাধারণ জ্ঞান (কম্পিউটার ও তথ্যপ্রযুক্তি)",
    "title": "সাধারণ জ্ঞান (কম্পিউটার ও তথ্যপ্রযুক্তি): পরীক্ষা-১৬",
    "topics": "কম্পিউটার সংগঠন ও পেরিফেরাল, মোবাইল প্রযুক্তি, ইন্টারনেট, তথ্যপ্রযুক্তির বড় প্রতিষ্ঠান ও সামাজিক যোগাযোগ মাধ্যম, সাইবার অপরাধ/ভাইরাস/অ্যান্টিভাইরাস, দৈনন্দিন জীবনে কম্পিউটার ও তথ্যপ্রযুক্তি",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 214,
    "subject": "বাংলা সাহিত্য",
    "label": "বাংলা সাহিত্য",
    "title": "বাংলা সাহিত্য: পরীক্ষা-১৪",
    "topics": "গুরুত্বপূর্ণ উক্তি/সংলাপ/চরিত্র (সকল যুগের), ছদ্মনাম, প্রবাদ-প্রবচন, ছন্দ ও অলংকার",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 217,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-13 (Language and Grammar)",
    "topics": "Transformation of sentence (Simple-Complex-Compound), Idioms and Phrases (N-Z), Clause",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 219,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-৯",
    "topics": "পরীক্ষা ৬১ থেকে ৬৬ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 221,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-৯",
    "topics": "সম্পূর্ণ সিলেবাস (এ পর্যন্ত অগ্রগতি অনুযায়ী)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  },
  {
    "offset": 223,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান (ভূগোল): পরীক্ষা-১৮",
    "topics": "দীর্ঘতম, উচ্চতম, বৃহত্তম, ক্ষুদ্রতম প্রভৃতি; নদী, সাগর, মহাসাগর, পর্বত, খাল, প্রণালি, সমুদ্রবন্দর, সীমারেখা; জাতীয় ও আন্তর্জাতিক গুরুত্বপূর্ণ ও ঐতিহাসিক স্থান ও স্থাপনা; ভৌগোলিক উপনাম",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 226,
    "subject": "গণিত",
    "label": "গণিত",
    "title": "গণিত: পরীক্ষা-১২",
    "topics": "পরিমিতি ও ঘনবস্তু",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 229,
    "subject": "ইংরেজি ব্যাকরণ",
    "label": "English (Language and Grammar)",
    "title": "English Exam-14 (Language and Grammar)",
    "topics": "Prefix & Suffix, Composition (paragraph, letter, etc), One word Substitution",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 232,
    "subject": "বাংলা ব্যাকরণ",
    "label": "বাংলা ব্যাকরণ",
    "title": "বাংলা ব্যাকরণ: পরীক্ষা-১৫",
    "topics": "উপসর্গ ও অনুসর্গ, এক কথায় প্রকাশ, বিপরীতার্থক শব্দ",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 235,
    "subject": "সাধারণ জ্ঞান",
    "label": "সাধারণ জ্ঞান",
    "title": "সাধারণ জ্ঞান: পরীক্ষা-১৪",
    "topics": "সাম্প্রতিক বাংলাদেশ ও আন্তর্জাতিক বিষয়াবলি, জাতীয় ও আন্তর্জাতিক রিপোর্ট-সমীক্ষা, বাংলাদেশ অর্থনৈতিক সমীক্ষা",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 238,
    "subject": "ইংরেজি সাহিত্য",
    "label": "English (Literature)",
    "title": "English Exam-15 (English Literature)",
    "topics": "Classification of English Literary Periods, Important Writers of the Different Ages [Old to Renaissance Period (Except Shakespeare)]",
    "q": 25,
    "min": 25,
    "isRevOrModel": false
  },
  {
    "offset": 240,
    "subject": "__FULL__",
    "label": "রিভিশন পরীক্ষা",
    "title": "রিভিশন পরীক্ষা-১০",
    "topics": "পরীক্ষা ৬৮ থেকে ৭৩ পর্যন্ত ৬টি পরীক্ষার সকল টপিক",
    "q": 50,
    "min": 50,
    "isRevOrModel": true
  },
  {
    "offset": 242,
    "subject": "__FULL__",
    "label": "ফুল মডেল টেস্ট",
    "title": "ফুল মডেল টেস্ট-১০",
    "topics": "সম্পূর্ণ সিলেবাস (সম্পূর্ণ চক্র শেষে চূড়ান্ত ফুল মডেল টেস্ট)",
    "q": 80,
    "min": 70,
    "isRevOrModel": true
  }
]
  .map(e => ({ ...e, subject: e.subject === '__FULL__' ? FULL_SYLLABUS_LABEL : e.subject }));

const CYCLE_LENGTH_DAYS = EXAM_SCHEDULE[EXAM_SCHEDULE.length - 1].offset + 1;

function buildYearlyCycleDays() {
  const byOffset = new Map(EXAM_SCHEDULE.map(e => [e.offset, e]));
  const days = [];

  for (let offset = 0; offset < CYCLE_LENGTH_DAYS; offset++) {
    const dayNumber = offset + 1;
    const exam = byOffset.get(offset);

    if (exam) {
      const tasks =
        `📝 আজকের পরীক্ষা: ${exam.title}\n` +
        `📘 বিষয়: ${exam.label}\n` +
        `🗒️ টপিক: ${exam.topics}\n` +
        `✅ পরীক্ষাটি রুটিন থেকে স্বয়ংক্রিয়ভাবে চালু হবে — সময়মতো অংশ নিন।`;
      days.push({
        day_number: dayNumber,
        title: `দিন ${dayNumber} — ${exam.title}`,
        tasks,
        auto_exam_subject: exam.subject,
        auto_exam_question_count: exam.q,
        auto_exam_duration_minutes: exam.min,
        auto_exam_topics: exam.topics,
      });
      continue;
    }

    // Gap day — find the next exam ahead and set it as today's prep target.
    let next = null;
    for (const e of EXAM_SCHEDULE) {
      if (e.offset > offset) { next = e; break; }
    }
    const daysLeft = next ? next.offset - offset : 0;
    const tasks = next
      ? `🎯 আসন্ন পরীক্ষা (${daysLeft} দিন পর): ${next.title}\n` +
        `📘 বিষয়: ${next.label}\n` +
        `🗒️ টপিক: ${next.topics}\n` +
        `✅ আজ এই টপিকগুলো পড়ুন এবং টপিকভিত্তিক জব সলুশন থেকে চর্চা করুন।`
      : `🔄 চক্র পর্যালোচনা — দুর্বল জায়গাগুলো রিভিশন করুন, আগামীকাল থেকে চক্র আবার দিন ১ থেকে শুরু হবে।`;
    days.push({
      day_number: dayNumber,
      title: next ? `দিন ${dayNumber} — প্রস্তুতি: ${next.title}` : `দিন ${dayNumber} — চক্র পর্যালোচনা`,
      tasks,
      auto_exam_subject: null,
      auto_exam_question_count: null,
      auto_exam_duration_minutes: null,
      auto_exam_topics: next ? next.topics : null,
    });
  }

  return days;
}

async function seedYearlyCycle(client, days) {
  const { rows: existing } = await client.query(
    `SELECT day_number, scheduled_date FROM routine_days WHERE category = 'yearly-cycle' AND scheduled_date IS NOT NULL`
  );
  const savedDates = Object.fromEntries(existing.map(r => [r.day_number, r.scheduled_date]));

  await client.query(`DELETE FROM routine_days WHERE category = 'yearly-cycle'`);
  for (const d of days) {
    await client.query(
      `INSERT INTO routine_days
         (category, day_number, title, tasks, exam_id, scheduled_date,
          auto_exam_subject, auto_exam_question_count, auto_exam_duration_minutes,
          auto_exam_topics)
       VALUES ('yearly-cycle',$1,$2,$3,NULL,$4,$5,$6,$7,$8)`,
      [d.day_number, d.title, d.tasks, savedDates[d.day_number] || null,
       d.auto_exam_subject || null, d.auto_exam_question_count || null, d.auto_exam_duration_minutes || null,
       d.auto_exam_topics || null]
    );
  }
  return days.length;
}

async function runSeed(poolArg) {
  const days = buildYearlyCycleDays();
  const client = await poolArg.connect();
  try {
    await client.query('BEGIN');
    const inserted = await seedYearlyCycle(client, days);
    await client.query('COMMIT');
    return { ok: true, totalDays: days.length, inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  (async () => {
    const days = buildYearlyCycleDays();
    console.log(`yearly-cycle total days: ${days.length} (exam-based cycle length, was ${CYCLE_LENGTH_DAYS})`);
    try {
      const result = await runSeed(pool);
      console.log(`✅ yearly-cycle: inserted ${result.inserted} routine days`);
      console.log('ℹ️ এবার অ্যাডমিন প্যানেল থেকে POST /api/routines/admin/yearly-cycle/activate দিয়ে একটি start_date সেট করুন — এরপর পুরো চক্র শেষ হলে এটি নিজে থেকেই আবার দিন ১ থেকে শুরু হবে।');
    } catch (err) {
      console.error('❌ Seeding failed, rolled back:', err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

module.exports = { runSeed, buildYearlyCycleDays, CYCLE_LENGTH_DAYS };
