// routes/seo.routes.js — SEO + link-preview support for the otherwise pure
// SPA in public-site/index.html.
//
// The SPA never changes location.pathname (every screen/overlay is opened
// via history.pushState({...}, '', location.pathname) — see index.html), so
// every visitor and every crawler always hits the exact same generic
// <title>/<meta> tags. That's fine for the app itself (Google renders JS
// fine these days) but it means:
//   1. Sharing a specific exam/notice link on Facebook/WhatsApp shows the
//      generic site title+description, not that exam's — bots that
//      generate link previews do NOT execute JS.
//   2. There's no sitemap.xml, so search engines have no list of the
//      thousands of individual exam/notice pages to crawl in the first
//      place.
//
// This file adds two things without touching the SPA's internal routing:
//   - GET /exam/:id and /notice/:id — served BEFORE the static index.html
//     middleware in server.js. Serves the *same* index.html but with the
//     <title>/<meta description>/OG tags swapped for that specific exam or
//     notice. The SPA's own JS (see the deep-link handler added to
//     index.html) then reads the same :id from the URL on load and opens
//     that exam/notice directly, exactly like the existing ?duel=/?ref=
//     deep links.
//   - GET /sitemap.xml + GET /robots.txt — list every public exam/notice
//     URL so search engines can discover them.
//
// Deliberately excludes internal/auto-generated exam rows (duel, daily
// quiz, practice, auto-subject-bucket) from both the sitemap and meta
// lookups — same filter the homepage tabs already use — since those aren't
// meant to be indexed or shared as standalone pages.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const INDEX_PATH = path.join(__dirname, '..', 'public-site', 'index.html');
const SITE_NAME = 'Exam House';
const DEFAULT_OG_IMAGE_PATH = '/icon-512.png';

// Only these exam rows are real, shareable, indexable content — mirrors the
// is_duel/is_daily/is_practice/is_auto_subject exclusion already used for
// the homepage's মন্ত্রণালয়/বিষয়ভিত্তিক tabs and total-exam count.
const PUBLIC_EXAM_FILTER = `
  e.is_duel = false AND e.is_daily = false AND e.is_practice = false
  AND e.is_auto_subject = false
`;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Swaps the <title> and injects/overwrites description + Open Graph + a
// canonical link tag in the shared index.html shell. Only touches <head> —
// the rest of the SPA markup/scripts is untouched, so this can't drift out
// of sync with the actual app.
function renderShellWithMeta(req, res, { title, description, canonicalPath, ogImage }) {
  let html;
  try {
    html = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (err) {
    return res.status(500).send('সাইট লোড করা যায়নি');
  }
  const url = `${baseUrl(req)}${canonicalPath}`;
  const image = ogImage || `${baseUrl(req)}${DEFAULT_OG_IMAGE_PATH}`;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`);

  const metaBlock = `
  <meta name="description" content="${safeDesc}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
</head>`;
  html = html.replace('</head>', metaBlock);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// GET /exam/:id — shareable/crawlable exam page. Falls through to the plain
// SPA shell (no injected meta) if the exam doesn't exist or isn't a public
// one, so a bad/old id still opens the app instead of erroring out.
router.get('/exam/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return next();
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.type, e.post_name, e.subject, e.grade,
         m.name AS ministry_name,
         CASE WHEN e.type = 'written'
           THEN (SELECT COUNT(*) FROM exam_written_questions ewq WHERE ewq.exam_id = e.id)
           ELSE (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id)
         END AS question_count
       FROM exams e LEFT JOIN ministries m ON m.id = e.ministry_id
       WHERE e.id = $1 AND ${PUBLIC_EXAM_FILTER}`,
      [id]
    );
    if (!rows.length) return next();
    const exam = rows[0];
    const parts = [exam.ministry_name, exam.subject, exam.grade ? `গ্রেড-${exam.grade}` : null]
      .filter(Boolean).join(' · ');
    const description = `${parts ? parts + ' — ' : ''}${exam.question_count || 0}টি প্রশ্ন নিয়ে ${SITE_NAME}-এ ফ্রি মডেল টেস্ট দিন, সাথে সাথে ফলাফল ও ব্যাখ্যা দেখুন।`;
    renderShellWithMeta(req, res, {
      title: `${exam.title} | ${SITE_NAME}`,
      description,
      canonicalPath: `/exam/${exam.id}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /notice/:id — shareable/crawlable notice (circular/announcement) page.
router.get('/notice/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return next();
  try {
    const { rows } = await pool.query(
      'SELECT id, title, body FROM notices WHERE id = $1',
      [id]
    );
    if (!rows.length) return next();
    const notice = rows[0];
    const description = notice.body.replace(/\s+/g, ' ').trim().slice(0, 160);
    renderShellWithMeta(req, res, {
      title: `${notice.title} | ${SITE_NAME}`,
      description: description || `${SITE_NAME}-এর নোটিশ`,
      canonicalPath: `/notice/${notice.id}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /sitemap.xml — lists home + every public exam + every notice, so
// search engines can find pages that otherwise only exist behind client-side
// JS navigation. lastmod uses created_at since these rows aren't updated
// after creation.
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const [examsRes, noticesRes] = await Promise.all([
      pool.query(`SELECT id, created_at FROM exams e WHERE ${PUBLIC_EXAM_FILTER} ORDER BY created_at DESC LIMIT 5000`),
      pool.query('SELECT id, created_at FROM notices ORDER BY created_at DESC LIMIT 1000'),
    ]);
    const root = baseUrl(req);
    const urls = [
      `<url><loc>${root}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      ...examsRes.rows.map(e => `<url><loc>${root}/exam/${e.id}</loc><lastmod>${new Date(e.created_at).toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
      ...noticesRes.rows.map(n => `<url><loc>${root}/notice/${n.id}</loc><lastmod>${new Date(n.created_at).toISOString().slice(0, 10)}</lastmod><changefreq>monthly</changefreq><priority>0.5</priority></url>`),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

// GET /robots.txt — allow everything, point at the sitemap.
router.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});

module.exports = router;
