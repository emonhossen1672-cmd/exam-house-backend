const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireUser, optionalUser } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const DUEL_TTL_DAYS = 7;

function genDuelCode() {
  return crypto.randomBytes(4).toString('hex'); // 8-char code, e.g. "a1b2c3d4"
}

// POST /api/duels — a logged-in student challenges a friend.
// body: { subject, count }
// Creates a real 'model' exam (is_duel=true) with random questions from the
// chosen subject — exactly like practice mode — so taking/submitting it
// reuses all existing exam machinery. The duel row just tracks who's racing.
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const subject = (req.body.subject || '').trim();
  let count = parseInt(req.body.count, 10);
  if (!Number.isFinite(count) || count < 5) count = 10;
  if (count > 30) count = 30;
  if (!subject) return res.status(400).json({ error: 'বিষয় নির্বাচন করুন' });

  const client = await pool.connect();
  try {
    const qRes = await client.query(
      `SELECT id FROM questions WHERE subject=$1 ORDER BY RANDOM() LIMIT $2`,
      [subject, count]
    );
    if (!qRes.rows.length) {
      return res.status(404).json({ error: 'এই বিষয়ে এখনো কোনো প্রশ্ন যোগ করা হয়নি' });
    }

    await client.query('BEGIN');
    const examSerial = 'EH-DL-' + Math.floor(1000 + Math.random() * 9000);
    const durationMinutes = Math.max(5, qRes.rows.length); // ~1 minute per question
    const examResult = await client.query(
      `INSERT INTO exams (title, type, subject, duration_minutes, status, serial, is_duel)
       VALUES ($1,'model',$2,$3,'active',$4,true) RETURNING *`,
      [`ডুয়েল চ্যালেঞ্জ: ${subject}`, subject, durationMinutes, examSerial]
    );
    const exam = examResult.rows[0];
    for (let i = 0; i < qRes.rows.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id, question_id, position) VALUES ($1,$2,$3)',
        [exam.id, qRes.rows[i].id, i + 1]
      );
    }

    // Generate a short unique join code (retry a few times on the rare collision)
    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = genDuelCode();
      const exists = await client.query('SELECT 1 FROM duels WHERE code=$1', [code]);
      if (!exists.rows.length) break;
    }

    const duelResult = await client.query(
      `INSERT INTO duels (code, exam_id, challenger_user_id, subject, question_count, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'pending', NOW() + ($6 || ' days')::interval) RETURNING *`,
      [code, exam.id, req.user.id, subject, qRes.rows.length, DUEL_TTL_DAYS]
    );

    await client.query('COMMIT');
    const duel = duelResult.rows[0];
    res.status(201).json({
      code: duel.code, exam_id: duel.exam_id, subject: duel.subject,
      question_count: duel.question_count, status: duel.status, expires_at: duel.expires_at
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }
}));

// GET /api/duels/code/:code — public duel info (challenger name, subject,
// status, scores once available) — works even before the visitor logs in,
// so the share link can show something meaningful right away.
router.get('/code/:code', optionalUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT d.*, ch.name AS challenger_name, op.name AS opponent_name,
      cr.score AS challenger_score, orr.score AS opponent_score
    FROM duels d
    JOIN users ch ON ch.id = d.challenger_user_id
    LEFT JOIN users op ON op.id = d.opponent_user_id
    LEFT JOIN results cr ON cr.id = d.challenger_result_id
    LEFT JOIN results orr ON orr.id = d.opponent_result_id
    WHERE d.code = $1
  `, [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'এই চ্যালেঞ্জটি পাওয়া যায়নি' });
  const d = rows[0];
  if (new Date(d.expires_at) < new Date() && d.status !== 'completed') {
    return res.status(410).json({ error: 'এই চ্যালেঞ্জের মেয়াদ শেষ হয়ে গেছে' });
  }
  res.json({
    code: d.code, exam_id: d.exam_id, subject: d.subject, question_count: d.question_count,
    status: d.status, challenger_id: d.challenger_user_id, challenger_name: d.challenger_name,
    opponent_id: d.opponent_user_id, opponent_name: d.opponent_name,
    challenger_score: d.challenger_score, opponent_score: d.opponent_score,
    winner_user_id: d.winner_user_id
  });
}));

// POST /api/duels/code/:code/join — a second logged-in student accepts the challenge.
router.post('/code/:code/join', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM duels WHERE code=$1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'এই চ্যালেঞ্জটি পাওয়া যায়নি' });
  const duel = rows[0];

  if (new Date(duel.expires_at) < new Date()) {
    return res.status(410).json({ error: 'এই চ্যালেঞ্জের মেয়াদ শেষ হয়ে গেছে' });
  }
  if (duel.challenger_user_id === req.user.id) {
    return res.status(400).json({ error: 'নিজের চ্যালেঞ্জ নিজে গ্রহণ করা যায় না' });
  }
  if (duel.opponent_user_id && duel.opponent_user_id !== req.user.id) {
    return res.status(409).json({ error: 'এই চ্যালেঞ্জ ইতিমধ্যে অন্য কেউ গ্রহণ করেছে' });
  }

  if (!duel.opponent_user_id) {
    await pool.query(
      `UPDATE duels SET opponent_user_id=$1, status='active' WHERE id=$2`,
      [req.user.id, duel.id]
    );
  }
  res.json({ exam_id: duel.exam_id, question_count: duel.question_count, subject: duel.subject });
}));

// GET /api/duels/me — every duel the logged-in student has sent or received,
// most recent first, with both sides' scores once available.
router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT d.*,
      ch.name AS challenger_name, op.name AS opponent_name,
      cr.score AS challenger_score, orr.score AS opponent_score
    FROM duels d
    JOIN users ch ON ch.id = d.challenger_user_id
    LEFT JOIN users op ON op.id = d.opponent_user_id
    LEFT JOIN results cr ON cr.id = d.challenger_result_id
    LEFT JOIN results orr ON orr.id = d.opponent_result_id
    WHERE d.challenger_user_id = $1 OR d.opponent_user_id = $1
    ORDER BY d.created_at DESC
    LIMIT 50
  `, [req.user.id]);

  const myId = req.user.id;
  const list = rows.map(d => {
    const iAmChallenger = d.challenger_user_id === myId;
    return {
      code: d.code, subject: d.subject, question_count: d.question_count, status: d.status,
      opponent_name: iAmChallenger ? d.opponent_name : d.challenger_name,
      my_score: iAmChallenger ? d.challenger_score : d.opponent_score,
      opponent_score: iAmChallenger ? d.opponent_score : d.challenger_score,
      winner_user_id: d.winner_user_id,
      created_at: d.created_at
    };
  });
  res.json(list);
}));

module.exports = router;
