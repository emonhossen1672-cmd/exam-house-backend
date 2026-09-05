// services/imageUpload.js — uploads an image buffer (from multer) to
// Cloudinary using their signed upload API via plain fetch. No new npm
// dependency needed — Node 18+ ships a global fetch/FormData/Blob, and this
// project already relies on that (see services/aiGrading.js, services/sms.js).
//
// Fails soft in the same spirit as services/aiGrading.js: if Cloudinary
// isn't configured, this throws a clear Bangla error and the route below
// turns that into a 400 — the student's textarea answer still goes through
// fine, only the "upload a photo" button is unavailable until configured.
const crypto = require('crypto');
const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET
} = require('../config');

function isConfigured() {
  return !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

// Cloudinary's signed-upload signature: sha1 of all non-file params
// (sorted, key=value joined with &) plus the API secret appended, no
// separator before the secret. Only `timestamp` and `folder` are signed
// here since those are the only extra params we send.
function buildSignature(params) {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + CLOUDINARY_API_SECRET).digest('hex');
}

async function uploadImageBuffer(buffer, originalname) {
  if (!isConfigured()) {
    throw new Error('ছবি আপলোড এখনো চালু করা হয়নি (Cloudinary কনফিগার করা নেই)');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'exam-house/written-answers';
  const signature = buildSignature({ timestamp, folder });

  const form = new FormData();
  form.append('file', new Blob([buffer]), originalname || 'answer.jpg');
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('Cloudinary upload failed:', data);
    throw new Error('ছবি আপলোড ব্যর্থ হয়েছে');
  }
  return data.secure_url;
}

module.exports = { uploadImageBuffer, isConfigured };
