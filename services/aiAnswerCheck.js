// services/aiAnswerCheck.js — independently solves an MCQ with Gemini
// *without* telling it the stored correct_option, so the result can be
// compared against the database to catch a wrong answer-key (OCR misread,
// bad source PDF, wrong CSV column, etc.) across a bulk-uploaded question
// bank without a human reading every question.
//
// Same Gemini setup as services/aiExplanation.js (see that file for why
// Gemini instead of Anthropic here) — free tier, so this must be called
// with a delay between requests (see the /admin/audit-answers route) to
// stay under the free-tier RPM limit.
//
// Fails soft per-question: throws on API/parse failure, caller treats
// that single question as "couldn't check" and moves on, never crashes
// the whole audit batch.
const { GEMINI_API_KEY, GEMINI_MODEL } = require('../config');

function buildPrompt({ questionText, optionA, optionB, optionC, optionD }) {
  return `তুমি একজন বাংলাদেশের সরকারি চাকরির পরীক্ষার বিশেষজ্ঞ। নিচের MCQ প্রশ্নটির সঠিক উত্তর কোনটা তা নিজে থেকে যাচাই করে বের করো। উত্তরের কোনো ইঙ্গিত তোমাকে দেওয়া হয়নি — শুধু প্রশ্ন ও অপশন দেখে তোমার নিজের জ্ঞান দিয়ে সিদ্ধান্ত নাও।

প্রশ্ন: ${questionText}
A) ${optionA}
B) ${optionB}
C) ${optionC}
D) ${optionD}

শুধু এই JSON ফরম্যাটে উত্তর দাও, আর কিছু না (কোনো ভূমিকা, মার্কডাউন কোড-ফেন্স ছাড়া):
{"answer":"A অথবা B অথবা C অথবা D","confidence":"high অথবা low","reason":"এক লাইনে বাংলায় সংক্ষিপ্ত কারণ"}

যদি প্রশ্নটি অস্পষ্ট, অসম্পূর্ণ, বা একাধিক অপশন সঠিক মনে হয়, সেক্ষেত্রে confidence "low" দাও।`;
}

function parseResponseText(text) {
  // Strip ```json fences if the model added them despite instructions.
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: pull a bare letter out of the text if JSON parsing fails.
    const m = cleaned.match(/\b([ABCD])\b/);
    if (!m) throw new Error('AI রেসপন্স থেকে উত্তর বোঝা যায়নি: ' + cleaned.slice(0, 200));
    parsed = { answer: m[1], confidence: 'low', reason: '(JSON পার্স ব্যর্থ, টেক্সট থেকে অনুমান করা হয়েছে)' };
  }
  const answer = String(parsed.answer || '').trim().toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(answer)) {
    throw new Error('AI একটা বৈধ অপশন (A/B/C/D) দেয়নি: ' + JSON.stringify(parsed).slice(0, 200));
  }
  return {
    answer,
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
    reason: String(parsed.reason || '').slice(0, 300),
  };
}

async function checkAnswer({ questionText, optionA, optionB, optionC, optionD }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY সেট করা নেই');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt({ questionText, optionA, optionB, optionC, optionD }) }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0 },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Gemini API ব্যর্থ (${response.status}): ${body.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini থেকে কোনো টেক্সট রেসপন্স পাওয়া যায়নি: ' + JSON.stringify(data).slice(0, 300));

  return parseResponseText(text);
}

module.exports = { checkAnswer };
