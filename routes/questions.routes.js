const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { TOPIC_JOB_SUBJECTS, UNTAGGED_TOPIC, UNTAGGED_SUBTOPIC, snapToFixedSubject, normalizeText } = require('../utils/topicJobSubjects');
const { checkAnswer } = require('../services/aiAnswerCheck');
const { updateStreak } = require('../utils/streak');
const { masteryLevel } = require('../utils/masteryLevel');
const { schedule } = require('../utils/spacedRepetition');

const subjectFixUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/questions?ministry_id=&grade=&subject=&topic=&subtopic=&search=  (admin only — includes correct answer)
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, search } = req.query;
  const clauses = [];
  const params = [];

  if (ministry_id) { params.push(ministry_id); clauses.push(`q.ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`q.grade = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`q.subject = $${params.length}`); }
  if (topic) { params.push(topic); clauses.push(`q.topic = $${params.length}`); }
  if (subtopic) { params.push(subtopic); clauses.push(`q.subtopic = $${params.length}`); }
  if (search) { params.push(`%${search}%`); clauses.push(`q.question_text ILIKE $${params.length}`); }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT q.*, m.name AS ministry_name FROM questions q
     LEFT JOIN ministries m ON m.id = q.ministry_id
     ${where} ORDER BY q.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

// POST /api/questions  — add a single question
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation } = req.body;
  if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_option) {
    return res.status(400).json({ error: 'সব ঘর পূরণ করুন' });
  }
  const { rows } = await pool.query(
    `INSERT INTO questions (ministry_id, grade, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [ministry_id || null, grade || null, snapToFixedSubject(subject), normalizeText(topic) || null, normalizeText(subtopic) || null, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), explanation || null]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/questions/:id — edit a question
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation } = req.body;
  const { rows } = await pool.query(
    `UPDATE questions SET ministry_id=$1, grade=$2, subject=$3, topic=$4, subtopic=$5, question_text=$6,
     option_a=$7, option_b=$8, option_c=$9, option_d=$10, correct_option=$11, explanation=$12
     WHERE id=$13 RETURNING *`,
    [ministry_id || null, grade || null, snapToFixedSubject(subject), normalizeText(topic) || null, normalizeText(subtopic) || null, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), explanation || null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/questions/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// GET /api/questions/ministries/list — for dropdowns
router.get('/ministries/list', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ministries ORDER BY name');
  res.json(rows);
}));

// POST /api/questions/ministries — add a new ministry
router.post('/ministries', requireAdmin, asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'নাম দিন' });
  const { rows } = await pool.query(
    'INSERT INTO ministries(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING *',
    [name]
  );
  res.status(201).json(rows[0]);
}));

// GET /api/questions/topic-job-subjects/list — fixed 12-subject list, for
// the admin form's subject dropdown (single source of truth, shared with
// utils/topicJobSubjects.js) so admins can't typo a subject that then never
// shows up on টপিকভিত্তিক জব সলুশন.
router.get('/topic-job-subjects/list', requireAdmin, asyncHandler(async (req, res) => {
  res.json(TOPIC_JOB_SUBJECTS);
}));

// POST /api/questions/bulk — insert many already-structured questions at once
// body: { questions: [{ ministry_id, grade, subject, topic, subtopic, question_text, option_a..d, correct_option, explanation, post_name, exam_year }] }
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'কোনো প্রশ্ন পাওয়া যায়নি' });
  }

  const client = await pool.connect();
  let added = 0;
  const errors = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.subject || !q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d ||
          !['A', 'B', 'C', 'D'].includes(String(q.correct_option || '').toUpperCase())) {
        errors.push(`প্রশ্ন ${i + 1}: তথ্য অসম্পূর্ণ বা ফরম্যাট ভুল`);
        continue;
      }
      await client.query(
        `INSERT INTO questions (ministry_id, grade, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, post_name, exam_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [q.ministry_id || null, q.grade || null, snapToFixedSubject(q.subject), normalizeText(q.topic) || null, normalizeText(q.subtopic) || null, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
         q.correct_option.toUpperCase(), q.explanation || null, (q.post_name || '').toString().trim() || null, q.exam_year || null]
      );
      added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  res.json({ added, failed: errors.length, errors });
}));

// GET /api/questions/public/reading-list?subject=X&page=1 — plain paginated
// listing of a subject's whole question bank, 30 per page, for রিডিং লিস্ট
// (read-through study, not an exam). `subject` must be one of the 12 fixed
// টপিকভিত্তিক জব সলুশন subjects (utils/topicJobSubjects.js) — Reading List
// and টপিকভিত্তিক জব সলুশন now share the exact same subject list. This
// endpoint shows EVERY question tagged with that subject, whether or not it
// also has a topic — topic-tagged questions show up here too (superset);
// see /public/topic-job-subjects etc. below for the topic-only subset.
const READING_PAGE_SIZE = 30;
router.get('/public/reading-list', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM questions WHERE subject = $1', [subject]);
  const total = countRes.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / READING_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * READING_PAGE_SIZE;

  const { rows } = await pool.query(
    `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
            q.correct_option, q.explanation, q.post_name, q.exam_year,
            m.name AS ministry_name
     FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
     WHERE q.subject = $1
     ORDER BY q.id ASC
     LIMIT $2 OFFSET $3`,
    [subject, READING_PAGE_SIZE, offset]
  );

  res.json({ subject, page, total_pages: totalPages, total_count: total, questions: rows });
}));

// GET /api/questions/public/search?q=&subject=&page=1&unique=1 — free-text
// search across the WHOLE question bank (not just the 12 fixed টপিকভিত্তিক
// subjects — Reading List's scope). Students had no way to look up a
// question by keyword anywhere on the public site before this; everything
// else requires drilling down Subject → Topic → Subtopic first.
//
// Uses ILIKE '%q%' for substring matching (works for partial Bengali words
// too) plus pg_trgm's similarity() to rank hits by closeness rather than
// just newest-first — both backed by the idx_questions_text_trgm GIN index
// (schema.sql) so this stays fast as the question bank grows.
//
// `unique=0` disables the default dedup-by-identical-text behavior (same
// question re-entered from multiple ministry exams collapses to its
// earliest copy by default, same as /public/topic-questions above).
const SEARCH_PAGE_SIZE = 20;
router.get('/public/search', optionalUser, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  const subject = (req.query.subject || '').trim();
  const unique = req.query.unique !== '0' && req.query.unique !== 'false';
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  if (q.length < 2) return res.status(400).json({ error: 'অন্তত ২টি অক্ষর লিখে সার্চ করুন' });

  const clauses = ['q.question_text ILIKE $1'];
  const params = [`%${q}%`];
  if (subject) { params.push(subject); clauses.push(`q.subject = $${params.length}`); }
  const where = clauses.join(' AND ');

  const userId = req.user ? req.user.id : null;
  params.push(userId);
  const userParamIdx = params.length;
  params.push(q);
  const simIdx = params.length;

  const scopedCte = `
    SELECT q.id, q.subject, q.topic, q.subtopic, q.grade, q.question_text,
           q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option,
           q.explanation, q.post_name, q.exam_year, m.name AS ministry_name,
           similarity(q.question_text, $${simIdx}) AS rank,
           ROW_NUMBER() OVER (PARTITION BY q.question_text ORDER BY q.id ASC) AS dup_rank,
           EXISTS(SELECT 1 FROM question_reads qr WHERE qr.question_id = q.id AND qr.user_id = $${userParamIdx}) AS is_read,
           EXISTS(SELECT 1 FROM bookmarks b WHERE b.question_id = q.id AND b.user_id = $${userParamIdx}) AS is_favorite
    FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
    WHERE ${where}`;
  const dedupClause = unique ? 'AND dup_rank = 1' : '';

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM (${scopedCte}) t WHERE 1=1 ${dedupClause}`,
    params
  );
  const total = countRes.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * SEARCH_PAGE_SIZE;

  const { rows } = await pool.query(
    `SELECT id, subject, topic, subtopic, grade, question_text, option_a, option_b, option_c, option_d,
            correct_option, explanation, post_name, exam_year, ministry_name, is_read, is_favorite
     FROM (${scopedCte}) t
     WHERE 1=1 ${dedupClause}
     ORDER BY rank DESC, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, SEARCH_PAGE_SIZE, offset]
  );

  res.json({ q, subject: subject || null, page, total_pages: totalPages, total_count: total, questions: rows });
}));

// GET /api/questions/public/reading-list/topics?subject=X — topic cards for
// রিডিং লিস্ট's OWN Subject → Topic → Subtopic → Questions drill-down.
// Same shape as /public/topics below, but — unlike that endpoint — this one
// is a superset: every topic-tagged group PLUS one extra "অন্যান্য" row for
// this subject's untagged questions (if any exist), so a student can reach
// every question in রিডিং লিস্ট via topic, not just the ones also uploaded
// for টপিকভিত্তিক জব সলুশন. Click through with /public/subtopics and
// /public/topic-questions exactly as-is — both already special-case the
// UNTAGGED_TOPIC/UNTAGGED_SUBTOPIC label generically, regardless of which
// screen sent the request.
router.get('/public/reading-list/topics', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const { rows } = await pool.query(
    `WITH tagged AS (
       SELECT TRIM(topic) AS topic,
              COUNT(*)::int AS question_count,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(subtopic), ''), $2))::int AS subtopic_count
       FROM questions WHERE subject = $1 AND TRIM(COALESCE(topic, '')) <> ''
       GROUP BY 1
     ),
     untagged AS (
       SELECT $3::text AS topic,
              COUNT(*)::int AS question_count,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(subtopic), ''), $2))::int AS subtopic_count
       FROM questions WHERE subject = $1 AND TRIM(COALESCE(topic, '')) = ''
     )
     SELECT * FROM tagged
     UNION ALL
     SELECT * FROM untagged WHERE question_count > 0
     ORDER BY question_count DESC`,
    [subject, UNTAGGED_SUBTOPIC, UNTAGGED_TOPIC]
  );
  res.json({ subject, topics: rows });
}));

// ============================================================================
// টপিকভিত্তিক জব সলুশন — Subject → Topic → Subtopic → Questions
// Same fixed 12-subject list as Reading List (utils/topicJobSubjects.js), but
// ONLY includes questions that also have a non-empty `topic` — a question
// tagged with just a subject (no topic) is Reading-List-only. Give a
// question a topic and it appears in BOTH views; leave topic blank and it
// appears ONLY in রিডিং লিস্ট, never here.
// ============================================================================

// GET /api/questions/public/topic-job-subjects — subject-card summary for
// the টপিকভিত্তিক জব সলুশন home screen. Always returns all 12 fixed subjects
// (even ones with 0 topic-tagged questions yet), each with question_count
// (topic-tagged questions only — see note above), topic_count, like_count,
// liked, and — for a logged-in student — read progress.
router.get('/public/topic-job-subjects', optionalUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count,
            COUNT(DISTINCT TRIM(topic))::int AS topic_count
     FROM questions WHERE subject = ANY($1) AND TRIM(COALESCE(topic, '')) <> '' GROUP BY subject`,
    [TOPIC_JOB_SUBJECTS]
  );
  const bySubject = new Map(rows.map(r => [r.subject, r]));

  const likeRes = await pool.query(
    'SELECT subject, COUNT(*)::int AS like_count FROM subject_likes WHERE subject = ANY($1) GROUP BY subject',
    [TOPIC_JOB_SUBJECTS]
  );
  const likeMap = new Map(likeRes.rows.map(r => [r.subject, r.like_count]));

  let readMap = new Map();
  let likedSet = new Set();
  if (req.user) {
    const readRes = await pool.query(
      `SELECT q.subject, COUNT(*)::int AS read_count
       FROM question_reads qr JOIN questions q ON q.id = qr.question_id
       WHERE qr.user_id = $1 AND q.subject = ANY($2) GROUP BY q.subject`,
      [req.user.id, TOPIC_JOB_SUBJECTS]
    );
    readMap = new Map(readRes.rows.map(r => [r.subject, r.read_count]));
    const likedRes = await pool.query('SELECT subject FROM subject_likes WHERE user_id=$1 AND subject = ANY($2)', [req.user.id, TOPIC_JOB_SUBJECTS]);
    likedSet = new Set(likedRes.rows.map(r => r.subject));
  }

  const result = TOPIC_JOB_SUBJECTS.map(subject => {
    const row = bySubject.get(subject);
    const question_count = row ? row.question_count : 0;
    return {
      subject,
      question_count,
      topic_count: row ? row.topic_count : 0,
      like_count: likeMap.get(subject) || 0,
      liked: likedSet.has(subject),
      read_count: Math.min(readMap.get(subject) || 0, question_count)
    };
  });

  res.json(result);
}));

// POST /api/questions/public/topic-job-like  body: { subject } — toggles the
// logged-in student's ❤️ on a subject.
router.post('/public/topic-job-like', requireUser, asyncHandler(async (req, res) => {
  const subject = (req.body.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় প্রয়োজন' });

  const existing = await pool.query('SELECT 1 FROM subject_likes WHERE user_id=$1 AND subject=$2', [req.user.id, subject]);
  if (existing.rows.length) {
    await pool.query('DELETE FROM subject_likes WHERE user_id=$1 AND subject=$2', [req.user.id, subject]);
  } else {
    await pool.query('INSERT INTO subject_likes (user_id, subject) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, subject]);
  }
  const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM subject_likes WHERE subject=$1', [subject]);
  res.json({ liked: !existing.rows.length, like_count: countRes.rows[0].c });
}));

// GET /api/questions/public/topic-importance?subject=X&post_name=Y(optional)
// "প্রশ্নব্যাংক বিশ্লেষণ" — ranks topics by how many *different* exam_years
// (and post_names) they've appeared in, not just raw question_count, since a
// single bulk upload can dump many questions under one topic without that
// topic actually being a recurring/important one. Only rows with an
// exam_year tagged are counted; untagged rows can't tell us "repeated
// across years" so they're excluded rather than distorting the ranking.
router.get('/public/topic-importance', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const postName = (req.query.post_name || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const params = [subject];
  let postClause = '';
  if (postName) { params.push(postName); postClause = `AND post_name = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT TRIM(topic) AS topic,
            COUNT(*)::int AS question_count,
            COUNT(DISTINCT exam_year)::int AS years_seen,
            COUNT(DISTINCT post_name)::int AS posts_seen
     FROM questions
     WHERE subject = $1 AND TRIM(COALESCE(topic, '')) <> '' AND exam_year IS NOT NULL ${postClause}
     GROUP BY 1
     ORDER BY years_seen DESC, posts_seen DESC, question_count DESC`,
    params
  );

  const maxYears = rows.length ? rows[0].years_seen : 0;
  const cutoffIdx = Math.max(0, Math.ceil(rows.length * 0.2) - 1);
  const cutoffYears = rows.length ? rows[cutoffIdx].years_seen : 0;
  const topics = rows.map(r => ({
    ...r,
    important: maxYears > 1 && r.years_seen >= Math.max(2, cutoffYears)
  }));

  res.json({ subject, post_name: postName || null, topics });
}));

// GET /api/questions/public/topics?subject=X — topics inside one (exact)
// subject, each with its own question_count and subtopic_count, so the
// client shows a topic card (level 2) before drilling into subtopics. Only
// topic-tagged questions are considered — a question with no topic never
// appears here (it's রিডিং লিস্ট-only, see note above).
router.get('/public/topics', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const { rows } = await pool.query(
    `SELECT TRIM(topic) AS topic,
            COUNT(*)::int AS question_count,
            COUNT(DISTINCT COALESCE(NULLIF(TRIM(subtopic), ''), $2))::int AS subtopic_count
     FROM questions WHERE subject = $1 AND TRIM(COALESCE(topic, '')) <> ''
     GROUP BY 1 ORDER BY question_count DESC`,
    [subject, UNTAGGED_SUBTOPIC]
  );
  res.json({ subject, topics: rows });
}));

// GET /api/questions/public/subtopics?subject=X&topic=Y — subtopics inside
// one topic, each with question_count (level 3, leaf list before questions).
router.get('/public/subtopics', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const topic = (req.query.topic || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });
  if (!topic) return res.status(400).json({ error: 'টপিক নির্বাচন করুন' });

  const topicClause = topic === UNTAGGED_TOPIC ? `(topic IS NULL OR TRIM(topic) = '')` : `topic = $2`;
  const topicParams = topic === UNTAGGED_TOPIC ? [] : [topic];

  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(subtopic), ''), $${topicParams.length + 2}) AS subtopic, COUNT(*)::int AS question_count
     FROM questions WHERE subject = $1 AND ${topicClause}
     GROUP BY 1 ORDER BY question_count DESC`,
    [subject, ...topicParams, UNTAGGED_SUBTOPIC]
  );
  res.json({ subject, topic, subtopics: rows });
}));

// GET /api/questions/public/topic-questions?subject=X&topic=Y&subtopic=Z&page=1
// Paginated (30/page) question listing. `topic` and `subtopic` are both
// optional filters within `subject` — omit topic for "সব প্রশ্ন" at subject
// level, provide topic but omit subtopic for all of a topic's questions,
// provide both for one subtopic's questions.
const TOPIC_PAGE_SIZE = 30;
// optionalUser so logged-in students get is_read/is_favorite flags per
// question and a scope-wide progress ring (X/Total read); guests still get
// the plain question list with those flags simply false.
router.get('/public/topic-questions', optionalUser, asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const topic = (req.query.topic || '').trim();
  const subtopic = (req.query.subtopic || '').trim();
  const filter = (req.query.filter || 'all').trim(); // all | favorite | read | unread
  const unique = req.query.unique === '1' || req.query.unique === 'true';
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const clauses = ['q.subject = $1'];
  const params = [subject];

  if (topic) {
    if (topic === UNTAGGED_TOPIC) {
      clauses.push(`(q.topic IS NULL OR TRIM(q.topic) = '')`);
    } else {
      params.push(topic);
      clauses.push(`q.topic = $${params.length}`);
    }
  } else {
    // "সব প্রশ্ন" at subject level within টপিকভিত্তিক জব সলুশন means all
    // TOPIC-TAGGED questions for this subject — untagged ones are
    // রিডিং লিস্ট-only and never appear in this view (see note above).
    clauses.push(`TRIM(COALESCE(q.topic, '')) <> ''`);
  }
  if (subtopic) {
    if (subtopic === UNTAGGED_SUBTOPIC) {
      clauses.push(`(q.subtopic IS NULL OR TRIM(q.subtopic) = '')`);
    } else {
      params.push(subtopic);
      clauses.push(`q.subtopic = $${params.length}`);
    }
  }
  const where = clauses.join(' AND ');
  const userId = req.user ? req.user.id : null;
  params.push(userId); // shared $N for the is_read / is_favorite EXISTS checks below
  const userParamIdx = params.length;

  // "Unique" collapses questions that share identical text (the same
  // question re-entered from multiple ministry exams) down to the
  // earliest-added copy, by id.
  const scopedCte = `
    SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.explanation, q.post_name, q.exam_year, m.name AS ministry_name,
           ROW_NUMBER() OVER (PARTITION BY q.question_text ORDER BY q.id ASC) AS dup_rank,
           EXISTS(SELECT 1 FROM question_reads qr WHERE qr.question_id = q.id AND qr.user_id = $${userParamIdx}) AS is_read,
           EXISTS(SELECT 1 FROM bookmarks b WHERE b.question_id = q.id AND b.user_id = $${userParamIdx}) AS is_favorite
    FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
    WHERE ${where}`;
  const dedupClause = unique ? 'AND dup_rank = 1' : '';

  // Scope-wide counts (dedup applied, filter tab NOT applied) — drives the
  // progress ring, which should reflect overall completion regardless of
  // which filter tab the student currently has selected.
  const ringRes = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_read)::int AS read_count,
            COUNT(*) FILTER (WHERE is_favorite)::int AS favorite_count
     FROM (${scopedCte}) t WHERE 1=1 ${dedupClause}`,
    params
  );
  const ring = ringRes.rows[0];

  const filterClause = filter === 'favorite' ? 'AND is_favorite'
    : filter === 'read' ? 'AND is_read'
    : filter === 'unread' ? 'AND NOT is_read'
    : '';

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM (${scopedCte}) t WHERE 1=1 ${dedupClause} ${filterClause}`,
    params
  );
  const total = countRes.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * TOPIC_PAGE_SIZE;

  const { rows } = await pool.query(
    `SELECT id, question_text, option_a, option_b, option_c, option_d,
            correct_option, explanation, post_name, exam_year, ministry_name, is_read, is_favorite
     FROM (${scopedCte}) t
     WHERE 1=1 ${dedupClause} ${filterClause}
     ORDER BY id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, TOPIC_PAGE_SIZE, offset]
  );

  res.json({
    subject, topic: topic || null, subtopic: subtopic || null, page, total_pages: totalPages, total_count: total,
    scope_total: ring.total, scope_read: ring.read_count, scope_favorite: ring.favorite_count,
    questions: rows
  });
}));

// GET /api/questions/public/answer-stats?ids=1,2,3 — for each question id,
// how many submitted results picked each option (A/B/C/D), pulled from the
// results.answers JSONB blob across every exam attempt ever submitted.
// Used by টপিকভিত্তিক জব সলুশন's per-question "কতজন কোনটা বেছেছে" stats icon.
router.get('/public/answer-stats', asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  if (!ids.length) return res.json({});

  const { rows } = await pool.query(
    `SELECT (kv.key)::int AS qid, UPPER(kv.value) AS opt, COUNT(*)::int AS cnt
     FROM results r, jsonb_each_text(r.answers) AS kv(key, value)
     WHERE (kv.key)::int = ANY($1::int[])
     GROUP BY qid, opt`,
    [ids]
  );

  const out = {};
  ids.forEach(id => { out[id] = { A: 0, B: 0, C: 0, D: 0, total: 0 }; });
  rows.forEach(r => {
    if (!out[r.qid]) out[r.qid] = { A: 0, B: 0, C: 0, D: 0, total: 0 };
    if (['A', 'B', 'C', 'D'].includes(r.opt)) {
      out[r.qid][r.opt] = r.cnt;
      out[r.qid].total += r.cnt;
    }
  });
  res.json(out);
}));

// POST /api/questions/public/mark-read  body: { question_ids: [...] } —
// records that the logged-in student has opened/revealed these questions.
router.post('/public/mark-read', requireUser, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.question_ids)
    ? req.body.question_ids.map(Number).filter(Number.isFinite)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'question_ids প্রয়োজন' });

  const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
  await pool.query(
    `INSERT INTO question_reads (user_id, question_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [req.user.id, ...ids]
  );
  res.json({ ok: true, marked: ids.length });
}));

// DELETE /api/questions/public/mark-read/:questionId — undo a read mark
// (used by টপিকভিত্তিক জব সলুশনের explicit "পড়া হয়েছে" checkbox, so a
// student can uncheck it if toggled by mistake).
router.delete('/public/mark-read/:questionId', requireUser, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM question_reads WHERE user_id=$1 AND question_id=$2',
    [req.user.id, req.params.questionId]
  );
  res.json({ ok: true });
}));

// ===================== জব সলুশন বিশ্লেষণ সিস্টেম =====================

// POST /api/questions/public/attempt  body: { question_id, selected_option } —
// টপিকভিত্তিক জব সলুশন-কে "পড়া হয়েছে" চেকবক্স থেকে "ট্যাপ করে চেক করো" মোডে
// বদলে দেয়। প্রতিটা উত্তর question_attempts-এ লগ হয় (এটাই বিশ্লেষণ সিস্টেমের
// মূল ডেটা সোর্স), সাথে সাথে read হিসেবেও গণ্য হয় (আলাদা mark-read কল লাগে
// না), আর ভুল হলে বিদ্যমান spaced-repetition ডেক (revision_cards)-এ যোগ হয় —
// revision.routes.js যেভাবে exam-এর ভুল প্রশ্ন যোগ করে ঠিক সেভাবেই।
router.post('/public/attempt', requireUser, asyncHandler(async (req, res) => {
  const questionId = parseInt(req.body.question_id, 10);
  const selected = String(req.body.selected_option || '').toUpperCase();
  if (!Number.isFinite(questionId) || !['A', 'B', 'C', 'D'].includes(selected)) {
    return res.status(400).json({ error: 'question_id ও selected_option প্রয়োজন' });
  }

  const { rows } = await pool.query('SELECT correct_option FROM questions WHERE id=$1', [questionId]);
  if (!rows[0]) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  const isCorrect = rows[0].correct_option === selected;
  const userId = req.user.id;

  await pool.query(
    `INSERT INTO question_attempts (user_id, question_id, selected_option, is_correct)
     VALUES ($1,$2,$3,$4)`,
    [userId, questionId, selected, isCorrect]
  );
  await pool.query(
    'INSERT INTO question_reads (user_id, question_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, questionId]
  );

  if (!isCorrect) {
    const cardRes = await pool.query(
      'SELECT repetitions, ease_factor, interval_days FROM revision_cards WHERE user_id=$1 AND question_id=$2',
      [userId, questionId]
    );
    const card = cardRes.rows[0] || { repetitions: 0, ease_factor: 2.5, interval_days: 0 };
    const next = schedule(card, 'wrong');
    await pool.query(
      `INSERT INTO revision_cards (user_id, question_id, repetitions, ease_factor, interval_days, due_date, last_result, source)
       VALUES ($1,$2,$3,$4,$5,$6,'wrong','topic-job')
       ON CONFLICT (user_id, question_id) DO UPDATE SET
         repetitions=$3, ease_factor=$4, interval_days=$5, due_date=$6, last_result='wrong'`,
      [userId, questionId, next.repetitions, next.ease_factor, next.interval_days, next.due_date]
    );
  }

  const streak = await updateStreak(userId);
  res.json({ is_correct: isCorrect, correct_option: rows[0].correct_option, streak });
}));

// GET /api/questions/public/topic-job-analysis?subject= — লগ-ইন করা ছাত্রের
// জন্য subject/topic/subtopic-ভিত্তিক মাস্টারি বিশ্লেষণ। দুটো সোর্স মেলানো
// হয়: question_attempts (টপিকভিত্তিক জব সলুশন প্র্যাকটিস) + results (জব-সলুশন
// রুটিন-অটো-জেনারেটেড এক্সাম, exam_questions জয়েন করে)। raw percentage-এর
// বদলে masteryLevel() থেকে পাওয়া লেভেল প্রাইমারি সংখ্যা হিসেবে ফেরত যায় —
// কম attempt-এ % বিভ্রান্তিকর, দেখুন utils/masteryLevel.js।
router.get('/public/topic-job-analysis', requireUser, asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const userId = req.user.id;

  const combinedSql = `
    WITH combined AS (
      SELECT q.subject, q.topic, q.subtopic, qa.is_correct, qa.attempted_at::date AS d
      FROM question_attempts qa JOIN questions q ON q.id = qa.question_id
      WHERE qa.user_id = $1
      UNION ALL
      SELECT q.subject, q.topic, q.subtopic,
             (UPPER(r.answers->>(q.id::text)) = q.correct_option) AS is_correct,
             r.submitted_at::date AS d
      FROM results r
      JOIN exam_questions eq ON eq.exam_id = r.exam_id
      JOIN questions q ON q.id = eq.question_id
      WHERE r.user_id = $1 AND r.answers ? (q.id::text)
    )
    SELECT subject, topic, subtopic,
           COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE is_correct)::int AS correct
    FROM combined
    WHERE subject = ANY($2::text[]) ${subject ? 'AND subject = $3' : ''}
    GROUP BY subject, topic, subtopic`;
  const params = subject ? [userId, TOPIC_JOB_SUBJECTS, subject] : [userId, TOPIC_JOB_SUBJECTS];
  const { rows } = await pool.query(combinedSql, params);

  // সাবজেক্ট-লেভেলে রোলআপ (টপিক না মিলিয়ে) — ড্যাশবোর্ডের র‍্যাংকড লিস্টের জন্য।
  const bySubject = {};
  rows.forEach(r => {
    if (!bySubject[r.subject]) bySubject[r.subject] = { correct: 0, attempted: 0, topics: [] };
    bySubject[r.subject].correct += r.correct;
    bySubject[r.subject].attempted += r.attempted;
    bySubject[r.subject].topics.push({
      topic: r.topic || null, subtopic: r.subtopic || null,
      ...masteryLevel(r.correct, r.attempted)
    });
  });
  const subjects = Object.entries(bySubject)
    .map(([s, v]) => ({ subject: s, ...masteryLevel(v.correct, v.attempted), topics: v.topics }))
    .sort((a, b) => (a.accuracy ?? 999) - (b.accuracy ?? 999)); // দুর্বল আগে

  // পিয়ার তুলনা: সব ইউজারের overall accuracy-তে এই ইউজারের percentile।
  const percRes = await pool.query(`
    WITH per_user AS (
      SELECT user_id, COUNT(*) FILTER (WHERE is_correct)::float / NULLIF(COUNT(*),0) AS acc
      FROM question_attempts GROUP BY user_id HAVING COUNT(*) >= 10
    )
    SELECT PERCENT_RANK() OVER (ORDER BY acc) AS pr, user_id
    FROM per_user`);
  const mine = percRes.rows.find(r => r.user_id === userId);
  const percentile = mine ? Math.round(mine.pr * 100) : null;

  // গত ৭ দিনের দৈনিক accuracy ট্রেন্ড।
  const trendRes = await pool.query(`
    SELECT attempted_at::date AS d,
           COUNT(*) FILTER (WHERE is_correct)::float / NULLIF(COUNT(*),0) * 100 AS acc
    FROM question_attempts
    WHERE user_id=$1 AND attempted_at >= CURRENT_DATE - INTERVAL '6 days'
    GROUP BY d ORDER BY d`, [userId]);

  res.json({
    subjects,
    percentile,
    trend: trendRes.rows.map(r => ({ date: r.d, accuracy: r.acc !== null ? Math.round(r.acc) : null }))
  });
}));

// GET /api/questions/public/action-plan?limit=10 — "আজকের অ্যাকশন প্ল্যান"।
// নতুন কিছু বানানো হয়নি — বিদ্যমান revision_cards ডিউ-কিউই টেনে আনা হচ্ছে,
// শুধু জব-সলুশন সাবজেক্টে ফিল্টার করে আর দুর্বল সাবজেক্ট আগে রেখে সাজানো,
// যাতে ছাত্র সবচেয়ে জরুরি জায়গা থেকেই শুরু করে।
router.get('/public/action-plan', requireUser, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 30);
  const { rows } = await pool.query(`
    SELECT rc.question_id, rc.due_date, rc.last_result, q.subject, q.topic, q.subtopic,
           q.question_text
    FROM revision_cards rc JOIN questions q ON q.id = rc.question_id
    WHERE rc.user_id=$1 AND rc.due_date <= CURRENT_DATE AND q.subject = ANY($2::text[])
    ORDER BY rc.due_date ASC
    LIMIT $3`,
    [req.user.id, TOPIC_JOB_SUBJECTS, limit]
  );
  res.json({ due_count: rows.length, items: rows });
}));

// GET /api/questions/public/:id/explanation — "কেন ভুল হলো?" button target.
// If an admin already wrote an explanation, return it straight from the DB
// (free, instant). Otherwise generate one via AI on first request and cache
// it onto questions.explanation so every future student who misses the same
// question gets the cached version instead of a fresh (paid) API call.
// Fails soft: if GEMINI_API_KEY isn't set or the call fails, respond with
// a friendly message instead of a 500 — a missing explanation should never
// break the revision/result screen.
router.get('/public/:id/explanation', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT question_text, option_a, option_b, option_c, option_d, correct_option, explanation
     FROM questions WHERE id = $1`,
    [req.params.id]
  );
  const q = rows[0];
  if (!q) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });

  if (q.explanation && q.explanation.trim()) {
    return res.json({ explanation: q.explanation, source: 'admin' });
  }

  try {
    const { explainQuestion } = require('../services/aiExplanation');
    const explanation = await explainQuestion({
      questionText: q.question_text,
      optionA: q.option_a,
      optionB: q.option_b,
      optionC: q.option_c,
      optionD: q.option_d,
      correctOption: q.correct_option,
    });
    await pool.query('UPDATE questions SET explanation = $1 WHERE id = $2', [explanation, req.params.id]);
    res.json({ explanation, source: 'ai' });
  } catch (err) {
    // Log the real reason (rate limit, bad key, network blip, etc.) so it's
    // visible in Render logs — the JSON response to the student stays a
    // generic friendly message either way, per aiExplanation.js's fail-soft
    // contract, but silently swallowing it here made this impossible to
    // debug from the outside.
    console.error(`❌ AI explanation failed for question ${req.params.id}:`, err.message);
    res.status(200).json({ explanation: null, error: 'এই মুহূর্তে ব্যাখ্যা তৈরি করা যায়নি, একটু পরে আবার চেষ্টা করুন।' });
  }
}));

// GET /api/questions/admin/subjects-raw — every distinct raw `subject` value
// in the bank with its question count and which of the 12 fixed টপিকভিত্তিক
// GET /api/questions/admin/subjects-raw — every distinct raw `subject` value
// in the bank with its question count (and how many of those have a topic
// tag) and which of the 12 fixed subjects (if any) it exactly matches.
// Reading List and টপিকভিত্তিক জব সলুশন now share this same 12-subject list:
// a subject NOT in the fixed list is invisible to BOTH until renamed to one
// of the 12; a subject that IS in the list but has 0 topic-tagged questions
// shows up in রিডিং লিস্ট only. `suggested_fixed_subject` is set when the raw
// text merely looks slightly off (stray space, invisible character, NFD vs
// NFC form) but normalizes to one of the 12 — the admin UI uses this to
// offer a one-tap fix instead of making the admin retype the exact string.
router.get('/admin/subjects-raw', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT subject, COUNT(*)::int AS question_count,
           COUNT(*) FILTER (WHERE TRIM(COALESCE(topic, '')) <> '')::int AS topic_tagged_count
    FROM questions GROUP BY subject ORDER BY question_count DESC
  `);
  res.json(rows.map(r => {
    const matches = TOPIC_JOB_SUBJECTS.includes(r.subject);
    const snapped = snapToFixedSubject(r.subject);
    const suggestion = (!matches && TOPIC_JOB_SUBJECTS.includes(snapped)) ? snapped : null;
    return {
      ...r,
      matches_topic_job_subject: matches,
      suggested_fixed_subject: suggestion
    };
  }));
}));

// PUT /api/questions/admin/rename-subject — bulk-relabels every question
// currently tagged with one raw subject string to another (e.g. to fix a
// mismatched spelling so it lines up with one of the 12 fixed subjects).
// Matching is done in JS via normalizeText (NFC + whitespace cleanup)
// instead of a plain SQL TRIM, because the whole reason a subject ends up
// mismatched in the first place is usually an invisible character or
// Unicode-form difference that TRIM() alone can't see — so a plain
// TRIM(subject)=$2 comparison would silently match nothing.
router.put('/admin/rename-subject', requireAdmin, asyncHandler(async (req, res) => {
  const from = normalizeText(req.body.from);
  const to = snapToFixedSubject(req.body.to);
  if (!from || !to) return res.status(400).json({ error: 'from ও to দুটোই দিতে হবে' });

  const { rows } = await pool.query('SELECT id, subject FROM questions');
  const ids = rows.filter(r => normalizeText(r.subject) === from).map(r => r.id);
  if (!ids.length) return res.json({ updated: 0 });

  const { rowCount } = await pool.query('UPDATE questions SET subject=$1 WHERE id = ANY($2)', [to, ids]);
  res.json({ updated: rowCount });
}));

// GET /api/questions/admin/export-by-subject?subject=X — downloads every
// question currently tagged with raw subject text X as an .xlsx file, one
// row per question with its `id` in the first column. For a MIXED raw
// subject (e.g. "বাংলা", "সব", "বাংলা / ইংরেজি / গণিত / সাধারণ জ্ঞান") a
// single rename-subject can't fix it — different rows really belong under
// different fixed subjects. Workflow: export → open in Excel/Sheets → read
// each question_text and type the correct one of the 12 fixed subjects into
// the `subject` column for that row (id column must stay untouched) →
// re-upload via PUT /admin/bulk-update-subjects below, which updates each
// row BY ID instead of re-inserting duplicates. Matching for export uses
// normalizeText (like rename-subject) so it also catches invisible-character
// variants of the same raw subject.
router.get('/admin/export-by-subject', requireAdmin, asyncHandler(async (req, res) => {
  const raw = normalizeText(req.query.subject);
  if (!raw) return res.status(400).json({ error: 'subject প্রয়োজন' });

  const { rows } = await pool.query(
    `SELECT id, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d,
            correct_option, explanation, post_name, exam_year
     FROM questions ORDER BY id ASC`
  );
  const matched = rows.filter(r => normalizeText(r.subject) === raw);
  if (!matched.length) return res.status(404).json({ error: 'এই subject-এর কোনো প্রশ্ন পাওয়া যায়নি' });

  const sheetRows = matched.map(r => ({
    id: r.id,
    subject: r.subject,
    topic: r.topic || '',
    subtopic: r.subtopic || '',
    question_text: r.question_text,
    option_a: r.option_a, option_b: r.option_b, option_c: r.option_c, option_d: r.option_d,
    correct: r.correct_option,
    explanation: r.explanation || '',
    post_name: r.post_name || '',
    year: r.exam_year || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, 'questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="subject-fix-${Date.now()}.xlsx"`);
  res.send(buf);
}));

// PUT /api/questions/admin/bulk-update-subjects  (multipart/form-data, field
// name: file) — the other half of export-by-subject above. Reads back the
// edited .xlsx/.csv and, for each row with a valid `id`, updates JUST that
// question's subject (snapped to one of the 12 fixed subjects) and, if
// present, topic/subtopic. Rows with a blank/invalid id or subject are
// skipped and reported — this never inserts new questions, only relabels
// existing ones, so re-running it is always safe.
router.put('/admin/bulk-update-subjects', requireAdmin, subjectFixUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });

  let rows;
  try {
    const name = req.file.originalname.toLowerCase();
    if (name.endsWith('.csv')) {
      rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } else {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'ফাইল পড়া যায়নি — CSV বা XLSX ফরম্যাট ঠিক আছে কিনা দেখুন' });
  }
  if (!rows.length) return res.status(400).json({ error: 'ফাইলে কোনো সারি পাওয়া যায়নি' });

  const client = await pool.connect();
  let updated = 0;
  const errors = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const id = parseInt(r.id, 10);
      const subject = snapToFixedSubject(r.subject);
      if (!Number.isFinite(id)) { errors.push(`সারি ${i + 2}: id ঠিক নেই`); continue; }
      if (!subject) { errors.push(`সারি ${i + 2} (id ${id}): subject ফাঁকা — বাদ দেওয়া হয়েছে`); continue; }
      if (!TOPIC_JOB_SUBJECTS.includes(subject)) {
        errors.push(`সারি ${i + 2} (id ${id}): "${r.subject}" — ১২টার একটার সাথেও মিলছে না, বাদ দেওয়া হয়েছে`);
        continue;
      }
      const hasTopic = r.topic !== undefined && r.topic !== '';
      const hasSubtopic = r.subtopic !== undefined && r.subtopic !== '';
      const { rowCount } = await client.query(
        `UPDATE questions SET subject = $1${hasTopic ? ', topic = $3' : ''}${hasSubtopic ? `, subtopic = $${hasTopic ? 4 : 3}` : ''}
         WHERE id = $2`,
        [subject, id, ...(hasTopic ? [normalizeText(r.topic) || null] : []), ...(hasSubtopic ? [normalizeText(r.subtopic) || null] : [])]
      );
      if (rowCount === 0) { errors.push(`সারি ${i + 2}: id ${id} খুঁজে পাওয়া যায়নি`); continue; }
      updated++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  res.json({ updated, failed: errors.length, errors });
}));

// PUT /api/questions/admin/bulk-retag — body: { question_ids: [...], subject?, topic?, subtopic? }
// Bulk-reassign topic/subtopic (and optionally subject) for a hand-picked
// set of question ids — the fix for questions that ended up under the wrong
// topic. Only the fields actually present in the body get updated; pass an
// empty string for topic/subtopic to clear it back to "অন্যান্য".
router.put('/admin/bulk-retag', requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.question_ids)
    ? req.body.question_ids.map(Number).filter(Number.isFinite)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'question_ids প্রয়োজন' });

  const sets = [];
  const params = [];
  if (req.body.subject !== undefined) { params.push(snapToFixedSubject(req.body.subject)); sets.push(`subject = $${params.length}`); }
  if (req.body.topic !== undefined) { params.push(normalizeText(req.body.topic) || null); sets.push(`topic = $${params.length}`); }
  if (req.body.subtopic !== undefined) { params.push(normalizeText(req.body.subtopic) || null); sets.push(`subtopic = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'subject, topic বা subtopic — অন্তত একটা দিন' });

  params.push(ids);
  const { rowCount } = await pool.query(
    `UPDATE questions SET ${sets.join(', ')} WHERE id = ANY($${params.length})`,
    params
  );
  res.json({ updated: rowCount });
}));

// GET /api/questions/admin/audit-corrupted?subject=&limit=200
// Finds questions that look broken from an OCR/PDF bulk upload: a missing
// option (blank, '-', '—', '_'), or option/question text containing stray
// OCR-garbage characters (¢, ©, $, or a lone unmatched bracket). Doesn't
// delete anything — just flags candidates for the admin to review.
router.get('/admin/audit-corrupted', requireAdmin, asyncHandler(async (req, res) => {
  const { subject, limit } = req.query;
  const params = [];
  const clauses = [
    `trim(option_a) IN ('', '-', '—', '_')`,
    `trim(option_b) IN ('', '-', '—', '_')`,
    `trim(option_c) IN ('', '-', '—', '_')`,
    `trim(option_d) IN ('', '-', '—', '_')`,
    `question_text ~ '[¢©]'`, `option_a ~ '[¢©]'`, `option_b ~ '[¢©]'`, `option_c ~ '[¢©]'`, `option_d ~ '[¢©]'`,
    // a ')' or ']' with no matching '(' / '[' earlier in the same field — common OCR artifact seen in the sample
    `option_a ~ '\\)[^(]*$' AND option_a !~ '\\('`,
    `option_b ~ '\\)[^(]*$' AND option_b !~ '\\('`,
    `option_c ~ '\\)[^(]*$' AND option_c !~ '\\('`,
    `option_d ~ '\\)[^(]*$' AND option_d !~ '\\('`,
  ];
  let where = `(${clauses.join(' OR ')})`;
  if (subject) { params.push(subject); where += ` AND subject = $${params.length}`; }
  params.push(Math.min(parseInt(limit) || 200, 1000));

  const { rows } = await pool.query(
    `SELECT id, subject, question_text, option_a, option_b, option_c, option_d, correct_option, created_at
     FROM questions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ count: rows.length, questions: rows });
}));

// PATCH /api/questions/admin/:id/correct-option  body: { correct_option: 'A' }
// Lightweight fix-just-the-answer-key endpoint — unlike PUT /:id this
// doesn't require resending question_text/options, so the audit-answers
// tool below can apply an AI-suggested correction with one call.
router.patch('/admin/:id/correct-option', requireAdmin, asyncHandler(async (req, res) => {
  const correct = String(req.body.correct_option || '').trim().toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(correct)) {
    return res.status(400).json({ error: 'correct_option এর মান A/B/C/D হতে হবে' });
  }
  const { rows } = await pool.query(
    'UPDATE questions SET correct_option = $1 WHERE id = $2 RETURNING id, correct_option',
    [correct, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// GET /api/questions/admin/audit-answers?subject=&limit=20&after_id=0
// Answer-key audit: independently asks the AI to solve each question
// (without telling it the stored correct_option) and flags rows where the
// AI's answer disagrees with what's in the database — a much smaller list
// than the full question bank for an admin to actually review.
//
// Runs one small batch per request (default/max 25 questions) with a
// delay between each Gemini call to stay under the free-tier rate limit
// (see services/aiAnswerCheck.js). The client calls this repeatedly,
// paging forward with after_id, until done=true.
//
// This is a signal, not a verdict — the AI can be wrong too, especially on
// ambiguous or oddly-worded questions (that's what "confidence: low" is
// for). Nothing gets changed automatically; the admin reviews and decides.
const AUDIT_ANSWERS_DELAY_MS = 4500; // ~13 req/min, under Gemini free-tier RPM caps
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

router.get('/admin/audit-answers', requireAdmin, asyncHandler(async (req, res) => {
  const { subject, after_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 20, 25);

  const params = [];
  const clauses = [];
  if (subject) { params.push(subject); clauses.push(`subject = $${params.length}`); }
  if (after_id) { params.push(parseInt(after_id) || 0); clauses.push(`id > $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, subject, question_text, option_a, option_b, option_c, option_d, correct_option
     FROM questions ${where} ORDER BY id ASC LIMIT $${params.length}`,
    params
  );

  const mismatches = [];
  const failed = [];
  let checked = 0;
  let lastId = after_id ? parseInt(after_id) || 0 : 0;

  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    lastId = q.id;
    if (i > 0) await sleep(AUDIT_ANSWERS_DELAY_MS);
    try {
      const result = await checkAnswer({
        questionText: q.question_text,
        optionA: q.option_a, optionB: q.option_b, optionC: q.option_c, optionD: q.option_d,
      });
      checked++;
      if (result.answer !== q.correct_option) {
        mismatches.push({
          id: q.id, subject: q.subject, question_text: q.question_text,
          option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d,
          correct_option: q.correct_option,
          ai_answer: result.answer, ai_confidence: result.confidence, ai_reason: result.reason,
        });
      }
    } catch (err) {
      failed.push({ id: q.id, error: err.message });
    }
  }

  res.json({
    checked,
    scanned: rows.length,
    mismatches,
    failed,
    last_id: lastId,
    done: rows.length < limit,
  });
}));

// DELETE /api/questions/admin/bulk  body: { ids: [1,2,3] }
router.delete('/admin/bulk', requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids প্রয়োজন' });
  const { rowCount } = await pool.query('DELETE FROM questions WHERE id = ANY($1)', [ids]);
  res.json({ deleted: rowCount });
}));

// DELETE /api/questions/admin/by-topic  body: { subject, topic, subtopic? }
// Permanently deletes every question under a subject+topic (optionally
// narrowed to one subtopic) — unlike the retag-to-blank trick in the admin
// panel, which only removes the tag and leaves the questions in place.
router.delete('/admin/by-topic', requireAdmin, asyncHandler(async (req, res) => {
  const { subject, topic, subtopic } = req.body;
  if (!subject || !topic) return res.status(400).json({ error: 'subject ও topic দুটোই প্রয়োজন' });

  const clauses = ['subject = $1'];
  const params = [subject];

  if (topic === UNTAGGED_TOPIC) {
    clauses.push(`(topic IS NULL OR TRIM(topic) = '')`);
  } else {
    params.push(topic);
    clauses.push(`topic = $${params.length}`);
  }

  if (subtopic) {
    if (subtopic === UNTAGGED_SUBTOPIC) {
      clauses.push(`(subtopic IS NULL OR TRIM(subtopic) = '')`);
    } else {
      params.push(subtopic);
      clauses.push(`subtopic = $${params.length}`);
    }
  }

  const { rowCount } = await pool.query(`DELETE FROM questions WHERE ${clauses.join(' AND ')}`, params);
  res.json({ deleted: rowCount });
}));

module.exports = router;
