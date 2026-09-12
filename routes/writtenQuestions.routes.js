// routes/writtenQuestions.routes.js — the রিটেন জব সলুশন question bank.
// Unlike routes/questions.routes.js (MCQ, auto-graded), each row here is a
// free-text question + a model_answer, used two ways:
//   1. Read directly as study content (GET /public/library) — the "রিটেন জব
//      সলুশন" reading feature, model_answer included, no exam involved.
//   2. Pulled into an actual written EXAM via routes/exams.routes.js, where
//      model_answer is hidden from students until grading/archive — see
//      exam_written_questions + written_answers in schema.sql.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { normalizeText, UNTAGGED_TOPIC, UNTAGGED_SUBTOPIC } = require('../utils/topicJobSubjects');
const { resolveTopic } = require('../utils/topicAutoDetect');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- ADMIN ----------

// GET /api/written-questions?ministry_id=&grade=&subject=&topic=&subtopic=&search=
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, search } = req.query;
  const clauses = [];
  const params = [];
  if (ministry_id) { params.push(ministry_id); clauses.push(`wq.ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`wq.grade = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`wq.subject = $${params.length}`); }
  if (topic) { params.push(topic); clauses.push(`wq.topic = $${params.length}`); }
  if (subtopic) { params.push(subtopic); clauses.push(`wq.subtopic = $${params.length}`); }
  if (search) { params.push(`%${search}%`); clauses.push(`wq.question_text ILIKE $${params.length}`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT wq.*, m.name AS ministry_name FROM written_questions wq
     LEFT JOIN ministries m ON m.id = wq.ministry_id
     ${where} ORDER BY wq.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

// POST /api/written-questions — add one
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks } = req.body;
  if (!subject || !question_text || !model_answer) {
    return res.status(400).json({ error: 'বিষয়, প্রশ্ন ও আদর্শ উত্তর দিতে হবে' });
  }
  const finalTopic = resolveTopic(normalizeText(topic), question_text);
  const { rows } = await pool.query(
    `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), finalTopic || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, question_text, model_answer, marks || 10]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/written-questions/:id
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks } = req.body;
  const finalTopic = resolveTopic(normalizeText(topic), question_text);
  const { rows } = await pool.query(
    `UPDATE written_questions SET ministry_id=$1, grade=$2, subject=$3, topic=$4, subtopic=$5,
       post_name=$6, question_text=$7, model_answer=$8, marks=$9
     WHERE id=$10 RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), finalTopic || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, question_text, model_answer, marks || 10, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/written-questions/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM written_questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// POST /api/written-questions/bulk — paste many at once.
// body: { questions: [{ ministry_id, grade, subject, topic, subtopic, question_text, model_answer, marks }] }
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
      if (!q.subject || !q.question_text || !q.model_answer) {
        errors.push(`প্রশ্ন ${i + 1}: বিষয়, প্রশ্ন বা আদর্শ উত্তর অনুপস্থিত`);
        continue;
      }
      const finalTopic = resolveTopic(normalizeText(q.topic), q.question_text);
      await client.query(
        `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [q.ministry_id || null, q.grade || null, normalizeText(q.subject), finalTopic || null,
         normalizeText(q.subtopic) || null, (q.post_name || '').toString().trim() || null, q.question_text, q.model_answer, q.marks || 10]
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

// POST /api/written-questions/bulk-upload — CSV/XLSX file upload (multipart,
// field name: file). Expected columns (header row, any order):
//   subject, question, answer
// Optional: ministry, grade, topic, subtopic, post_name, marks
// `topic` left blank is auto-detected from the question text where possible
// (see utils/topicAutoDetect.js — catches recurring patterns like "পদ
// নির্ণয়", "কারক নির্ণয়", "শুদ্ধ বানান লিখুন", "Make a sentence with the
// idiom ...", "Translate into English", "Fill in the blank", etc.) so a CSV
// full of mixed grammar-drill questions splits into separate topic buckets
// (idiom-এর একটা সমগ্র, সমাস আলাদা, কারক আলাদা, বাগধারা আলাদা...) instead of
// landing as one long undifferentiated list. Still can't guess an
// unfamiliar phrasing — leave the topic column filled in for anything that
// doesn't match one of the known patterns.
const WQ_CSV_REQUIRED = ['subject', 'question', 'answer'];

function parseWrittenFile(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.csv')) {
    const text = file.buffer.toString('utf8');
    return parse(text, { columns: true, skip_empty_lines: true, trim: true });
  }
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

router.post('/bulk-upload', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });

  let rows;
  try {
    rows = parseWrittenFile(req.file);
  } catch (err) {
    return res.status(400).json({ error: 'ফাইল পড়া যায়নি — CSV বা XLSX ফরম্যাট ঠিক আছে কিনা দেখুন' });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'ফাইলে কোনো প্রশ্ন পাওয়া যায়নি' });

  const client = await pool.connect();
  let added = 0;
  const errors = [];
  try {
    await client.query('BEGIN');

    const ministryCache = {};
    async function getMinistryId(name) {
      if (!name) return null;
      const key = String(name).trim();
      if (!key) return null;
      if (ministryCache[key]) return ministryCache[key];
      const found = await client.query('SELECT id FROM ministries WHERE name=$1', [key]);
      if (found.rows.length) { ministryCache[key] = found.rows[0].id; return found.rows[0].id; }
      const created = await client.query('INSERT INTO ministries(name) VALUES ($1) RETURNING id', [key]);
      ministryCache[key] = created.rows[0].id;
      return created.rows[0].id;
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2;

      const missing = WQ_CSV_REQUIRED.filter(col => !r[col] && r[col] !== 0);
      if (missing.length) {
        errors.push(`সারি ${rowNum}: ${missing.join(', ')} খালি`);
        continue;
      }

      const ministryId = await getMinistryId(r.ministry);
      const finalTopic = resolveTopic(normalizeText(r.topic), r.question);
      await client.query(
        `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, question_text, model_answer, marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ministryId, r.grade || null, normalizeText(r.subject), finalTopic || null, normalizeText(r.subtopic) || null,
         r.post_name || null, r.question, r.answer, r.marks || 10]
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

// GET /api/written-questions/admin/subjects — distinct subjects + counts, for
// the admin panel's filter dropdown.
router.get('/admin/subjects', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count FROM written_questions GROUP BY subject ORDER BY subject`
  );
  res.json(rows);
}));

// ---------- PUBLIC (রিটেন জব সলুশন reading feature — model_answer included) ----------

// GET /api/written-questions/public/subjects — subject list with counts, for
// the রিটেন জব সলুশন landing screen.
router.get('/public/subjects', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, COUNT(*)::int AS question_count FROM written_questions GROUP BY subject ORDER BY subject`
  );
  res.json(rows);
}));

// GET /api/written-questions/public/topics?subject=X — topic cards for the
// রিটেন জব সলুশন reading screen's Subject → Topic → Questions drill-down.
// Every distinct topic under this subject gets its own row (its own
// "সমগ্র") plus one extra "অন্যান্য" row for anything still untagged, so
// mixed content (idioms, সমাস, কারক, বাগধারা, ...) shows up as separate,
// browsable collections instead of one long flat list.
router.get('/public/topics', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const { rows } = await pool.query(
    `WITH tagged AS (
       SELECT TRIM(topic) AS topic,
              COUNT(*)::int AS question_count,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(subtopic), ''), $2))::int AS subtopic_count
       FROM written_questions WHERE subject = $1 AND TRIM(COALESCE(topic, '')) <> ''
       GROUP BY 1
     ),
     untagged AS (
       SELECT $3::text AS topic,
              COUNT(*)::int AS question_count,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(subtopic), ''), $2))::int AS subtopic_count
       FROM written_questions WHERE subject = $1 AND TRIM(COALESCE(topic, '')) = ''
     )
     SELECT * FROM tagged
     UNION ALL
     SELECT * FROM untagged WHERE question_count > 0
     ORDER BY question_count DESC`,
    [subject, UNTAGGED_SUBTOPIC, UNTAGGED_TOPIC]
  );
  res.json({ subject, topics: rows });
}));

// GET /api/written-questions/public/subtopics?subject=X&topic=Y — subtopics
// inside one topic, each with question_count (leaf list before questions).
router.get('/public/subtopics', asyncHandler(async (req, res) => {
  const subject = (req.query.subject || '').trim();
  const topic = (req.query.topic || '').trim();
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });
  if (!topic) return res.status(400).json({ error: 'টপিক নির্বাচন করুন' });

  const topicClause = topic === UNTAGGED_TOPIC ? `(topic IS NULL OR TRIM(topic) = '')` : `topic = $2`;
  const topicParams = topic === UNTAGGED_TOPIC ? [] : [topic];

  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(subtopic), ''), $${topicParams.length + 2}) AS subtopic, COUNT(*)::int AS question_count
     FROM written_questions WHERE subject = $1 AND ${topicClause}
     GROUP BY 1 ORDER BY question_count DESC`,
    [subject, ...topicParams, UNTAGGED_SUBTOPIC]
  );
  res.json({ subject, topic, subtopics: rows });
}));

// GET /api/written-questions/public/library?subject=&topic=&subtopic= — full
// reading list (question + model answer), most recent first.
router.get('/public/library', asyncHandler(async (req, res) => {
  const { subject, topic, subtopic } = req.query;
  const clauses = [];
  const params = [];
  if (subject) { params.push(subject); clauses.push(`subject = $${params.length}`); }
  if (topic) {
    if (topic === UNTAGGED_TOPIC) clauses.push(`(topic IS NULL OR TRIM(topic) = '')`);
    else { params.push(topic); clauses.push(`topic = $${params.length}`); }
  }
  if (subtopic) {
    if (subtopic === UNTAGGED_SUBTOPIC) clauses.push(`(subtopic IS NULL OR TRIM(subtopic) = '')`);
    else { params.push(subtopic); clauses.push(`subtopic = $${params.length}`); }
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT id, subject, topic, subtopic, question_text, model_answer, marks, created_at
     FROM written_questions ${where} ORDER BY created_at DESC LIMIT 300`,
    params
  );
  res.json(rows);
}));

module.exports = router;
