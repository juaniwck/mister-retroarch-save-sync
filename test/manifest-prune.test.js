'use strict';

/*
 * Manifest staleness: deleting saves (or rm -rf'ing a whole core folder)
 * fires no write-style inotify event, so manifest.server kept stale entries
 * until an unrelated save write triggered a rebuild. The daemon's periodic
 * loop now uses countMissingManifestEntries() to detect entries pointing at
 * deleted files and rebuilds; the watcher additionally listens for
 * delete/moved_from for an immediate rebuild via the normal handleFile ->
 * onRetroarchWrite path.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeManifest, countMissingManifestEntries } = require('../src/manifest');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-manifest-'));
const saves = path.join(root, 'saves');
fs.mkdirSync(path.join(saves, 'FCEUmm'), { recursive: true });
fs.mkdirSync(path.join(saves, 'Mesen'), { recursive: true });
fs.writeFileSync(path.join(saves, 'FCEUmm', 'Game A.srm'), Buffer.alloc(8192, 1));
fs.writeFileSync(path.join(saves, 'Mesen', 'Game B.srm'), Buffer.alloc(8192, 2));
fs.writeFileSync(path.join(saves, 'Mesen', 'Game C.srm'), Buffer.alloc(8192, 3));

// Fresh manifest: nothing missing.
assert.strictEqual(writeManifest(root), 3, 'manifest covers all three saves');
assert.strictEqual(countMissingManifestEntries(root), 0, 'fresh manifest has no missing entries');

// rm -rf a whole core folder (the field scenario: dropping unwanted cores).
fs.rmSync(path.join(saves, 'Mesen'), { recursive: true, force: true });
assert.strictEqual(countMissingManifestEntries(root), 2, 'both deleted files detected as missing');

// Rebuild drops every stale entry in one pass.
assert.strictEqual(writeManifest(root), 1, 'rebuild keeps only existing files');
assert.strictEqual(countMissingManifestEntries(root), 0, 'no missing entries after rebuild');
const entries = JSON.parse(fs.readFileSync(path.join(root, 'manifest.server'), 'utf8'));
assert.strictEqual(entries.length, 1);
assert.strictEqual(entries[0].path, 'saves/FCEUmm/Game A.srm');

// Absent or unreadable manifest: never reports missing (nothing to prune).
fs.rmSync(path.join(root, 'manifest.server'));
assert.strictEqual(countMissingManifestEntries(root), 0, 'absent manifest -> 0');
fs.writeFileSync(path.join(root, 'manifest.server'), 'not json {');
assert.strictEqual(countMissingManifestEntries(root), 0, 'corrupt manifest -> 0');

console.log('MANIFEST PRUNE TEST PASSED');
