'use strict';

/*
 * End-to-end safety test for multi-group core routing. The setup mirrors the
 * corruption scenario the round-trip guard is designed to prevent: an SMS
 * save arrives in GPGX (a genesis + sms member). Without the guard, the
 * Genesis adapter would byte-expand the SMS data into MiSTer Genesis/, and
 * a subsequent reconcile would pick up that byte-expanded file and fan the
 * garbage back to the source. With the guard, the Genesis-side write is
 * skipped and only the SMS-side write happens.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');

function patterned(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-multi-'));
const raSaves = path.join(tmp, 'retroarch', 'saves');
const msSaves = path.join(tmp, 'mister', 'saves');

// Pre-create every target dir so writeFile doesn't need to mkdir
const mapping = loadMapping(null);
for (const def of Object.values(mapping.systems)) {
  for (const d of def.retroarch) fs.mkdirSync(path.join(raSaves, d), { recursive: true });
  for (const d of def.mister) fs.mkdirSync(path.join(msSaves, d), { recursive: true });
}

// Case 1: SMS save (8 KiB) arrives in GPGX folder — the corruption scenario.
const smsRaw = patterned(8192, 42);
const src = path.join(raSaves, 'Genesis Plus GX', 'BestSMSGame.srm');
fs.writeFileSync(src, smsRaw);

const errors = [];
const engine = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: () => {}, error: (m) => { errors.push(String(m)); console.error('ERR:', m); } },
});
engine.reconcileAll();

// The SMS-side target MUST exist and reconstruct the source
const msSms = path.join(msSaves, 'SMS', 'BestSMSGame.sav');
assert(fs.existsSync(msSms), 'SMS-side target should be written');
const msSmsBytes = fs.readFileSync(msSms);
assert.strictEqual(msSmsBytes.length, 32768, 'SMS-side padded to 32 KiB');
assert(msSmsBytes.subarray(0, 8192).equals(smsRaw), 'SMS-side first 8 KiB matches source');

// The Genesis-side targets MUST NOT exist — the round-trip guard skipped them
for (const d of ['Genesis', 'MegaDrive']) {
  const p = path.join(msSaves, d, 'BestSMSGame.sav');
  assert(!fs.existsSync(p), `MiSTer ${d}/ must not receive an SMS save via the Genesis adapter`);
}

// RA-side fan-out. The SMS save is routed only to cores that belong to the
// sms/gg groups — including the multi-system Sega cores, which are members of
// genesis AND sms/gg. Content discrimination keeps it OUT of the genesis
// group, so Genesis-only RA cores (BlastEm, ClownMDEmu) must NOT receive it.
for (const d of ['SMS Plus GX', 'Gearsystem', 'Emux SMS']) {
  const p = path.join(raSaves, d, 'BestSMSGame.srm');
  assert(fs.existsSync(p) && fs.readFileSync(p).equals(smsRaw), `RA SMS core ${d} passthrough`);
}
for (const d of ['PicoDrive', 'Genesis Plus GX Wide']) {
  // Multi-system cores: reachable via the sms/gg groups, so they DO get it.
  const p = path.join(raSaves, d, 'BestSMSGame.srm');
  assert(fs.existsSync(p) && fs.readFileSync(p).equals(smsRaw), `multi-system core ${d} passthrough`);
}
for (const d of ['BlastEm', 'ClownMDEmu']) {
  // Genesis-only cores: the SMS save must never land here (discriminator).
  const p = path.join(raSaves, d, 'BestSMSGame.srm');
  assert(!fs.existsSync(p), `Genesis-only core ${d} must NOT receive an SMS save`);
}

// The source itself must not have been touched
assert(fs.readFileSync(src).equals(smsRaw), 'source SMS save preserved byte-for-byte');

// Now the critical test: run a SECOND reconcile. Without the round-trip
// guard, MiSTer Genesis/ would win on mtime and its byte-expanded contents
// would flow back to the source. With the guard, nothing changed.
const srcMtimeBefore = fs.statSync(src).mtimeMs;
engine.reconcileAll();
const srcMtimeAfter = fs.statSync(src).mtimeMs;
assert.strictEqual(srcMtimeBefore, srcMtimeAfter, 'second reconcile must not touch source');
assert(fs.readFileSync(src).equals(smsRaw), 'source SMS save still intact after 2nd reconcile');

// Case 2: Genesis save via GPGX — the intended-family flow — must succeed
// on the MiSTer Genesis targets AND the MiSTer SMS target (padded-equivalent
// safe there).
const genRaw = (() => {
  // Byte-expanded 8 KiB save (emulator format): every low byte carries the
  // real value, high bytes are 0x00.
  const inner = patterned(4096, 77);
  const b = Buffer.alloc(8192);
  for (let i = 0; i < inner.length; i += 1) b[i * 2 + 1] = inner[i];
  return b;
})();
fs.writeFileSync(path.join(raSaves, 'Genesis Plus GX', 'RealGenesisGame.srm'), genRaw);
engine.reconcileAll();

for (const d of ['Genesis', 'MegaDrive']) {
  const p = path.join(msSaves, d, 'RealGenesisGame.sav');
  assert(fs.existsSync(p), `Genesis target ${d}/ should receive a genesis save`);
  const b = fs.readFileSync(p);
  assert.strictEqual(b.length, 65536, `Genesis target ${d}/ padded to 64 KiB`);
}
const msSms2 = path.join(msSaves, 'SMS', 'RealGenesisGame.sav');
assert(fs.existsSync(msSms2), 'SMS target also receives the (padded-equivalent) copy');

console.log('MULTI-GROUP SAFETY TEST PASSED');
