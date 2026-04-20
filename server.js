// listen.bizapp.club — upload iPhone voice memos, share a link, play in browser.
//
// Flow:
//   1. Owner logs in with UPLOAD_PASSWORD.
//   2. Owner picks a voice memo file (any audio format iPhone produces).
//   3. Server transcodes to 64 kbps mono MP3 via ffmpeg.
//   4. If MP3 > 24 MB, server splits into 40-minute parts.
//   5. Each part uploads to GHL media library.
//   6. Row written to SQLite with slug + ordered part URLs.
//   7. Owner gets a share link like /p/<slug>.
//   8. Recipients open the link — one big play button, auto-advances
//      through parts, no login, no download prompt.

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { nanoid } = require('nanoid');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./lib/db');
const ghl = require('./lib/ghl');
const { prepareParts, probeDuration } = require('./lib/transcode');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SITE_NAME = process.env.SITE_NAME || 'listen.bizapp.club';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://listen.bizapp.club';

if (!UPLOAD_PASSWORD) {
  console.error('[boot] UPLOAD_PASSWORD is not set — refusing to start');
  process.exit(1);
}

// ---------- middleware ----------

app.use(cookieParser(SESSION_SECRET));
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Traefik

// Cheap logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${req.method}] ${req.originalUrl} → ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Upload multer — stream to disk, 500 MB cap on the incoming file.
const upload = multer({
  dest: process.env.UPLOAD_TMP || os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB incoming
});

function requireOwner(req, res, next) {
  if (req.signedCookies.auth === 'ok') return next();
  return res.redirect('/login');
}

// ---------- helpers ----------

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function layout({ title, body, ogTitle, ogDescription, ogAudioUrl, noindex = true }) {
  const og = [
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:type" content="music.song">`,
    `<meta property="og:title" content="${escHtml(ogTitle || title)}">`,
    ogDescription ? `<meta property="og:description" content="${escHtml(ogDescription)}">` : '',
    ogAudioUrl ? `<meta property="og:audio" content="${escHtml(ogAudioUrl)}">` : '',
    ogAudioUrl ? `<meta property="og:audio:type" content="audio/mpeg">` : '',
    `<meta name="twitter:card" content="player">`,
    `<meta name="twitter:title" content="${escHtml(ogTitle || title)}">`,
    ogDescription ? `<meta name="twitter:description" content="${escHtml(ogDescription)}">` : '',
  ].filter(Boolean).join('\n  ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(title)}</title>
  ${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
  ${og}
  <style>${BASE_CSS}</style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function escHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const BASE_CSS = `
  :root { --fg:#111; --muted:#666; --bg:#fafafa; --card:#fff; --brand:#2563eb; --brand-dark:#1d4ed8; --ok:#16a34a; --err:#dc2626; --border:#e5e7eb; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 24px 0 8px; }
  p { margin: 0 0 16px; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .btn { display: inline-block; background: var(--brand); color: #fff; border: 0; border-radius: 10px; padding: 14px 22px; font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; min-height: 48px; }
  .btn:hover { background: var(--brand-dark); }
  .btn:active { transform: translateY(1px); }
  .btn-block { display: block; width: 100%; text-align: center; }
  .btn-secondary { background: #fff; color: var(--fg); border: 1px solid var(--border); }
  .btn-secondary:hover { background: #f3f4f6; }
  input[type="file"], input[type="password"], input[type="text"] { display: block; width: 100%; padding: 12px 14px; font-size: 16px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
  input[type="file"] { padding: 10px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .stack > * + * { margin-top: 12px; }
  .link-box { padding: 14px; background: #f3f4f6; border-radius: 10px; font-family: ui-monospace, monospace; word-break: break-all; font-size: 14px; border: 1px solid var(--border); }
  .ok { color: var(--ok); }
  .err { color: var(--err); }
  .player { margin-top: 8px; }
  audio { width: 100%; outline: none; }
  .part-label { color: var(--muted); font-size: 14px; margin-top: 8px; }
  .footer { margin-top: 40px; color: var(--muted); font-size: 13px; text-align: center; }
`;

// ---------- routes ----------

app.get('/', (req, res) => {
  if (req.signedCookies.auth === 'ok') return res.redirect('/upload');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.send(layout({
    title: 'Log in — ' + SITE_NAME,
    body: `
      <h1>Log in</h1>
      <p class="muted">Enter your password to upload a voice message.</p>
      <form class="card stack" method="POST" action="/login">
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autofocus>
        </div>
        <button type="submit" class="btn btn-block">Log in</button>
        ${req.query.err ? '<p class="err">Wrong password. Try again.</p>' : ''}
      </form>
    `,
  }));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === UPLOAD_PASSWORD) {
    res.cookie('auth', 'ok', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    return res.redirect('/upload');
  }
  return res.redirect('/login?err=1');
});

app.post('/logout', (req, res) => {
  res.clearCookie('auth');
  res.redirect('/login');
});

app.get('/upload', requireOwner, (req, res) => {
  const recent = db.listRecent(10);
  const recentHtml = recent.length === 0 ? '' : `
    <h2>Recent</h2>
    <div class="card">
      ${recent.map(r => `
        <div style="padding: 10px 0; border-bottom: 1px solid var(--border);">
          <div><a href="/p/${r.slug}">/p/${r.slug}</a></div>
          <div class="muted" style="font-size: 13px;">${escHtml(r.title || '(untitled)')} · ${fmtDuration(r.duration_sec)} · ${r.parts.length} part${r.parts.length !== 1 ? 's' : ''}</div>
        </div>
      `).join('')}
    </div>
  `;

  res.send(layout({
    title: 'Upload — ' + SITE_NAME,
    body: `
      <h1>Upload a voice message</h1>
      <p class="muted">Share the link. No download needed.</p>
      <form class="card stack" method="POST" action="/api/upload" enctype="multipart/form-data" id="uploadForm">
        <div>
          <label for="title">Title (optional)</label>
          <input id="title" name="title" type="text" placeholder="e.g. Voice note — April 20">
        </div>
        <div>
          <label for="audio">Audio file</label>
          <input id="audio" name="audio" type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.mp4,.mov" required>
        </div>
        <button type="submit" class="btn btn-block" id="submitBtn">Upload and make link</button>
        <p class="muted" id="status" style="display:none;"></p>
      </form>
      ${recentHtml}
      <div class="footer">
        <form method="POST" action="/logout" style="display:inline;">
          <button type="submit" class="btn btn-secondary" style="padding: 8px 14px; min-height: 36px; font-size: 14px;">Log out</button>
        </form>
      </div>
      <script>
        const form = document.getElementById('uploadForm');
        const btn = document.getElementById('submitBtn');
        const status = document.getElementById('status');
        form.addEventListener('submit', () => {
          btn.disabled = true;
          btn.textContent = 'Uploading… this can take a minute for long files.';
          status.style.display = 'block';
          status.textContent = 'Transcoding and sending to storage…';
        });
      </script>
    `,
  }));
});

app.post('/api/upload', requireOwner, upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded');

  const workDir = path.join(os.tmpdir(), 'listen-' + nanoid(10));
  fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log(`[upload] received ${file.originalname} (${file.size} bytes)`);
    const baseName = nanoid(10);

    // Transcode + split to parts
    const { parts, durationSec } = prepareParts(file.path, workDir, baseName);
    console.log(`[upload] produced ${parts.length} part(s), ${durationSec}s total`);

    // Upload each part to GHL
    const partUrls = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const displayName = `${baseName}_${String(i + 1).padStart(3, '0')}.mp3`;
      const url = ghl.uploadToGhl(p, displayName);
      const size = fs.statSync(p).size;
      partUrls.push({ url, size });
    }

    // Slug — 8 chars is plenty, unguessable, short enough to share
    const slug = nanoid(8);
    db.insert({
      slug,
      title: (req.body.title || '').toString().slice(0, 200),
      durationSec,
      parts: partUrls,
    });

    const shareLink = `${PUBLIC_ORIGIN}/p/${slug}`;
    console.log(`[upload] done: ${shareLink}`);

    res.send(layout({
      title: 'Link ready — ' + SITE_NAME,
      body: `
        <h1 class="ok">Link ready</h1>
        <p class="muted">Send this link. Anyone can play it in a browser — no download, no login.</p>
        <div class="card stack">
          <div class="link-box" id="link">${escHtml(shareLink)}</div>
          <button class="btn btn-block" id="copyBtn" type="button">Copy link</button>
          <a class="btn btn-secondary btn-block" href="/p/${slug}" target="_blank" rel="noopener">Open to test</a>
        </div>
        <div class="card">
          <p><strong>Parts:</strong> ${parts.length}</p>
          <p><strong>Length:</strong> ${fmtDuration(durationSec)}</p>
        </div>
        <a href="/upload" class="btn btn-secondary btn-block">Upload another</a>
        <script>
          const btn = document.getElementById('copyBtn');
          btn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(${JSON.stringify(shareLink)});
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
            } catch (e) {
              btn.textContent = 'Copy failed — long-press the link';
            }
          });
        </script>
      `,
    }));
  } catch (err) {
    console.error('[upload] failed:', err);
    res.status(500).send(layout({
      title: 'Upload failed — ' + SITE_NAME,
      body: `
        <h1 class="err">Something broke</h1>
        <p>${escHtml(err.message || 'Unknown error')}</p>
        <a href="/upload" class="btn btn-block">Try again</a>
      `,
    }));
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(file.path); } catch {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

app.get('/p/:slug', (req, res) => {
  const rec = db.getBySlug(req.params.slug);
  if (!rec) {
    return res.status(404).send(layout({
      title: 'Not found',
      body: `<h1>Not found</h1><p>This link does not exist or was removed.</p>`,
    }));
  }

  // Hint search engines not to index — these are personal
  res.set('X-Robots-Tag', 'noindex, nofollow');

  const parts = rec.parts; // [{url, size}]
  const title = rec.title || 'Voice message';
  const totalParts = parts.length;
  const ogAudio = parts[0] && parts[0].url;

  const body = `
    <h1>${escHtml(title)}</h1>
    <p class="muted">${fmtDuration(rec.duration_sec)} · ${totalParts} part${totalParts !== 1 ? 's' : ''}</p>
    <div class="card">
      <audio id="player" class="player" controls preload="metadata" controlslist="nodownload" src="${escHtml(parts[0].url)}"></audio>
      <div class="part-label" id="partLabel">${totalParts > 1 ? 'Part 1 of ' + totalParts : ''}</div>
    </div>
    <div class="footer">Shared from ${escHtml(SITE_NAME)}</div>
    <script>
      const parts = ${JSON.stringify(parts.map(p => p.url))};
      const player = document.getElementById('player');
      const label = document.getElementById('partLabel');
      let idx = 0;
      player.addEventListener('ended', () => {
        if (idx < parts.length - 1) {
          idx += 1;
          player.src = parts[idx];
          label.textContent = 'Part ' + (idx + 1) + ' of ' + parts.length;
          player.play().catch(() => {
            // Autoplay blocked — show a button
            label.innerHTML = 'Part ' + (idx + 1) + ' of ' + parts.length + ' — <a href="#" id="nextBtn">tap to play</a>';
            document.getElementById('nextBtn').addEventListener('click', (e) => {
              e.preventDefault();
              player.play();
            });
          });
        }
      });
    </script>
  `;

  res.send(layout({
    title: title + ' — ' + SITE_NAME,
    body,
    ogTitle: title,
    ogDescription: `Voice message · ${fmtDuration(rec.duration_sec)}`,
    ogAudioUrl: ogAudio,
    noindex: true,
  }));
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, site: SITE_NAME });
});

// ---------- boot ----------

console.log(`[boot] starting ${SITE_NAME} on :${PORT}`);
const check = ghl.healthCheck();
if (check.ok) {
  console.log('[boot] GHL reachable');
} else {
  console.warn('[boot] GHL check failed:', check.reason);
}

app.listen(PORT, () => {
  console.log(`[boot] listening on :${PORT}`);
});
