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

/**
 * Format a SQLite CURRENT_TIMESTAMP (UTC, "YYYY-MM-DD HH:MM:SS") as Gulf
 * Standard Time (Asia/Dubai, UTC+4) — what Mosh sees on his phone.
 * Example output: "Apr 20, 2026 · 9:29 AM GST"
 */
function fmtGstTimestamp(createdAt) {
  if (!createdAt) return '';
  // SQLite CURRENT_TIMESTAMP has no TZ suffix but is UTC. Append Z so the JS
  // Date parses it as UTC instead of local time.
  const raw = String(createdAt).trim();
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z');
  const d = new Date(iso);
  if (isNaN(d)) return '';
  try {
    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dubai',
      month: 'short', day: 'numeric', year: 'numeric',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dubai',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d);
    return `${date} · ${time} GST`;
  } catch {
    return '';
  }
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
  <header class="site-header">
    <a href="/" class="brand" aria-label="${escHtml(SITE_NAME)} — home">
      <span class="brand-mark">🎙</span>
      <span class="brand-name">${escHtml(SITE_NAME)}</span>
    </a>
  </header>
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

/**
 * Sanitize a title/filename for use as a GHL displayName and an HTTP download
 * filename. Keep it friendly (letters, numbers, space, dash, underscore, dot)
 * and short enough that GHL's UI doesn't truncate awkwardly.
 */
function sanitizeForFilename(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}._\- ]+/gu, '-')  // any other char → dash
    .replace(/-{2,}/g, '-')                 // collapse runs
    .replace(/^[\-_.\s]+|[\-_.\s]+$/g, '')  // trim punctuation
    .slice(0, 80)
    || 'voice-memo';
}

/** Filename without the extension (".m4a"/".mp3"/…) */
function baseFilename(originalName) {
  if (!originalName) return '';
  return path.parse(originalName).name || '';
}

// How many items per Recent page. Tuned for ~4-5 cards per viewport on mobile;
// IntersectionObserver triggers the next fetch while the user is still scrolling.
const RECENT_PAGE_SIZE = 10;

/**
 * Render one card's HTML. Used both for the initial server-rendered list
 * and for the JSON responses of /api/recent — same template, no drift.
 */
function renderRecentCard(r) {
  const shareLink = `${PUBLIC_ORIGIN}/p/${r.slug}`;
  const title = r.title || 'Voice memo';
  return `
    <div class="card stack recent-item" data-slug="${escHtml(r.slug)}" data-id="${r.id}">
      <div>
        <div style="font-weight: 600; font-size: 16px; word-break: break-word;" class="recent-title">${escHtml(title)}</div>
        <div class="muted" style="font-size: 13px; margin-top: 2px;">
          ${fmtDuration(r.duration_sec)} · ${r.parts.length} part${r.parts.length !== 1 ? 's' : ''}
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 2px;">
          ${escHtml(fmtGstTimestamp(r.created_at))}
        </div>
      </div>
      <div class="link-box recent-link">${escHtml(shareLink)}</div>
      <button type="button" class="btn btn-block copy-btn" data-url="${escHtml(shareLink)}">Copy link</button>
      <div class="row">
        <a class="btn btn-secondary" href="/p/${escHtml(r.slug)}" target="_blank" rel="noopener">Open</a>
        <button type="button" class="btn btn-secondary rename-btn" data-slug="${escHtml(r.slug)}">Rename</button>
        <button type="button" class="btn btn-danger delete-btn" data-slug="${escHtml(r.slug)}" data-title="${escHtml(title)}">Delete</button>
      </div>
    </div>
  `;
}

const BASE_CSS = `
  :root { --fg:#111; --muted:#666; --bg:#fafafa; --card:#fff; --brand:#2563eb; --brand-dark:#1d4ed8; --ok:#16a34a; --err:#dc2626; --border:#e5e7eb; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; }
  .site-header { background: #0f172a; padding: 14px 20px; }
  .site-header .brand { display: inline-flex; align-items: center; gap: 8px; color: #fff; text-decoration: none; font-weight: 700; font-size: 17px; letter-spacing: -0.01em; }
  .site-header .brand:hover { opacity: 0.85; }
  .site-header .brand-mark { font-size: 20px; line-height: 1; }
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
  .btn-danger { background: #fff; color: var(--err); border: 1px solid #fecaca; }
  .btn-danger:hover { background: #fef2f2; }
  .btn-danger:disabled { opacity: 0.6; cursor: default; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row .btn { flex: 1 1 auto; padding: 10px 14px; font-size: 14px; min-height: 44px; text-align: center; }
  .dropzone { position: relative; border: 2px dashed #cbd5e1; border-radius: 12px; background: #fff; transition: border-color .15s, background-color .15s; cursor: pointer; }
  .dropzone:hover { border-color: var(--brand); background: #f8fafc; }
  .dropzone.is-dragover { border-color: var(--brand); background: #eff6ff; }
  .dropzone input[type="file"] { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .dropzone-inner { padding: 32px 20px; text-align: center; pointer-events: none; }
  .dropzone-icon { font-size: 44px; line-height: 1; margin-bottom: 8px; }
  .dropzone-text strong { display: block; font-size: 16px; color: var(--fg); }
  .dropzone-text .sub { display: block; font-size: 14px; color: var(--muted); margin-top: 4px; }
  .dropzone-filename { display: none; margin-top: 12px; font-weight: 600; color: var(--brand); word-break: break-all; font-size: 14px; }
  .dropzone.has-file .dropzone-filename { display: block; }
  .dropzone.has-file .dropzone-icon { color: var(--ok); }
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
  /* Resume-listening modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.55); display: none; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .modal-backdrop.is-open { display: flex; }
  .modal { background: var(--card); border-radius: 14px; padding: 24px; max-width: 420px; width: 100%; box-shadow: 0 12px 32px rgba(0,0,0,0.2); }
  .modal h2 { margin: 0 0 8px; font-size: 20px; }
  .modal p { margin: 0 0 20px; color: var(--muted); font-size: 15px; line-height: 1.45; }
  .modal .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .modal .row .btn { flex: 1 1 140px; }
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
  const firstPage = db.listRecent({ limit: RECENT_PAGE_SIZE });
  // Cursor for the next page — the lowest id we rendered. `null` means
  // "no more" (won't happen here unless the user has exactly 0 recordings,
  // but we also use null later when the server signals end-of-list).
  const nextCursor = firstPage.length === RECENT_PAGE_SIZE
    ? firstPage[firstPage.length - 1].id
    : null;

  const recentHtml = firstPage.length === 0 ? '' : `
    <h2>Recent</h2>
    <div id="recent-list">
      ${firstPage.map(renderRecentCard).join('')}
    </div>
    ${nextCursor != null ? `
      <div id="recent-sentinel" data-cursor="${nextCursor}" class="muted" style="text-align: center; padding: 16px;">
        Loading more…
      </div>
    ` : ''}
    <script>
      // ---- Event delegation on #recent-list — one set of handlers covers
      //      both the initial cards and everything we append on scroll. ----
      (function () {
        const list = document.getElementById('recent-list');
        if (!list) return;

        list.addEventListener('click', async (e) => {
          const btn = e.target.closest('button, a');
          if (!btn) return;

          // Copy link
          if (btn.classList.contains('copy-btn')) {
            const url = btn.dataset.url;
            try {
              await navigator.clipboard.writeText(url);
              const prev = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = prev; }, 1500);
            } catch (err) {
              btn.textContent = 'Copy failed — long-press the link';
            }
            return;
          }

          // Rename
          if (btn.classList.contains('rename-btn')) {
            const item = btn.closest('.recent-item');
            const current = item.querySelector('.recent-title').textContent;
            const next = prompt('New title', current);
            if (next == null) return;
            const title = next.trim();
            if (!title) { alert('Title cannot be empty.'); return; }
            const res = await fetch('/api/rename/' + btn.dataset.slug, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title }),
              credentials: 'same-origin',
            });
            if (res.ok) {
              item.querySelector('.recent-title').textContent = title;
              // Keep the Delete button's data-title in sync so the confirm
              // message matches the renamed record.
              const delBtn = item.querySelector('.delete-btn');
              if (delBtn) delBtn.dataset.title = title;
            } else {
              alert('Rename failed.');
            }
            return;
          }

          // Delete
          if (btn.classList.contains('delete-btn')) {
            const title = btn.dataset.title || 'this recording';
            const ok = confirm('Delete "' + title + '"?\\n\\nThe share link will stop working and the audio will be removed from storage. This cannot be undone.');
            if (!ok) return;
            btn.disabled = true;
            btn.textContent = 'Deleting…';
            const res = await fetch('/api/delete/' + btn.dataset.slug, {
              method: 'POST',
              credentials: 'same-origin',
            });
            if (res.ok) {
              btn.closest('.recent-item').remove();
            } else {
              btn.disabled = false;
              btn.textContent = 'Delete';
              alert('Delete failed.');
            }
            return;
          }
        });

        // ---- Infinite scroll: IntersectionObserver on a sentinel div ----
        //
        // When the sentinel crosses into the viewport (with 200px rootMargin
        // so the fetch starts before the user reaches the bottom), we hit
        // /api/recent?before=<cursor>&limit=N. Server returns { html, nextCursor }.
        // Append html, update cursor; when nextCursor is null the server is
        // telling us "that was the last page" — we disconnect and remove the
        // sentinel so the "Loading more…" text doesn't linger.
        const sentinel = document.getElementById('recent-sentinel');
        if (!sentinel || !('IntersectionObserver' in window)) return;

        let loading = false;
        const io = new IntersectionObserver(async (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || loading) continue;
            loading = true;
            const cursor = sentinel.dataset.cursor;
            try {
              const res = await fetch('/api/recent?before=' + encodeURIComponent(cursor) + '&limit=${RECENT_PAGE_SIZE}', {
                credentials: 'same-origin',
              });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const data = await res.json();
              if (data.html) {
                list.insertAdjacentHTML('beforeend', data.html);
              }
              if (data.nextCursor == null) {
                io.disconnect();
                sentinel.remove();
              } else {
                sentinel.dataset.cursor = data.nextCursor;
                loading = false;
              }
            } catch (err) {
              console.error('[recent] load more failed', err);
              sentinel.textContent = 'Could not load more — scroll to retry.';
              loading = false;
            }
          }
        }, { rootMargin: '200px 0px' });
        io.observe(sentinel);
      })();
    </script>
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
          <div class="dropzone" id="dropzone">
            <input id="audio" name="audio" type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.mp4,.mov" required>
            <div class="dropzone-inner">
              <div class="dropzone-icon" id="dropzoneIcon">🎙</div>
              <div class="dropzone-text">
                <strong>Drop your voice memo here</strong>
                <span class="sub">or tap to choose a file — .m4a, .mp3, .wav, .aac</span>
              </div>
              <div class="dropzone-filename" id="dropzoneFilename"></div>
            </div>
          </div>
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

        // ---- Dropzone: drag/drop + click + filename echo ----
        const dropzone = document.getElementById('dropzone');
        const fileInput = document.getElementById('audio');
        const filenameEl = document.getElementById('dropzoneFilename');
        const iconEl = document.getElementById('dropzoneIcon');

        function showFilename() {
          const f = fileInput.files && fileInput.files[0];
          if (f) {
            filenameEl.textContent = f.name;
            dropzone.classList.add('has-file');
            iconEl.textContent = '✅';
          } else {
            filenameEl.textContent = '';
            dropzone.classList.remove('has-file');
            iconEl.textContent = '🎙';
          }
        }

        ['dragenter', 'dragover'].forEach(ev => {
          dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('is-dragover');
          });
        });
        ['dragleave', 'drop'].forEach(ev => {
          dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('is-dragover');
          });
        });
        dropzone.addEventListener('drop', (e) => {
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            // Assign the dropped file(s) into the file input so the form submits them.
            try {
              fileInput.files = e.dataTransfer.files;
            } catch (err) {
              // Some browsers don't allow direct assignment — fall through to change handler.
            }
            showFilename();
          }
        });
        fileInput.addEventListener('change', showFilename);
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
    const baseName = nanoid(10); // internal work-dir prefix, never shown

    // Transcode + split to parts
    const { parts, durationSec } = prepareParts(file.path, workDir, baseName);
    console.log(`[upload] produced ${parts.length} part(s), ${durationSec}s total`);

    // Resolve the title: user-typed value takes priority, otherwise fall back
    // to the uploaded filename without its extension. This same value drives
    // (a) the title shown on the listen page, (b) the displayName sent to GHL
    // so Mosh can find the file in the GHL media library later, and (c) the
    // Content-Disposition filename when a listener taps Download.
    const userTitle = (req.body.title || '').toString().trim();
    const fallbackTitle = baseFilename(file.originalname) || 'Voice memo';
    const title = (userTitle || fallbackTitle).slice(0, 200);

    // Unique suffix on GHL names keeps two "Meeting notes" uploads from
    // colliding in the folder — the Recent UI shows titles without it.
    const uniq = nanoid(4);
    const safeBase = sanitizeForFilename(title);

    // Upload each part to GHL
    const partUrls = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const partSuffix = parts.length > 1 ? `-part-${String(i + 1).padStart(2, '0')}` : '';
      const displayName = `${safeBase}${partSuffix}-${uniq}.mp3`;
      const url = ghl.uploadToGhl(p, displayName);
      const size = fs.statSync(p).size;
      partUrls.push({ url, size });
    }

    // Slug — 8 chars is plenty, unguessable, short enough to share
    const slug = nanoid(8);
    db.insert({
      slug,
      title,
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

// ---- Admin-only: paginated Recent list. Returns pre-rendered card HTML ----
//
// Query params:
//   before — required cursor (the lowest id from the previous page)
//   limit  — optional, clamped 1..50, defaults to RECENT_PAGE_SIZE
//
// Response: { html: "<div>…</div><div>…</div>", nextCursor: <id|null> }
// When nextCursor is null the caller should stop asking — that was the last page.
app.get('/api/recent', requireOwner, (req, res) => {
  const before = parseInt(req.query.before, 10);
  if (!Number.isFinite(before) || before <= 0) {
    return res.status(400).json({ error: 'before cursor required' });
  }
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || RECENT_PAGE_SIZE));
  const rows = db.listRecent({ before, limit });
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
  res.json({
    html: rows.map(renderRecentCard).join(''),
    nextCursor,
  });
});

// ---- Admin-only: rename a recording's title. JSON body: {title: "..."} ----
app.post('/api/rename/:slug', requireOwner, express.json(), (req, res) => {
  const title = (req.body && req.body.title || '').toString().trim();
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });
  const changed = db.updateTitle(req.params.slug, title.slice(0, 200));
  if (!changed) return res.status(404).json({ ok: false, error: 'not found' });
  console.log(`[rename] ${req.params.slug} → ${title}`);
  res.json({ ok: true, title });
});

// ---- Admin-only: delete a recording (DB row + best-effort GHL cleanup) ----
app.post('/api/delete/:slug', requireOwner, (req, res) => {
  const parts = db.deleteBySlug(req.params.slug);
  if (!parts) return res.status(404).json({ ok: false, error: 'not found' });
  console.log(`[delete] ${req.params.slug} (${parts.length} part${parts.length !== 1 ? 's' : ''})`);
  // Fire GHL deletes best-effort — don't block the response on their speed,
  // and ignore failures (we already dropped the DB row, so the share link
  // is already dead; orphan files in GHL are noise, not a correctness bug).
  for (const p of parts) {
    try { ghl.tryDeleteFromGhl(p.url); } catch {}
  }
  res.json({ ok: true });
});

// ---- Public: proxy a part as a download (adds Content-Disposition) ----
//
// GHL serves the MP3 inline (browsers play it in the tab instead of saving).
// We can't force Content-Disposition on GHL's CDN URL without a signed URL,
// so we stream it through our server with our own headers. The filename is
// derived from the recording's title so it lands on disk with a useful name.
app.get('/d/:slug/:idx', async (req, res) => {
  const rec = db.getBySlug(req.params.slug);
  if (!rec) return res.status(404).send('Not found');
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= rec.parts.length) {
    return res.status(404).send('Not found');
  }
  const part = rec.parts[idx];
  const title = rec.title || 'voice-memo';
  const safeBase = sanitizeForFilename(title);
  const partSuffix = rec.parts.length > 1 ? ` - Part ${idx + 1}` : '';
  const filename = `${safeBase}${partSuffix}.mp3`;

  try {
    const upstream = await fetch(part.url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('Upstream error');
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    res.set('Cache-Control', 'public, max-age=3600');

    // Node 20 fetch returns a web ReadableStream — turn it into a Node stream.
    const { Readable } = require('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('[download]', err);
    res.status(502).send('Download failed');
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

  // Download buttons: one per part for multi-part, one labeled "Download" otherwise.
  const downloadBlock = totalParts === 1
    ? `<a class="btn btn-secondary btn-block" href="/d/${rec.slug}/0" download>⬇ Download</a>`
    : `<div class="row" style="margin-top: 8px;">
         ${parts.map((_p, i) => `
           <a class="btn btn-secondary" href="/d/${rec.slug}/${i}" download>⬇ Part ${i + 1}</a>
         `).join('')}
       </div>`;

  const body = `
    <h1>${escHtml(title)}</h1>
    <p class="muted">${fmtDuration(rec.duration_sec)} · ${totalParts} part${totalParts !== 1 ? 's' : ''}</p>
    <div class="card">
      <audio id="player" class="player" controls preload="metadata" src="${escHtml(parts[0].url)}"></audio>
      <div class="part-label" id="partLabel">${totalParts > 1 ? 'Part 1 of ' + totalParts : ''}</div>
      ${downloadBlock}
    </div>
    <div id="resumeModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="resumeTitle">
      <div class="modal">
        <h2 id="resumeTitle">Welcome back</h2>
        <p id="resumeMsg">You stopped at <span id="resumeAt">0:00</span>. Pick up where you left off, or start from the beginning?</p>
        <div class="row">
          <button type="button" class="btn" id="resumeContinue">▶ Continue</button>
          <button type="button" class="btn btn-secondary" id="resumeRestart">↺ Start over</button>
        </div>
      </div>
    </div>
    <div class="footer">Shared from ${escHtml(SITE_NAME)}</div>
    <script>
      const parts = ${JSON.stringify(parts.map(p => p.url))};
      const player = document.getElementById('player');
      const label = document.getElementById('partLabel');
      const STORAGE_KEY = 'listen:${rec.slug}';
      let idx = 0;

      // ---------- label helper ----------
      function setPartLabel(i) {
        label.textContent = parts.length > 1 ? 'Part ' + (i + 1) + ' of ' + parts.length : '';
      }

      // ---------- position persistence ----------
      // Save format: { partIdx, t, updatedAt }. Per-slug key → different
      // recordings don't collide. localStorage is per-browser by default,
      // which matches what we want ("browser-wise" resume).
      let lastSavedAt = 0;
      function savePosition(force) {
        // Don't persist trivial positions — avoids the modal appearing
        // when the user just clicked the link and immediately left.
        if (!player.src) return;
        const t = player.currentTime;
        if (!Number.isFinite(t)) return;
        if (!force && t < 3) return;                   // ignore first 3s
        const now = Date.now();
        if (!force && now - lastSavedAt < 2500) return; // throttle to 2.5s
        lastSavedAt = now;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            partIdx: idx,
            t: t,
            updatedAt: now,
          }));
        } catch { /* quota or disabled — nothing we can do */ }
      }
      function clearPosition() {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
      }

      player.addEventListener('timeupdate', () => savePosition(false));
      player.addEventListener('pause', () => savePosition(true));
      document.addEventListener('visibilitychange', () => {
        // Fires reliably on mobile when the user backgrounds the tab,
        // unlike 'beforeunload' which is unreliable on iOS Safari.
        if (document.visibilityState === 'hidden') savePosition(true);
      });
      window.addEventListener('pagehide', () => savePosition(true));

      // ---------- part advance (existing ended-handler logic) ----------
      player.addEventListener('ended', () => {
        if (idx < parts.length - 1) {
          idx += 1;
          player.src = parts[idx];
          setPartLabel(idx);
          player.play().catch(() => {
            label.innerHTML = 'Part ' + (idx + 1) + ' of ' + parts.length + ' — <a href="#" id="nextBtn">tap to play</a>';
            document.getElementById('nextBtn').addEventListener('click', (e) => {
              e.preventDefault();
              player.play();
            });
          });
        } else {
          // Reached the end of the final part — clear so next visit starts fresh.
          clearPosition();
        }
      });

      // ---------- resume modal ----------
      function fmtTime(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
      }

      function seekTo(partIdx, t) {
        idx = Math.max(0, Math.min(parts.length - 1, partIdx | 0));
        setPartLabel(idx);
        if (player.src !== parts[idx]) player.src = parts[idx];
        const doSeek = () => {
          try { player.currentTime = t; } catch {}
        };
        if (player.readyState >= 1) {
          doSeek();
        } else {
          player.addEventListener('loadedmetadata', doSeek, { once: true });
          player.load();
        }
      }

      (function maybeShowResume() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
        if (!saved) return;
        const partIdx = saved.partIdx | 0;
        const t = Number(saved.t) || 0;
        if (partIdx < 0 || partIdx >= parts.length) { clearPosition(); return; }
        if (t < 3) { clearPosition(); return; } // trivial — ignore

        // Global elapsed for nicer display across multi-part recordings.
        // We don't know part durations here, so just show the in-part time
        // plus a "Part X" hint if multi-part.
        const at = parts.length > 1
          ? 'Part ' + (partIdx + 1) + ' · ' + fmtTime(t)
          : fmtTime(t);
        document.getElementById('resumeAt').textContent = at;

        const modal = document.getElementById('resumeModal');
        modal.classList.add('is-open');

        document.getElementById('resumeContinue').addEventListener('click', () => {
          modal.classList.remove('is-open');
          seekTo(partIdx, t);
          player.play().catch(() => { /* autoplay blocked — user can tap play */ });
        });
        document.getElementById('resumeRestart').addEventListener('click', () => {
          modal.classList.remove('is-open');
          clearPosition();
          idx = 0;
          setPartLabel(0);
          if (player.src !== parts[0]) player.src = parts[0];
          try { player.currentTime = 0; } catch {}
          player.play().catch(() => { /* autoplay blocked */ });
        });
      })();
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
