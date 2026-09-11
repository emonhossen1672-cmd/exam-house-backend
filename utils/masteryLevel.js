// utils/masteryLevel.js
//
// জব সলুশন বিশ্লেষণ সিস্টেম raw accuracy % দেখানোর বদলে এই "মাস্টারি লেভেল"
// ব্যবহার করে। কারণ: কম attempt-এ raw % বিভ্রান্তিকর — ৩টা প্রশ্নের ১টা ঠিক
// হলে "৩৩%" দেখানো একজন ছাত্রকে অকারণে ভয় দেখাবে, কারণ ডেটাই যথেষ্ট না।
//
// তাই লেভেল নির্ধারণ হয় accuracy এবং attempted count দুটো মিলিয়ে:
//   - MIN_ATTEMPTS-এর কম চেষ্টা করা টপিক সবসময় 'নতুন' — লেভেল ৫-এর মতো
//     overconfident দাবি করবে না।
//   - এরপর accuracy অনুযায়ী ৫টা স্তরে ভাগ হয়।
//
// UI-তে এটাই প্রাইমারি সংখ্যা, raw percentage আর attempted/correct থাকে
// ছোট করে পাশে ("১৮টির মধ্যে ১১টি সঠিক") — সংখ্যাটা লুকানো হয় না, শুধু
// সবচেয়ে বড় হরফে % না দেখিয়ে ভুল বোঝাবুঝি এড়ানো হয়।

const MIN_ATTEMPTS = 5;

const LEVELS = [
  { id: 1, label: 'নতুন শিখছি', min: 0 },
  { id: 2, label: 'অনুশীলনরত', min: 40 },
  { id: 3, label: 'মোটামুটি দক্ষ', min: 60 },
  { id: 4, label: 'দক্ষ', min: 75 },
  { id: 5, label: 'মাস্টার', min: 90 },
];

/**
 * @param {number} correct
 * @param {number} attempted
 * @returns {{ level:number, label:string, accuracy:number|null, correct:number, attempted:number, is_new:boolean }}
 */
function masteryLevel(correct, attempted) {
  const a = Number(attempted) || 0;
  const c = Number(correct) || 0;
  if (a === 0) return { level: 0, label: 'শুরু হয়নি', accuracy: null, correct: 0, attempted: 0, is_new: true };

  const accuracy = Math.round((c / a) * 100);
  if (a < MIN_ATTEMPTS) {
    return { level: 1, label: 'নতুন শিখছি', accuracy, correct: c, attempted: a, is_new: true };
  }
  let level = LEVELS[0];
  for (const l of LEVELS) if (accuracy >= l.min) level = l;
  return { level: level.id, label: level.label, accuracy, correct: c, attempted: a, is_new: false };
}

module.exports = { masteryLevel, MIN_ATTEMPTS, LEVELS };
