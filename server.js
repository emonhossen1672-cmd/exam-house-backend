require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { generalLimiter } = require('./middleware/rateLimit');

const app = express();
app.use(cors());
app.use(express.json());

// main student-facing website — served at "/"
app.use(express.static(path.join(__dirname, 'public-site')));

// admin panel — served at "/admin"
app.use('/admin', express.static(path.join(__dirname, 'public')));

// general safety-net rate limit for all API traffic; stricter per-route
// limiters (login, OTP, submissions) are applied inside their own route files
app.use('/api/', generalLimiter);

app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'Exam House API' });
});

app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/bulk-upload', require('./routes/bulkUpload.routes'));
app.use('/api/questions', require('./routes/questions.routes'));
app.use('/api/exams', require('./routes/exams.routes'));
app.use('/api/results', require('./routes/results.routes'));
app.use('/api/bookmarks', require('./routes/bookmarks.routes'));
app.use('/api/reports', require('./routes/reports.routes'));

const PORT = process.env.PORT || 4000;

const autoInit = require('./autoInit');
autoInit().finally(() => {
  app.listen(PORT, () => console.log(`Exam House API running on port ${PORT}`));
});
