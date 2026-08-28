// middleware/auth.js — protects /api/admin/* routes
const jwt = require('jsonwebtoken');

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'লগইন প্রয়োজন' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'সেশন মেয়াদোত্তীর্ণ, আবার লগইন করুন' });
  }
}

module.exports = { requireAdmin };
