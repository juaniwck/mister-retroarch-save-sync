'use strict';

/*
 * For every core that appears in more than one system group, verify that
 * feeding a wrong-family save through the adapter produces output which
 * either:
 *   (a) round-trips to the same bytes (safe — the extra copy is inert), or
 *   (b) is padded-equivalent (safe — sync detects and skips rewrite), or
 *   (c) throws (safe — syncGame's error handler catches and moves on).
 *
 * Anything else = potential corruption via reconcile round-trip.
 */

const assert = require('assert');
const { adapters, discriminators } = require('../src/converters');
const { DEFAULT_MAPPING } = require('../src/mapping');

// A wrong-family save is kept away from an adapter in production by two
// independent layers: the content discriminator (a group with a
// `discriminate` ref rejects saves that don't match its family) and the
// sync engine's round-trip guard (skips a write whose conversion isn't
// reversible). This test verifies BOTH layers together: a (group, sample)
// combination is safe when the group's discriminator rejects the sample OR
// the adapter round-trips it safely. A sample the discriminator ACCEPTS must
// still round-trip safely — that's where this test keeps its teeth.
function discriminatorRejects(group, buf) {
  const def = DEFAULT_MAPPING.systems[group];
  const name = def && def.discriminate;
  if (!name || typeof discriminators[name] !== 'function') return false;
  return !discriminators[name](buf);
}

function patterned(size, seed) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

function isUniform(buf) {
  if (buf.length === 0) return true;
  const first = buf[0];
  if (first !== 0x00 && first !== 0xff) return false;
  for (let i = 1; i < buf.length; i += 1) if (buf[i] !== first) return false;
  return true;
}
function paddedEquivalent(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.subarray(0, short.length).equals(short)) return false;
  return isUniform(long.subarray(short.length));
}

// A save file "safely round-trips" through `system`'s adapter if writing it as
// MiSTer, reading it back, and writing again produces something equivalent to
// the source. That's the invariant we need for the sync engine to never
// overwrite the source with garbage.
function classifyRoundTrip(system, source) {
  try {
    const misterBuf = adapters[system].fromRaw('mister', source);
    const roundTripped = adapters[system].toRaw('mister', misterBuf);
    if (roundTripped.equals(source)) return { ok: true, why: 'identity' };
    if (paddedEquivalent(roundTripped, source)) return { ok: true, why: 'padded-equivalent' };
    return { ok: false, why: `corrupted: source=${source.length}B roundtripped=${roundTripped.length}B` };
  } catch (e) {
    return { ok: true, why: `throws (${e.message.slice(0, 60)})` };
  }
}

// Representative wrong-family payloads
const samples = {
  'GB (32 KiB SRAM)': patterned(32 * 1024, 1),
  'GB (128 KiB SRAM)': patterned(128 * 1024, 2),
  'GB (512 B EEPROM)': patterned(512, 3),
  'SNES (2 KiB SRAM)': patterned(2 * 1024, 4),
  'SNES (8 KiB SRAM)': patterned(8 * 1024, 5),
  'SNES (32 KiB SRAM)': patterned(32 * 1024, 6),
  'SNES (128 KiB SRAM)': patterned(128 * 1024, 7),
  'GBA (8 KiB EEPROM)': patterned(8 * 1024, 8),
  'GBA (64 KiB SRAM)': patterned(64 * 1024, 9),
  'GBA (128 KiB Flash + RTC)': Buffer.concat([patterned(128 * 1024, 10), patterned(68, 11)]),
  'Genesis (8 KiB emulator, byte-expanded)': (() => {
    const inner = patterned(4 * 1024, 12);
    const b = Buffer.alloc(8 * 1024);
    for (let i = 0; i < inner.length; i += 1) { b[i * 2 + 1] = inner[i]; }
    return b;
  })(),
  'SMS (8 KiB SRAM)': patterned(8 * 1024, 14),
};

// For each MULTI-SYSTEM core in the default mapping, list the groups it
// belongs to and check each sample against each group's adapter.
const multiSystem = {
  'mGBA':                    ['gb', 'gba'],
  'Mesen-S':                 ['snes', 'gb'],
  'Genesis Plus GX':         ['genesis'],  // baseline: genesis-only for now
  'Genesis Plus GX Wide':    ['genesis'],
  'PicoDrive':               ['genesis'],
};

const failures = [];
console.log('CROSS-FAMILY ROUND-TRIP SAFETY MATRIX\n');
for (const [core, groups] of Object.entries(multiSystem)) {
  console.log(`--- ${core}  →  ${groups.join(' + ')}`);
  for (const [name, buf] of Object.entries(samples)) {
    for (const grp of groups) {
      if (discriminatorRejects(grp, buf)) {
        console.log(`    [ok ] ${name.padEnd(38)} via ${grp.padEnd(8)} — rejected by discriminator (never reaches adapter)`);
        continue;
      }
      const r = classifyRoundTrip(grp, buf);
      const flag = r.ok ? 'ok ' : 'BAD';
      console.log(`    [${flag}] ${name.padEnd(38)} via ${grp.padEnd(8)} — ${r.why}`);
      if (!r.ok) failures.push({ core, group: grp, sample: name, why: r.why });
    }
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} unsafe combinations:`);
  for (const f of failures) console.log(`  ${f.core} + ${f.group}: ${f.sample} — ${f.why}`);
  process.exit(1);
}
console.log('\nALL COMBINATIONS SAFE');
