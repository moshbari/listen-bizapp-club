// ffmpeg wrapper — transcode any audio input to 64 kbps mono MP3, then
// split into ≤ 24 MB parts so each part fits under GHL's 25 MB non-video cap.
//
// At 64 kbps mono, 1 minute = ~480 KB. A 40-minute part is ~19 MB, well
// under the 25 MB ceiling even with tag/metadata overhead.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PART_SECONDS = 40 * 60; // 40 minutes — keeps each part ≤ ~19 MB
const MAX_SINGLE_BYTES = 24 * 1024 * 1024; // 24 MB — leave 1 MB headroom below 25 MB cap

function probeDuration(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8' });
    const secs = parseFloat(out.trim());
    return Number.isFinite(secs) ? Math.round(secs) : 0;
  } catch (err) {
    console.error('[ffprobe]', err.message);
    return 0;
  }
}

/**
 * Transcode any audio file to 64 kbps mono MP3.
 * @param {string} inputPath
 * @param {string} outputPath .mp3 target
 */
function transcodeToMp3(inputPath, outputPath) {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-ac', '1',          // mono
    '-b:a', '64k',       // 64 kbps bitrate
    '-ar', '22050',      // 22.05 kHz sample rate (plenty for speech)
    '-y',                // overwrite
    outputPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * Split an MP3 into 40-minute parts in `outDir`. Output files are named
 * `${base}_001.mp3`, `${base}_002.mp3`, etc. (zero-padded).
 * Uses stream-copy so splitting is fast and lossless.
 */
function splitMp3(inputPath, outDir, base) {
  const pattern = path.join(outDir, `${base}_%03d.mp3`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-f', 'segment',
    '-segment_time', String(PART_SECONDS),
    '-c', 'copy',
    '-reset_timestamps', '1',
    '-y',
    pattern,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  // Collect the files ffmpeg produced, sorted by part number.
  const parts = fs.readdirSync(outDir)
    .filter(f => f.startsWith(`${base}_`) && f.endsWith('.mp3'))
    .sort();
  return parts.map(f => path.join(outDir, f));
}

/**
 * Full pipeline — takes a raw upload, returns an array of mp3 part paths
 * ready to upload to GHL. Cleans up the transcoded intermediary if split.
 * @returns {Promise<{parts: string[], durationSec: number}>}
 */
function prepareParts(inputPath, workDir, baseName) {
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const mp3Path = path.join(workDir, `${baseName}.mp3`);
  transcodeToMp3(inputPath, mp3Path);
  const durationSec = probeDuration(mp3Path);
  const size = fs.statSync(mp3Path).size;

  if (size <= MAX_SINGLE_BYTES) {
    return { parts: [mp3Path], durationSec };
  }

  console.log(`[transcode] ${size} bytes > ${MAX_SINGLE_BYTES} — splitting into ${PART_SECONDS}s parts`);
  const parts = splitMp3(mp3Path, workDir, baseName);
  // Remove the full-length intermediate — we only need the parts.
  try { fs.unlinkSync(mp3Path); } catch {}
  return { parts, durationSec };
}

module.exports = { prepareParts, probeDuration, transcodeToMp3, splitMp3 };
