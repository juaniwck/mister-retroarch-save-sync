/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 *
 * The sync engine. A save that changes in any mapped location is converted to
 * the canonical "raw" (emulator) form via the vendored save-file-converter
 * logic and then fanned out to every other location in its system group, in
 * whatever form that location requires.
 *
 * Loop safety: a write is skipped when the target already holds equivalent
 * data — byte-identical, or round-trip-identical (converting the existing
 * target back to raw yields the same bytes, which covers cases like MiSTer
 * GBA files carrying appended RTC data or differently-padded Genesis files).
 * Additionally, events caused by our own writes are recognized by hash and
 * consumed without processing.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { adapters, discriminators, segaDisc, isUniform } = require('./converters');

// True when the two buffers hold identical save data and differ only by a
// uniform (0x00 or 0xFF) pad at the end — e.g. an 8 KiB emulator NES save vs
// the same save padded to 32 KiB for the MiSTer core.
function paddedEquivalent(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.subarray(0, short.length).equals(short)) return false;
  return isUniform(long.subarray(short.length));
}

const TMP_SUFFIX = '.savesync.tmp';

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

class SyncEngine {
  /**
   * @param opts.retroarchSaves  <RETROARCH_ROOT>/saves
   * @param opts.misterSaves    MiSTer saves root (e.g. /media/fat/saves)
   * @param opts.mapping        mapping object (see mapping.js)
   * @param opts.dirIndex       Map from buildDirIndex()
   * @param opts.onRetroarchWrite callback fired whenever the RetroArch tree changed
   */
  constructor(opts) {
    this.retroarchSaves = opts.retroarchSaves;
    this.misterSaves = opts.misterSaves;
    this.mapping = opts.mapping;
    this.dirIndex = opts.dirIndex;
    this.onRetroarchWrite = opts.onRetroarchWrite || (() => {});
    this.log = opts.log || console;
    this.createMissingDirs = opts.createMissingDirs !== false;
    this.dryRun = !!opts.dryRun;
    this.selfWrites = new Map(); // absolute path -> md5 we last wrote
    this.writeCount = 0;
    this.dirFailures = new Set(); // directories we couldn't write into
    this.mtimeCache = new Map(); // absolute path -> last-processed mtimeMs
  }

  // ------------------------------------------------------------------ utils

  ignored(fileName) {
    const m = this.mapping;
    const lower = fileName.toLowerCase();
    if (fileName.endsWith(TMP_SUFFIX) || fileName.startsWith('.')) return true;
    if ((m.ignore || []).some((n) => n.toLowerCase() === lower)) return true;
    const ext = path.extname(lower).slice(1);
    if ((m.ignoreExtensions || []).includes(ext)) return true;
    if ((m.ignoreSubstrings || []).some((s) => lower.includes(s.toLowerCase()))) return true;
    return false;
  }

  classify(absPath) {
    // -> { side, root, coreDir, fileName } or null
    for (const [side, root] of [['retroarch', this.retroarchSaves], ['mister', this.misterSaves]]) {
      const rel = path.relative(root, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = rel.split(path.sep);
      if (parts.length !== 2) return null; // only <root>/<CoreDir>/<file>
      return { side, root, coreDir: parts[0], fileName: parts[1] };
    }
    return null;
  }

  writeFile(absPath, buf) {
    if (this.dryRun) {
      this.log.info(`[dry-run] would write ${absPath} (${buf.length} bytes)`);
      return true;
    }
    const dir = path.dirname(absPath);
    if (this.dirFailures.has(dir)) return false;
    const tmp = absPath + TMP_SUFFIX;

    // Write-first strategy. On stacked / bind / FUSE-backed mounts (mergerfs,
    // proxmox LXC bind mounts, overlayfs, etc.) mkdir() can spuriously return
    // ENOENT for a directory that objectively exists, while writing a file
    // into that directory works fine. And stat() isn't always reliable
    // either: if the syscall is even briefly out of sync with what open()
    // sees, our probe lies to us.
    //
    // So: just try the write. If the OPEN itself fails with ENOENT, then the
    // parent probably really is missing — retry once after a mkdir. If mkdir
    // also fails, note the directory as unusable and stop hammering it.
    const write = () => {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, absPath);
    };

    try {
      write();
    } catch (firstErr) {
      // Clean up any stray tmp from the failed attempt so we don't leave crumbs.
      try { fs.unlinkSync(tmp); } catch { /* fine */ }

      if (firstErr.code !== 'ENOENT') {
        this.noteDirFailure(dir, firstErr);
        return false;
      }

      // Missing parent (or something pretending to be). Try to create it, but
      // don't fail if mkdir spuriously errors while the directory is in fact
      // present.
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (mkdirErr) {
        if (mkdirErr.code !== 'EEXIST' && !fs.existsSync(dir)) {
          this.noteDirFailure(dir, mkdirErr);
          return false;
        }
      }

      try {
        write();
      } catch (retryErr) {
        try { fs.unlinkSync(tmp); } catch { /* fine */ }
        this.noteDirFailure(dir, retryErr);
        return false;
      }
    }

    this.selfWrites.set(absPath, md5(buf));
    this.writeCount += 1;
    if (absPath.startsWith(this.retroarchSaves + path.sep)) this.onRetroarchWrite();
    this.log.info(`[sync] wrote ${absPath} (${buf.length} bytes)`);
    return true;
  }

  // Log a directory-level write failure exactly once (per reconcile pass /
  // until cleared), instead of once per game.
  noteDirFailure(dir, e) {
    if (this.dirFailures.has(dir)) return;
    this.dirFailures.add(dir);
    this.log.error(
      `[sync] cannot write into ${dir} (${e.code || 'ERR'}: ${e.message}). `
      + 'Further writes to this directory are suppressed until the next reconcile. '
      + 'If this path lives on a mergerfs pool and the directory had to be created, '
      + 'path-preserving create policies (epmfs/eplfs) can reject mkdir with ENOENT — '
      + 'create the folder manually on the pool, or use a non-path-preserving policy '
      + 'like mfs/pfrd. Otherwise check mount visibility and write permissions for '
      + 'the container UID.',
    );
  }

  locations(system) {
    const def = this.mapping.systems[system];
    const out = [];
    for (const d of def.retroarch) {
      out.push({ side: 'retroarch', dir: path.join(this.retroarchSaves, d), exts: def.retroarchExts });
    }
    for (const d of def.mister) {
      out.push({ side: 'mister', dir: path.join(this.misterSaves, d), exts: def.misterExts });
    }
    return out;
  }

  targetUsable(loc) {
    if (this.dirFailures.has(loc.dir)) return false;
    if (fs.existsSync(loc.dir)) return true;
    return this.createMissingDirs;
  }

  // ------------------------------------------------------------ event entry

  handleFile(absPath) {
    const cls = this.classify(absPath);
    if (!cls || this.ignored(cls.fileName)) return;

    if (cls.side === 'retroarch') this.onRetroarchWrite(); // keep manifest fresh even for files we don't sync

    let buf;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      return; // deleted/renamed while settling
    }

    const expected = this.selfWrites.get(absPath);
    if (expected && expected === md5(buf)) {
      this.selfWrites.delete(absPath);
      return; // echo of our own write
    }

    const memberships = this.dirIndex.get(cls.coreDir.toLowerCase()) || [];
    for (const { system, side } of memberships) {
      if (side !== cls.side) continue;
      try {
        this.syncGame(system, cls, buf, absPath);
      } catch (e) {
        this.log.error(`[sync] ${system}: failed to sync ${absPath}: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------- generic sync

  syncGame(system, cls, buf, srcPath) {
    const game = path.basename(cls.fileName, path.extname(cls.fileName));
    if (system === 'n64') {
      this.syncN64(cls, buf, srcPath, game);
      return;
    }
    if (segaDisc[system]) {
      this.syncSegaDisc(system, cls, buf, srcPath, game);
      return;
    }

    const adapter = adapters[system];
    const def = this.mapping.systems[system];

    const validExts = (cls.side === 'retroarch' ? def.retroarchExts : def.misterExts);
    const ext = path.extname(cls.fileName).slice(1).toLowerCase();
    if (!validExts.includes(ext)) return;

    // Content-based discrimination for multi-system RA cores. A save in a
    // Genesis Plus GX folder that looks like SMS bytes is only routed to
    // sms/gg groups; a byte-expanded save is only routed to genesis. See
    // converters.discriminators.
    if (def.discriminate) {
      const check = discriminators[def.discriminate];
      if (typeof check === 'function' && !check(buf)) return;
    }

    const raw = adapter.toRaw(cls.side, buf);
    const rawHash = md5(raw);

    for (const loc of this.locations(system)) {
      if (!this.targetUsable(loc)) continue;
      let converted;
      try {
        converted = adapter.fromRaw(loc.side, raw);
      } catch {
        continue; // adapter refused this input for this side
      }

      // Round-trip safety. Reading the converted file back must reconstruct
      // the source (byte-equal or padded-equivalent). If not, this adapter's
      // transform is lossy for this input and writing here would set up
      // future corruption when the reconcile picks the wrong-family target
      // as source. Silently skip — the correct-family target for this save
      // still gets written by the other group.
      //
      // In practice this only fires for saves routed through the Genesis
      // adapter with non-genesis-format data (byte-expansion isn't reversible
      // for arbitrary input). All other adapters are either identity,
      // trailing-pad only, or throw on invalid data.
      if (!this.roundTripSafe(adapter, loc.side, raw, converted)) continue;

      for (const targetExt of loc.exts) {
        const target = path.join(loc.dir, `${game}.${targetExt}`);
        if (target === srcPath) continue;
        if (this.targetHoldsEquivalent(target, converted, adapter, loc.side, rawHash)) continue;
        this.writeFile(target, converted);
      }
    }
  }

  roundTripSafe(adapter, side, raw, converted) {
    try {
      const returned = adapter.toRaw(side, converted);
      if (returned.equals(raw)) return true;
      if (paddedEquivalent(returned, raw)) return true;
      return false;
    } catch {
      return false;
    }
  }

  targetHoldsEquivalent(targetPath, converted, adapter, side, rawHash) {
    let existing;
    try {
      existing = fs.readFileSync(targetPath);
    } catch {
      return false;
    }
    if (existing.equals(converted)) return true;
    if (paddedEquivalent(existing, converted)) return true;
    try {
      return md5(adapter.toRaw(side, existing)) === rawHash;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- Sega disc systems

  // Saturn / Sega CD. Two logical parts (internal backup RAM + optional RAM
  // cart) live as separate per-game files on the RetroArch side and as one
  // concatenated file on the MiSTer side. Saturn MiSTer files can carry
  // garbage in their byte-expansion bytes, so equivalence is judged on
  // PARSED parts, never raw file bytes.
  syncSegaDisc(system, cls, buf, srcPath, game) {
    const disc = segaDisc[system];
    const def = this.mapping.systems[system];
    const ext = path.extname(cls.fileName).slice(1).toLowerCase();

    // Gather the raw part pair from the source.
    let internal = null;
    let cart = null;
    if (cls.side === 'mister') {
      if (!def.misterExts.includes(ext)) return;
      const parsed = disc.parseMister(buf); // throws on invalid input
      internal = parsed.internal;
      if (parsed.hasCartSection) cart = parsed.cart;
    } else {
      if (!def.retroarchExts.includes(ext)) return;
      const srcDir = path.dirname(srcPath);
      if (ext === disc.internalExt) {
        internal = buf;
        if (disc.cartExt) cart = this.tryRead(path.join(srcDir, `${game}.${disc.cartExt}`));
      } else if (disc.cartExt && ext === disc.cartExt) {
        cart = buf;
        internal = this.tryRead(path.join(srcDir, `${game}.${disc.internalExt}`));
      } else {
        return;
      }
      // Validate + normalize (handles gzipped Mednafen files, padding, etc).
      // Throws on junk, which the caller logs.
      ({ internal, cart } = disc.normalizeParts({ internal, cart }));
    }
    if (!internal && !cart) return;

    const cartHasContent = cart !== null && !cart.equals(disc.emptyCartRaw());

    for (const loc of this.locations(system)) {
      if (!this.targetUsable(loc)) continue;

      if (loc.side === 'retroarch') {
        if (internal) {
          const t = path.join(loc.dir, `${game}.${disc.internalExt}`);
          if (t !== srcPath && !this.bytesEqualOnDisk(t, internal)) this.writeFile(t, internal);
        }
        if (cart && disc.cartExt) {
          const t = path.join(loc.dir, `${game}.${disc.cartExt}`);
          if (t !== srcPath && !this.bytesEqualOnDisk(t, cart)) this.writeFile(t, cart);
        }
        continue;
      }

      // MiSTer side: decide the output shape, preserving an existing cart
      // section the source knows nothing about (Sega CD cart is never synced;
      // Saturn cart may simply be absent from the triggering event).
      const target = path.join(loc.dir, `${game}.${loc.exts[0]}`);
      if (target === srcPath) continue;

      const existingBuf = this.tryRead(target);
      let existing = null;
      if (existingBuf) {
        try {
          existing = disc.parseMister(existingBuf);
        } catch { /* unparseable target: treat as absent, it will be replaced */ }
      }

      const outInternal = internal || (existing ? existing.internal : null);
      let outCart = null;
      if (existing && existing.hasCartSection) {
        // Target already has a cart section: keep the shape. Fresh cart data
        // (even a freshly-emptied cart) wins over the preserved one.
        outCart = cart || existing.cart;
      } else if (cartHasContent) {
        // No cart section on the target yet: only grow the file for a cart
        // that actually holds saves, not for an empty placeholder .bcr.
        outCart = cart;
      }

      // Parsed equivalence: skip when the target already holds these parts.
      if (existing
        && outInternal && existing.internal.equals(outInternal)
        && ((outCart === null) === !existing.hasCartSection)
        && (outCart === null || existing.cart.equals(outCart))) {
        continue;
      }

      const converted = disc.buildMister({ internal: outInternal, cart: outCart });
      if (existingBuf && existingBuf.equals(converted)) continue;
      this.writeFile(target, converted);
    }
  }

  tryRead(p) {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- N64 sync

  // Canonical raw = libretro combined .srm (296960 bytes). Standalone
  // .eep/.sra/.fla changes are merged into the freshest existing combined
  // image so the other regions are preserved. MiSTer Controller Pak files
  // (<game>_1.cpk .. <game>_4.cpk, raw 32 KiB memory card images with no
  // transformation) merge into / extract from the combined image's mempak
  // region the same way.
  syncN64(cls, buf, srcPath, game) {
    const n64 = adapters.n64;
    const def = this.mapping.systems.n64;

    const ext = path.extname(cls.fileName).slice(1).toLowerCase();
    if (ext === 'cpk') {
      if (cls.side !== 'mister') return; // paks only live as files on the MiSTer side
      const m = game.match(/^(.*)_([1-4])$/);
      if (!m) return; // not the MiSTer <game>_N.cpk naming; leave it alone
      if (!n64.isPakSized(buf)) return; // transient mid-write state; settles next pass
      game = m[1];
    }

    let raw;
    if (n64.isCombined(buf)) {
      raw = buf;
    } else if (cls.side === 'mister') {
      // Gather-mode: any MiSTer-side part event (.eep/.sra/.fla/_N.cpk)
      // resyncs the whole game from the MiSTer directory in one merge, so a
      // game with several part files fans out once instead of once per part.
      //
      // Staleness guard: when a combined .srm exists somewhere, a MiSTer part
      // file older than it is data the .srm already supersedes (e.g. the
      // daemon was down while RetroArch played) — merging it would regress
      // that region/pak slot. Each part is only merged if its mtime is >= the
      // base's. Our own fan-out writes parts right after the .srm, so
      // steady-state parts always pass the >= check with identical bytes.
      raw = this.gatherN64FromMisterDir(path.dirname(srcPath), game, srcPath);
    } else {
      raw = n64.toRaw(cls.side, buf, this.newestN64Combined(game, srcPath).buf);
    }
    const rawHash = md5(raw);

    // Existing standalone target sizes (so a 512-byte EEPROM stays 512 bytes)
    const preferredSizes = {};
    for (const loc of this.locations('n64')) {
      const eep = path.join(loc.dir, `${game}.eep`);
      try {
        preferredSizes.eep = preferredSizes.eep || fs.statSync(eep).size;
      } catch { /* not present */ }
    }
    const standalone = n64.extractStandalone(raw, preferredSizes);

    for (const loc of this.locations('n64')) {
      if (!this.targetUsable(loc)) continue;

      if (loc.side === 'retroarch') {
        const srmTarget = path.join(loc.dir, `${game}.srm`);
        if (srmTarget !== srcPath && !this.bytesEqualOnDisk(srmTarget, raw)) this.writeFile(srmTarget, raw);
      }

      // Standalone region files: RetroArch dirs mirror them (matching the
      // existing library layout), MiSTer gets them as its native cart saves.
      for (const [ext2, data] of Object.entries(standalone)) {
        const target = path.join(loc.dir, `${game}.${ext2}`);
        if (target === srcPath) continue;
        if (!this.bytesEqualOnDisk(target, data)) this.writeFile(target, data);
      }

      // Controller Paks: MiSTer keeps them as <game>_N.cpk files. Only the
      // MiSTer side gets these — RetroArch reads paks from inside the .srm.
      // A slot that is uniform 0x00/0xFF was never touched by any pak
      // (formatted paks always carry ID/header structure) and is skipped.
      if (loc.side === 'mister') {
        for (let i = 0; i < 4; i += 1) {
          const slot = n64.pakSlot(raw, i);
          if (isUniform(slot)) continue;
          const target = path.join(loc.dir, `${game}_${i + 1}.cpk`);
          if (target === srcPath) continue;
          if (!this.bytesEqualOnDisk(target, slot)) this.writeFile(target, Buffer.from(slot));
        }
      }
    }

    void rawHash;
  }

  // Merge every N64 part file for `game` found in a MiSTer directory
  // (.eep/.sra/.fla region files and _1.._4.cpk Controller Paks) over the
  // freshest existing combined image, honoring the per-part staleness guard
  // described in syncN64.
  gatherN64FromMisterDir(dir, game, srcPath) {
    const n64 = adapters.n64;
    const base = this.newestN64Combined(game, srcPath);
    const merged = Buffer.from(base.buf || n64.blankCombined());
    const fresh = (p) => {
      if (base.buf === null) return true;
      try {
        return fs.statSync(p).mtimeMs >= base.mtime;
      } catch {
        return false;
      }
    };

    for (const ext of ['eep', 'sra', 'fla']) {
      const p = path.join(dir, `${game}.${ext}`);
      if (!fresh(p)) continue;
      const data = this.tryRead(p);
      if (!data) continue;
      try {
        adapters.n64.toRaw('mister', data, merged).copy(merged);
      } catch { /* not a valid region file; skip */ }
    }
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(dir, `${game}_${i + 1}.cpk`);
      if (!fresh(p)) continue;
      const pak = this.tryRead(p);
      if (pak && n64.isPakSized(pak)) pak.copy(merged, n64.pakOffset(i), 0, n64.PAK_SIZE);
    }
    return merged;
  }

  bytesEqualOnDisk(targetPath, buf) {
    try {
      return fs.readFileSync(targetPath).equals(buf);
    } catch {
      return false;
    }
  }

  newestN64Combined(game, excludePath) {
    let best = null;
    let bestMtime = -1;
    for (const loc of this.locations('n64')) {
      if (loc.side !== 'retroarch') continue;
      const p = path.join(loc.dir, `${game}.srm`);
      if (p === excludePath) continue;
      try {
        const st = fs.statSync(p);
        if (st.size === adapters.n64.combinedSize && st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = p;
        }
      } catch { /* not present */ }
    }
    return best ? { buf: fs.readFileSync(best), mtime: bestMtime } : { buf: null, mtime: -1 };
  }

  // ------------------------------------------------------------ full reconcile

  // Runs up to `maxPasses` passes: a directory can belong to two system
  // groups (mGBA is in both gb and gba), so a save arriving there on pass 1
  // may need pass 2 to fan out through the second group.
  reconcileAll(maxPasses = 4) {
    this.dirFailures.clear(); // retry directories that failed last time (mount may be back)
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const before = this.writeCount;
      this.reconcilePass();
      if (this.writeCount === before) break;
    }
  }

  reconcilePass() {
    for (const system of Object.keys(this.mapping.systems)) {
      const games = new Map(); // game -> {path, mtime, cls}
      for (const loc of this.locations(system)) {
        let entries;
        try {
          entries = fs.readdirSync(loc.dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (this.ignored(name)) continue;
          const ext = path.extname(name).slice(1).toLowerCase();
          const validExts = loc.exts.includes('*') ? ['eep', 'sra', 'fla', 'srm', 'cpk'] : loc.exts;
          if (!validExts.includes(ext)) continue;
          const p = path.join(loc.dir, name);
          let st;
          try {
            st = fs.statSync(p);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          const game = path.basename(name, path.extname(name));
          const key = game.toLowerCase();
          const cur = games.get(key);
          if (!cur || st.mtimeMs > cur.mtime) {
            games.set(key, {
              path: p,
              mtime: st.mtimeMs,
              cls: { side: loc.side, coreDir: path.basename(loc.dir), fileName: name },
            });
          }
        }
      }

      for (const { path: p, mtime, cls } of games.values()) {
        // Skip files whose mtime hasn't moved since the last reconcile. The
        // cache key includes the system id because a single file may be
        // considered by more than one system group (multi-system RA cores
        // like Genesis Plus GX map to genesis + sms + gg), and each group
        // may accept or reject it based on discriminate — we don't want the
        // first system's decision to short-circuit the others.
        const cacheKey = `${system}:${p}`;
        const cached = this.mtimeCache.get(cacheKey);
        if (cached === mtime) continue;
        try {
          this.syncGame(system, cls, fs.readFileSync(p), p);
          this.mtimeCache.set(cacheKey, mtime);
        } catch (e) {
          this.log.error(`[reconcile] ${system}: ${p}: ${e.message}`);
        }
      }
    }
  }
}

module.exports = { SyncEngine, md5 };
