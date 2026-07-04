'use strict';

/*
 * SYSTEMS / RETROARCH_CORES environment filtering: the human-friendly
 * alternative to writing a full mapping.json. Both filter the loaded mapping
 * (default or custom); unknown names are reported; systems left with no
 * RetroArch cores are dropped.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMapping, applyEnvFilters, buildDirIndex } = require('../src/mapping');
const { SyncEngine } = require('../src/sync');

function capturingLog() {
  const errors = [];
  const infos = [];
  return { error: (m) => errors.push(m), info: (m) => infos.push(m), errors, infos };
}

// 1. No filter env vars -> mapping passes through untouched.
{
  const m = loadMapping(null);
  assert.strictEqual(applyEnvFilters(m, {}), m, 'no env vars: same object back');
  assert.strictEqual(applyEnvFilters(m, { SYSTEMS: '  ', RETROARCH_CORES: '' }), m, 'blank env vars: unchanged');
}

// 2. RETROARCH_CORES keeps only listed cores, preserving everything else.
{
  const log = capturingLog();
  const m = applyEnvFilters(loadMapping(null), {
    RETROARCH_CORES: 'FCEUmm, Snes9x, Gambatte, mGBA, Genesis Plus GX, Beetle PCE, Beetle PSX HW, Beetle Saturn, Mupen64Plus-Next',
  }, log);
  assert.deepStrictEqual(m.systems.nes.retroarch, ['FCEUmm']);
  assert.deepStrictEqual(m.systems.snes.retroarch, ['Snes9x']);
  assert.deepStrictEqual(m.systems.gb.retroarch, ['Gambatte', 'mGBA']);
  assert.deepStrictEqual(m.systems.gba.retroarch, ['mGBA']);
  // multi-system core survives in every group it belongs to
  for (const sys of ['genesis', 'sms', 'gg', 'segacd']) {
    assert.deepStrictEqual(m.systems[sys].retroarch, ['Genesis Plus GX'], `${sys} keeps GPGX`);
  }
  // non-core fields untouched
  assert.strictEqual(m.systems.genesis.discriminate, 'genesisLike', 'discriminate preserved');
  assert.deepStrictEqual(m.systems.genesis.mister, ['Genesis', 'MegaDrive'], 'mister dirs preserved');
  assert.deepStrictEqual(m.systems.n64.misterExts, ['*'], 'n64 wildcard preserved');
  assert.strictEqual(log.errors.length, 0, 'no unknown-name errors for valid list');
  // all 12 systems still present (every one kept at least one core)
  assert.strictEqual(Object.keys(m.systems).length, 12);
}

// 3. Systems that lose every core are dropped, with a log line.
{
  const log = capturingLog();
  const m = applyEnvFilters(loadMapping(null), { RETROARCH_CORES: 'FCEUmm' }, log);
  assert.deepStrictEqual(Object.keys(m.systems), ['nes'], 'only nes survives an FCEUmm-only list');
  assert(log.infos.some((x) => x.includes("dropped")), 'dropped systems are logged');
}

// 4. SYSTEMS filter, alone and combined with cores; case/whitespace tolerant.
{
  const m1 = applyEnvFilters(loadMapping(null), { SYSTEMS: ' NES , snes ' }, capturingLog());
  assert.deepStrictEqual(Object.keys(m1.systems).sort(), ['nes', 'snes']);

  const m2 = applyEnvFilters(loadMapping(null), {
    SYSTEMS: 'gb, gba',
    RETROARCH_CORES: 'gambatte, MGBA',
  }, capturingLog());
  assert.deepStrictEqual(Object.keys(m2.systems).sort(), ['gb', 'gba']);
  assert.deepStrictEqual(m2.systems.gb.retroarch, ['Gambatte', 'mGBA'], 'case-insensitive core match');
}

// 5. Unknown names are reported, not silently ignored.
{
  const log = capturingLog();
  applyEnvFilters(loadMapping(null), { SYSTEMS: 'nes, dreamcast', RETROARCH_CORES: 'FCEUmm, Snes9X 2010' }, log);
  assert(log.errors.some((x) => x.includes("'dreamcast'")), 'unknown system reported');
  assert(log.errors.some((x) => x.toLowerCase().includes('snes9x 2010')), 'unknown core reported');
}

// 6. Live smoke: engine on an env-filtered mapping routes correctly and
//    ignores cores that were filtered out.
{
  const mapping = applyEnvFilters(loadMapping(null), {
    RETROARCH_CORES: 'Gambatte, Genesis Plus GX',
  }, capturingLog());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-env-'));
  const ra = path.join(tmp, 'ra', 'saves');
  const ms = path.join(tmp, 'ms', 'saves');
  for (const d of ['Gambatte', 'Genesis Plus GX', 'Snes9x']) fs.mkdirSync(path.join(ra, d), { recursive: true });
  for (const d of ['GAMEBOY', 'GBC', 'SGB', 'Genesis', 'MegaDrive', 'SMS', 'GameGear', 'SNES']) {
    fs.mkdirSync(path.join(ms, d), { recursive: true });
  }
  const gen = Buffer.alloc(8192);
  for (let i = 1; i < 8192; i += 2) gen[i] = (i * 7) & 0xff; // byte-expanded -> genesis
  fs.writeFileSync(path.join(ra, 'Genesis Plus GX', 'Sonic.srm'), gen);
  fs.writeFileSync(path.join(ra, 'Gambatte', 'Link.srm'), Buffer.alloc(8192, 3));
  fs.writeFileSync(path.join(ra, 'Snes9x', 'Mario.srm'), Buffer.alloc(32768, 4)); // filtered out

  const engine = new SyncEngine({
    retroarchSaves: ra,
    misterSaves: ms,
    mapping,
    dirIndex: buildDirIndex(mapping),
    log: { info: () => {}, error: (m) => { throw new Error(`sync logged an error: ${m}`); } },
  });
  engine.reconcileAll();

  assert(fs.existsSync(path.join(ms, 'Genesis', 'Sonic.sav')), 'genesis routed');
  assert(!fs.existsSync(path.join(ms, 'SMS', 'Sonic.sav')), 'discrimination still active');
  for (const d of ['GAMEBOY', 'GBC', 'SGB']) assert(fs.existsSync(path.join(ms, d, 'Link.sav')), `gb -> ${d}`);
  assert(!fs.existsSync(path.join(ms, 'SNES', 'Mario.sav')), 'filtered-out core ignored');
  const before = engine.writeCount;
  engine.reconcileAll();
  assert.strictEqual(engine.writeCount, before, 'idempotent');
}

console.log('ENV FILTER TEST PASSED');
