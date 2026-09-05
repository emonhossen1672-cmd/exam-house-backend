// services/examTemplateScheduler.js — polls exam_templates and auto-creates
// a real 'live' exams row each time one comes due (right weekday, run_time
// reached, not already generated today). Replaces admins manually
// re-creating the same weekly live exam by hand — which is also how a
// wrong/default duration_minutes kept slipping through before.
//
// Same hosting caveat as services/reminderScheduler.js: this runs on
// setInterval inside the web process. On a Render FREE instance that spins
// down after ~15 min idle, a template due while asleep won't fire until the
// next request wakes the app — for guaranteed on-time generation either
// upgrade to an always-on instance, or hit a dedicated route from an
// external cron (e.g. cron-job.org) every few minutes instead of relying on
// this in-process interval.
const pool = require('../db');

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // check every 2 minutes

function genSerial(examType) {
  return examType === 'written' ? `EH-MT-${Math.floor(1000 + Math.random() * 9000)}` : `EH-LV-${Math.floor(1000 + Math.random() * 9000)}`;
}

// today's date (Asia/Dhaka, via process.env.TZ set in server.js) as 'YYYY-MM-DD'
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'HH:MM' (or 'HH:MM:SS') local time right now
function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
}

// Generates one exam from a template. { force: true } skips the
// weekday/run_time/already-generated-today guards (used by the admin
// "এখনই চালান" / run-now button) but still respects `active`.
async function generateFromTemplate(template, { force = false } = {}) {
  if (!template.active && !force) {
    throw new Error('টেমপ্লেটটি নিষ্ক্রিয় করা আছে');
  }

  const isWritten = template.exam_type === 'written';
  const bankTable = isWritten ? 'written_questions' : 'questions';
  const { rows: qRows } = await pool.query(
    `SELECT id FROM ${bankTable}
     WHERE ($1::int IS NULL OR ministry_id = $1)
       AND ($2::text IS NULL OR post_name = $2)
       AND ($3::text IS NULL OR subject = $3)
       AND ($4::int IS NULL OR grade = $4)
       AND ($5::text IS NULL OR topic = $5)
       AND ($6::text IS NULL OR subtopic = $6)
     ORDER BY RANDOM() LIMIT $7`,
    [template.ministry_id, template.post_name, template.subject, template.grade, template.topic, template.subtopic, template.question_count]
  );
  if (qRows.length < template.question_count) {
    throw new Error(`প্রশ্ন যথেষ্ট নেই — দরকার ${template.question_count}টি, পাওয়া গেছে ${qRows.length}টি`);
  }
  if (isWritten && !['self_check', 'manual', 'ai'].includes(template.grading_mode)) {
    throw new Error('রিটেন টেমপ্লেটের জন্য মূল্যায়ন পদ্ধতি (grading_mode) নির্ধারিত নেই');
  }

  const today = todayDateStr();
  const startTime = `${today}T${template.run_time}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const examResult = await client.query(
      `INSERT INTO exams
         (title, type, ministry_id, post_name, subject, grade, duration_minutes, start_time,
          serial, status, negative_marks, routine_category, exam_template_id, grading_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',$10,$11,$12,$13) RETURNING *`,
      [template.title_pattern, isWritten ? 'written' : 'live', template.ministry_id, template.post_name, template.subject,
       template.grade, template.duration_minutes, startTime, genSerial(template.exam_type),
       template.negative_marks || 0, template.routine_category, template.id, isWritten ? template.grading_mode : null]
    );
    const exam = examResult.rows[0];
    const joinTable = isWritten ? 'exam_written_questions' : 'exam_questions';
    const joinCol = isWritten ? 'written_question_id' : 'question_id';
    for (let i = 0; i < qRows.length; i++) {
      await client.query(
        `INSERT INTO ${joinTable} (exam_id, ${joinCol}, position) VALUES ($1,$2,$3)`,
        [exam.id, qRows[i].id, i + 1]
      );
    }
    await client.query('UPDATE exam_templates SET last_generated_date = $1 WHERE id = $2', [today, template.id]);
    await client.query('COMMIT');
    return exam;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runDueTemplates() {
  try {
    const today = new Date();
    const weekday = today.getDay(); // 0=Sunday..6=Saturday
    const todayStr = todayDateStr();
    const nowStr = nowTimeStr();

    const { rows: templates } = await pool.query(
      `SELECT * FROM exam_templates
       WHERE active = true
         AND $1 = ANY(weekdays)
         AND run_time <= $2::time
         AND (last_generated_date IS DISTINCT FROM $3::date)`,
      [weekday, nowStr, todayStr]
    );

    for (const t of templates) {
      try {
        const exam = await generateFromTemplate(t);
        console.log(`✅ Template #${t.id} generated exam #${exam.id} ("${t.title_pattern}")`);
      } catch (err) {
        console.error(`❌ Template #${t.id} failed to generate: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('❌ examTemplateScheduler failed:', err.message);
  }
}

function startExamTemplateScheduler() {
  runDueTemplates(); // run once immediately on boot, then on the interval
  setInterval(runDueTemplates, CHECK_INTERVAL_MS);
}

module.exports = { startExamTemplateScheduler, runDueTemplates, generateFromTemplate };
