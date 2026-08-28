// db.js — PostgreSQL connection pool
// On Render, set DATABASE_URL to your Postgres instance's "Internal Database URL".
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

module.exports = pool;
