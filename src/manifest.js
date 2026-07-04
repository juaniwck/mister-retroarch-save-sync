/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 *
 * Regenerates the RetroArch cloud-sync style "manifest.server" file that must
 * live next to the saves directory: a JSON array of
 *   { "path": "saves/<Core>/<file>", "hash": "<md5 of file contents>" }
 * covering every file under saves/.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function md5File(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && !e.name.endsWith('.savesync.tmp')) out.push(p);
  }
  return out;
}

/**
 * @param retroarchRoot directory that CONTAINS the saves/ directory;
 *                      manifest.server is written here.
 */
function writeManifest(retroarchRoot) {
  const savesDir = path.join(retroarchRoot, 'saves');
  const files = walk(savesDir).sort((a, b) => a.localeCompare(b));

  const entries = files.map((f) => ({
    path: path.posix.join('saves', path.relative(savesDir, f).split(path.sep).join('/')),
    hash: md5File(f),
  }));

  const manifestPath = path.join(retroarchRoot, 'manifest.server');
  const tmpPath = `${manifestPath}.savesync.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpPath, manifestPath);
  return entries.length;
}

/**
 * Count manifest entries whose file no longer exists on disk. Deletions
 * (a removed save, an rm -rf'd core folder) don't produce the inotify events
 * the sync path listens for, so the periodic loop uses this to detect a
 * stale manifest and trigger a rebuild — writeManifest() always regenerates
 * from a fresh walk, so one rebuild drops every stale entry at once.
 * Returns 0 when the manifest is absent or unreadable (nothing to prune).
 */
function countMissingManifestEntries(retroarchRoot) {
  const manifestPath = path.join(retroarchRoot, 'manifest.server');
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(entries)) return 0;
  let missing = 0;
  for (const e of entries) {
    if (!e || typeof e.path !== 'string') continue;
    const p = path.join(retroarchRoot, ...e.path.split('/'));
    if (!fs.existsSync(p)) missing += 1;
  }
  return missing;
}

module.exports = { writeManifest, countMissingManifestEntries, md5File, walk };
