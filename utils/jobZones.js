// utils/jobZones.js
//
// Zone Analysis ফিচারের জন্য "লক্ষ্য" (users.preparing_for) → "জোন" ম্যাপিং।
// প্রতিটা জোন হলো একগুচ্ছ utils/topicJobSubjects.js-এর এক্সাক্ট subject
// ভ্যালু — অর্থাৎ প্রশ্নব্যাংকে যে ১২টা subject ট্যাগ আগে থেকেই আছে, সেগুলোকেই
// এখানে জব-সার্কুলার-বাস্তবসম্মত ৫টা জোনে গ্রুপ করা হয়েছে (utils/subjectMap.js-এর
// ৫-গ্রুপ ভিন্ন — ওটা generic, এটা প্রাইমারি শিক্ষক নিয়োগ সিলেবাসের মতো
// job-specific)। নতুন প্রশ্ন লাগবে না — বিদ্যমান TOPIC_JOB_SUBJECTS ট্যাগিং-ই
// যথেষ্ট।
//
// নতুন লক্ষ্য/জব যোগ করতে হলে এখানে আরেকটা এন্ট্রি বসালেই হবে; বাকি সব কোড
// (zone quiz builder, zone analysis) goal config থেকেই zones/subjects পড়ে,
// hardcode করা নেই।

const JOB_GOALS = {
  'প্রাইমারি শিক্ষক হতে চাই': {
    label: 'শিক্ষকতা (Primary)',
    zones: [
      { key: 'bangla', name: 'বাংলা ভাষা', subjects: ['বাংলা ব্যাকরণ', 'বাংলা সাহিত্য'] },
      { key: 'english', name: 'English Language', subjects: ['ইংরেজি ব্যাকরণ', 'ইংরেজি সাহিত্য', 'ভোকাবুলারি'] },
      { key: 'math', name: 'গাণিতিক যুক্তি', subjects: ['গণিত'] },
      { key: 'science', name: 'সাধারণ বিজ্ঞান', subjects: ['বিজ্ঞান'] },
      { key: 'ict', name: 'কম্পিউটার ও তথ্যপ্রযুক্তি', subjects: ['তথ্য ও যোগাযোগ প্রযুক্তি'] },
    ],
  },
};

const DEFAULT_GOAL = 'প্রাইমারি শিক্ষক হতে চাই';

function getGoalConfig(goal) {
  return JOB_GOALS[goal] || JOB_GOALS[DEFAULT_GOAL];
}

// subject (exact TOPIC_JOB_SUBJECTS value) -> zone name, for this goal.
function subjectToZone(goal, subject) {
  const cfg = getGoalConfig(goal);
  const zone = cfg.zones.find(z => z.subjects.includes(subject));
  return zone ? zone.name : null;
}

module.exports = { JOB_GOALS, DEFAULT_GOAL, getGoalConfig, subjectToZone };
