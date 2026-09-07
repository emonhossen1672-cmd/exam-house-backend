// services/aiExplanation.js — on-demand AI-generated explanation for MCQ
// questions that don't already have one written by an admin.
//
// Uses Google's Gemini API (GEMINI_API_KEY, see config.js) rather than
// Anthropic — Gemini has a genuinely free tier (no billing/card required,
// see aistudio.google.com/apikey), which fits this low-stakes,
// rate-limited, cache-once-per-question use case. services/aiGrading.js
// (written-answer grading) is a separate, higher-stakes feature and still
// uses Anthropic — this file does not touch that.
//
// Fails soft: if GEMINI_API_KEY isn't set, or the API call/parsing fails
// for any reason, this throws and the caller (routes/questions.routes.js)
// leaves the question without an explanation and returns a friendly
// message instead of a 500 — a missing explanation should never break the
// review/revision screen.
const { GEMINI_API_KEY, GEMINI_MODEL } = require('../config');

async function explainQuestion({ questionText, optionA, optionB, optionC, optionD, correctOption }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY সেট করা নেই');
  }

  const prompt = `তুমি একজন বাংলাদেশের সরকারি চাকরির পরীক্ষার শিক্ষক। নিচের MCQ প্রশ্নটির সঠিক উত্তর কেন সঠিক এবং বাকি অপশনগুলো কেন ভুল — এটা একজন শিক্ষার্থীকে ২-৩ বাক্যে বাংলায় সহজভাবে বুঝিয়ে দাও। মুখস্থ করার কৌশল বা মনে রাখার টিপস থাকলে যোগ করতে পারো।

প্রশ্ন: ${questionText}
ক) ${optionA}
খ) ${optionB}
গ) ${optionC}
ঘ) ${optionD}
সঠিক উত্তর: ${correctOption}

শুধু ব্যাখ্যার টেক্সট দাও, কোনো ভূমিকা, JSON, বা মার্কডাউন ছাড়া।`;

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

  return text.trim().slice(0, 2000);
}

module.exports = { explainQuestion };
