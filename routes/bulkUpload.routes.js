const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { snapToFixedSubject, normalizeText } = require('../utils/topicJobSubjects');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Expected columns (header row, any order):
// ministry, grade, subject, question, option_a, option_b, option_c, option_d, correct
// Optional: post_name (পদের নাম), year (সাল) — used to tag this question's
// source when it later appears in an auto-generated বিষয়ভিত্তিক model test.
// Optional: topic (টপিক), subtopic (সাবটপিক) — groups the question under
// টপিকভিত্তিক জব সলুশন (subject → topic → subtopic); left blank, they fall
// into the "অন্যান্য" bucket for that level.
const REQUIRED = ['subject', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct'];

function parseFile(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.csv')) {
    const text = file.buffer.toString('utf8');
    return parse(text, { columns: true, skip_empty_lines: true, trim: true });
  }
  // .xlsx / .xls
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// POST /api/questions/bulk-upload  (multipart/form-data, field name: file)
router.post('/', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });

  let rows;
  try {
    rows = parseFile(req.file);
  } catch (err) {
    return res.status(400).json({ error: 'ফাইল পড়া যায়নি — CSV বা XLSX ফরম্যাট ঠিক আছে কিনা দেখুন' });
  }

  if (rows.length === 0) return res.status(400).json({ error: 'ফাইলে কোনো প্রশ্ন পাওয়া যায়নি' });

  const client = await pool.connect();
  let added = 0;
  const errors = [];

  try {
    await client.query('BEGIN');

    // cache ministry name -> id
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
      const rowNum = i + 2; // header is row 1

      const missing = REQUIRED.filter(col => !r[col] && r[col] !== 0);
      if (missing.length) {
        errors.push(`সারি ${rowNum}: ${missing.join(', ')} খালি`);
        continue;
      }
      const correct = String(r.correct).trim().toUpperCase();
      if (!['A', 'B', 'C', 'D'].includes(correct)) {
        errors.push(`সারি ${rowNum}: correct এর মান A/B/C/D হতে হবে (পাওয়া গেছে: ${r.correct})`);
        continue;
      }

      const ministryId = await getMinistryId(r.ministry);
      // snapToFixedSubject cleans invisible/whitespace differences and, if the
      // result matches one of the 12 টপিকভিত্তিক জব সলুশন subjects, locks it to
      // the exact canonical string — otherwise CSV rows edited on mobile can
      // look right but silently fail the exact-match check (see topicJobSubjects.js).
      await client.query(
        `INSERT INTO questions (ministry_id, grade, subject, topic, subtopic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, post_name, exam_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [ministryId, r.grade || null, snapToFixedSubject(r.subject), normalizeText(r.topic) || null, normalizeText(r.subtopic) || null, r.question, r.option_a, r.option_b, r.option_c, r.option_d, correct, r.explanation || null,
         r.post_name || null, r.year || null]
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

module.exports = router;
