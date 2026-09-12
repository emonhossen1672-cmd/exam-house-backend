// services/aiStudyCoach.js — turns the raw weak/unexplored-topic numbers
// from GET /api/exams/public/weak-topics into a short, personalized Bangla
// coaching paragraph, e.g. "বাংলা ব্যাকরণে তোমার accuracy ৪২% — এটা তোমার
// সবচেয়ে দুর্বল জায়গা। আজ ওখান থেকে ১৫টা প্রশ্ন প্র্যাকটিস করো..."
//
// Same Gemini setup as services/aiExplanation.js and the same reasons for
// choosing Gemini over Anthropic here (free tier, low-stakes, cache-once-
// per-day use case — see routes/exams.routes.js public/study-coach and
// schema.sql's ai_study_coach_cache table for the caching side of this).
//
// Fails soft: if GEMINI_API_KEY isn't set, or the call/parsing fails, this
// throws and the caller falls back to a plain, non-AI summary built
// directly from the numbers — a missing AI paragraph should never block a
// student from seeing their weak topics.
const { GEMINI_API_KEY, GEMINI_MODEL } = require('../config');

async function generateStudyAdvice({ weakTopics, unexploredTopics }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY সেট করা নেই');
  }

  const weakList = weakTopics.length
    ? weakTopics.map(t => `- ${t.subject} / ${t.topic}: accuracy ${t.accuracy}% (${t.attempts}টা চেষ্টা)`).join('\n')
    : '(এখনো কোনো দুর্বল টপিক শনাক্ত হয়নি — যথেষ্ট অ্যাটেম্পট নেই)';

  const unexploredList = unexploredTopics.length
    ? unexploredTopics.slice(0, 5).map(t => `- ${t.subject} / ${t.topic}`).join('\n')
    : '(নেই)';

  const prompt = `তুমি একজন বাংলাদেশের সরকারি চাকরির পরীক্ষার প্রস্তুতি কোচ। একজন শিক্ষার্থীর টপিক-ভিত্তিক accuracy ডেটা নিচে দেওয়া হলো। এটা দেখে তাকে ৩-৪ বাক্যে বাংলায়, বন্ধুত্বপূর্ণ কিন্তু direct ভাষায় বলো:
১) তার সবচেয়ে দুর্বল ১-২টা টপিক কোনটা এবং কেন এটা গুরুত্বপূর্ণ,
২) আজকে ঠিক কী করা উচিত (নির্দিষ্ট টপিক/সাবজেক্ট নাম দিয়ে, সংখ্যাসহ যদি প্রাসঙ্গিক হয়)।
শুধু উপদেশের টেক্সট দাও — কোনো ভূমিকা, শিরোনাম, বুলেট পয়েন্ট, JSON, বা মার্কডাউন ছাড়া, একটানা বাংলা প্যারাগ্রাফ হিসেবে।

দুর্বল টপিক (accuracy অনুযায়ী সাজানো, সবচেয়ে দুর্বলটা আগে):
${weakList}

এখনো চেষ্টা করা হয়নি এমন টপিক:
${unexploredList}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini API ব্যর্থ (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini থেকে কোনো টেক্সট রেসপন্স পাওয়া যায়নি: ' + JSON.stringify(data).slice(0, 300));

  return text.trim().slice(0, 1500);
}

module.exports = { generateStudyAdvice };
