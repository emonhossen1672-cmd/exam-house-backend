require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// serve the admin panel (static single-page HTML) at /admin
app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Exam House API', admin: '/admin' });
});

app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/bulk-upload', require('./routes/bulkUpload.routes'));
app.use('/api/questions', require('./routes/questions.routes'));
app.use('/api/exams', require('./routes/exams.routes'));
app.use('/api/results', require('./routes/results.routes'));

const PORT = process.env.PORT || 4000;

const autoInit = require('./autoInit');
autoInit().finally(() => {
  app.listen(PORT, () => console.log(`Exam House API running on port ${PORT}`));
});
