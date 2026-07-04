'use strict';

/*
 * Regression tests for the three multi-part systems added in
 * saturn-segacd-cpk v1:
 *
 *   saturn — MiSTer <game>.sav (byte-expanded internal [+ cart]) <->
 *            Beetle Saturn <game>.bkr (32 KiB) / <game>.bcr (512 KiB)
 *   segacd — MiSTer <game>.sav (internal [+ cart]) <->
 *            Genesis Plus GX per-game <game>.brm (8 KiB). Cart section is
 *            preserved on write but never synced.
 *   n64    — MiSTer <game>_N.cpk Controller Paks <-> the mempak region of
 *            the libretro combined <game>.srm.
 *
 * All fixtures are synthesized through the vendored save-file-converter
 * classes so they are structurally valid on both sides. The behaviors under
 * test mirror what was verified against real field saves (Tempest 2000,
 * Sonic CD, Wave Race 64).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMapping, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');
const { segaDisc } = require('../src/converters');
const vendor = require('../dist/converter.cjs');

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const toBuf = (ab) => Buffer.from(ab);

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savesync-newsys-'));
  const ra = path.join(tmp, 'retroarch', 'saves');
  const ms = path.join(tmp, 'mister', 'saves');
  for (const d of ['Saturn', 'MegaCD', 'N64']) fs.mkdirSync(path.join(ms, d), { recursive: true });
  for (const d of ['Beetle Saturn', 'Mednafen Saturn', 'Genesis Plus GX', 'Genesis Plus GX Wide', 'Mupen64Plus-Next']) {
    fs.mkdirSync(path.join(ra, d), { recursive: true });
  }
  return { tmp, ra, ms };
}

function makeEngine(ra, ms) {
  const mapping = loadMapping(null);
  return new SyncEngine({
    retroarchSaves: ra,
    misterSaves: ms,
    mapping,
    dirIndex: buildDirIndex(mapping),
    log: { info: () => {}, error: (m) => { throw new Error(`sync logged an error: ${m}`); } },
  });
}

function futureTouch(p, secondsAhead = 5) {
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(p, t, t);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Saturn: formatted-empty internal / cart raws with a marker in the data area
const satInternal = toBuf(vendor.SegaSaturnSaveData.createEmptySave(vendor.SegaSaturnSaveData.INTERNAL_BLOCK_SIZE));
satInternal[0x100] = 0x11; // data-area marker; format signature is at the start
const satCartWithContent = toBuf(vendor.SegaSaturnSaveData.createEmptySave(vendor.SegaSaturnSaveData.CARTRIDGE_BLOCK_SIZE));
satCartWithContent[0x2000] = 0x77;

// Sega CD: formatted-empty internal with a marker
const scdInternal = toBuf(vendor.SegaCdUtil.makeEmptySave(vendor.SegaCdUtil.INTERNAL_SAVE_SIZE));
scdInternal[0x40] = 0x22;
const scdCart = toBuf(vendor.SegaCdUtil.makeEmptySave(vendor.MisterSegaCdSaveData.RAM_CART_SIZE));
scdCart[0x100] = 0x5a;

// N64: a structurally valid, empty Controller Pak
const blankPak = toBuf(vendor.N64MempackSaveData.createFromSaveFiles([]).getArrayBuffer());
assert.strictEqual(blankPak.length, 32768, 'synthesized pak must be 32 KiB');

// ===========================================================================
// 1. Saturn: MiSTer -> RA, internal only
// ===========================================================================
{
  const { ra, ms } = makeTree();
  const misterSmall = toBuf(vendor.MisterSegaSaturnSaveData.createFromRawData({
    rawInternalSaveArrayBuffer: toAB(satInternal),
  }).getMisterArrayBuffer());
  assert.strictEqual(misterSmall.length, 65536, 'small Saturn MiSTer file is 64 KiB');
  fs.writeFileSync(path.join(ms, 'Saturn', 'Game.sav'), misterSmall);

  const engine = makeEngine(ra, ms);
  engine.reconcileAll();

  for (const d of ['Beetle Saturn', 'Mednafen Saturn']) {
    const bkr = fs.readFileSync(path.join(ra, d, 'Game.bkr'));
    assert(bkr.equals(satInternal), `${d}/Game.bkr must equal the parsed internal`);
    assert(!fs.existsSync(path.join(ra, d, 'Game.bcr')), `${d}: no bcr for a cart-less save`);
  }
  const before = engine.writeCount;
  engine.reconcileAll();
  assert.strictEqual(engine.writeCount, before, 'saturn mister->ra idempotent');
  console.log('saturn mister->ra: OK');
}

// ===========================================================================
// 2. Saturn: RA -> MiSTer, bcr with content grows the file; empty bcr doesn't
// ===========================================================================
{
  const { ra, ms } = makeTree();
  fs.writeFileSync(path.join(ra, 'Beetle Saturn', 'Game.bkr'), satInternal);
  // an empty placeholder bcr must NOT create a large MiSTer file
  fs.writeFileSync(
    path.join(ra, 'Beetle Saturn', 'Game.bcr'),
    toBuf(vendor.SegaSaturnSaveData.createEmptySave(vendor.SegaSaturnSaveData.CARTRIDGE_BLOCK_SIZE)),
  );
  const engine = makeEngine(ra, ms);
  engine.reconcileAll();

  let sav = fs.readFileSync(path.join(ms, 'Saturn', 'Game.sav'));
  assert.strictEqual(sav.length, 65536, 'empty placeholder bcr must not grow the MiSTer file');
  assert(segaDisc.saturn.parseMister(sav).internal.equals(satInternal), 'internal must round-trip');

  // now give the cart real content — the MiSTer file must grow
  fs.writeFileSync(path.join(ra, 'Beetle Saturn', 'Game.bcr'), satCartWithContent);
  futureTouch(path.join(ra, 'Beetle Saturn', 'Game.bcr'));
  engine.reconcileAll();

  sav = fs.readFileSync(path.join(ms, 'Saturn', 'Game.sav'));
  assert.strictEqual(sav.length, 65536 + 1048576, 'cart with content must grow the MiSTer file');
  const parsed = segaDisc.saturn.parseMister(sav);
  assert.strictEqual(parsed.cart[0x2000], 0x77, 'cart content must survive the round trip');
  assert(parsed.internal.equals(satInternal), 'internal must be intact after growth');

  const before = engine.writeCount;
  engine.reconcileAll();
  assert.strictEqual(engine.writeCount, before, 'saturn ra->mister idempotent');
  console.log('saturn ra->mister (+cart growth): OK');
}

// ===========================================================================
// 3. Sega CD: MiSTer -> RA, and cart-section preservation on RA -> MiSTer
// ===========================================================================
{
  const { ra, ms } = makeTree();
  const large = toBuf(vendor.MisterSegaCdSaveData.createFromRawData({
    rawInternalSaveArrayBuffer: toAB(scdInternal),
    rawCartSaveArrayBuffer: toAB(scdCart),
  }).getMisterArrayBuffer());
  assert.strictEqual(large.length, 8192 + 524288, 'large Sega CD MiSTer file');
  fs.writeFileSync(path.join(ms, 'MegaCD', 'Game.sav'), large);

  const engine = makeEngine(ra, ms);
  engine.reconcileAll();

  for (const d of ['Genesis Plus GX', 'Genesis Plus GX Wide']) {
    assert(fs.readFileSync(path.join(ra, d, 'Game.brm')).equals(scdInternal), `${d}/Game.brm = internal`);
  }

  // RA-side internal changes; the cart section (never synced) must survive
  const newInternal = Buffer.from(scdInternal);
  newInternal[0x40] = 0xa5;
  fs.writeFileSync(path.join(ra, 'Genesis Plus GX', 'Game.brm'), newInternal);
  futureTouch(path.join(ra, 'Genesis Plus GX', 'Game.brm'));
  engine.reconcileAll();

  const sav = fs.readFileSync(path.join(ms, 'MegaCD', 'Game.sav'));
  assert.strictEqual(sav.length, large.length, 'MiSTer file must stay large');
  const parsed = segaDisc.segacd.parseMister(sav);
  assert.strictEqual(parsed.internal[0x40], 0xa5, 'internal updated from RA');
  assert.strictEqual(parsed.cart[0x100], 0x5a, 'cart section preserved');

  // shared GPGX files are ignored, never routed
  fs.writeFileSync(path.join(ra, 'Genesis Plus GX', 'cart.brm'), scdCart);
  fs.writeFileSync(path.join(ra, 'Genesis Plus GX', 'scd_U.brm'), scdInternal);
  engine.reconcileAll();
  assert(!fs.existsSync(path.join(ms, 'MegaCD', 'cart.sav')), 'cart.brm must be ignored');
  assert(!fs.existsSync(path.join(ms, 'MegaCD', 'scd_U.sav')), 'scd_U.brm must be ignored');

  const before = engine.writeCount;
  engine.reconcileAll();
  assert.strictEqual(engine.writeCount, before, 'segacd idempotent');
  console.log('segacd both directions (+cart preservation, ignores): OK');
}

// ===========================================================================
// 4. N64 Controller Paks: cpk -> srm merge and srm -> cpk extraction
// ===========================================================================
{
  const { ra, ms } = makeTree();
  // MiSTer side: pak 1 with a marker, pak 3 untouched-blank (not written)
  const pak1 = Buffer.from(blankPak);
  pak1[0x2000] = 0x99; // data-area marker
  fs.writeFileSync(path.join(ms, 'N64', 'Game_1.cpk'), pak1);
  fs.writeFileSync(path.join(ms, 'N64', 'Game_2.cpk'), blankPak);

  const engine = makeEngine(ra, ms);
  engine.reconcileAll();

  const srm = fs.readFileSync(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'));
  assert.strictEqual(srm.length, 0x48800, 'combined srm produced');
  assert(srm.subarray(0x800, 0x8800).equals(pak1), 'pak 1 embedded at slot 0');
  assert(srm.subarray(0x8800, 0x10800).equals(blankPak), 'pak 2 embedded at slot 1');

  // RA side: modify pak 2 inside the srm — only Game_2.cpk may change
  const srm2 = Buffer.from(srm);
  srm2[0x8800 + 0x3000] = 0x42;
  fs.writeFileSync(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'), srm2);
  futureTouch(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'));
  engine.reconcileAll();

  const outPak1 = fs.readFileSync(path.join(ms, 'N64', 'Game_1.cpk'));
  const outPak2 = fs.readFileSync(path.join(ms, 'N64', 'Game_2.cpk'));
  assert(outPak1.equals(pak1), 'pak 1 untouched');
  assert.strictEqual(outPak2[0x3000], 0x42, 'pak 2 updated from srm');

  // a cpk with a non-MiSTer name pattern is left alone
  fs.writeFileSync(path.join(ms, 'N64', 'Oddball.cpk'), blankPak);
  engine.reconcileAll();
  assert(!fs.existsSync(path.join(ra, 'Mupen64Plus-Next', 'Oddball.srm')), 'unsuffixed cpk not routed');

  const before = engine.writeCount;
  engine.reconcileAll();
  assert.strictEqual(engine.writeCount, before, 'n64 cpk idempotent');
  console.log('n64 cpk both directions: OK');
}

// ===========================================================================
// 5. N64 Controller Paks are RAW SRAM — no filesystem validation (field bug).
//    Unformatted paks (random garbage no game ever initialized) and homebrew
//    layouts that the strict mempack parser rejects must sync as-is. A
//    wrong-sized .cpk (transient mid-write) is skipped silently. Multiple
//    part files for one game produce exactly ONE write per .srm target.
// ===========================================================================
{
  const { ra, ms } = makeTree();

  // "Unformatted pak": pseudorandom bytes, exactly what a real never-
  // formatted Controller Pak dumps as. Fails ID-area checksums by design.
  const garbagePak = Buffer.alloc(32768);
  for (let i = 0; i < garbagePak.length; i += 1) garbagePak[i] = (i * 2654435761) & 0xff;
  const sra = Buffer.alloc(32768);
  for (let i = 0; i < sra.length; i += 1) sra[i] = (i * 40503) & 0xff;

  fs.writeFileSync(path.join(ms, 'N64', 'Game.sra'), sra);
  for (let n = 1; n <= 4; n += 1) fs.writeFileSync(path.join(ms, 'N64', `Game_${n}.cpk`), garbagePak);
  // wrong-sized pak: silently skipped, never merged, never an error
  fs.writeFileSync(path.join(ms, 'N64', 'Game2_1.cpk'), Buffer.alloc(1000, 0xab));

  const writes = [];
  const mapping = loadMapping(null);
  const engine = new SyncEngine({
    retroarchSaves: ra,
    misterSaves: ms,
    mapping,
    dirIndex: buildDirIndex(mapping),
    log: {
      info: (m) => { if (m.includes('wrote')) writes.push(m); },
      error: (m) => { throw new Error(`sync logged an error: ${m}`); }, // the field bug logged here
    },
  });
  engine.reconcileAll();

  const srm = fs.readFileSync(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'));
  for (let n = 1; n <= 4; n += 1) {
    assert(srm.subarray(0x800 + (n - 1) * 0x8000, 0x800 + n * 0x8000).equals(garbagePak),
      `unformatted pak ${n} must embed raw`);
  }
  assert(srm.subarray(0x20800, 0x28800).equals(sra), 'sra region embedded alongside paks');
  assert(!fs.existsSync(path.join(ra, 'Mupen64Plus-Next', 'Game2.srm')), 'wrong-sized cpk not routed');

  // gather-mode: 5 part files, but each srm target written exactly once
  const perTarget = {};
  for (const w of writes.filter((x) => x.includes('.srm'))) {
    const p = w.match(/wrote (.*) \(/)[1];
    perTarget[p] = (perTarget[p] || 0) + 1;
  }
  for (const [p, c] of Object.entries(perTarget)) {
    assert.strictEqual(c, 1, `${p} must be written exactly once, was ${c}`);
  }

  // Staleness guard: a NEWER srm must not be regressed by stale mister paks,
  // and the stale pak file gets corrected from the srm instead.
  const newer = Buffer.from(srm);
  newer[0x800 + 0x500] ^= 0xff;
  fs.writeFileSync(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'), newer);
  futureTouch(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'), 10);
  const past = new Date(Date.now() - 3600 * 1000);
  for (let n = 1; n <= 4; n += 1) fs.utimesSync(path.join(ms, 'N64', `Game_${n}.cpk`), past, past);
  fs.utimesSync(path.join(ms, 'N64', 'Game.sra'), past, past);

  const engine2 = new SyncEngine({
    retroarchSaves: ra,
    misterSaves: ms,
    mapping,
    dirIndex: buildDirIndex(mapping),
    log: { info: () => {}, error: (m) => { throw new Error(`sync logged an error: ${m}`); } },
  });
  engine2.reconcileAll();

  const finalSrm = fs.readFileSync(path.join(ra, 'Mupen64Plus-Next', 'Game.srm'));
  assert.strictEqual(finalSrm[0x800 + 0x500], newer[0x800 + 0x500], 'newer srm must not be regressed by stale paks');
  const finalCpk = fs.readFileSync(path.join(ms, 'N64', 'Game_1.cpk'));
  assert.strictEqual(finalCpk[0x500], newer[0x800 + 0x500], 'stale cpk corrected from newer srm');

  const before5 = engine2.writeCount;
  engine2.reconcileAll();
  assert.strictEqual(engine2.writeCount, before5, 'raw-pak path idempotent');
  console.log('n64 raw paks (unformatted/homebrew), size guard, staleness guard: OK');
}

console.log('SATURN / SEGACD / N64-CPK TESTS PASSED');
