/*
 * mister-retroarch-save-sync — GPL-3.0-or-later
 *
 * Thin wrapper around inotifywait (inotify-tools). One recursive watcher per
 * root. Events are coalesced per file with a settle delay so that a core
 * flushing a save in several writes produces a single sync.
 */

'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

/**
 * Watch one or more paths. Each path can be a directory or a symlink to a
 * directory — inotify follows terminal symlinks by default, and events are
 * reported using the path string as passed in (so a symlink watch reports
 * events under the symlink path, not the target's realpath). Directories
 * passed here are watched recursively.
 *
 * `paths` may be a single string (legacy call sites) or an array.
 * Calls onFile(absolutePath) after the file has been quiet for `settleMs`.
 */
function watch(paths, onFile, { settleMs = 1500, log = console } = {}) {
  const watchList = Array.isArray(paths) ? paths.filter(Boolean) : [paths];
  if (watchList.length === 0) return null;

  const timers = new Map();

  const args = [
    '-m', '-r', '-q',
    // close_write: local writes and SMB writes that close the handle.
    // moved_to:    atomic-rename writers.
    // create:      new files appearing.
    // modify:      SMB writes that keep the handle open across saves (typical
    //              samba behavior — no close_write ever fires). The per-file
    //              settle delay collapses the many MODIFY events one write
    //              produces into a single sync trigger.
    // delete/moved_from: deletions. The sync engine can't read a deleted
    //              file so the event is a no-op for syncing, but on the
    //              RetroArch side it schedules a manifest rebuild so
    //              manifest.server drops stale entries immediately instead
    //              of waiting for the periodic missing-file scan.
    '-e', 'close_write', '-e', 'moved_to', '-e', 'create', '-e', 'modify',
    '-e', 'delete', '-e', 'moved_from',
    '--format', '%w%f|%e',
    ...watchList,
  ];

  const child = spawn('inotifywait', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const sep = line.lastIndexOf('|');
    if (sep < 0) return;
    const file = line.slice(0, sep);
    const events = line.slice(sep + 1);
    if (events.includes('ISDIR')) return;

    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      onFile(file);
    }, settleMs));
  });

  child.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && !msg.startsWith('Setting up watches') && !msg.startsWith('Watches established')) {
      log.error(`[inotify] ${msg}`);
    }
  });

  child.on('exit', (code, signal) => {
    log.error(`[inotify] inotifywait exited (code=${code} signal=${signal}); restarting in 5s`);
    setTimeout(() => watch(watchList, onFile, { settleMs, log }), 5000);
  });

  return child;
}

module.exports = { watch };
