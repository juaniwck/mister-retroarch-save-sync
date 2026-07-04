'use strict';

/* Reconcile-pass test with synthetic but format-correct saves. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine, md5 } = require('../src/sync');
const { writeManifest } = require('../src/manifest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-'));
const raRoot = path.join(tmp, 'retroarch');
const raSaves = path.join(raRoot, 'saves');
const msSaves = path.join(tmp, 'mister', 'saves');

function put(root, dir, name, buf) {
  const p = path.join(root, dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}
function read(root, dir, name) {
  return fs.readFileSync(path.join(root, dir, name));
}
function exists(root, dir, name) {
  return fs.existsSync(path.join(root, dir, name));
}

function patterned(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

// --- SNES: raw 8KB in bsnes-jg, expect copies in bsnes-hd beta + MiSTer SNES
const snes = patterned(8192, 1);
put(raSaves, 'bsnes-jg', 'Chrono.srm', snes);

// --- NES: raw 8KB, MiSTer copy must be padded to 32KB
const nes = patterned(8192, 2);
put(raSaves, 'FCEUmm', 'Zelda.srm', nes);

// --- GB: Gambatte save duplicated to mGBA + all MiSTer GB dirs
const gb = patterned(32768, 3);
put(raSaves, 'Gambatte', 'Crystal.srm', gb);

// --- GBA: MiSTer file with RTC appended (non-power-of-2) -> RA gets stripped
const gbaRaw = patterned(65536, 4);
const gbaWithRtc = Buffer.concat([gbaRaw, patterned(68, 9)]);
put(msSaves, 'GBA', 'Emerald.sav', gbaWithRtc);

// --- Genesis: byte-expanded emulator save -> MiSTer collapsed+padded to 64KB 0xFF
const genCollapsed = patterned(8192, 5);
const genExpanded = Buffer.alloc(16384);
for (let i = 0; i < genCollapsed.length; i += 1) {
  genExpanded[i * 2] = 0x00;
  genExpanded[i * 2 + 1] = genCollapsed[i];
}
put(raSaves, 'Genesis Plus GX', 'Sonic3.srm', genExpanded);

// --- PCE: valid BRAM (HUBM magic), 2KB, straight copy
const pce = Buffer.alloc(2048);
pce.write('HUBM', 0, 'ascii');
pce[16] = 0x42;
put(raSaves, 'Beetle PCE Fast', 'Rondo.sav', pce);

// --- PSX: unformatted-looking 128KB card (parse fails -> raw copy fallback)
//     and a formatted card ('MC' magic) as second game
const psxBlank = Buffer.alloc(131072, 0x00);
psxBlank[5000] = 0x77;
put(msSaves, 'PSX', 'AceCombat.sav', psxBlank);

const psxCard = Buffer.alloc(131072, 0x00);
psxCard.write('MC', 0, 'ascii');
psxCard[127] = 0x0e; // header frame checksum-ish; parser mostly checks magic + structure
for (let i = 1; i <= 15; i += 1) {
  const off = i * 128;
  psxCard.writeUInt32LE(0xa0, off); // block state: available
  psxCard.writeUInt32LE(0xffffffff, off + 8);
  let xor = 0;
  for (let j = 0; j < 127; j += 1) xor ^= psxCard[off + j];
  psxCard[off + 127] = xor;
}
put(raSaves, 'PCSX-ReARMed', 'SOTN.srm', psxCard);

// --- N64: mister .eep should land in combined .srm for both RA cores;
//     RA combined .srm with SRAM data should produce mister .sra
const eep = patterned(512, 6);
put(msSaves, 'N64', 'Mario64.eep', eep);

const SRM_TOTAL = 296960;
const combined = Buffer.alloc(SRM_TOTAL, 0xff);
combined.fill(0x00, 0x800, 0x800 + 0x20000); // blank mempaks
patterned(32768, 7).copy(combined, 0x20800); // SRAM region active
put(raSaves, 'Mupen64Plus-Next', 'OoT.srm', combined);

// --- ignored files must not propagate
put(raSaves, 'Gambatte', 'retroarch.cfg', Buffer.from('cfg'));
put(raSaves, 'Gambatte', 'Crystal.rtc', patterned(48, 8));
put(raSaves, 'Gambatte', 'Crystal_bak.srm', patterned(32768, 9));

// ---------------------------------------------------------------------------
const mapping = loadMapping(null);
const engine = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: () => {}, error: (...a) => console.error(...a) },
});

engine.reconcileAll();

// SNES
assert(read(raSaves, 'bsnes-hd beta', 'Chrono.srm').equals(snes), 'snes RA dup');
assert(read(msSaves, 'SNES', 'Chrono.sav').equals(snes), 'snes mister');

// NES
const nesMister = read(msSaves, 'NES', 'Zelda.sav');
assert.strictEqual(nesMister.length, 32768, 'nes mister padded');
assert(nesMister.subarray(0, 8192).equals(nes), 'nes mister data');
assert(read(raSaves, 'Nestopia', 'Zelda.srm').length >= 8192, 'nes RA dup');
assert(read(raSaves, 'QuickNES', 'Zelda.srm').subarray(0, 8192).equals(nes), 'nes quicknes');

// GB fan-out
for (const d of ['GAMEBOY', 'GBC', 'SGB']) {
  assert(read(msSaves, d, 'Crystal.sav').equals(gb), `gb mister ${d}`);
}
assert(read(raSaves, 'mGBA', 'Crystal.srm').equals(gb), 'gb -> mGBA');

// GBA save duplicated per request into the GB family as well
assert(exists(msSaves, "GAMEBOY", "Emerald.sav"), "gba dup into GB family");
assert(exists(raSaves, "Gambatte", "Emerald.srm"), "gba dup into Gambatte");
// GBA RTC stripped for RA
assert(read(raSaves, 'mGBA', 'Emerald.srm').equals(gbaRaw), 'gba rtc stripped');
// and MiSTer file must NOT have been clobbered (round-trip equality)
assert(read(msSaves, 'GBA', 'Emerald.sav').equals(gbaWithRtc), 'gba mister untouched');

// Genesis
const genMister = read(msSaves, 'Genesis', 'Sonic3.sav');
assert.strictEqual(genMister.length, 65536, 'genesis mister 64KB');
assert(genMister.subarray(0, 8192).equals(genCollapsed), 'genesis collapsed');
assert.strictEqual(genMister[65535], 0xff, 'genesis 0xFF padding');
assert(read(msSaves, 'MegaDrive', 'Sonic3.sav').equals(genMister), 'megadrive dup');
assert(read(raSaves, 'PicoDrive', 'Sonic3.srm').equals(genExpanded), 'picodrive dup');

// PCE
assert(read(msSaves, 'TGFX16', 'Rondo.sav').equals(pce), 'pce mister');
assert(read(raSaves, 'Beetle PCE', 'Rondo.sav').equals(pce), 'pce RA dup');

// PSX fallback copy + dual extensions
assert(read(raSaves, 'Beetle PSX', 'AceCombat.srm').equals(psxBlank), 'psx blank srm');
assert(read(raSaves, 'Beetle PSX', 'AceCombat.mcr').equals(psxBlank), 'psx blank mcr');
assert(read(raSaves, 'PCSX-ReARMed', 'AceCombat.srm').equals(psxBlank), 'psx blank rearmed');
assert(read(msSaves, 'PSX', 'SOTN.sav').equals(psxCard), 'psx card to mister');
assert(read(raSaves, 'Beetle PSX HW', 'SOTN.mcr').equals(psxCard), 'psx card dup');

// N64: eep -> combined srm in both RA cores
const m64srm = read(raSaves, 'Mupen64Plus-Next', 'Mario64.srm');
assert.strictEqual(m64srm.length, SRM_TOTAL, 'n64 srm size');
assert(m64srm.subarray(0, 512).equals(eep), 'n64 eep in srm');
assert(read(raSaves, 'ParaLLEl N64', 'Mario64.srm').equals(m64srm), 'n64 srm dup');
assert(read(raSaves, 'Mupen64Plus-Next', 'Mario64.eep').equals(eep), 'n64 eep in RA');

// N64: combined srm -> mister sra
assert(read(msSaves, 'N64', 'OoT.sra').equals(combined.subarray(0x20800, 0x20800 + 0x8000)), 'n64 sra to mister');
assert(read(raSaves, 'ParaLLEl N64', 'OoT.srm').equals(combined), 'n64 oot dup');
assert(!exists(msSaves, 'N64', 'OoT.eep'), 'n64 no spurious eep');

// ignored files not propagated
assert(!exists(raSaves, 'mGBA', 'retroarch.cfg'), 'cfg not synced');
assert(!exists(raSaves, 'mGBA', 'Crystal.rtc'), 'rtc not synced');
assert(!exists(raSaves, 'mGBA', 'Crystal_bak.srm'), 'bak not synced');

// Idempotence: second reconcile writes nothing
let writes = 0;
const engine2 = new SyncEngine({
  retroarchSaves: raSaves,
  misterSaves: msSaves,
  mapping,
  dirIndex: buildDirIndex(mapping),
  log: { info: (m) => { if (String(m).includes('wrote')) writes += 1; }, error: (...a) => console.error(...a) },
});
engine2.reconcileAll();
assert.strictEqual(writes, 0, `second reconcile should be a no-op, got ${writes} writes`);

// Manifest
const n = writeManifest(raRoot);
const manifest = JSON.parse(fs.readFileSync(path.join(raRoot, 'manifest.server'), 'utf8'));
assert(n > 0 && manifest.length === n, 'manifest entries');
const chrono = manifest.find((e) => e.path === 'saves/bsnes-jg/Chrono.srm');
assert(chrono && chrono.hash === md5(snes), 'manifest md5');

console.log(`ALL TESTS PASSED (${manifest.length} manifest entries) — tree at ${tmp}`);
