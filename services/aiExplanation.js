// services/aiExplanation.js — on-demand AI-generated explanation for MCQ
// questions that don't already have one written by an admin.
//
// Mirrors services/aiGrading.js: same ANTHROPIC_API_KEY/MODEL config, same
// "fail soft" contract — if the key isn't set or the call/parse fails, this
// throws and the caller (routes/questions.routes.js) just returns the
// question without an explanation instead of blocking the student.
//
// Callers should cache the result back onto questions.explanation so the
// API is only ever called once per question (see the route for the
// UPDATE ... SET explanation = $1 that happens right after a successful call).
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = require('../config');

async function explainQuestion({ questionText, optionA, optionB, optionC, optionD, correctOption }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY সেট করা নেই');
  }

  const prompt = `তুমি একজন বাংলাদেশের সরকারি চাকরির পরীক্ষার শিক্ষক। নিচের MCQ প্রশ্নটির সঠিক উত্তর কেন সঠিক এবং বাকি অপশনগুলো কেন ভুল — এটা একজন শিক্ষার্থীকে ২-৩ বাক্যে বাংলায় সহজভাবে বুঝিয়ে দাও। মুখস্থ করার কৌশল বা মনে রাখার টিপস থাকলে যোগ করতে পারো।

প্রশ্ন: ${questionText}
ক) ${optionA}
খ) ${optionB}
গ) ${optionC}
ঘ) ${optionD}
সঠিক উত্তর: ${correctOption}

শুধু ব্যাখ্যার টেক্সট দাও, কোনো ভূমিকা, JSON, বা মার্কডাউন ছাড়া।`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API ব্যর্থ (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('AI থেকে কোনো টেক্সট রেসপন্স পাওয়া যায়নি');

  return textBlock.text.trim().slice(0, 2000);
}

module.exports = { explainQuestion };
