// routes/zone.routes.js — "জোন এনালাইসিস" (Zone Analysis)
//
// Student-facing দুর্বল-জোন-খুঁজে-বের-করা ফিচার:
//   1) POST /api/zone/start   — ১০ প্রশ্নের অনবোর্ডিং কুইজ ("জোন তৈরি করি"),
//      users.preparing_for (লক্ষ্য) অনুযায়ী প্রতিটা জোন থেকে ~সমান প্রশ্ন
//      নিয়ে বানানো একটা practice exam।
//   2) GET  /api/zone/analysis — Heat Map + তালিকা দুটো ভিউয়ের জন্য একটাই
//      কল। source (সব/প্রশ্নব্যাংক/ফ্ল্যাশকার্ড/মডেল টেস্ট) আর status
//      (সব/দুর্বল/কনফিউজড/স্ট্রং) দুটো দিয়েই ফিল্টার করা যায়।
//
// ডেটা সোর্স পুরোপুরি বিদ্যমান টেবিল থেকেই — /api/questions/public/
// topic-job-analysis-এর মতোই question_attempts (single-question practice,
// এখন source ট্যাগসহ) আর results/exam_questions (যেকোনো exam জমা) UNION
// করে জোন-ভিত্তিক রোলআপ করা হয়।
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { TOPIC_JOB_SUBJECTS } = require('../utils/topicJobSubjects');
const { getGoalConfig, subjectToZone } = require('../utils/jobZones');
const { zoneStatus } = require('../utils/zoneStatus');

const ZONE_QUIZ_QUESTION_COUNT = 10;
const ZONE_QUIZ_DURATION_MINUTES = 10;

// req.user শুধু JWT পেলোড (id/name/phone) — preparing_for টোকেনে নেই, কারণ
// প্রোফাইল থেকে যেকোনো সময় বদলাতে পারে। তাই এখানেই DB থেকে টেনে আনা হচ্ছে।
async function resolveGoal(req) {
  if (req.body?.goal || req.query?.goal) return req.body?.goal || req.query?.goal;
  const { rows } = await pool.query('SELECT preparing_for FROM users WHERE id=$1', [req.user.id]);
  return rows[0]?.preparing_for || null;
}

// exam flags -> which "source" bucket a submission counts toward.
function examSource(exam) {
  if (exam.is_zone_quiz) return 'zone_quiz';
  return 'model_test'; // live / model / practice(non-zone) / daily / auto-subject সবই এখানে
}

// POST /api/zone/start — নতুন জোন-কুইজ বানায়, প্রতিটা জোন থেকে প্রায় সমান
// প্রশ্ন নিয়ে, যতটা সম্ভব ছাত্র আগে উত্তর দেয়নি এমন প্রশ্ন বেছে।
router.post('/start', requireUser, asyncHandler(async (req, res) => {
  const goal = await resolveGoal(req);
  const cfg = getGoalConfig(goal);
  const zoneCount = cfg.zones.length;
  const perZone = Math.max(1, Math.round(ZONE_QUIZ_QUESTION_COUNT / zoneCount));

  const picked = [];
  for (const zone of cfg.zones) {
    const { rows } = await pool.query(
      `SELECT q.id FROM questions q
       WHERE q.subject = ANY($1::text[])
         AND q.id NOT IN (SELECT question_id FROM question_attempts WHERE user_id=$2)
       ORDER BY RANDOM() LIMIT $3`,
      [zone.subjects, req.user.id, perZone]
    );
    let ids = rows.map(r => r.id);
    if (ids.length < perZone) {
      // এই জোনে আনসিন প্রশ্ন যথেষ্ট নেই — বাকিটা যেকোনো প্রশ্ন দিয়ে পূরণ।
      const fillRes = await pool.query(
        `SELECT id FROM questions WHERE subject = ANY($1::text[]) AND id != ALL($2::int[])
         ORDER BY RANDOM() LIMIT $3`,
        [zone.subjects, ids.length ? ids : [0], perZone - ids.length]
      );
      ids = ids.concat(fillRes.rows.map(r => r.id));
    }
    ids.forEach(id => picked.push({ id, zone: zone.name }));
  }

  if (!picked.length) {
    return res.status(404).json({ error: 'এই লক্ষ্যের জন্য এখনো যথেষ্ট প্রশ্ন নেই' });
  }

  const examRes = await pool.query(
    `INSERT INTO exams (title, type, duration_minutes, status, is_practice, is_zone_quiz)
     VALUES ($1, 'model', $2, 'active', true, true) RETURNING id`,
    [`জোন তৈরি করি — ${cfg.label}`, ZONE_QUIZ_DURATION_MINUTES]
  );
  const examId = examRes.rows[0].id;

  await Promise.all(picked.map((p, i) =>
    pool.query(
      `INSERT INTO exam_questions (exam_id, question_id, position, tag) VALUES ($1,$2,$3,$4)`,
      [examId, p.id, i + 1, p.zone]
    )
  ));

  const qRes = await pool.query(
    `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, eq.position, eq.tag AS zone
     FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
     WHERE eq.exam_id=$1 ORDER BY eq.position`,
    [examId]
  );

  res.json({
    exam_id: examId,
    goal: cfg.label,
    duration_minutes: ZONE_QUIZ_DURATION_MINUTES,
    questions: qRes.rows,
  });
}));

// GET /api/zone/analysis?goal=&source=all|qbank|flashcard|model_test&status=all|weak|confused|strong
router.get('/analysis', requireUser, asyncHandler(async (req, res) => {
  const goal = await resolveGoal(req);
  const cfg = getGoalConfig(goal);
  const sourceFilter = req.query.source || 'all'; // all | qbank | flashcard | model_test
  const statusFilter = req.query.status || 'all'; // all | weak | confused | strong
  const userId = req.user.id;

  const combinedSql = `
    WITH combined AS (
      SELECT q.subject, qa.is_correct, qa.source
      FROM question_attempts qa JOIN questions q ON q.id = qa.question_id
      WHERE qa.user_id = $1 AND q.subject = ANY($2::text[])
      UNION ALL
      SELECT q.subject,
             (UPPER(r.answers->>(q.id::text)) = q.correct_option) AS is_correct,
             CASE WHEN e.is_zone_quiz THEN 'zone_quiz' ELSE 'model_test' END AS source
      FROM results r
      JOIN exams e ON e.id = r.exam_id
      JOIN exam_questions eq ON eq.exam_id = r.exam_id
      JOIN questions q ON q.id = eq.question_id
      WHERE r.user_id = $1 AND r.answers ? (q.id::text) AND q.subject = ANY($2::text[])
    )
    SELECT subject, source,
           COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE is_correct)::int AS correct
    FROM combined
    GROUP BY subject, source`;
  const { rows } = await pool.query(combinedSql, [userId, TOPIC_JOB_SUBJECTS]);

  const filteredRows = sourceFilter === 'all'
    ? rows
    : rows.filter(r => sourceFilter === 'model_test' ? (r.source === 'model_test' || r.source === 'zone_quiz') : r.source === sourceFilter);

  // subject rows -> zone rollup
  const byZone = {};
  cfg.zones.forEach(z => { byZone[z.name] = { correct: 0, attempted: 0 }; });
  filteredRows.forEach(r => {
    const zoneName = subjectToZone(goal, r.subject);
    if (!zoneName) return;
    byZone[zoneName].correct += r.correct;
    byZone[zoneName].attempted += r.attempted;
  });

  const STATUS_LABEL_TO_KEY = { 'দুর্বল': 'weak', 'কনফিউজড': 'confused', 'স্ট্রং': 'strong' };
  let zones = cfg.zones.map(z => {
    const v = byZone[z.name];
    const s = zoneStatus(v.correct, v.attempted);
    return {
      zone: z.name,
      zone_key: z.key,
      status: s.status,
      status_key: STATUS_LABEL_TO_KEY[s.status],
      accuracy: s.accuracy,
      correct: s.correct,
      attempted: s.attempted,
      // Heat Map রঙের জন্য 0-100 স্কোর — attempt না থাকলে 0 (লাল), যত বেশি
      // accuracy তত সবুজের দিকে।
      score: v.attempted > 0 ? s.accuracy : 0,
    };
  });

  if (statusFilter !== 'all') {
    zones = zones.filter(z => z.status_key === statusFilter);
  }

  const totalAttempted = zones.reduce((s, z) => s + z.attempted, 0);
  const totalCorrect = zones.reduce((s, z) => s + z.correct, 0);
  const overallReadiness = totalAttempted > 0 ? Math.round((totalCorrect / totalAttempted) * 100) : 0;
  const markedZoneCount = cfg.zones
    .map(z => zoneStatus(byZone[z.name].correct, byZone[z.name].attempted).status)
    .filter(s => s === 'দুর্বল' || s === 'কনফিউজড').length;

  res.json({
    goal: cfg.label,
    readiness_percent: overallReadiness,
    total_questions_practiced: totalAttempted,
    correct_answers: totalCorrect,
    marked_zone_count: markedZoneCount,
    zones,
  });
}));

module.exports = router;
