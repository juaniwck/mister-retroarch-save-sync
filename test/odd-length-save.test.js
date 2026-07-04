'use strict';

/*
 * Regression: odd-length save in a Sega multi-system RA core folder.
 *
 * The vendored GenesisUtil.isByteExpanded() read one byte past the end of the
 * DataView whenever the input buffer was odd-length AND looked byte-expanded
 * (or uniform 0x00/0xFF) all the way to the end. Because both Sega
 * discriminators (genesisLike, smsGgLike) call isByteExpanded for any save
 * >= 512 bytes, an odd-length save in e.g. "Genesis Plus GX Wide" made every
 * reconcile pass throw "Offset is outside the bounds of the DataView" for
 * genesis, sms, AND gg. Reported in the field on:
 *   "Devil Crash Alternate Style PCE (Dragon's Fury Hack) v1 Pyron.srm"
 *
 * After the fix, byte-expansion detection treats any odd-length buffer as
 * "not byte-expanded" (expansion always doubles length, so an odd buffer can
 * never be expanded). The reconcile must complete without throwing, and no
 * wrong-format save may reach any MiSTer target (the round-trip guard skips
 * the MiSTer SMS write; the Genesis group rejects the save outright).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');
const { discriminators } = require('../src/converters');

// --- Unit-level: the discriminators must not throw on odd-length input, and
// must return the semantically correct answer (odd => not byte-expanded). ---
function oddUniform(n) { return Buffer.alloc(n, 0xff); }
function oddExpanded(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = i % 2 === 0 ? 0x00 : (i * 7) & 0xff;
  return b;
}
for (const [name, buf] of Object.entries({
  'odd uniform 0xFF (8193)': oddUniform(8193),
  'odd expanded (8193)': oddExpanded(8193),
  'odd uniform 0xFF (513)': oddUniform(513),
})) {
  let g; let s;
  assert.doesNotThrow(() => { g = discriminators.genesisLike(buf); }, `genesisLike must not throw on ${name}`);
  assert.doesNotThrow(() => { s = discriminators.smsGgLike(buf); }, `smsGgLike must not throw on ${name}`);
  // Odd-length >= 512B is not a valid Sega SRAM/FRAM layout: routed nowhere.
  assert.strictEqual(g, false, `${name}: odd buffer is not byte-expanded -> genesisLike false`);
  assert.strictEqual(s, false, `${name}: odd buffer is not a valid SMS/GG save -> smsGgLike false`);
}

// --- Integration: reconcile a tree containing an odd-length save. ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-odd-'));
const raSaves = path.join(tmp, 'retroarch', 'saves');
const msSaves = path.join(tmp, 'mister', 'saves');

for (const d of ['Genesis', 'MegaDrive', 'SMS', 'GameGear']) {
  fs.mkdirSync(path.join(msSaves, d), { recursive: true });
}
for (const d of ['Genesis Plus GX Wide', 'PicoDrive', 'SMS Plus GX', 'Gearsystem']) {
  fs.mkdirSync(path.join(raSaves, d), { recursive: true });
}

const GAME = "Devil Crash Alternate Style PCE (Dragon's Fury Hack) v1 Pyron";
const src = path.join(raSaves, 'Genesis Plus GX Wide', `${GAME}.srm`);
fs.writeFileSync(src, oddUniform(8193));

const mapping = loadMapping(null);
const engine = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: () => {}, error: (m) => { throw new Error(`reconcile logged an error: ${m}`); } },
});

// The whole point: this used to throw on every pass. It must not now, and the
// error-logging path (wired to throw above) must never fire.
assert.doesNotThrow(() => engine.reconcileAll(), 'reconcile must not throw on odd-length save');

// The anomalous save must be routed NOWHERE: no MiSTer target for any Sega
// system, and no RetroArch cross-core fan-out either.
for (const d of ['Genesis', 'MegaDrive', 'SMS', 'GameGear']) {
  const p = path.join(msSaves, d, `${GAME}.sav`);
  assert(!fs.existsSync(p), `MiSTer ${d}/ must not receive this odd-length save`);
}
for (const d of ['PicoDrive', 'SMS Plus GX', 'Gearsystem']) {
  for (const ext of ['srm', 'sav']) {
    const p = path.join(raSaves, d, `${GAME}.${ext}`);
    assert(!fs.existsSync(p), `RA ${d}/ must not receive this odd-length save (${ext})`);
  }
}

// Source is left untouched.
assert.strictEqual(fs.readFileSync(src).length, 8193, 'source must be preserved');
assert.strictEqual(engine.writeCount, 0, 'anomalous odd-length save must produce zero writes');

// Idempotence: a second pass writes nothing new and still never throws.
const before = engine.writeCount;
assert.doesNotThrow(() => engine.reconcileAll(), 'second reconcile must not throw');
assert.strictEqual(engine.writeCount, before, 'second reconcile should be a no-op');

console.log('ODD-LENGTH SAVE REGRESSION TEST PASSED');

// ---------------------------------------------------------------------------
// Companion case from the field: the *settled* form of the same save.
//
// The reported crash came from an odd-length transient of a romhack save
// (Dragon's Fury Hack adds SRAM to a game that originally couldn't save). Its
// settled form is a byte-expanded 64 KiB Genesis SRAM = 128 KiB even, here
// blank (every logical byte 0xFF -> "00 ff 00 ff ..."). That must route to
// Genesis (+MegaDrive) only, never to SMS/GameGear, and round-trip cleanly.
// ---------------------------------------------------------------------------
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-settled-'));
  const ra2 = path.join(tmp2, 'retroarch', 'saves');
  const ms2 = path.join(tmp2, 'mister', 'saves');
  for (const d of ['Genesis', 'MegaDrive', 'SMS', 'GameGear']) fs.mkdirSync(path.join(ms2, d), { recursive: true });
  fs.mkdirSync(path.join(ra2, 'Genesis Plus GX Wide'), { recursive: true });

  // blank 64 KiB SRAM, byte-expanded alternate-0x00 -> 128 KiB
  const expanded = Buffer.alloc(131072);
  for (let i = 0; i < expanded.length; i += 2) { expanded[i] = 0x00; expanded[i + 1] = 0xff; }

  assert.strictEqual(discriminators.genesisLike(expanded), true, 'byte-expanded save -> genesisLike true');
  assert.strictEqual(discriminators.smsGgLike(expanded), false, 'byte-expanded save -> smsGgLike false');

  const srcp = path.join(ra2, 'Genesis Plus GX Wide', `${GAME}.srm`);
  fs.writeFileSync(srcp, expanded);

  const engine2 = new SyncEngine({
    retroarchSaves: ra2,
    misterSaves: ms2,
    mapping,
    dirIndex: buildDirIndex(mapping),
    log: { info: () => {}, error: (m) => { throw new Error(`reconcile logged an error: ${m}`); } },
  });
  assert.doesNotThrow(() => engine2.reconcileAll(), 'settled save must reconcile without throwing');

  for (const d of ['Genesis', 'MegaDrive']) {
    const p = path.join(ms2, d, `${GAME}.sav`);
    assert(fs.existsSync(p), `settled save must reach MiSTer ${d}/`);
    assert.strictEqual(fs.statSync(p).size, 65536, `MiSTer ${d}/ save collapsed to 64 KiB`);
  }
  for (const d of ['SMS', 'GameGear']) {
    assert(!fs.existsSync(path.join(ms2, d, `${GAME}.sav`)), `settled Genesis save must NOT reach MiSTer ${d}/`);
  }

  const before2 = engine2.writeCount;
  engine2.reconcileAll();
  assert.strictEqual(engine2.writeCount, before2, 'settled save reconcile must be idempotent');

  console.log('SETTLED BYTE-EXPANDED SAVE ROUTING TEST PASSED');
}
