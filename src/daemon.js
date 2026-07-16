#!/usr/bin/env node
/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 *
 * Watches the RetroArch and MiSTer save trees with inotify and keeps saves
 * converted and unified between them. Regenerates RetroArch's cloud-sync
 * manifest.server (next to the saves directory) whenever the RetroArch tree
 * changes.
 *
 * Conversion logic from save-file-converter
 * (https://github.com/euan-forrester/save-file-converter), GPL-3.0.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { loadMapping, applyEnvFilters, buildDirIndex, defaultPath } = require('./mapping');
const { SyncEngine } = require('./sync');
const { writeManifest, countMissingManifestEntries } = require('./manifest');
const { watch } = require('./watcher');

const RETROARCH_ROOT = process.env.RETROARCH_ROOT || '/retroarch';
const MISTER_SAVES = process.env.MISTER_SAVES || '/mister/saves';
const CONFIG_PATH = process.env.MAPPING_FILE || defaultPath;
const SETTLE_MS = parseInt(process.env.SETTLE_MS || '1500', 10);
const MANIFEST_DEBOUNCE_MS = parseInt(process.env.MANIFEST_DEBOUNCE_MS || '3000', 10);
const SYNC_ON_START = (process.env.SYNC_ON_START || 'true') !== 'false';
const WRITE_MANIFEST = (process.env.WRITE_MANIFEST || 'true') !== 'false';
const CREATE_MISSING_DIRS = (process.env.CREATE_MISSING_DIRS || 'true') !== 'false';
const DRY_RUN = (process.env.DRY_RUN || 'false') === 'true';
// Minutes between periodic full reconciles. Useful when a directory is a
// network mount (cifs/nfs): inotify cannot see writes made by the remote
// machine, so poll-style reconciles pick them up. 0 disables.
const RECONCILE_INTERVAL_MIN = parseInt(process.env.RECONCILE_INTERVAL_MIN || '0', 10);

// Distinctive banner so it's obvious from the container logs whether this
// build is running. Bump when writeFile / mount behavior changes.
const BUILD_TAG = 'watchers v4 + discriminators v2 + saturn-segacd-cpk v2 + manifest-prune + env-cores v1';

// ISO-8601 timestamp for log lines, in the timezone selected by the TZ
// environment variable (e.g. TZ=America/New_York). Node resolves TZ via its
// bundled tz data, so getFullYear()/getHours()/getTimezoneOffset() already
// reflect the chosen zone. toISOString() cannot be used here because it is
// always UTC and would ignore TZ. With TZ unset (or UTC) the offset is 0 and
// the output ends in "Z", identical to the previous UTC-only format.
function logTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const abs = Math.abs(offMin);
  const offset = offMin === 0
    ? 'Z'
    : `${offMin > 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${p(d.getMilliseconds(), 3)}${offset}`;
}

const log = {
  info: (...a) => console.log(logTimestamp(), ...a),
  error: (...a) => console.error(logTimestamp(), ...a),
};

// Probe every target directory the mapping references. For each, run the
// three syscalls that matter and log what actually happened. This turns a
// mount problem into a single readable table instead of a per-file error
// flood.
function probeTargets(retroarchSaves, misterSaves, mapping) {
  const targets = new Set();
  for (const def of Object.values(mapping.systems)) {
    for (const d of def.retroarch) targets.add(path.join(retroarchSaves, d));
    for (const d of def.mister) targets.add(path.join(misterSaves, d));
  }

  const diag = (dir) => {
    const out = { dir, statOk: false, readdirOk: false, writeOk: false, symlink: null, notes: [] };

    try {
      const ls = fs.lstatSync(dir);
      if (ls.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(dir);
          const resolved = path.resolve(path.dirname(dir), target);
          out.symlink = { target, resolved, targetExists: fs.existsSync(resolved) };
        } catch (e) {
          out.notes.push(`readlink: ${e.code || 'ERR'}`);
        }
      }
    } catch { /* fall through */ }

    try {
      const st = fs.statSync(dir);
      out.statOk = st.isDirectory();
      if (!st.isDirectory()) out.notes.push('stat: exists but not a directory');
    } catch (e) {
      out.notes.push(`stat: ${e.code || 'ERR'}`);
    }

    try {
      const entries = fs.readdirSync(dir);
      out.readdirOk = true;
      out.entryCount = entries.length;
    } catch (e) {
      out.notes.push(`readdir: ${e.code || 'ERR'}`);
    }

    const probe = path.join(dir, `.savesync-probe-${process.pid}`);
    try {
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      out.writeOk = true;
    } catch (e) {
      out.notes.push(`write: ${e.code || 'ERR'}`);
      if (e.code === 'ENOENT' && !out.symlink) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          try {
            fs.writeFileSync(probe, '');
            fs.unlinkSync(probe);
            out.writeOk = true;
            out.notes.push('write ok after mkdir');
          } catch (retry) {
            out.notes.push(`write after mkdir: ${retry.code || 'ERR'}`);
          }
        } catch (mk) {
          out.notes.push(`mkdir: ${mk.code || 'ERR'}`);
        }
      }
    }

    return out;
  };

  const results = [...targets].sort().map(diag);
  const bad = results.filter((r) => !r.writeOk);
  const good = results.length - bad.length;

  log.info(`[probe] ${good}/${results.length} target directories writable`);
  for (const r of bad) {
    const link = r.symlink
      ? ` symlink→${r.symlink.target} (target ${r.symlink.targetExists ? 'ok' : 'UNREACHABLE'})`
      : '';
    log.error(
      `[probe]   ${r.dir}: stat=${r.statOk ? 'ok' : 'FAIL'} `
      + `readdir=${r.readdirOk ? `ok(${r.entryCount})` : 'FAIL'} `
      + `write=FAIL${link} — ${r.notes.join('; ')}`,
    );
  }

  // Signature detection: symlinks whose targets fall outside the mount the
  // container currently has. Print a single actionable fix instead of a wall
  // of per-file failures.
  const brokenLinks = bad.filter((r) => r.symlink && !r.symlink.targetExists);
  if (brokenLinks.length > 0) {
    // Compute a plausible common parent for the fix suggestion.
    const targetsResolved = brokenLinks.map((r) => r.symlink.resolved);
    let common = targetsResolved[0];
    for (const t of targetsResolved) {
      while (!t.startsWith(common)) common = path.dirname(common);
      if (common === '/') break;
    }
    log.error(
      `[probe] ${brokenLinks.length} target(s) are symlinks pointing outside the `
      + 'container\'s mounts. This is the standard RetroNAS layout: MiSTer per-'
      + 'core folders are symlinks into a unified saves tree (e.g. '
      + `${brokenLinks[0].symlink.target}). Mount a higher-level host directory `
      + `so the symlink targets are inside the container. Example: bind the `
      + `entire retronas root into /retronas and set MISTER_SAVES=/retronas/`
      + `mister/saves, RETROARCH_ROOT=/retronas/retroarch/saves. Symlink `
      + `targets currently want to resolve under: ${common}`,
    );
  }
}

function main() {
  const retroarchSaves = path.join(RETROARCH_ROOT, 'saves');

  for (const [name, dir] of [['RetroArch saves', retroarchSaves], ['MiSTer saves', MISTER_SAVES]]) {
    if (!fs.existsSync(dir)) {
      log.error(`${name} directory not found: ${dir}. Check your volume mounts.`);
      process.exit(1);
    }
  }

  // A mounted /config/mapping.json (if any) is loaded first; the SYSTEMS and
  // RETROARCH_CORES environment variables then filter it down — the easy way
  // to say "I only use these cores" without writing JSON.
  const mapping = applyEnvFilters(loadMapping(CONFIG_PATH), process.env, log);
  if (Object.keys(mapping.systems).length === 0) {
    log.error('Mapping has no systems left after SYSTEMS/RETROARCH_CORES filtering. Check the values.');
    process.exit(1);
  }
  const dirIndex = buildDirIndex(mapping);

  let manifestTimer = null;
  const scheduleManifest = () => {
    if (!WRITE_MANIFEST || DRY_RUN) return;
    clearTimeout(manifestTimer);
    manifestTimer = setTimeout(() => {
      try {
        const n = writeManifest(RETROARCH_ROOT);
        log.info(`[manifest] wrote manifest.server (${n} entries)`);
      } catch (e) {
        log.error(`[manifest] failed: ${e.message}`);
      }
    }, MANIFEST_DEBOUNCE_MS);
  };

  const engine = new SyncEngine({
    retroarchSaves,
    misterSaves: MISTER_SAVES,
    mapping,
    dirIndex,
    onRetroarchWrite: scheduleManifest,
    createMissingDirs: CREATE_MISSING_DIRS,
    dryRun: DRY_RUN,
    log,
  });

  log.info('mister-retroarch-save-sync starting');
  log.info(`  build:           ${BUILD_TAG}`);
  log.info(`  RetroArch saves: ${retroarchSaves}`);
  log.info(`  MiSTer saves:    ${MISTER_SAVES}`);
  log.info(`  Systems:         ${Object.keys(mapping.systems).join(', ')}`);
  if (DRY_RUN) log.info('  DRY RUN: no files will be written');

  probeTargets(retroarchSaves, MISTER_SAVES, mapping);

  if (SYNC_ON_START) {
    log.info('[reconcile] initial full reconcile...');
    engine.reconcileAll();
    log.info('[reconcile] done');
    scheduleManifest();
  }

  const onFile = (p) => engine.handleFile(p);

  // Retroarch side: single recursive watch on the saves root works.
  watch(retroarchSaves, onFile, { settleMs: SETTLE_MS, log });

  // MiSTer side: the parent recursive watch does not traverse symlinks, and
  // in RetroNAS-style layouts every core directory (SNES, N64, GAMEBOY, ...)
  // is a symlink into a unified saves tree. Adding each mapped core dir
  // explicitly makes inotifywait follow those symlinks (it dereferences
  // terminal symlinks on watch registration) while still reporting events
  // using the symlink path we passed in — so the sync engine's classifier
  // sees the MiSTer-view path and doesn't need to know about the real target.
  const misterCoreDirs = new Set();
  for (const def of Object.values(mapping.systems)) {
    for (const d of def.mister) misterCoreDirs.add(path.join(MISTER_SAVES, d));
  }
  const misterWatchPaths = [MISTER_SAVES];
  let symlinkedCoreCount = 0;
  for (const dir of misterCoreDirs) {
    let isLink = false;
    try { isLink = fs.lstatSync(dir).isSymbolicLink(); } catch { /* missing */ }
    if (isLink) {
      misterWatchPaths.push(dir);
      symlinkedCoreCount += 1;
    }
  }
  watch(misterWatchPaths, onFile, { settleMs: SETTLE_MS, log });

  log.info(
    `[watch] inotify watchers established `
    + `(retroarch: 1 recursive; mister: 1 recursive + ${symlinkedCoreCount} symlinked cores)`,
  );

  if (RECONCILE_INTERVAL_MIN > 0) {
    setInterval(() => {
      log.info('[reconcile] periodic scan (fallback for writes inotify missed)...');
      const before = engine.writeCount;
      engine.reconcileAll();
      const changed = engine.writeCount - before;
      if (changed > 0) scheduleManifest();
      log.info(`[reconcile] done (${changed} file(s) synced this pass)`);

      // Deleted saves don't fire the write-style inotify events, so also
      // check the manifest for entries whose file is gone and rebuild it
      // (a rebuild is a fresh walk, so all stale entries drop at once).
      if (WRITE_MANIFEST && !DRY_RUN) {
        const missing = countMissingManifestEntries(RETROARCH_ROOT);
        if (missing > 0) {
          log.info(`[manifest] ${missing} entr${missing === 1 ? 'y' : 'ies'} point(s) at deleted file(s); rebuilding`);
          scheduleManifest();
        }
      }
    }, RECONCILE_INTERVAL_MIN * 60 * 1000);
    log.info(`[reconcile] periodic fallback scan every ${RECONCILE_INTERVAL_MIN} min`);
  }
}

main();
