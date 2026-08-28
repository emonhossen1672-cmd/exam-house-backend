// autoInit.js — runs automatically every time the server starts.
// Safe to run repeatedly: uses IF NOT EXISTS / ON CONFLICT DO NOTHING,
// so it won't duplicate anything after the first successful run.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function autoInit() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('✅ Tables ready.');

    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';

    const existing = await pool.query('SELECT id FROM admin_users WHERE username=$1', [username]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)', [username, hash]);
      console.log(`✅ Admin user created — username: ${username}`);
    } else {
      console.log('ℹ️ Admin user already exists.');
    }

    const ministries = ['স্বাস্থ্য অধিদপ্তর','শিক্ষা মন্ত্রণালয়','ভূমি মন্ত্রণালয়','খাদ্য অধিদপ্তর','ডাক অধিদপ্তর','সমাজসেবা অধিদপ্তর','পরিসংখ্যান ব্যুরো','প্রাথমিক শিক্ষা অধিদপ্তর'];
    for (const m of ministries) {
      await pool.query('INSERT INTO ministries(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [m]);
    }
    console.log('✅ Startup check complete.');
  } catch (err) {
    console.error('❌ autoInit failed:', err.message);
  }
}

module.exports = autoInit;
