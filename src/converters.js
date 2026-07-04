/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 *
 * Conversion adapters. All heavy lifting is done by the vendored
 * save-file-converter modules (GPL-3.0,
 * https://github.com/euan-forrester/save-file-converter), bundled into
 * dist/converter.cjs. This file adapts those ArrayBuffer-based classes to
 * Node Buffers and adds the one format that project does not model:
 * the libretro mupen64plus combined ".srm" (EEPROM + mempaks + SRAM +
 * FlashRAM concatenated).
 *
 * The canonical ("raw") representation for each system is the plain emulator
 * format, which is what save-file-converter calls "raw". Every adapter
 * implements:
 *   toRaw(kind, buf)      -> Buffer          (kind: 'retroarch' | 'mister')
 *   fromRaw(kind, raw)    -> Buffer or {extension: Buffer, ...} for N64
 */

'use strict';

const vendor = require('../dist/converter.cjs');

function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function toBuf(ab) {
  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// Generic adapter around the MisterXxxSaveData classes.
// createFromMisterData(ab).getRawArrayBuffer()  : MiSTer file -> raw
// createFromRawData(ab).getMisterArrayBuffer()  : raw -> MiSTer file
// RetroArch files for these systems ARE the raw format.
// ---------------------------------------------------------------------------
function classAdapter(Cls) {
  return {
    toRaw(kind, buf) {
      if (kind === 'mister') return toBuf(Cls.createFromMisterData(toAB(buf)).getRawArrayBuffer());
      return buf; // retroarch == raw
    },
    fromRaw(kind, raw) {
      if (kind === 'mister') return toBuf(Cls.createFromRawData(toAB(raw)).getMisterArrayBuffer());
      return raw;
    },
  };
}

// PSX: validate as a PS1 memory card when possible, but fall back to a plain
// copy for 128 KiB images that don't parse (e.g. a freshly-created card the
// core hasn't formatted yet). RetroArch .srm/.mcr and MiSTer .sav are all the
// same raw 128 KiB memory card image.
const PS1_CARD_SIZE = 128 * 1024;
const psxAdapter = {
  toRaw(kind, buf) {
    try {
      const o = kind === 'mister'
        ? vendor.MisterPs1SaveData.createFromMisterData(toAB(buf))
        : vendor.MisterPs1SaveData.createFromRawData(toAB(buf));
      return toBuf(o.getRawArrayBuffer());
    } catch (e) {
      if (buf.length === PS1_CARD_SIZE) return buf;
      throw e;
    }
  },
  fromRaw(kind, raw) {
    return raw; // identical bytes on both sides
  },
};

// PCE: verify BRAM magic; identical bytes on both sides.
const pceAdapter = {
  toRaw(kind, buf) {
    vendor.PcEngineUtil.verifyPcEngineData(toAB(buf));
    return buf;
  },
  fromRaw(kind, raw) {
    return raw;
  },
};

// ---------------------------------------------------------------------------
// N64
//
// libretro mupen64plus-next / ParaLLEl N64 combined .srm layout:
//   0x00000  EEPROM    0x00800 (2 KiB)
//   0x00800  mempaks   0x20000 (4 x 32 KiB)
//   0x20800  SRAM      0x08000 (32 KiB)
//   0x28800  FlashRAM  0x20000 (128 KiB)
//   total    0x48800   (296960 bytes)
//
// MiSTer cart saves (and standalone RetroArch files) are single-region files
// whose extension is derived from size: .eep (512/2048), .sra (32768),
// .fla (131072). save-file-converter confirms MiSTer stores these with the
// same endianness as emulators, so region bytes copy straight across.
//
// Canonical raw for this system = the combined 296960-byte image.
// ---------------------------------------------------------------------------
const N64 = {
  EEPROM: { offset: 0x00000, size: 0x00800 },
  MEMPAK: { offset: 0x00800, size: 0x20000 },
  SRAM: { offset: 0x20800, size: 0x08000 },
  FLASH: { offset: 0x28800, size: 0x20000 },
  TOTAL: 0x48800,
};

function isUniform(buf) {
  if (buf.length === 0) return true;
  const first = buf[0];
  if (first !== 0x00 && first !== 0xff) return false;
  for (let i = 1; i < buf.length; i += 1) if (buf[i] !== first) return false;
  return true;
}

function blankCombined() {
  const b = Buffer.alloc(N64.TOTAL, 0xff); // mupen initializes save memory to 0xFF
  b.fill(0x00, N64.MEMPAK.offset, N64.MEMPAK.offset + N64.MEMPAK.size);
  return b;
}

function regionForStandalone(buf) {
  const ab = toAB(buf);
  if (vendor.N64Util.isEepromSave(ab)) return 'EEPROM';
  if (vendor.N64Util.isSramSave(ab)) return 'SRAM';
  if (vendor.N64Util.isFlashRamSave(ab)) return 'FLASH';
  throw new Error(`Unrecognized N64 save size: ${buf.length} bytes`);
}

// Merge a standalone .eep/.sra/.fla into a combined image (base = existing
// combined image if the sync engine found one, so other regions survive).
function mergeStandaloneIntoCombined(standalone, base) {
  const out = Buffer.from(base && base.length === N64.TOTAL ? base : blankCombined());
  const region = N64[regionForStandalone(standalone)];
  standalone.copy(out, region.offset, 0, Math.min(standalone.length, region.size));
  if (standalone.length < region.size) {
    // Undersized EEPROM (512B): fill the remainder of the region with 0xFF
    out.fill(0xff, region.offset + standalone.length, region.offset + region.size);
  }
  return out;
}

// Extract the active single-region saves from a combined image.
// Returns { eep?, sra?, fla? }. preferredSizes lets us keep an existing
// 512-byte EEPROM at 512 bytes instead of growing it to 2 KiB.
function extractStandalone(combined, preferredSizes = {}) {
  const out = {};
  const eep = combined.subarray(N64.EEPROM.offset, N64.EEPROM.offset + N64.EEPROM.size);
  const sra = combined.subarray(N64.SRAM.offset, N64.SRAM.offset + N64.SRAM.size);
  const fla = combined.subarray(N64.FLASH.offset, N64.FLASH.offset + N64.FLASH.size);

  if (!isUniform(eep)) {
    let size = preferredSizes.eep;
    if (!size) size = isUniform(eep.subarray(512)) ? 512 : 2048;
    out.eep = Buffer.from(eep.subarray(0, size));
  }
  if (!isUniform(sra)) out.sra = Buffer.from(sra);
  if (!isUniform(fla)) out.fla = Buffer.from(fla);
  return out;
}

const n64Adapter = {
  combinedSize: N64.TOTAL,
  PAK_SIZE: 0x8000,
  isCombined(buf) {
    return buf.length === N64.TOTAL;
  },
  pakOffset(i) {
    return N64.MEMPAK.offset + i * this.PAK_SIZE;
  },
  pakSlot(combined, i) {
    return combined.subarray(this.pakOffset(i), this.pakOffset(i) + this.PAK_SIZE);
  },
  // A Controller Pak is battery SRAM: its contents can legitimately be an
  // unformatted pak (random garbage no game ever initialized — MiSTer dumps
  // it raw), a homebrew layout that ignores the standard filesystem
  // (XenoCrisis), or a filesystem the game itself will repair on next boot.
  // The MiSTer .cpk format is a raw 32 KiB image with no transformation, and
  // the libretro combined .srm embeds pak bytes raw without validating them
  // either — so neither do we. The only requirement is the size: merging a
  // wrong-sized blob into a fixed 32 KiB .srm slot would corrupt the image.
  // (v1 ran paks through the vendored filesystem parser here; real MiSTer
  // saves failed its ID-area checksum and offset checks. Field bug.)
  isPakSized(buf) {
    return buf.length === this.PAK_SIZE;
  },
  blankCombined,
  toRaw(kind, buf, base) {
    if (this.isCombined(buf)) return buf;
    return mergeStandaloneIntoCombined(buf, base);
  },
  extractStandalone,
  regionForStandalone,
};

// ---------------------------------------------------------------------------
// Sega disc systems (Saturn, Sega CD)
//
// Both use the same two-part model: internal backup RAM plus an optional
// RAM cart. The MiSTer file is the internal section with the cart section
// optionally concatenated after it (Saturn additionally byte-expands the
// whole file, and its files can carry garbage in the expansion bytes, so
// equivalence must always be judged on the PARSED parts, never file bytes).
//
// Canonical raw = the plain emulator part files:
//   saturn: <game>.bkr (32 KiB internal) / <game>.bcr (512 KiB cart)
//           — Beetle Saturn / Mednafen naming. Mednafen may gzip these;
//           the vendored EmulatorSegaSaturnSaveData transparently handles
//           that, which is why parts are normalized through it below.
//   segacd: <game>.brm (8 KiB internal) — Genesis Plus GX per-game BRAM.
//           The cart file is NOT synced for Sega CD: GPGX's cart BRAM is a
//           shared file (cart.brm) or has unverified per-game naming, so a
//           cart section found in a MiSTer file is preserved on write but
//           never fanned out. scd_U/E/J.brm and cart.brm are ignored in the
//           mapping for the same reason.
// ---------------------------------------------------------------------------
function makeSegaDisc({ Cls, internalExt, cartExt, misterLargeSize, emptyCartRaw }) {
  return {
    Cls,
    internalExt,
    cartExt,
    parseMister(buf) {
      const o = Cls.createFromMisterData(toAB(buf));
      return {
        internal: toBuf(o.getRawArrayBuffer(Cls.INTERNAL_MEMORY)),
        cart: toBuf(o.getRawArrayBuffer(Cls.RAM_CART)),
        hasCartSection: buf.length === misterLargeSize,
      };
    },
    buildMister({ internal, cart }) {
      return toBuf(Cls.createFromRawData({
        rawInternalSaveArrayBuffer: internal ? toAB(internal) : null,
        rawCartSaveArrayBuffer: cart ? toAB(cart) : null,
      }).getMisterArrayBuffer());
    },
    // Validate + normalize emulator-side parts (decompress gzipped Mednafen
    // files, strip padding, verify format signatures). Throws on junk input.
    normalizeParts({ internal, cart }) {
      const out = { internal: null, cart: null };
      if (internal) {
        const o = Cls.createFromRawData({ rawInternalSaveArrayBuffer: toAB(internal) });
        out.internal = toBuf(o.getRawArrayBuffer(Cls.INTERNAL_MEMORY));
      }
      if (cart) {
        const o = Cls.createFromRawData({ rawCartSaveArrayBuffer: toAB(cart) });
        out.cart = toBuf(o.getRawArrayBuffer(Cls.RAM_CART));
      }
      return out;
    },
    emptyCartRaw,
  };
}

const segaDisc = {
  saturn: makeSegaDisc({
    Cls: vendor.MisterSegaSaturnSaveData,
    internalExt: 'bkr',
    cartExt: 'bcr',
    // byte-expanded internal (32K -> 64K) + byte-expanded cart (512K -> 1M)
    misterLargeSize: (32768 * 2) + (524288 * 2),
    emptyCartRaw: () => toBuf(
      vendor.SegaSaturnSaveData.createEmptySave(vendor.SegaSaturnSaveData.CARTRIDGE_BLOCK_SIZE),
    ),
  }),
  segacd: makeSegaDisc({
    Cls: vendor.MisterSegaCdSaveData,
    internalExt: 'brm',
    cartExt: null,
    // internal (8K) + cart (512K), stored plain (not byte-expanded)
    misterLargeSize: vendor.SegaCdUtil.INTERNAL_SAVE_SIZE + vendor.MisterSegaCdSaveData.RAM_CART_SIZE,
    emptyCartRaw: () => toBuf(vendor.SegaCdUtil.makeEmptySave(vendor.MisterSegaCdSaveData.RAM_CART_SIZE)),
  }),
};

// ---------------------------------------------------------------------------

const adapters = {
  nes: classAdapter(vendor.MisterNesSaveData),
  snes: classAdapter(vendor.MisterSnesSaveData),
  gb: classAdapter(vendor.MisterGameboySaveData),
  gba: classAdapter(vendor.MisterGameboyAdvanceSaveData),
  genesis: classAdapter(vendor.MisterGenesisSaveData),
  sms: classAdapter(vendor.MisterSmsSaveData),
  gg: classAdapter(vendor.MisterSmsSaveData), // Game Gear uses the same raw-copy format on both sides
  pce: pceAdapter,
  psx: psxAdapter,
  n64: n64Adapter,
};

// Content-based discriminators for multi-system RetroArch cores. Given a
// save file's bytes, each function returns true if the save could plausibly
// belong to its system.
//
// The daemon calls the matching function (referenced by name from the
// mapping) before routing a save. If a system has no discriminator, it
// unconditionally accepts anything from its listed RA cores — the
// duplicate-blindly behavior kept for the GB family, where the byte pattern
// genuinely doesn't distinguish GB from GBA at overlapping save sizes.
const discriminators = {
  // Emulator-side Genesis SRAM/FRAM saves are byte-expanded: every second
  // byte is either 0x00 or 0xFF. That's the reliable tell for Genesis vs
  // SMS/GG in the multi-system Sega cores (Genesis Plus GX, GPGX Wide,
  // PicoDrive). Genesis EEPROM saves are tiny (<512B) and not byte-expanded,
  // so we let those through too — they're indistinguishable from a small
  // SMS save at the byte level and either interpretation is a raw copy.
  genesisLike(buf) {
    if (buf.length < vendor.GenesisSmallestSramSize) return true; // possible Genesis EEPROM
    return vendor.GenesisUtil.isByteExpanded(toAB(buf));
  },

  // Complement of genesisLike: if the buffer is byte-expanded, it's Genesis,
  // not SMS/GG. Small files (< 512B) are ambiguous — accept.
  //
  // Odd-length saves >= 512B are rejected: no Sega SRAM/FRAM layout is
  // odd-length (Genesis saves are byte-expanded, hence always even; SMS/GG
  // SRAM is even too). Such a file is anomalous — most likely a truncated,
  // corrupt, or non-save file that landed in a multi-system core folder. We
  // route it to NEITHER family (genesisLike already returns false for it,
  // since an odd buffer can't be byte-expanded) rather than guessing SMS/GG
  // and fanning a wrong-family save out to MiSTer. It stays put until sorted
  // out. This also mirrors the vendored isByteExpanded fix that stopped the
  // out-of-bounds DataView read on odd-length input.
  smsGgLike(buf) {
    if (buf.length < 512) return true;
    if ((buf.length % 2) !== 0) return false;
    return !vendor.GenesisUtil.isByteExpanded(toAB(buf));
  },
};

module.exports = { adapters, discriminators, n64: n64Adapter, segaDisc, isUniform };
