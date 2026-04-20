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

// Cursor-based pagination. `before` is the lowest id from the previous page.
// Using `id < ?` (indexed) stays O(log N) as the table grows — OFFSET gets
// slower as offset grows because SQLite has to scan past every skipped row.
const listPageStmt = db.prepare(`
  SELECT id, slug, title, duration_sec, parts_json, created_at
  FROM recordings
  WHERE id < ?
  ORDER BY id DESC
  LIMIT ?
`);

// Same query with no cursor (first page). SQLite has no native "optional
// param" so we use Number.MAX_SAFE_INTEGER as the sentinel — 9007199254740991
// fits in a SQLite INTEGER column, and no real row id will ever reach it.
const FIRST_PAGE_CURSOR = Number.MAX_SAFE_INTEGER;

const updateTitleStmt = db.prepare(`
  UPDATE recordings SET title = ? WHERE slug = ?
`);

const deleteBySlugStmt = db.prepare(`
  DELETE FROM recordings WHERE slug = ?
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

/**
 * Paginated recent list.
 * @param {object} opts
 * @param {number} [opts.before] — return rows with id STRICTLY LESS THAN this.
 *   Omit for the first page.
 * @param {number} [opts.limit=10]
 * @returns {Array<{id,slug,title,duration_sec,parts,created_at}>}
 */
function listRecent({ before, limit = 10 } = {}) {
  const cursor = Number.isFinite(before) ? before : FIRST_PAGE_CURSOR;
  const cap = Math.max(1, Math.min(50, limit | 0 || 10));
  return listPageStmt.all(cursor, cap).map(row => ({
    ...row,
    parts: JSON.parse(row.parts_json),
  }));
}

function updateTitle(slug, title) {
  const res = updateTitleStmt.run((title || '').toString().slice(0, 200), slug);
  return res.changes > 0;
}

/**
 * Delete a record by slug. Returns the parts array (urls) so callers can
 * fire GHL deletes after the DB row is gone, or null if no such slug.
 */
function deleteBySlug(slug) {
  const row = getBySlug(slug);
  if (!row) return null;
  deleteBySlugStmt.run(slug);
  return row.parts;
}

module.exports = { insert, getBySlug, listRecent, updateTitle, deleteBySlug };
