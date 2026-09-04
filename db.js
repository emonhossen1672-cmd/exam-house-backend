// db.js — PostgreSQL connection pool
// On Render, set DATABASE_URL to your Postgres instance's "Internal Database URL".

// Fix: exam start_time is stored as a plain TIMESTAMP (no timezone) — literally
// whatever the admin typed in the "শুরুর সময়" field (Bangladesh wall-clock time,
// e.g. "21:00"). That part was always correct. The bug was on the READ side:
// with no TZ set, both the Node process and every Postgres session defaulted to
// UTC (Render's container default), so `new Date(exam.start_time)` and SQL
// comparisons like `start_time <= NOW()` silently treated that "21:00" as UTC
// instead of Bangladesh time — a consistent ~6 hour drift, which is why exams
// appeared to start/end at the wrong moment. Pinning both sides to Asia/Dhaka
// makes "what the admin typed" and "what gets compared/displayed" agree, with
// no schema change or data migration needed — existing rows are already stored
// as correct Bangladesh wall-clock text.
process.env.TZ = process.env.TZ || 'Asia/Dhaka';

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

// Every pooled connection also gets its session timezone pinned explicitly —
// belt-and-suspenders alongside process.env.TZ above, since PgBouncer/connection
// poolers on some hosts can reset session settings between checkouts.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Dhaka'").catch(() => {});
});

module.exports = pool;
