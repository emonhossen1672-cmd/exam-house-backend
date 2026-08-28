// initDb.js — run once after deploy to create tables + your admin login
// On Render: open the Shell tab for this service and run:  node initDb.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅ Tables created.');

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = await bcrypt.hash(password, 10);

  const existing = await pool.query('SELECT id FROM admin_users WHERE username=$1', [username]);
  if (existing.rows.length === 0) {
    await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)', [username, hash]);
    console.log(`✅ Admin user created — username: ${username}`);
  } else {
    console.log('ℹ️ Admin user already exists, skipped.');
  }

  const ministries = ['স্বাস্থ্য অধিদপ্তর','শিক্ষা মন্ত্রণালয়','ভূমি মন্ত্রণালয়','খাদ্য অধিদপ্তর','ডাক অধিদপ্তর','সমাজসেবা অধিদপ্তর','পরিসংখ্যান ব্যুরো','প্রাথমিক শিক্ষা অধিদপ্তর'];
  for (const m of ministries) {
    await pool.query('INSERT INTO ministries(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [m]);
  }
  console.log('✅ Default ministries added.');

  await pool.end();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
