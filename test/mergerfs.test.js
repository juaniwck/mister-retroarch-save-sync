'use strict';

/*
 * Regression test for the class of mount weirdness we've seen: mkdir()
 * spuriously returns ENOENT on stacked/bind/FUSE filesystems (mergerfs
 * path-preserving policies, some proxmox LXC bind mounts, overlayfs) even
 * when the directory objectively exists and writeFile into it works fine.
 *
 * We break mkdir globally. Writes into EXISTING directories must succeed
 * without ever needing mkdir. A genuinely missing directory must be skipped
 * with a single logged error, not one per game.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Break mkdir before loading the engine
const realMkdirSync = fs.mkdirSync.bind(fs);
let mkdirCalls = 0;
const brokenMkdir = () => {
  mkdirCalls += 1;
  const e = new Error('ENOENT: no such file or directory, mkdir');
  e.code = 'ENOENT';
  throw e;
};

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-mergerfs-'));
const raSaves = path.join(tmp, 'retroarch', 'saves');
const msSaves = path.join(tmp, 'mister', 'saves');

function put(root, dir, name, buf) {
  const p = path.join(root, dir, name);
  realMkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}
function patterned(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

// Pre-create every target dir the mapping references EXCEPT two we deliberately
// leave missing so mkdir(-broken) is exercised.
const mapping = loadMapping(null);
const preexisting = new Set();
for (const def of Object.values(mapping.systems)) {
  for (const d of def.retroarch) preexisting.add(path.join(raSaves, d));
  for (const d of def.mister) preexisting.add(path.join(msSaves, d));
}
preexisting.delete(path.join(msSaves, 'GBC'));       // MiSTer side: missing
preexisting.delete(path.join(raSaves, 'bsnes-hd beta')); // RA side: missing
for (const d of preexisting) realMkdirSync(d, { recursive: true });

const snes = patterned(8192, 1);
put(raSaves, 'bsnes-jg', 'Chrono.srm', snes);
const gb = patterned(32768, 2);
put(raSaves, 'Gambatte', 'Crystal.srm', gb);

// Break mkdir for the engine under test
fs.mkdirSync = brokenMkdir;

const errors = [];
const engine = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: () => {}, error: (m) => errors.push(String(m)) },
});

mkdirCalls = 0;
engine.reconcileAll();
fs.mkdirSync = realMkdirSync;

// Writes into existing directories must have succeeded
assert(fs.readFileSync(path.join(msSaves, 'SNES', 'Chrono.sav')).equals(snes), 'snes -> MiSTer');
assert(fs.readFileSync(path.join(msSaves, 'GAMEBOY', 'Crystal.sav')).equals(gb), 'gb -> GAMEBOY');
assert(fs.readFileSync(path.join(msSaves, 'SGB', 'Crystal.sav')).equals(gb), 'gb -> SGB');
assert(fs.readFileSync(path.join(raSaves, 'mGBA', 'Crystal.srm')).equals(gb), 'gb -> mGBA');

// The two intentionally-missing directories must have been skipped
assert(!fs.existsSync(path.join(msSaves, 'GBC')), 'GBC not created');
assert(!fs.existsSync(path.join(raSaves, 'bsnes-hd beta')), 'bsnes-hd beta not created');

// Exactly one error per missing directory
const perDir = {};
for (const e of errors) {
  const m = e.match(/cannot write into (.+?) \(/);
  if (m) perDir[m[1]] = (perDir[m[1]] || 0) + 1;
}
for (const [dir, count] of Object.entries(perDir)) {
  assert.strictEqual(count, 1, `expected 1 error for ${dir}, got ${count}`);
}
const missing = Object.keys(perDir).map((d) => path.basename(d)).sort();
assert.deepStrictEqual(missing, ['GBC', 'bsnes-hd beta'], `unexpected failed dirs: ${missing}`);

console.log(`MERGERFS REGRESSION TEST PASSED (mkdir calls: ${mkdirCalls}, suppressed: ${missing.join(', ')})`);
