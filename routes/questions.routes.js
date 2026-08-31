const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { normalizeSubject } = require('../utils/subjectMap');

// GET /api/questions?ministry_id=&grade=&subject=&topic=&search=  (admin only — includes correct answer)
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, search } = req.query;
  const clauses = [];
  const params = [];

  if (ministry_id) { params.push(ministry_id); clauses.push(`q.ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`q.grade = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`q.subject = $${params.length}`); }
  if (topic) { params.push(topic); clauses.push(`q.topic = $${params.length}`); }
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
  const { ministry_id, grade, subject, topic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation } = req.body;
  if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_option) {
    return res.status(400).json({ error: 'সব ঘর পূরণ করুন' });
  }
  const { rows } = await pool.query(
    `INSERT INTO questions (ministry_id, grade, subject, topic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ministry_id || null, grade || null, subject, (topic || '').trim() || null, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), explanation || null]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/questions/:id — edit a question
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation } = req.body;
  const { rows } = await pool.query(
    `UPDATE questions SET ministry_id=$1, grade=$2, subject=$3, topic=$4, question_text=$5,
     option_a=$6, option_b=$7, option_c=$8, option_d=$9, correct_option=$10, explanation=$11
     WHERE id=$12 RETURNING *`,
    [ministry_id || null, grade || null, subject, (topic || '').trim() || null, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), explanation || null, req.params.id]
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

// POST /api/questions/bulk — insert many already-structured questions at once
// body: { questions: [{ ministry_id, grade, subject, question_text, option_a..d, correct_option, explanation }] }
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
        `INSERT INTO questions (ministry_id, grade, subject, topic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [q.ministry_id || null, q.grade || null, q.subject, (q.topic || '').trim() || null, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
         q.correct_option.toUpperCase(), q.explanation || null]
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
// (read-through study, not an exam). Answer/explanation are included in the
// payload — the reveal is a client-side tap, same trust level as the archive
// endpoint in exams.routes.js which already sends correct_option once a
// window has closed. Ordered by id so pagination is stable across requests.
const READING_PAGE_SIZE = 30;
router.get('/public/reading-list', asyncHandler(async (req, res) => {
  const canonicalSubject = (req.query.subject || '').trim();
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!canonicalSubject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  // The subject passed in is a canonical name (বাংলা, ইংরেজি, ...) — find every
  // raw subject value in the database that normalizes to it (e.g. বাংলা also
  // covers বাংলা (ধ্বনি ও বর্ণ), ইংরেজি also covers English) and match against all of them.
  const distinctRes = await pool.query('SELECT DISTINCT subject FROM questions');
  const matchingRawSubjects = distinctRes.rows
    .map(r => r.subject)
    .filter(s => normalizeSubject(s) === canonicalSubject);
  if (!matchingRawSubjects.length) {
    return res.json({ subject: canonicalSubject, page: 1, total_pages: 1, total_count: 0, questions: [] });
  }

  const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM questions WHERE subject = ANY($1)', [matchingRawSubjects]);
  const total = countRes.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / READING_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * READING_PAGE_SIZE;

  const { rows } = await pool.query(
    `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
            q.correct_option, q.explanation, q.post_name, q.exam_year,
            m.name AS ministry_name
     FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
     WHERE q.subject = ANY($1)
     ORDER BY q.id ASC
     LIMIT $2 OFFSET $3`,
    [matchingRawSubjects, READING_PAGE_SIZE, offset]
  );

  res.json({ subject: canonicalSubject, page, total_pages: totalPages, total_count: total, questions: rows });
}));

// GET /api/questions/public/topics?subject=X — for টপিকভিত্তিক জব সলুশন:
// distinct topics inside one canonical subject, with question counts, so the
// client can list topics before drilling into any one of them. Questions with
// no topic set are grouped under "অন্যান্য" rather than dropped, so older
// data (uploaded before topics existed) is still reachable.
const UNTAGGED_TOPIC = 'অন্যান্য';
router.get('/public/topics', asyncHandler(async (req, res) => {
  const canonicalSubject = (req.query.subject || '').trim();
  if (!canonicalSubject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const distinctRes = await pool.query('SELECT DISTINCT subject FROM questions');
  const matchingRawSubjects = distinctRes.rows
    .map(r => r.subject)
    .filter(s => normalizeSubject(s) === canonicalSubject);
  if (!matchingRawSubjects.length) {
    return res.json({ subject: canonicalSubject, topics: [] });
  }

  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(topic), ''), $2) AS topic, COUNT(*)::int AS question_count
     FROM questions WHERE subject = ANY($1)
     GROUP BY 1 ORDER BY question_count DESC`,
    [matchingRawSubjects, UNTAGGED_TOPIC]
  );
  res.json({ subject: canonicalSubject, topics: rows });
}));

// GET /api/questions/public/topic-questions?subject=X&topic=Y&page=1 — paginated
// (30/page, same page size and payload shape as reading-list) listing of one
// topic's questions within a subject, each tagged with which exam/post/year it
// came from — the "টপিকভিত্তিক জব সলুশন" reading view. Pass topic=অন্যান্য to
// get untagged questions for that subject.
const TOPIC_PAGE_SIZE = 30;
router.get('/public/topic-questions', asyncHandler(async (req, res) => {
  const canonicalSubject = (req.query.subject || '').trim();
  const topic = (req.query.topic || '').trim();
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!canonicalSubject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });
  if (!topic) return res.status(400).json({ error: 'টপিক নির্বাচন করুন' });

  const distinctRes = await pool.query('SELECT DISTINCT subject FROM questions');
  const matchingRawSubjects = distinctRes.rows
    .map(r => r.subject)
    .filter(s => normalizeSubject(s) === canonicalSubject);
  if (!matchingRawSubjects.length) {
    return res.json({ subject: canonicalSubject, topic, page: 1, total_pages: 1, total_count: 0, questions: [] });
  }

  const topicClause = topic === UNTAGGED_TOPIC
    ? `(q.topic IS NULL OR TRIM(q.topic) = '')`
    : `q.topic = $2`;
  const topicParams = topic === UNTAGGED_TOPIC ? [] : [topic];

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM questions q WHERE q.subject = ANY($1) AND ${topicClause}`,
    [matchingRawSubjects, ...topicParams]
  );
  const total = countRes.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * TOPIC_PAGE_SIZE;

  const { rows } = await pool.query(
    `SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
            q.correct_option, q.explanation, q.post_name, q.exam_year,
            m.name AS ministry_name
     FROM questions q LEFT JOIN ministries m ON m.id = q.ministry_id
     WHERE q.subject = ANY($1) AND ${topicClause}
     ORDER BY q.id ASC
     LIMIT $${topicParams.length + 2} OFFSET $${topicParams.length + 3}`,
    [matchingRawSubjects, ...topicParams, TOPIC_PAGE_SIZE, offset]
  );

  res.json({ subject: canonicalSubject, topic, page, total_pages: totalPages, total_count: total, questions: rows });
}));

module.exports = router;
