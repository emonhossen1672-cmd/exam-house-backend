// services/routineExamScheduler.js — the automatic half of "রুটিন অনুযায়ী
// পরীক্ষা জারি রাখা". Polls routine_days for rows whose scheduled_date has
// arrived and which are flagged as a test day (auto_exam_subject IS NOT
// NULL, exam_id still NULL), and auto-creates a real 'live' exam for it —
// same question-picking pattern as services/examTemplateScheduler.js.
//
// scheduled_date itself is set separately, in bulk, by an admin hitting
// POST /api/routines/admin/:category/activate — this scheduler only acts on
// dates that are already filled in.
//
// Same Render free-tier caveat as the other in-process schedulers: if the
// web process is asleep when a date arrives, it fires on the next request
// that wakes it, not necessarily exactly at midnight.
const pool = require('../db');
const { TOPIC_JOB_TO_CANONICAL } = require('../utils/subjectMap');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Reverse of TOPIC_JOB_TO_CANONICAL: canonical group -> list of the exact
// topicJobSubjects.js subjects under it, e.g. 'বাংলা' -> ['বাংলা ব্যাকরণ','বাংলা সাহিত্য']
const CANONICAL_TO_SUBJECTS = {};
for (const [exact, canonical] of Object.entries(TOPIC_JOB_TO_CANONICAL)) {
  (CANONICAL_TO_SUBJECTS[canonical] ||= []).push(exact);
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function genSerial() {
  return `EH-RT-${Math.floor(1000 + Math.random() * 9000)}`;
}

// day.auto_exam_subject can be either one of the 12 exact subjects or one of
// the 5 canonical group names — either way this returns the list of exact
// `subject` values to pull questions from.
function subjectsFor(autoExamSubject) {
  if (CANONICAL_TO_SUBJECTS[autoExamSubject]) return CANONICAL_TO_SUBJECTS[autoExamSubject];
  return [autoExamSubject]; // treat as an exact subject already
}

async function generateExamForDay(day) {
  const subjects = subjectsFor(day.auto_exam_subject);
  const questionCount = day.auto_exam_question_count || 25;

  const { rows: qRows } = await pool.query(
    `SELECT id FROM questions WHERE subject = ANY($1::text[]) ORDER BY RANDOM() LIMIT $2`,
    [subjects, questionCount]
  );
  if (qRows.length < questionCount) {
    throw new Error(`প্রশ্ন যথেষ্ট নেই ("${day.auto_exam_subject}") — দরকার ${questionCount}টি, পাওয়া গেছে ${qRows.length}টি`);
  }

  const today = todayDateStr();
  const startTime = `${today}T20:00:00`; // fixed 8pm Asia/Dhaka slot, same as the weekly-model-test template

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const examResult = await client.query(
      `INSERT INTO exams
         (title, type, duration_minutes, start_time, serial, status, negative_marks, routine_category)
       VALUES ($1,'live',$2,$3,$4,'scheduled',0,$5) RETURNING *`,
      [`রুটিন পরীক্ষা — ${day.auto_exam_subject} (দিন ${day.day_number})`,
       day.auto_exam_duration_minutes || 30, startTime, genSerial(), day.category]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRows.length; i++) {
      await client.query(
        `INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)`,
        [exam.id, qRows[i].id, i + 1]
      );
    }
    await client.query('UPDATE routine_days SET exam_id = $1 WHERE id = $2', [exam.id, day.id]);
    await client.query('COMMIT');
    return exam;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runDueRoutineExams() {
  try {
    const todayStr = todayDateStr();
    const { rows: days } = await pool.query(
      `SELECT * FROM routine_days
       WHERE scheduled_date <= $1::date
         AND auto_exam_subject IS NOT NULL
         AND exam_id IS NULL`,
      [todayStr]
    );
    for (const day of days) {
      try {
        const exam = await generateExamForDay(day);
        console.log(`✅ Routine day #${day.id} (${day.category}, দিন ${day.day_number}) generated exam #${exam.id}`);
      } catch (err) {
        console.error(`❌ Routine day #${day.id} failed to generate exam: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('❌ routineExamScheduler failed:', err.message);
  }
}

function startRoutineExamScheduler() {
  runDueRoutineExams();
  setInterval(runDueRoutineExams, CHECK_INTERVAL_MS);
}

module.exports = { startRoutineExamScheduler, runDueRoutineExams, generateExamForDay };
