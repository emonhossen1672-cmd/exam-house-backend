// services/aiGrading.js — AI-assisted grading for রিটেন (written) exam
// answers. Only used when an exam's grading_mode = 'ai' (see
// routes/writtenAnswers.routes.js). Sends the question, the admin's model
// answer, and the student's submitted answer to the Anthropic API and asks
// for marks + short Bangla feedback back as JSON.
//
// Fails soft: if ANTHROPIC_API_KEY isn't set, or the API call/parsing fails
// for any reason, this throws and the caller leaves the submission
// status='pending' so an admin can grade it manually instead — a bad AI call
// should never block a student's submission from being saved.
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = require('../config');

async function gradeWrittenAnswer({ questionText, modelAnswer, studentAnswer, maxMarks }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY সেট করা নেই');
  }
  if (!studentAnswer || !studentAnswer.trim()) {
    return { marks_awarded: 0, feedback: 'কোনো উত্তর জমা দেওয়া হয়নি।' };
  }

  const prompt = `তুমি একজন বাংলাদেশের সরকারি চাকরির পরীক্ষার রিটেন উত্তরপত্র মূল্যায়নকারী শিক্ষক।
নিচের প্রশ্ন, নমুনা/আদর্শ উত্তর এবং একজন পরীক্ষার্থীর জমাকৃত উত্তর দেওয়া হলো। পরীক্ষার্থীর উত্তরটি আদর্শ উত্তরের সাথে তুলনা করে মূল্যায়ন করো — বানান/ভাষার ধরন নয়, বরং বিষয়বস্তুর সঠিকতা ও সম্পূর্ণতা দেখে নম্বর দাও।

প্রশ্ন:
${questionText}

আদর্শ উত্তর:
${modelAnswer}

পরীক্ষার্থীর উত্তর:
${studentAnswer}

সর্বোচ্চ নম্বর: ${maxMarks}

শুধু নিচের ফরম্যাটে বিশুদ্ধ JSON আউটপুট দাও, অন্য কোনো লেখা বা মার্কডাউন ছাড়া:
{"marks_awarded": <সর্বোচ্চ ${maxMarks} এর মধ্যে একটি সংখ্যা>, "feedback": "<২-৩ বাক্যে বাংলায় সংক্ষিপ্ত মূল্যায়ন — কী ঠিক ছিল, কী বাদ পড়েছে বা ভুল ছিল>"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
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

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('AI রেসপন্স পার্স করা যায়নি: ' + cleaned.slice(0, 200));
  }

  let marks = Number(parsed.marks_awarded);
  if (!Number.isFinite(marks)) marks = 0;
  marks = Math.max(0, Math.min(maxMarks, marks));

  return { marks_awarded: marks, feedback: String(parsed.feedback || '').slice(0, 2000) };
}

module.exports = { gradeWrittenAnswer };
