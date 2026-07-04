'use strict';

/*
 * Multi-system RA core routing test. Genesis Plus GX plays Genesis, SMS, and
 * Game Gear. A save in the Genesis Plus GX folder must be routed only to
 * the MiSTer folder(s) whose format matches the file's actual content:
 *   - byte-expanded save -> MiSTer/Genesis + MegaDrive, not SMS/GameGear
 *   - raw bytes save     -> MiSTer/SMS + GameGear,       not Genesis/MegaDrive
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-disc-'));
const raSaves = path.join(tmp, 'retroarch', 'saves');
const msSaves = path.join(tmp, 'mister', 'saves');

function put(dir, name, buf) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}
function patterned(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
function exists(p) { return fs.existsSync(p); }

// Pre-create every MiSTer target dir so mkdir isn't in the way.
for (const d of ['Genesis', 'MegaDrive', 'SMS', 'GameGear']) {
  fs.mkdirSync(path.join(msSaves, d), { recursive: true });
}
for (const d of ['Genesis Plus GX', 'PicoDrive', 'SMS Plus GX', 'Gearsystem']) {
  fs.mkdirSync(path.join(raSaves, d), { recursive: true });
}

// --- Case 1: A Genesis-formatted (byte-expanded) save in GPGX folder ---
// Emulator Genesis SRAM: 16 KB byte-expanded, every second byte 0x00.
const genesisBytes = Buffer.alloc(16384);
const collapsed = patterned(8192, 7);
for (let i = 0; i < collapsed.length; i += 1) {
  genesisBytes[i * 2] = 0x00;
  genesisBytes[i * 2 + 1] = collapsed[i];
}
put(path.join(raSaves, 'Genesis Plus GX'), 'GenGame.srm', genesisBytes);

// --- Case 2: A raw-bytes SMS save in GPGX folder ---
// Raw 8 KB SMS save data with no byte expansion.
const smsBytes = patterned(8192, 42);
put(path.join(raSaves, 'Genesis Plus GX'), 'SMSGame.srm', smsBytes);

// --- Case 3: Genesis save in PicoDrive folder (verify pico routed too) ---
put(path.join(raSaves, 'PicoDrive'), 'GenGame2.srm', genesisBytes);

const mapping = loadMapping(null);
const engine = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: () => {}, error: (m) => console.error(m) },
});

engine.reconcileAll();

// Genesis save: MUST land in Genesis + MegaDrive, MUST NOT land in SMS/GameGear
assert(exists(path.join(msSaves, 'Genesis', 'GenGame.sav')), 'Genesis save -> Genesis');
assert(exists(path.join(msSaves, 'MegaDrive', 'GenGame.sav')), 'Genesis save -> MegaDrive');
assert(!exists(path.join(msSaves, 'SMS', 'GenGame.sav')), 'Genesis save NOT -> SMS');
assert(!exists(path.join(msSaves, 'GameGear', 'GenGame.sav')), 'Genesis save NOT -> GameGear');

// SMS save: MUST land in SMS + GameGear, MUST NOT land in Genesis/MegaDrive
assert(exists(path.join(msSaves, 'SMS', 'SMSGame.sav')), 'SMS save -> SMS');
assert(exists(path.join(msSaves, 'GameGear', 'SMSGame.sav')), 'SMS save -> GameGear');
assert(!exists(path.join(msSaves, 'Genesis', 'SMSGame.sav')), 'SMS save NOT -> Genesis');
assert(!exists(path.join(msSaves, 'MegaDrive', 'SMSGame.sav')), 'SMS save NOT -> MegaDrive');

// PicoDrive → Genesis fan-out works too
assert(exists(path.join(msSaves, 'Genesis', 'GenGame2.sav')), 'PicoDrive Genesis save -> Genesis');
assert(!exists(path.join(msSaves, 'SMS', 'GenGame2.sav')), 'PicoDrive Genesis save NOT -> SMS');

// Cross-core fan-out on the RA side within the same detected system
assert(exists(path.join(raSaves, 'PicoDrive', 'GenGame.srm')), 'GPGX Genesis save -> PicoDrive');
assert(!exists(path.join(raSaves, 'SMS Plus GX', 'GenGame.srm')), 'GPGX Genesis save NOT -> SMS Plus GX');
assert(exists(path.join(raSaves, 'SMS Plus GX', 'SMSGame.srm')), 'GPGX SMS save -> SMS Plus GX');
assert(exists(path.join(raSaves, 'Gearsystem', 'SMSGame.srm')), 'GPGX SMS save -> Gearsystem');

// Idempotence
const before = engine.writeCount;
engine.reconcileAll();
assert.strictEqual(engine.writeCount, before, 'second reconcile should be a no-op');

console.log('DISCRIMINATOR TEST PASSED');
