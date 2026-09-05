// routes/writtenAnswers.routes.js — submitting and grading answers for a
// রিটেন (written) exam. Mirrors routes/results.routes.js (which does this
// for MCQ exams) but per-question, since each written answer may be graded
// separately and at a different time (manual review, or async AI grading).
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAdmin, requireUser, optionalUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const { gradeWrittenAnswer } = require('../services/aiGrading');

// ---------- STUDENT ----------

// POST /api/written-answers/submit
// body: { exam_id, participant_name, participant_phone,
//         answers: [{ written_question_id, answer_text, image_url }] }
// Works for guests and logged-in users, same as /api/results.
router.post('/submit', submitLimiter, optionalUser, asyncHandler(async (req, res) => {
  const { exam_id, participant_name, participant_phone, answers } = req.body;
  const userId = req.user ? req.user.id : null;
  const name = req.user ? req.user.name : participant_name;
  const phone = req.user ? req.user.phone : (participant_phone || null);

  if (!exam_id || !name || !Array.isArray(answers) || !answers.length) {
    return res.status(400).json({ error: 'নাম ও উত্তর প্রয়োজন' });
  }

  const examRes = await pool.query('SELECT * FROM exams WHERE id=$1', [exam_id]);
  if (!examRes.rows.length) return res.status(404).json({ error: 'পরীক্ষা পাওয়া যায়নি' });
  const exam = examRes.rows[0];
  if (exam.type !== 'written') return res.status(400).json({ error: 'এটি রিটেন পরীক্ষা নয়' });
  if (exam.status === 'closed') return res.status(403).json({ error: 'পরীক্ষাটি বন্ধ করে দেওয়া হয়েছে' });
  if (exam.start_time && new Date(exam.start_time) > new Date()) {
    return res.status(403).json({ error: 'পরীক্ষা এখনো শুরু হয়নি' });
  }

  const wqRes = await pool.query(
    `SELECT written_question_id FROM exam_written_questions WHERE exam_id=$1`,
    [exam_id]
  );
  const validIds = new Set(wqRes.rows.map(r => r.written_question_id));

  const client = await pool.connect();
  const saved = [];
  try {
    await client.query('BEGIN');
    for (const a of answers) {
      const qid = a.written_question_id;
      if (!validIds.has(qid)) continue;

      let existing;
      if (userId) {
        existing = await client.query(
          'SELECT id, status FROM written_answers WHERE exam_id=$1 AND written_question_id=$2 AND user_id=$3',
          [exam_id, qid, userId]
        );
      } else if (phone) {
        existing = await client.query(
          'SELECT id, status FROM written_answers WHERE exam_id=$1 AND written_question_id=$2 AND user_id IS NULL AND participant_phone=$3',
          [exam_id, qid, phone]
        );
      } else {
        existing = { rows: [] };
      }

      if (existing.rows.length) {
        if (existing.rows[0].status !== 'pending') {
          // already graded/self-checked — don't let a resubmit silently overwrite it
          continue;
        }
        const upd = await client.query(
          `UPDATE written_answers SET answer_text=$1, image_url=$2, submitted_at=NOW()
           WHERE id=$3 RETURNING *`,
          [a.answer_text || null, a.image_url || null, existing.rows[0].id]
        );
        saved.push(upd.rows[0]);
      } else {
        const ins = await client.query(
          `INSERT INTO written_answers (exam_id, written_question_id, user_id, participant_name, participant_phone, answer_text, image_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
          [exam_id, qid, userId, name, phone, a.answer_text || null, a.image_url || null]
        );
        saved.push(ins.rows[0]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  } finally {
    client.release();
  }

  // self_check mode: nothing further to do, frontend fetches the archive
  // (with model answers) right after this to let the student compare.
  if (exam.grading_mode === 'self_check') {
    for (const row of saved) {
      await pool.query(`UPDATE written_answers SET status='self_checked' WHERE id=$1`, [row.id]);
    }
    return res.json({ ok: true, grading_mode: 'self_check', saved: saved.length });
  }

  // ai mode: grade right away, best-effort — a failure here just leaves the
  // row 'pending' for an admin to grade manually or re-trigger AI grading later.
  if (exam.grading_mode === 'ai') {
    for (const row of saved) {
      try {
        const wq = await pool.query('SELECT question_text, model_answer, marks FROM written_questions WHERE id=$1', [row.written_question_id]);
        if (!wq.rows.length) continue;
        const { marks_awarded, feedback } = await gradeWrittenAnswer({
          questionText: wq.rows[0].question_text,
          modelAnswer: wq.rows[0].model_answer,
          studentAnswer: row.answer_text,
          maxMarks: Number(wq.rows[0].marks),
        });
        await pool.query(
          `UPDATE written_answers SET status='graded', marks_awarded=$1, feedback=$2, graded_by='ai', graded_at=NOW() WHERE id=$3`,
          [marks_awarded, feedback, row.id]
        );
      } catch (err) {
        console.error(`⚠️ AI grading failed for written_answers.id=${row.id}: ${err.message}`);
      }
    }
    return res.json({ ok: true, grading_mode: 'ai', saved: saved.length });
  }

  // manual mode: stays 'pending' until an admin reviews it
  res.json({ ok: true, grading_mode: exam.grading_mode || 'manual', saved: saved.length });
}));

// GET /api/written-answers/my/:examId — the current student's own answers +
// status/marks/feedback for a written exam (also works for guests via ?phone=).
router.get('/my/:examId', optionalUser, asyncHandler(async (req, res) => {
  const userId = req.user ? req.user.id : null;
  const phone = req.query.phone || null;
  if (!userId && !phone) return res.status(400).json({ error: 'লগইন করুন বা ফোন নম্বর দিন' });

  const params = [req.params.examId];
  let where;
  if (userId) { params.push(userId); where = 'wa.exam_id=$1 AND wa.user_id=$2'; }
  else { params.push(phone); where = 'wa.exam_id=$1 AND wa.user_id IS NULL AND wa.participant_phone=$2'; }

  const { rows } = await pool.query(
    `SELECT wa.*, wq.question_text, wq.marks AS max_marks,
       CASE WHEN wa.status IN ('graded','self_checked') THEN wq.model_answer ELSE NULL END AS model_answer,
       ewq.position
     FROM written_answers wa
     JOIN written_questions wq ON wq.id = wa.written_question_id
     JOIN exam_written_questions ewq ON ewq.exam_id = wa.exam_id AND ewq.written_question_id = wa.written_question_id
     WHERE ${where} ORDER BY ewq.position`,
    params
  );
  res.json(rows);
}));

// ---------- ADMIN (manual review / AI re-grade) ----------

// GET /api/written-answers/admin/exam/:examId?status=pending
router.get('/admin/exam/:examId', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query;
  const params = [req.params.examId];
  let statusClause = '';
  if (status) { params.push(status); statusClause = `AND wa.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT wa.*, wq.question_text, wq.model_answer, wq.marks AS max_marks, ewq.position
     FROM written_answers wa
     JOIN written_questions wq ON wq.id = wa.written_question_id
     JOIN exam_written_questions ewq ON ewq.exam_id = wa.exam_id AND ewq.written_question_id = wa.written_question_id
     WHERE wa.exam_id = $1 ${statusClause}
     ORDER BY ewq.position, wa.submitted_at`,
    params
  );
  res.json(rows);
}));

// PUT /api/written-answers/admin/:id/grade — manual grading
// body: { marks_awarded, feedback }
router.put('/admin/:id/grade', requireAdmin, asyncHandler(async (req, res) => {
  const { marks_awarded, feedback } = req.body;
  if (marks_awarded === undefined || marks_awarded === null) {
    return res.status(400).json({ error: 'নম্বর দিন' });
  }
  const { rows } = await pool.query(
    `UPDATE written_answers SET marks_awarded=$1, feedback=$2, status='graded', graded_by='admin', graded_at=NOW()
     WHERE id=$3 RETURNING *`,
    [marks_awarded, feedback || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'উত্তর পাওয়া যায়নি' });
  res.json(rows[0]);
}));

// POST /api/written-answers/admin/:id/ai-grade — (re-)run AI grading on one answer
router.post('/admin/:id/ai-grade', requireAdmin, asyncHandler(async (req, res) => {
  const ansRes = await pool.query(
    `SELECT wa.*, wq.question_text, wq.model_answer, wq.marks AS max_marks
     FROM written_answers wa JOIN written_questions wq ON wq.id = wa.written_question_id
     WHERE wa.id=$1`,
    [req.params.id]
  );
  if (!ansRes.rows.length) return res.status(404).json({ error: 'উত্তর পাওয়া যায়নি' });
  const a = ansRes.rows[0];
  try {
    const { marks_awarded, feedback } = await gradeWrittenAnswer({
      questionText: a.question_text,
      modelAnswer: a.model_answer,
      studentAnswer: a.answer_text,
      maxMarks: Number(a.max_marks),
    });
    const { rows } = await pool.query(
      `UPDATE written_answers SET marks_awarded=$1, feedback=$2, status='graded', graded_by='ai', graded_at=NOW()
       WHERE id=$3 RETURNING *`,
      [marks_awarded, feedback, a.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(502).json({ error: 'AI গ্রেডিং ব্যর্থ: ' + err.message });
  }
}));

// POST /api/written-answers/admin/exam/:examId/ai-grade-pending — bulk AI-grade
// every still-pending answer for an exam (e.g. after switching an exam to ai mode).
router.post('/admin/exam/:examId/ai-grade-pending', requireAdmin, asyncHandler(async (req, res) => {
  const { rows: pending } = await pool.query(
    `SELECT wa.*, wq.question_text, wq.model_answer, wq.marks AS max_marks
     FROM written_answers wa JOIN written_questions wq ON wq.id = wa.written_question_id
     WHERE wa.exam_id=$1 AND wa.status='pending'`,
    [req.params.examId]
  );
  let graded = 0;
  const errors = [];
  for (const a of pending) {
    try {
      const { marks_awarded, feedback } = await gradeWrittenAnswer({
        questionText: a.question_text,
        modelAnswer: a.model_answer,
        studentAnswer: a.answer_text,
        maxMarks: Number(a.max_marks),
      });
      await pool.query(
        `UPDATE written_answers SET marks_awarded=$1, feedback=$2, status='graded', graded_by='ai', graded_at=NOW() WHERE id=$3`,
        [marks_awarded, feedback, a.id]
      );
      graded++;
    } catch (err) {
      errors.push(`উত্তর #${a.id}: ${err.message}`);
    }
  }
  res.json({ graded, failed: errors.length, errors });
}));

module.exports = router;
