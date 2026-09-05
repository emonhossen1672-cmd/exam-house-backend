const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { TOPIC_JOB_SUBJECTS, UNTAGGED_TOPIC, UNTAGGED_SUBTOPIC, snapToFixedSubject, normalizeText } = require('../utils/topicJobSubjects');

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

module.exports = router;
