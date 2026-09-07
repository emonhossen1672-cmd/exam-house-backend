// routes/upload.routes.js — lets a student upload a real photo (camera or
// gallery) of a handwritten রিটেন answer instead of pasting a link. Public
// endpoint (guests can submit written exams too, same as /api/written-answers).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const asyncHandler = require('../utils/asyncHandler');
const pool = require('../db');
const { optionalUser, requireUser } = require('../middleware/auth');
const { submitLimiter } = require('../middleware/rateLimit');
const { uploadImageBuffer, isConfigured } = require('../services/imageUpload');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — plenty for a phone photo
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('শুধু ছবি ফাইল আপলোড করা যাবে'));
    }
    cb(null, true);
  }
});

// GET /api/upload/status — lets the frontend check once (on exam start)
// whether real upload is available, so it can hide the camera/gallery
// button and fall back to the manual link input if Cloudinary isn't
// configured yet, instead of failing only when the student tries to submit.
router.get('/status', (req, res) => {
  res.json({ enabled: isConfigured() });
});

// POST /api/upload/image  (multipart/form-data, field name: image)
router.post('/image', submitLimiter, optionalUser, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ছবি পাওয়া যায়নি' });
  try {
    const url = await uploadImageBuffer(req.file.buffer, req.file.originalname);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message || 'ছবি আপলোড ব্যর্থ হয়েছে' });
  }
}));

// POST /api/upload/avatar  (multipart/form-data, field name: image)
// Logged-in-only: uploads to a separate 'exam-house/avatars' Cloudinary
// folder and immediately saves the resulting URL onto the user's row, so
// the frontend just needs to call this one endpoint from the profile
// screen's "change photo" button and re-render with the returned avatar_url.
router.post('/avatar', submitLimiter, requireUser, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ছবি পাওয়া যায়নি' });
  try {
    const url = await uploadImageBuffer(req.file.buffer, req.file.originalname, 'exam-house/avatars');
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [url, req.user.id]);
    res.json({ avatar_url: url });
  } catch (err) {
    res.status(400).json({ error: err.message || 'ছবি আপলোড ব্যর্থ হয়েছে' });
  }
}));

module.exports = router;
