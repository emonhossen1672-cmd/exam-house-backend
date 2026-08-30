// middleware/auth.js — protects admin routes and user (student) routes
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'লগইন প্রয়োজন' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'অনুমতি নেই' });
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ, আবার লগইন করুন' });
  }
}

// requires a logged-in student/user — blocks the request if missing/invalid
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'লগইন প্রয়োজন' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'user') return res.status(403).json({ error: 'অনুমতি নেই' });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ, আবার লগইন করুন' });
  }
}

// attaches req.user if a valid user token is present, but never blocks (guests allowed)
function optionalUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role === 'user') req.user = payload;
    } catch (err) { /* invalid/expired token — just continue as guest */ }
  }
  next();
}

module.exports = { requireAdmin, requireUser, optionalUser };
