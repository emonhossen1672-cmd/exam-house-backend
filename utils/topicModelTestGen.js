// utils/topicModelTestGen.js
//
// প্রতিটা সাবজেক্ট+টপিক (অধ্যায়) এর জন্য কমপক্ষে MODEL_TESTS_MIN_PER_TOPIC-টা
// মডেল টেস্ট গ্যারান্টি দেওয়ার হিসাব। প্রতিযোগী অ্যাপ (Ultimate Job Solutions)
// এর "স্পেশাল মডেল" স্ক্রিনে দেখা যায়: মোট প্রশ্ন ৫৪৮৪ হলে প্রতি টেস্টে ১০০
// প্রশ্ন ধরে ৫৪টা "সম্ভাব্য টেস্ট" বানানো হয় — অর্থাৎ questions_per_test একটা
// স্ট্যান্ডার্ড সংখ্যায় ফিক্সড থাকে আর possible_tests = ⌊total / per_test⌋।
//
// টপিক-লেভেলে প্রশ্ন সংখ্যা সাবজেক্ট-লেভেলের চেয়ে অনেক কম হয়, তাই সরাসরি এই
// সূত্র ব্যবহার করলে ছোট টপিকে ১০টার কম (এমনকি ০টা) টেস্ট হয়ে যেতে পারে।
// তাই এই ফাংশন questions_per_test কে প্রয়োজনে ছোট করে হলেও কমপক্ষে ১০টা
// টেস্ট নিশ্চিত করে, আর প্রশ্ন খুব কম থাকলে (< MIN_TESTS * MIN_QUESTIONS_PER_TEST)
// ছোট ছোট শাফল-করা (কিছুটা ওভারল্যাপ-সহ) টেস্ট দিয়ে ১০টার কোটা পূরণ করে —
// যাতে একটা প্রশ্নও থাকা মাত্র "মডেল টেস্ট" ট্যাব খালি না দেখায়।

const MODEL_TESTS_MIN_PER_TOPIC = 10;      // চাহিদা অনুযায়ী: প্রতি টপিকে মিনিমাম ১০টা
const STANDARD_QUESTIONS_PER_TEST = 20;    // টপিক-লেভেলে ডিফল্ট টেস্ট সাইজ (সাবজেক্ট-লেভেলের ১০০ এর তুলনায় ছোট, যেহেতু টপিক অনেক বেশি নির্দিষ্ট)
const MIN_QUESTIONS_PER_TEST = 5;          // এর নিচে টেস্ট রাখা হয় না (খুব ছোট বলে অর্থহীন হয়ে যাবে)
const MAX_TESTS_CAP = 200;                 // নিরাপত্তা সীমা — অস্বাভাবিক বড় ডেটাসেটেও এক কলে অতিরিক্ত রো তৈরি না হয়

/**
 * @param {number} totalQuestions - এই সাবজেক্ট+টপিকে মোট প্রশ্ন সংখ্যা
 * @returns {{ questionsPerTest: number, numTests: number, allowOverlap: boolean }}
 *   allowOverlap=true মানে প্রশ্ন এতই কম যে ১০টা টেস্ট বানাতে একই প্রশ্ন
 *   একাধিক টেস্টে (আলাদা শাফল-এ) পুনরাবৃত্তি করতে হয়েছে — একটা টেস্টের
 *   *ভেতরে* কখনো ডুপ্লিকেট থাকে না, শুধু টেস্ট-থেকে-টেস্টে ওভারল্যাপ হতে পারে।
 */
function computeTopicTestPlan(totalQuestions) {
  const total = Math.max(0, totalQuestions | 0);
  if (total === 0) {
    return { questionsPerTest: 0, numTests: 0, allowOverlap: false };
  }

  // প্রশ্ন এত কম যে MIN_QUESTIONS_PER_TEST সাইজের ১০টা আলাদা (non-overlapping)
  // টেস্ট বানানো সম্ভব না — তাই ছোট সাইজে শাফল-সহ ওভারল্যাপ অনুমোদন করে
  // ঠিক ১০টা টেস্ট বানাও।
  if (total < MODEL_TESTS_MIN_PER_TOPIC * MIN_QUESTIONS_PER_TEST) {
    const perTest = Math.max(1, Math.min(total, MIN_QUESTIONS_PER_TEST));
    return { questionsPerTest: perTest, numTests: MODEL_TESTS_MIN_PER_TOPIC, allowOverlap: true };
  }

  // স্ট্যান্ডার্ড সাইজে যতগুলো non-overlapping টেস্ট হয়, সেটা হিসাব করো।
  let perTest = STANDARD_QUESTIONS_PER_TEST;
  let numTests = Math.floor(total / perTest);

  // স্ট্যান্ডার্ড সাইজে ১০টার কম হলে, ঠিক ১০টা (বা তার বেশি) নিশ্চিত করতে
  // per-test সাইজ ছোট করো — কিন্তু MIN_QUESTIONS_PER_TEST এর নিচে না।
  if (numTests < MODEL_TESTS_MIN_PER_TOPIC) {
    perTest = Math.max(MIN_QUESTIONS_PER_TEST, Math.floor(total / MODEL_TESTS_MIN_PER_TOPIC));
    numTests = Math.floor(total / perTest);
  }

  numTests = Math.min(numTests, MAX_TESTS_CAP);
  return { questionsPerTest: perTest, numTests, allowOverlap: false };
}

// Fisher–Yates শাফল (in-place)
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * questionIds (এলোমেলো ক্রম ধরে নেওয়া যায় না — এখানেই শাফল হয়) থেকে
 * computeTopicTestPlan অনুযায়ী কয়েকটা প্রশ্ন-চাঙ্ক বানিয়ে দেয়। প্রতিটা
 * চাঙ্ক একটা টেস্টের জন্য প্রশ্ন আইডির লিস্ট।
 * @param {number[]} questionIds
 * @returns {number[][]}
 */
function buildTopicTestChunks(questionIds) {
  const plan = computeTopicTestPlan(questionIds.length);
  if (!plan.numTests || !plan.questionsPerTest) return [];

  if (!plan.allowOverlap) {
    // non-overlapping: একবার শাফল করে ক্রমান্বয়ে ভাগ করে দাও
    const shuffled = shuffle(questionIds);
    const chunks = [];
    for (let i = 0; i < plan.numTests; i++) {
      chunks.push(shuffled.slice(i * plan.questionsPerTest, (i + 1) * plan.questionsPerTest));
    }
    return chunks;
  }

  // overlap অনুমোদিত: প্রতিটা টেস্টের জন্য আলাদা করে শাফল করে প্রথম
  // questionsPerTest-টা নাও (একটা টেস্টের ভেতরে ডুপ্লিকেট হবে না)
  const chunks = [];
  for (let i = 0; i < plan.numTests; i++) {
    chunks.push(shuffle(questionIds).slice(0, plan.questionsPerTest));
  }
  return chunks;
}

module.exports = {
  MODEL_TESTS_MIN_PER_TOPIC,
  STANDARD_QUESTIONS_PER_TEST,
  MIN_QUESTIONS_PER_TEST,
  computeTopicTestPlan,
  buildTopicTestChunks
};
