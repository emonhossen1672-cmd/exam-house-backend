// routes/migrate.routes.js — one-time admin endpoint to migrate all data
// from the current database (DATABASE_URL, the Render Postgres that's about
// to expire) into a new database (NEON_DATABASE_URL, set as a temporary env
// var on Render) — used from public/migrate-tool.html. Safe to call more
// than once; each run truncates and re-copies every table on the target.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { migrateToNeon } = require('../services/migrateToNeon');

router.post('/run', requireAdmin, asyncHandler(async (req, res) => {
  const target = process.env.NEON_DATABASE_URL;
  if (!target) {
    return res.status(400).json({
      error: 'NEON_DATABASE_URL env var সেট করা নেই। Render → এই সার্ভিস → Environment ট্যাবে গিয়ে NEON_DATABASE_URL নামে একটা env var যোগ করুন (ভ্যালু: আপনার Neon কানেকশন স্ট্রিং), তারপর আবার এই বাটনে চাপুন।'
    });
  }

  const logLines = [];
  const result = await migrateToNeon({
    sourceConnectionString: process.env.DATABASE_URL,
    targetConnectionString: target,
    logFn: (line) => logLines.push(line),
  });

  res.json({ ...result, log: logLines });
}));

module.exports = router;
