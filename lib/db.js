// Tiny SQLite wrapper. One table, no migrations framework — we rewrite
// the schema line if it changes. Persistent volume path comes from env.

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'listen.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    duration_sec INTEGER NOT NULL DEFAULT 0,
    parts_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_slug ON recordings(slug);
`);

const insertStmt = db.prepare(`
  INSERT INTO recordings (slug, title, duration_sec, parts_json)
  VALUES (?, ?, ?, ?)
`);

const getBySlugStmt = db.prepare(`
  SELECT slug, title, duration_sec, parts_json, created_at
  FROM recordings WHERE slug = ?
`);

const listRecentStmt = db.prepare(`
  SELECT slug, title, duration_sec, parts_json, created_at
  FROM recordings ORDER BY id DESC LIMIT ?
`);

function insert({ slug, title, durationSec, parts }) {
  insertStmt.run(slug, title || '', durationSec || 0, JSON.stringify(parts));
}

function getBySlug(slug) {
  const row = getBySlugStmt.get(slug);
  if (!row) return null;
  return {
    ...row,
    parts: JSON.parse(row.parts_json),
  };
}

function listRecent(limit = 20) {
  return listRecentStmt.all(limit).map(row => ({
    ...row,
    parts: JSON.parse(row.parts_json),
  }));
}

module.exports = { insert, getBySlug, listRecent };
