const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/questions?ministry_id=&grade=&subject=&search=  (admin only — includes correct answer)
router.get('/', requireAdmin, async (req, res) => {
  const { ministry_id, grade, subject, search } = req.query;
  const clauses = [];
  const params = [];

  if (ministry_id) { params.push(ministry_id); clauses.push(`q.ministry_id = $${params.length}`); }
  if (grade) { params.push(grade); clauses.push(`q.grade = $${params.length}`); }
  if (subject) { params.push(subject); clauses.push(`q.subject = $${params.length}`); }
  if (search) { params.push(`%${search}%`); clauses.push(`q.question_text ILIKE $${params.length}`); }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT q.*, m.name AS ministry_name FROM questions q
     LEFT JOIN ministries m ON m.id = q.ministry_id
     ${where} ORDER BY q.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

// POST /api/questions  — add a single question
router.post('/', requireAdmin, async (req, res) => {
  const { ministry_id, grade, subject, question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  if (!subject || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_option) {
    return res.status(400).json({ error: 'সব ঘর পূরণ করুন' });
  }
  const { rows } = await pool.query(
    `INSERT INTO questions (ministry_id, grade, subject, question_text, option_a, option_b, option_c, option_d, correct_option)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ministry_id || null, grade || null, subject, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase()]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/questions/:id — edit a question
router.put('/:id', requireAdmin, async (req, res) => {
  const { ministry_id, grade, subject, question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  const { rows } = await pool.query(
    `UPDATE questions SET ministry_id=$1, grade=$2, subject=$3, question_text=$4,
     option_a=$5, option_b=$6, option_c=$7, option_d=$8, correct_option=$9
     WHERE id=$10 RETURNING *`,
    [ministry_id || null, grade || null, subject, question_text, option_a, option_b, option_c, option_d, correct_option.toUpperCase(), req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'প্রশ্ন পাওয়া যায়নি' });
  res.json(rows[0]);
});

// DELETE /api/questions/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/questions/ministries/list — for dropdowns
router.get('/ministries/list', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ministries ORDER BY name');
  res.json(rows);
});

// POST /api/questions/ministries — add a new ministry
router.post('/ministries', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'নাম দিন' });
  const { rows } = await pool.query(
    'INSERT INTO ministries(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING *',
    [name]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
