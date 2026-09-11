// utils/streak.js
//
// এতদিন এই ফাংশনটা routes/results.routes.js-এর ভেতরে লোকাল ছিল (শুধু exam
// submit করলে streak আপডেট হতো)। জব সলুশন বিশ্লেষণ সিস্টেমের জন্য নতুন
// POST /api/questions/public/attempt এন্ডপয়েন্টেও (টপিকভিত্তিক জব সলুশন
// প্র্যাকটিসে) একই streak আপডেট হওয়া দরকার — তাই এখানে বের করে দুই জায়গা
// থেকেই import করা হচ্ছে, লজিক ডুপ্লিকেট না করে।
//
// আচরণ অপরিবর্তিত: একই দিনে আবার -> unchanged. পরপর দিন -> +1. ফাঁক পড়লে -> ১-এ রিসেট।
const pool = require('../db');

async function updateStreak(userId) {
  const { rows } = await pool.query(
    'SELECT current_streak, longest_streak, last_activity_date FROM users WHERE id=$1',
    [userId]
  );
  if (!rows.length) return null;
  const u = rows[0];

  const todayRes = await pool.query('SELECT CURRENT_DATE AS today');
  const today = todayRes.rows[0].today;
  const todayStr = new Date(today).toDateString();
  const lastStr = u.last_activity_date ? new Date(u.last_activity_date).toDateString() : null;

  let newStreak = u.current_streak;
  if (lastStr === todayStr) {
    // already counted today — no change
  } else {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (lastStr === yesterday.toDateString()) {
      newStreak = u.current_streak + 1;
    } else {
      newStreak = 1;
    }
    const newLongest = Math.max(u.longest_streak, newStreak);
    await pool.query(
      'UPDATE users SET current_streak=$1, longest_streak=$2, last_activity_date=CURRENT_DATE WHERE id=$3',
      [newStreak, newLongest, userId]
    );
  }
  return { current_streak: newStreak, longest_streak: Math.max(u.longest_streak, newStreak) };
}

module.exports = { updateStreak };
