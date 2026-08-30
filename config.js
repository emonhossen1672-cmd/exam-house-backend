// config.js — central place for required environment variables.
//
// Previously, JWT_SECRET and ADMIN_PASSWORD silently fell back to hardcoded
// defaults ('dev-secret-change-me', 'changeme123') if the env vars weren't
// set. That's fine for local dev, but dangerous in production: if you forget
// to set them on Render, anyone who reads this public source code could
// forge a valid admin JWT or log in with the default password.
//
// This module makes that impossible to forget silently — the server now
// refuses to start at all if these aren't set, with a clear error message
// telling you exactly what to set and where.
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`\n❌ Missing required environment variable: ${name}`);
    console.error('   Set this in your Render dashboard (Environment tab) — or in a local .env file for dev —');
    console.error('   before starting the server. Refusing to start with an insecure default.\n');
    process.exit(1);
  }
  return value;
}

const JWT_SECRET = required('JWT_SECRET');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = required('ADMIN_PASSWORD');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

module.exports = { JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, IS_PRODUCTION };
