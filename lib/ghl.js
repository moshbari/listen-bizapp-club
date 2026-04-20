// GHL media upload — uses curl via execSync because Node's native FormData
// and the `form-data` npm package both fail with 400 "Unexpected end of form"
// on GHL's multipart parser. Pattern from the playbook's GHL_MEDIA_UPLOAD.md.
//
// Env vars:
//   GHL_API_KEY       — PIT token (pit-<uuid>)
//   GHL_LOCATION_ID   — sub-account location id
//   GHL_FOLDER_ID     — folder id (resolved once, reused forever)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function isConfigured() {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID && process.env.GHL_FOLDER_ID);
}

/**
 * Upload a file on disk to GHL media library.
 * @param {string} filePath absolute path to the file
 * @param {string} displayName name to show in GHL UI (no slashes)
 * @returns {Promise<string>} the public CDN URL
 */
function uploadToGhl(filePath, displayName) {
  if (!isConfigured()) throw new Error('[GHL] not configured');
  if (!fs.existsSync(filePath)) throw new Error(`[GHL] file not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(`[GHL] file too large: ${stat.size} bytes (max 25 MB for non-video). Split first.`);
  }

  const args = [
    '-s',
    '-S',
    '--fail-with-body',
    '-X', 'POST',
    'https://services.leadconnectorhq.com/medias/upload-file',
    '-H', `Authorization: Bearer ${process.env.GHL_API_KEY}`,
    '-H', 'Version: 2021-07-28',
    // Set MIME type explicitly. node:20-slim doesn't ship /etc/mime.types,
    // so without `;type=` curl sends application/octet-stream and GHL
    // rejects with INVALID_FILE_TYPE.
    '-F', `file=@${filePath};type=audio/mpeg`,
    '-F', 'hosted=false',
    '-F', `name=${displayName}`,
    '-F', `altId=${process.env.GHL_LOCATION_ID}`,
    '-F', 'altType=location',
    '-F', `parentId=${process.env.GHL_FOLDER_ID}`,
  ];

  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const body = (err.stdout || '') + (err.stderr || '');
    throw new Error(`[GHL] upload failed: ${body.slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`[GHL] non-JSON response: ${out.slice(0, 500)}`);
  }

  if (!parsed.url) {
    throw new Error(`[GHL] no url in response: ${JSON.stringify(parsed).slice(0, 500)}`);
  }

  console.log(`[GHL] uploaded ${displayName} → ${parsed.url}`);
  return parsed.url;
}

/**
 * Null-on-failure wrapper. Use this in user-facing paths so a GHL outage
 * doesn't block the user — caller can fall back to local disk.
 */
function tryUploadToGhl(filePath, displayName) {
  try {
    return uploadToGhl(filePath, displayName);
  } catch (err) {
    console.error('[GHL] tryUpload failed:', err.message);
    return null;
  }
}

/**
 * Best-effort delete of a media file from GHL by its CDN URL.
 * The URL pattern is:
 *   https://assets.cdn.filesafe.space/<locationId>/media/<fileUuid>.<ext>
 * `<fileUuid>` is the same id GHL accepts on `DELETE /medias/<id>`.
 *
 * Returns true on success, false on any failure (logged). Never throws —
 * callers shouldn't have a GHL delete failure block deleting the DB row.
 */
function tryDeleteFromGhl(url) {
  if (!isConfigured()) return false;
  if (!url || typeof url !== 'string') return false;
  const m = url.match(/\/media\/([0-9a-f-]{36})\.[a-z0-9]+(?:\?.*)?$/i);
  if (!m) {
    console.warn('[GHL] tryDelete: could not extract uuid from', url);
    return false;
  }
  const fileId = m[1];
  const args = [
    '-s',
    '-S',
    '--fail-with-body',
    '-X', 'DELETE',
    '-H', `Authorization: Bearer ${process.env.GHL_API_KEY}`,
    '-H', 'Version: 2021-07-28',
    `https://services.leadconnectorhq.com/medias/${fileId}?altId=${process.env.GHL_LOCATION_ID}&altType=location`,
  ];
  try {
    execFileSync('curl', args, { encoding: 'utf8' });
    console.log(`[GHL] deleted ${fileId}`);
    return true;
  } catch (err) {
    const body = (err.stdout || '') + (err.stderr || '');
    console.warn(`[GHL] tryDelete failed for ${fileId}: ${body.slice(0, 200)}`);
    return false;
  }
}

/**
 * Self-check — list one folder to confirm the token + location are valid.
 * Called at server boot so we fail fast instead of at first upload.
 */
function healthCheck() {
  if (!isConfigured()) return { ok: false, reason: 'missing env vars' };
  const args = [
    '-s',
    '-S',
    '--fail-with-body',
    '-H', `Authorization: Bearer ${process.env.GHL_API_KEY}`,
    '-H', 'Version: 2021-07-28',
    `https://services.leadconnectorhq.com/medias/files?altId=${process.env.GHL_LOCATION_ID}&altType=location&type=folder&limit=1`,
  ];
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8' });
    JSON.parse(out); // just verify it's JSON
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err.stdout || err.message || '').toString().slice(0, 300) };
  }
}

module.exports = { isConfigured, uploadToGhl, tryUploadToGhl, tryDeleteFromGhl, healthCheck };
