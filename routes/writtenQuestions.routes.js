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
const { WRITTEN_SUBJECTS, writtenSubjectBucket } = require('../utils/writtenSubjectBuckets');

// রিটেন জব সলুশন reading screen drill-down: মন্ত্রণালয় → বিষয় (বাংলা/ইংরেজি/গণিত/সাধারণ জ্ঞান) → প্রশ্ন.
// Questions uploaded without a ministry are grouped under this bucket so
// they never disappear from the reading screen.
const UNTAGGED_MINISTRY = 'অন্যান্য';
const NO_MINISTRY_ID = 'none'; // ministry_id URL value for the bucket above

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
  const { ministry_id, grade, subject, topic, subtopic, post_name, exam_year, question_text, model_answer, marks } = req.body;
  if (!subject || !question_text || !model_answer) {
    return res.status(400).json({ error: 'বিষয়, প্রশ্ন ও আদর্শ উত্তর দিতে হবে' });
  }
  const finalTopic = resolveTopic(normalizeText(topic), question_text);
  const { rows } = await pool.query(
    `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, exam_year, question_text, model_answer, marks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), finalTopic || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, exam_year || null, question_text, model_answer, marks || 10]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/written-questions/:id
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { ministry_id, grade, subject, topic, subtopic, post_name, exam_year, question_text, model_answer, marks } = req.body;
  const finalTopic = resolveTopic(normalizeText(topic), question_text);
  const { rows } = await pool.query(
    `UPDATE written_questions SET ministry_id=$1, grade=$2, subject=$3, topic=$4, subtopic=$5,
       post_name=$6, exam_year=$7, question_text=$8, model_answer=$9, marks=$10
     WHERE id=$11 RETURNING *`,
    [ministry_id || null, grade || null, normalizeText(subject), finalTopic || null,
     normalizeText(subtopic) || null, (post_name || '').toString().trim() || null, exam_year || null, question_text, model_answer, marks || 10, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// DELETE /api/written-questions/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM written_questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));


// ---------- auto রিটেন মডেল টেস্ট ----------
// Every batch of uploaded written questions that carries a ministry is also
// turned into an always-open written model test (type='written', no
// start_time, self-check grading) so the same questions that appear in
// রিটেন জব সলুশন can be attempted as a test — no separate "create exam"
// step. One test per (ministry, post_name, exam_year); a later upload for the
// same combination appends to the existing test instead of making a copy.
// Rows without a ministry stay question-bank-only. Opt out with
// create_test=0 (CSV form field) / create_test:false (paste JSON).
function autoTestSerial() { return `EH-MT-${Math.floor(1000 + Math.random() * 9000)}`; }

async function autoCreateWrittenTests(client, items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.ministry_id) continue;
    const key = `${it.ministry_id}|${it.post_name || ''}|${it.exam_year || ''}`;
    if (!groups.has(key)) groups.set(key, { ministry_id: it.ministry_id, post_name: it.post_name || null, exam_year: it.exam_year || null, ids: [] });
    groups.get(key).ids.push(it.id);
  }
  const out = [];
  for (const g of groups.values()) {
    const m = await client.query('SELECT name FROM ministries WHERE id=$1', [g.ministry_id]);
    const title = `${m.rows[0].name}${g.post_name ? ' — ' + g.post_name : ''}${g.exam_year ? ' (' + g.exam_year + ')' : ''} রিটেন মডেল টেস্ট`;
    const existing = await client.query(
      `SELECT id FROM exams WHERE type='written' AND ministry_id=$1 AND title=$2 AND start_time IS NULL ORDER BY id LIMIT 1`,
      [g.ministry_id, title]
    );
    let examId, created = false;
    if (existing.rows.length) {
      examId = existing.rows[0].id;
    } else {
      // ~3 minutes per question, rounded to 5, clamped 30–180 min (editable later).
      const duration = Math.min(180, Math.max(30, Math.ceil((g.ids.length * 3) / 5) * 5));
      const ins = await client.query(
        `INSERT INTO exams (title, type, ministry_id, post_name, duration_minutes, serial, status, grading_mode)
         VALUES ($1,'written',$2,$3,$4,$5,'scheduled','self_check') RETURNING id`,
        [title, g.ministry_id, g.post_name, duration, autoTestSerial()]
      );
      examId = ins.rows[0].id;
      created = true;
    }
    const pos = await client.query('SELECT COALESCE(MAX(position),0) AS p FROM exam_written_questions WHERE exam_id=$1', [examId]);
    let position = pos.rows[0].p;
    for (const id of g.ids) {
      await client.query('INSERT INTO exam_written_questions (exam_id, written_question_id, position) VALUES ($1,$2,$3)', [examId, id, ++position]);
    }
    out.push({ exam_id: examId, title, created, added: g.ids.length });
  }
  return out;
}

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
  const inserted = [];
  let tests = [];
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
        `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, exam_year, question_text, model_answer, marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [q.ministry_id || null, q.grade || null, normalizeText(q.subject), finalTopic || null,
         normalizeText(q.subtopic) || null, (q.post_name || '').toString().trim() || null, q.exam_year || null, q.question_text, q.model_answer, q.marks || 10]
      ).then(r => inserted.push({ id: r.rows[0].id, ministry_id: q.ministry_id || null, post_name: (q.post_name || '').toString().trim() || null, exam_year: q.exam_year || null }));
      added++;
    }
    if (req.body.create_test !== false) tests = await autoCreateWrittenTests(client, inserted);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
  res.json({ added, failed: errors.length, errors, tests });
}));

// POST /api/written-questions/bulk-upload — CSV/XLSX file upload (multipart,
// field name: file). Expected columns (header row, any order):
//   subject, question, answer
// Optional: ministry, grade, topic, subtopic, post_name, exam_year (or year), marks
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
  const inserted = [];
  let tests = [];
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
        `INSERT INTO written_questions (ministry_id, grade, subject, topic, subtopic, post_name, exam_year, question_text, model_answer, marks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ministryId, r.grade || null, normalizeText(r.subject), finalTopic || null, normalizeText(r.subtopic) || null,
         r.post_name || null, r.exam_year || r.year || null, r.question, r.answer, r.marks || 10]
      ).then(x => inserted.push({ id: x.rows[0].id, ministry_id: ministryId, post_name: r.post_name || null, exam_year: r.exam_year || r.year || null }));
      added++;
    }

    // multipart form field; anything but "0"/"false" means yes
    const wantTest = !['0', 'false'].includes(String(req.body.create_test || '1'));
    if (wantTest) tests = await autoCreateWrittenTests(client, inserted);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  res.json({ added, failed: errors.length, errors, tests });
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

// GET /api/written-questions/public/ministries — first screen of the
// রিটেন জব সলুশন reading feature: every ministry/organization that has at
// least one written question, with its question count. Questions with no
// ministry are grouped into one extra "অন্যান্য" card.
router.get('/public/ministries', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id::text AS ministry_id, m.name AS ministry_name, COUNT(*)::int AS question_count
     FROM written_questions wq
     JOIN ministries m ON m.id = wq.ministry_id
     GROUP BY m.id, m.name
     ORDER BY m.name`
  );
  const none = await pool.query(
    `SELECT COUNT(*)::int AS question_count FROM written_questions WHERE ministry_id IS NULL`
  );
  if (none.rows[0].question_count > 0) {
    rows.push({ ministry_id: NO_MINISTRY_ID, ministry_name: UNTAGGED_MINISTRY, question_count: none.rows[0].question_count });
  }
  res.json(rows);
}));

// Builds the WHERE fragment for one ministry (real id or "none"). Returns
// null for an invalid id. `params` is mutated (id pushed when needed).
function ministryClause(mid, params) {
  if (mid === NO_MINISTRY_ID) return 'wq.ministry_id IS NULL';
  if (!/^\d+$/.test(String(mid))) return null;
  params.push(mid);
  return `wq.ministry_id = $${params.length}`;
}

// GET /api/written-questions/public/ministry-subjects?ministry_id=X — second
// screen: always the 4 fixed subjects (বাংলা, ইংরেজি, গণিত, সাধারণ জ্ঞান)
// with their question_count inside this ministry. Raw `subject` values from
// uploads are auto-sorted into these 4 (see utils/writtenSubjectBuckets.js).
router.get('/public/ministry-subjects', asyncHandler(async (req, res) => {
  const mid = String(req.query.ministry_id || '').trim();
  if (!mid) return res.status(400).json({ error: 'মন্ত্রণালয় নির্বাচন করুন' });
  const params = [];
  const clause = ministryClause(mid, params);
  if (!clause) return res.status(400).json({ error: 'মন্ত্রণালয় সঠিক নয়' });

  let ministryName = UNTAGGED_MINISTRY;
  if (mid !== NO_MINISTRY_ID) {
    const m = await pool.query('SELECT name FROM ministries WHERE id=$1', [mid]);
    if (!m.rows.length) return res.status(404).json({ error: 'মন্ত্রণালয় পাওয়া যায়নি' });
    ministryName = m.rows[0].name;
  }

  const { rows } = await pool.query(
    `SELECT wq.subject, COUNT(*)::int AS n FROM written_questions wq WHERE ${clause} GROUP BY wq.subject`,
    params
  );
  const totals = Object.fromEntries(WRITTEN_SUBJECTS.map(s => [s, 0]));
  rows.forEach(r => { totals[writtenSubjectBucket(r.subject)] += r.n; });
  res.json({
    ministry_id: mid,
    ministry_name: ministryName,
    subjects: WRITTEN_SUBJECTS.map(s => ({ subject: s, question_count: totals[s] })),
  });
}));

// GET /api/written-questions/public/library?ministry_id=&bucket=&subject=&topic=&subtopic=&limit=
// — full reading list (question + model answer). `bucket` is one of the 4
// WRITTEN_SUBJECTS and matches every raw subject that auto-sorts into it.
// With ministry_id the list is in upload order (a book's questions read in
// sequence); without it the old most-recent-first order is kept for the
// older subject-based callers.
router.get('/public/library', asyncHandler(async (req, res) => {
  const { ministry_id, bucket, subject, topic, subtopic } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
  const clauses = [];
  const params = [];
  if (ministry_id) {
    const c = ministryClause(String(ministry_id), params);
    if (!c) return res.status(400).json({ error: 'মন্ত্রণালয় সঠিক নয়' });
    clauses.push(c);
  }
  if (bucket) {
    if (!WRITTEN_SUBJECTS.includes(bucket)) return res.status(400).json({ error: 'বিষয় সঠিক নয়' });
    const distinctParams = [];
    const dClause = ministry_id ? `WHERE ${ministryClause(String(ministry_id), distinctParams)}` : '';
    const d = await pool.query(
      `SELECT DISTINCT wq.subject FROM written_questions wq ${dClause}`, distinctParams
    );
    const matching = d.rows.map(r => r.subject).filter(sub => writtenSubjectBucket(sub) === bucket);
    if (!matching.length) return res.json([]);
    params.push(matching);
    clauses.push(`wq.subject = ANY($${params.length})`);
  }
  if (subject) { params.push(subject); clauses.push(`wq.subject = $${params.length}`); }
  if (topic) {
    if (topic === UNTAGGED_TOPIC) clauses.push(`(wq.topic IS NULL OR TRIM(wq.topic) = '')`);
    else { params.push(topic); clauses.push(`wq.topic = $${params.length}`); }
  }
  if (subtopic) {
    if (subtopic === UNTAGGED_SUBTOPIC) clauses.push(`(wq.subtopic IS NULL OR TRIM(wq.subtopic) = '')`);
    else { params.push(subtopic); clauses.push(`wq.subtopic = $${params.length}`); }
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const order = ministry_id ? 'ORDER BY wq.id ASC' : 'ORDER BY wq.created_at DESC, wq.id DESC';
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT wq.id, wq.subject, wq.topic, wq.subtopic, wq.post_name, wq.exam_year, m.name AS ministry_name,
            wq.question_text, wq.model_answer, wq.marks, wq.created_at
     FROM written_questions wq
     LEFT JOIN ministries m ON m.id = wq.ministry_id
     ${where} ${order} LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

module.exports = router;
