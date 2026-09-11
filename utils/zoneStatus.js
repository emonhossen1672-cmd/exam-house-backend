// utils/zoneStatus.js
//
// Zone Analysis-এর জন্য utils/masteryLevel.js-এর ৫-স্তরের বদলে সহজ ৩-স্তরের
// স্ট্যাটাস: দুর্বল / কনফিউজড / স্ট্রং। Heat Map আর তালিকা ভিউ দুটোতেই এটা
// ব্যবহার হয়। একেবারে কম attempt (< MIN_ATTEMPTS) হলে "দুর্বল" ধরা হয় —
// masteryLevel.js-এর মতো "নতুন" আলাদা করে দেখানো হয় না, কারণ Zone
// Analysis-এর পুরো উদ্দেশ্যই হলো "এখনো তেমন প্র্যাকটিস হয়নি এমন জায়গা" আগে
// দেখানো, তাই কম-attempt জোনও লাল/দুর্বল হিসেবে ফ্ল্যাগ হওয়া উচিত।

const MIN_ATTEMPTS = 3; // zone quiz-এ প্রতি জোনে মাত্র ~২টা প্রশ্ন থাকে, তাই থ্রেশহোল্ড কম

function zoneStatus(correct, attempted) {
  const a = Number(attempted) || 0;
  const c = Number(correct) || 0;
  const accuracy = a > 0 ? Math.round((c / a) * 100) : 0;

  let status;
  if (a < MIN_ATTEMPTS) status = 'দুর্বল';
  else if (accuracy < 50) status = 'দুর্বল';
  else if (accuracy < 75) status = 'কনফিউজড';
  else status = 'স্ট্রং';

  return { status, accuracy, correct: c, attempted: a };
}

module.exports = { zoneStatus, MIN_ATTEMPTS };
