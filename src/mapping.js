/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 * Default mapping between RetroArch core save directories and MiSTer save
 * directories. Every location within a system group is kept in sync: a save
 * that changes anywhere is converted and duplicated to every other location
 * in the group ("unified" saves, per-core differences ignored where the
 * underlying format is identical).
 *
 * Override by mounting a JSON file at /config/mapping.json with the same shape.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// system:        internal id, also used as the converter id in converters.js
// retroarch:     core directory names under <RETROARCH_ROOT>/saves/
// retroarchExts: file extensions synced on the RetroArch side (first one is
//                the primary; all of them are written so setups that expect
//                either extension keep working, mirroring the user's existing
//                layout where e.g. PSX saves exist as both .srm and .mcr)
// mister:        save directory names under <MISTER_SAVES>/
// misterExts:    extensions on the MiSTer side ('*' = derived from content,
//                used by N64 where the extension depends on save chip type)
const DEFAULT_MAPPING = {
  systems: {
    nes: {
      retroarch: [
        // FCEUmm's folder has been 'FCEUmm' for years — no renames.
        'FCEUmm',
        // Nestopia's info file renamed 'Nestopia UE' → 'Nestopia' in libretro-super,
        // but many retroarch installs still write to 'Nestopia UE'.
        'Nestopia UE', 'Nestopia',
        'QuickNES', 'Mesen',
        'bnes/higan', 'Emux NES', 'fixNES', 'nes', 'RustyNES',
      ],
      retroarchExts: ['srm'],
      mister: ['NES'],
      misterExts: ['sav'],
    },
    snes: {
      retroarch: [
        'bsnes-jg', 'bsnes-hd beta', 'bsnes',
        'bsnes-mercury Accuracy', 'bsnes-mercury Balanced', 'bsnes-mercury Performance',
        'bsnes 2014 Accuracy', 'bsnes 2014 Balanced', 'bsnes 2014 Performance',
        'bsnes C++98 (v085)',
        'Snes9x', 'Snes9x 2002', 'Snes9x 2005', 'Snes9x 2005 Plus', 'Snes9x 2010',
        'Mesen-S',
        'Beetle bsnes', 'Beetle Supafaust', 'ChimeraSNES',
        'nSide (Super Famicom Balanced)', 'nSide (Super Famicom Accuracy)',
      ],
      retroarchExts: ['srm'],
      mister: ['SNES'],
      misterExts: ['sav'],
    },
    gb: {
      retroarch: [
        'Gambatte', 'mGBA', 'SameBoy', 'Gearboy', 'TGB Dual', 'VBA-M',
        'DoubleCherryGB', 'Boytacean', 'Emux GB', 'fixGB', 'IroGB',
        'Mesen-S',
      ],
      retroarchExts: ['srm'],
      mister: ['GAMEBOY', 'GBC', 'SGB'],
      misterExts: ['sav'],
    },
    gba: {
      retroarch: [
        'mGBA', 'VBA-M', 'VBA Next',
        'gpSP', 'Beetle GBA', 'Meteor', 'TempGBA', 'SkyEmu',
      ],
      retroarchExts: ['srm'],
      mister: ['GBA'],
      misterExts: ['sav'],
    },
    // Sega multi-system cores (Genesis Plus GX, its wide variant, PicoDrive)
    // play Genesis + SMS + Game Gear. The three systems are also listed here
    // under their own groups. Discrimination is content-based: emulator
    // Genesis SRAM saves are byte-expanded (every other byte is 0x00 or 0xFF)
    // while SMS/GG saves are raw. discriminators.genesisLike / smsGgLike do
    // the check — an SMS save via GPGX only routes to the sms/gg groups, not
    // to genesis, and vice versa. No wrong-format save ever lands in the
    // wrong MiSTer folder.
    genesis: {
      retroarch: [
        'Genesis Plus GX', 'Genesis Plus GX Wide', 'PicoDrive',
        'BlastEm', 'ClownMDEmu',
      ],
      retroarchExts: ['srm'],
      mister: ['Genesis', 'MegaDrive'],
      misterExts: ['sav'],
      discriminate: 'genesisLike',
    },
    sms: {
      retroarch: [
        'SMS Plus GX', 'Gearsystem', 'Emux SMS',
        'Genesis Plus GX', 'Genesis Plus GX Wide', 'PicoDrive',
      ],
      retroarchExts: ['srm', 'sav'],
      mister: ['SMS'],
      misterExts: ['sav'],
      discriminate: 'smsGgLike',
    },
    gg: {
      retroarch: [
        'SMS Plus GX', 'Gearsystem',
        'Genesis Plus GX', 'Genesis Plus GX Wide', 'PicoDrive',
      ],
      retroarchExts: ['srm', 'sav'],
      mister: ['GameGear'],
      misterExts: ['sav'],
      discriminate: 'smsGgLike',
    },
    pce: {
      retroarch: [
        // Mednafen* are the legacy folder names, Beetle* the modern ones.
        'Mednafen PCE', 'Mednafen PCE Fast',
        'Beetle PCE', 'Beetle PCE Fast',
        'Beetle SuperGrafx', 'Geargrafx',
      ],
      // Retroarch PCE cores use .srm for saves (matching every other libretro
      // core), so that's what we need to read on the RA side and what we
      // need to produce so retroarch will find the save on load. .sav is
      // included as well: save-file-converter's PCE module (and some older
      // configurations) use .sav, and writing both extensions keeps every
      // core happy regardless of its configured backup file extension.
      retroarchExts: ['srm', 'sav'],
      mister: ['TGFX16'],
      misterExts: ['sav'],
    },
    psx: {
      retroarch: [
        'Beetle PSX', 'Beetle PSX HW',
        // 'PCSX ReARMed' (space) is the legacy folder; 'PCSX-ReARMed' (dash)
        // is the modern one. Include both.
        'PCSX ReARMed', 'PCSX-ReARMed',
        'PCSX ReARMed [NEON]', 'PCSX ReARMed [Interpreter]',
        'PCSX1',
        'DuckStation', 'SwanStation', 'Rustation',
      ],
      retroarchExts: ['srm', 'mcr'],
      mister: ['PSX'],
      misterExts: ['sav'],
    },
    // Saturn: two logical parts per game. RetroArch (Beetle Saturn) keeps
    // them as separate files — <game>.bkr (internal backup RAM, 32 KiB) and
    // <game>.bcr (backup cart, 512 KiB) — while the MiSTer file is both
    // parts byte-expanded and concatenated (64 KiB, or 64 KiB + 1 MiB when a
    // cart is present). Handled by the segaDisc sync path, not the generic
    // one. The .smpc clock file Beetle writes alongside is ignored.
    // Kronos is NOT supported: it writes its own .ram format into a
    // kronos/saturn subfolder.
    saturn: {
      retroarch: ['Beetle Saturn', 'Mednafen Saturn'],
      retroarchExts: ['bkr', 'bcr'],
      mister: ['Saturn'],
      misterExts: ['sav'],
    },
    // Sega CD: RetroArch (Genesis Plus GX) must be set to per-game BRAM
    // (core option "CD System BRAM" = per game) so saves are named
    // <game>.brm and can be matched across sides. The MiSTer file is the
    // 8 KiB internal BRAM, optionally with the 512 KiB RAM cart concatenated;
    // a cart section is PRESERVED on writes but not synced (GPGX's cart file
    // is shared/unmappable — see ignore list). PicoDrive is not supported:
    // it uses its own combined .csm format.
    segacd: {
      retroarch: ['Genesis Plus GX', 'Genesis Plus GX Wide'],
      retroarchExts: ['brm'],
      mister: ['MegaCD'],
      misterExts: ['sav'],
    },
    n64: {
      retroarch: [
        'Mupen64Plus-Next',
        'mupen64plus_next_gles2', 'mupen64plus_next_gles3',
        'ParaLLEl N64', 'ParaLLEl (Debug)',
      ],
      retroarchExts: ['srm', 'eep', 'sra', 'fla'],
      mister: ['N64'],
      misterExts: ['*'], // eep / sra / fla decided by save chip type
    },
  },
  // Files never synced and never treated as save data
  ignore: [
    'retroarch.cfg',
    'manifest.server',
    // GPGX Sega CD shared save files: per-BIOS internal BRAM and the shared
    // RAM cart. These aren't named after a game so they can't be mapped to a
    // MiSTer save. Only per-game <game>.brm files are synced.
    'scd_U.brm', 'scd_E.brm', 'scd_J.brm', 'cart.brm',
  ],
  ignoreExtensions: ['rtc', 'rtch', 'srms', 'ldci', 'state', 'tmp', 'smpc'],
  ignoreSubstrings: ['_bak'],
};

function loadMapping(configPath) {
  if (configPath && fs.existsSync(configPath)) {
    try {
      const user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...DEFAULT_MAPPING, ...user, systems: { ...(user.systems || DEFAULT_MAPPING.systems) } };
    } catch (e) {
      console.error(`[mapping] Failed to parse ${configPath}: ${e.message}. Using defaults.`);
    }
  }
  return DEFAULT_MAPPING;
}

// ---------------------------------------------------------------------------
// Environment-variable filtering — the human-friendly alternative to writing
// a full mapping.json. The built-in mapping already knows every core's
// system, extensions, MiSTer folders, and content discriminators, so all a
// person needs to say is which cores (and optionally which systems) they
// actually use:
//
//   RETROARCH_CORES="FCEUmm, Snes9x, Gambatte, mGBA, Genesis Plus GX"
//   SYSTEMS="nes, snes, gb, gba, genesis"
//
// Both are comma-separated, case-insensitive, whitespace-tolerant, and
// optional. They filter whatever mapping was loaded (built-in default or a
// mounted mapping.json). A system whose RetroArch core list ends up empty is
// dropped entirely. Unknown names are reported so typos don't fail silently.
// ---------------------------------------------------------------------------
function parseListEnv(value) {
  if (!value || !value.trim()) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function applyEnvFilters(mapping, env, log = console) {
  const systemsWanted = parseListEnv(env.SYSTEMS);
  const coresWanted = parseListEnv(env.RETROARCH_CORES);
  if (!systemsWanted && !coresWanted) return mapping;

  const out = JSON.parse(JSON.stringify(mapping));

  if (systemsWanted) {
    const known = new Set(Object.keys(out.systems).map((s) => s.toLowerCase()));
    const wanted = new Set(systemsWanted.map((s) => s.toLowerCase()));
    for (const name of wanted) {
      if (!known.has(name)) {
        log.error(`[mapping] SYSTEMS names unknown system '${name}'. Known: ${[...known].join(', ')}`);
      }
    }
    for (const sys of Object.keys(out.systems)) {
      if (!wanted.has(sys.toLowerCase())) delete out.systems[sys];
    }
  }

  if (coresWanted) {
    const wanted = new Set(coresWanted.map((c) => c.toLowerCase()));
    const knownCores = new Set();
    for (const def of Object.values(out.systems)) {
      for (const d of def.retroarch) knownCores.add(d.toLowerCase());
    }
    for (const name of wanted) {
      if (!knownCores.has(name)) {
        log.error(
          `[mapping] RETROARCH_CORES names unknown core folder '${name}' — check the exact `
          + 'folder name under saves/ (see the supported-cores table in the README).',
        );
      }
    }
    for (const [sys, def] of Object.entries(out.systems)) {
      def.retroarch = def.retroarch.filter((d) => wanted.has(d.toLowerCase()));
      if (def.retroarch.length === 0) {
        log.info(`[mapping] system '${sys}' has no remaining RetroArch cores; dropped`);
        delete out.systems[sys];
      }
    }
  }

  return out;
}

// Build fast lookup: directory name (lowercased) -> [{system, side}]
// A directory can belong to more than one group (mGBA belongs to gb and gba).
function buildDirIndex(mapping) {
  const index = new Map();
  const add = (dir, system, side) => {
    const key = dir.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ system, side });
  };
  for (const [system, def] of Object.entries(mapping.systems)) {
    for (const d of def.retroarch) add(d, system, 'retroarch');
    for (const d of def.mister) add(d, system, 'mister');
  }
  return index;
}

module.exports = { DEFAULT_MAPPING, loadMapping, applyEnvFilters, buildDirIndex, defaultPath: path.join('/config', 'mapping.json') };
