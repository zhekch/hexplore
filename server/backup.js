// Timed backups of data.db, taken by the server that owns it.
//
// Everything this map knows lives in one SQLite file: the accounts, every cell
// and its provenance, the routes, the Home Assistant token. Copying it while
// it's being written to is the one way to get a file that opens cleanly and is
// missing half a transaction, so nothing here touches the bytes directly —
// `VACUUM INTO` asks SQLite to write out a consistent, compacted copy, which is
// atomic with respect to whatever else is going on.
//
// It is deliberately a *smart* backup: a map nobody edited for a week should
// leave one file behind, not seven identical ones. Two things stand between a
// tick and a new file:
//
//   1. The source file's size and mtime. If neither moved since the last look,
//      nothing has been written and there is nothing to copy. This costs one
//      stat() and is the usual answer.
//   2. The hash of the copy itself. `VACUUM INTO` rebuilds the database from
//      its logical contents, so two vacuums of the same data produce the same
//      bytes — even after a write that added a row and deleted it again. When
//      the hash matches the last kept file, the copy is thrown away and the
//      backup counts as "nothing changed" rather than as a duplicate.
//
// The schedule is a cron expression (src/cron.js, shared with the dialog, which
// composes one from a picker or takes it typed). Times are local: "04:00" means
// four in the morning where the machine is.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCron, nextRun, previousRun } from '../src/cron.js';

const DEFAULT_CRON = '0 4 * * *'; // every day at 04:00, while nobody is looking
const DEFAULT_KEEP = 14;
const MAX_KEEP = 365;
const TICK_MS = 30 * 1000;
/** A missed backup is taken this long after boot, not the instant the port opens. */
const CATCH_UP_DELAY_MS = 15 * 1000;

const PREFIX = 'visited-map-';
const SUFFIX = '.db';
// Where the last run's bookkeeping is kept — beside the backups, *not* in the
// database. Writing "I took a backup at 04:00" into data.db is itself a change
// to data.db, which makes the next tick see a modified file, take a copy, write
// that down, and so on forever: a smart backup that records itself inside what
// it is watching can never skip anything. See loadState().
const STATE_FILE = '.backup-state.json';
// Only files this module wrote are ever listed, offered for download or
// deleted. Whatever else lives in that directory is none of its business.
// The optional tail is for two backups taken in the same second — pressing the
// button twice must not have the second one land on the first one's name.
const NAME_RE = /^visited-map-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/;

const nowSec = () => Math.floor(Date.now() / 1000);
const two = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** True for a name this module could have written — checked before any unlink. */
export function isBackupName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

async function fileSig(file) {
  try {
    const s = await stat(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

// What the database looks like from the outside, right now. The journal files
// are in here because a rollback journal appearing and disappearing is a write
// even when the main file's mtime hasn't caught up yet.
async function sourceSignature(dbPath) {
  const parts = await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-journal`].map((f) => fileSig(f)),
  );
  return parts.join('|');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db the live database
 * @param {string} opts.dbPath where it lives on disk
 * @param {string} opts.dir where backups are written
 * @param {(msg:string) => void} [opts.log]
 */
export function createBackups({ db, dbPath, dir, log = () => {} }) {
  db.exec(`
    -- One row, id 1. Backups are a property of the *instance* — one database
    -- file, one schedule — not of an account, which is why this has no user_id
    -- and why only the first account (the one that made the map) can change it.
    --
    -- Settings only. What the last run *did* lives in the sidecar file next to
    -- the backups, because writing it here would edit the database on every
    -- tick and there would be nothing left to skip.
    CREATE TABLE IF NOT EXISTS backup_settings (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      cron    TEXT    NOT NULL DEFAULT '${DEFAULT_CRON}',
      keep    INTEGER NOT NULL DEFAULT ${DEFAULT_KEEP}
    );
    INSERT OR IGNORE INTO backup_settings(id) VALUES(1);
  `);

  const readRow = db.prepare('SELECT * FROM backup_settings WHERE id = 1');
  const writeSettings = db.prepare('UPDATE backup_settings SET enabled = ?, cron = ?, keep = ? WHERE id = 1');

  let running = false;
  let timer = null;
  let dueAt = 0; // epoch ms of the next firing, 0 when the schedule is off

  const settings = () => readRow.get();

  const BLANK_STATE = {
    lastRun: 0, // epoch s of the last attempt, kept or skipped
    lastOk: 0, //  …of the last one that wrote a file
    lastError: '',
    lastFile: '',
    lastSize: 0,
    lastHash: '', // of the newest kept copy: the "has anything changed" test
    srcSig: '', //  size/mtime of data.db when we last looked
    runs: 0,
    skips: 0,
  };
  let state = null;

  // Losing this file costs one redundant backup and nothing else, so anything
  // unreadable is treated as "we've never run" rather than as an error.
  async function loadState() {
    if (state) return state;
    try {
      state = { ...BLANK_STATE, ...JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8')) };
    } catch {
      state = { ...BLANK_STATE };
    }
    return state;
  }

  async function saveState(patch) {
    state = { ...(await loadState()), ...patch };
    try {
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `${STATE_FILE}.tmp`);
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, path.join(dir, STATE_FILE));
    } catch (e) {
      log(`could not record the backup state: ${e.message ?? e}`);
    }
    return state;
  }

  /** When the schedule next comes round, as epoch seconds (0 = never). */
  function nextAt(s = settings()) {
    if (!s.enabled) return 0;
    try {
      const at = nextRun(s.cron, new Date());
      return at ? Math.floor(at.getTime() / 1000) : 0;
    } catch {
      return 0;
    }
  }

  function reschedule() {
    const at = nextAt();
    dueAt = at ? at * 1000 : 0;
  }

  /**
   * Every kept backup, newest first. Ordered by the file's own mtime rather
   * than by its name: retention deletes from the end of this list, and the one
   * thing that must never happen is the newest copy being taken for the oldest
   * because a clock change made the names sort oddly.
   */
  async function list() {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter(isBackupName)) {
      try {
        const s = await stat(path.join(dir, name));
        out.push({ name, size: s.size, at: Math.floor(s.mtimeMs / 1000), ms: s.mtimeMs });
      } catch {
        /* it went away between the listing and the stat — fine, it's gone */
      }
    }
    out.sort((a, b) => b.ms - a.ms || (a.name < b.name ? 1 : -1));
    return out.map(({ ms, ...rest }) => rest);
  }

  // Retention is by count, applied after a file lands. Deleting only ever
  // touches names this module wrote (NAME_RE), so pointing BACKUP_DIR at a
  // directory with other things in it can't eat them.
  async function prune(keep) {
    const files = await list();
    const doomed = files.slice(Math.max(1, keep));
    for (const f of doomed) {
      try {
        await unlink(path.join(dir, f.name));
      } catch (e) {
        log(`could not remove old backup ${f.name}: ${e.message ?? e}`);
      }
    }
    return doomed.length;
  }

  /**
   * Take one backup.
   *
   * @param {{force?:boolean}} [opts] force skips the "has anything changed"
   *   tests — used by nothing in the UI, because a button that always writes a
   *   file is a button that fills a disk with copies of the same map.
   * @returns {Promise<{status:'saved'|'unchanged'|'error', file?:string, size?:number, pruned?:number, error?:string}>}
   */
  async function run({ force = false } = {}) {
    if (running) return { status: 'unchanged', error: 'A backup is already running.' };
    running = true;
    const s = settings();
    const st = await loadState();
    try {
      const sig = await sourceSignature(dbPath);
      // Nothing has been written since the last look. This is the common case
      // for a map that only changes when someone opens it.
      if (!force && sig === st.srcSig && st.lastFile) {
        await saveState({ lastRun: nowSec(), lastError: '', srcSig: sig, skips: st.skips + 1 });
        return { status: 'unchanged', reason: 'nothing written since the last check' };
      }

      await mkdir(dir, { recursive: true });
      // Vacuum to a temp name first: the copy has to exist and be complete
      // before it can be compared, and a half-written file must never be
      // sitting in the directory under a name that looks like a backup.
      const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);
      try {
        await unlink(tmp);
      } catch {
        /* it shouldn't be there, and if it isn't, good */
      }
      // Synchronous, and the only place this server blocks on purpose: SQLite
      // has to see a stable database to write a consistent copy of it. A few
      // megabytes is a few milliseconds; it runs at 4am by default for the day
      // it isn't.
      db.prepare('VACUUM INTO ?').run(tmp);

      const hash = await hashFile(tmp);
      // The bytes are identical to the newest kept copy — the map was written
      // to, but nothing about it actually changed.
      if (!force && hash === st.lastHash) {
        await unlink(tmp).catch(() => {});
        await saveState({ lastRun: nowSec(), lastError: '', srcSig: sig, skips: st.skips + 1 });
        return { status: 'unchanged', reason: 'the map is identical to the last backup' };
      }

      // rename() replaces silently, so a second backup in the same second would
      // land on the first one's name and quietly take its place. Step aside
      // instead: two copies asked for are two copies kept.
      const base = `${PREFIX}${stamp()}`;
      let name = `${base}${SUFFIX}`;
      for (let n = 2; n < 100; n++) {
        if (!(await stat(path.join(dir, name)).catch(() => null))) break;
        name = `${base}-${n}${SUFFIX}`;
      }
      const dest = path.join(dir, name);
      await rename(tmp, dest);
      const size = (await stat(dest)).size;
      const at = nowSec();
      const pruned = await prune(s.keep);
      await saveState({
        lastRun: at,
        lastOk: at,
        lastError: '',
        lastFile: name,
        lastSize: size,
        lastHash: hash,
        srcSig: sig,
        runs: st.runs + 1,
      });
      log(`backup written: ${name} (${(size / 1e6).toFixed(1)} MB)${pruned ? `, ${pruned} old one(s) removed` : ''}`);
      return { status: 'saved', file: name, size, pruned };
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 200);
      await saveState({ lastRun: nowSec(), lastError: msg });
      log(`backup failed: ${msg}`);
      return { status: 'error', error: msg };
    } finally {
      running = false;
      reschedule();
    }
  }

  async function tick() {
    if (!dueAt || running) return;
    if (Date.now() < dueAt) return;
    await run();
  }

  /**
   * Start the timer. A tick every half minute rather than one long timeout: a
   * laptop that slept through 04:00 wakes up already past it and runs then,
   * which is the behaviour you want from a backup and not what a timeout set
   * for eleven hours' time gives you.
   */
  function start() {
    reschedule();
    const s = settings();
    // Missed while the server was down. `previousRun` says when it should have
    // gone; if the last attempt predates that, take one now rather than waiting
    // another day for the schedule to come round.
    if (s.enabled && s.cron) {
      loadState()
        .then((st) => {
          const prev = previousRun(s.cron, new Date());
          if (prev && st.lastRun * 1000 < prev.getTime()) {
            setTimeout(() => {
              run().catch(() => {});
            }, CATCH_UP_DELAY_MS).unref?.();
          }
        })
        .catch(() => {
          /* an unreadable expression is reported in the dialog, not here */
        });
    }
    clearInterval(timer);
    timer = setInterval(() => {
      tick().catch((e) => log(`backup tick failed: ${e.message ?? e}`));
    }, TICK_MS);
    timer.unref?.();
    return timer;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  /**
   * Change the schedule. Throws with a readable message for anything the cron
   * parser won't take, so the dialog can show it as-is.
   */
  function save({ enabled, cron, keep }) {
    const s = settings();
    const nextCron = cron === undefined ? s.cron : String(cron).trim().toLowerCase();
    parseCron(nextCron); // throws for the dialog to show
    // Nothing here falls back to the default on a bad number: "keep 0" is a
    // request to keep as few as possible, which is one, not fourteen.
    const asked = Math.trunc(+keep);
    const nextKeep = keep === undefined
      ? s.keep
      : (Number.isFinite(asked) ? Math.min(MAX_KEEP, Math.max(1, asked)) : DEFAULT_KEEP);
    const nextEnabled = enabled === undefined ? s.enabled : (enabled ? 1 : 0);
    writeSettings.run(nextEnabled, nextCron, nextKeep);
    reschedule();
    return settings();
  }

  /** Everything the dialog shows, in one call. */
  async function status() {
    const s = settings();
    const st = await loadState();
    return {
      enabled: !!s.enabled,
      cron: s.cron,
      keep: s.keep,
      dir,
      lastRun: st.lastRun,
      lastOk: st.lastOk,
      lastError: st.lastError,
      lastFile: st.lastFile,
      lastSize: st.lastSize,
      runs: st.runs,
      skips: st.skips,
      nextRun: nextAt(s),
      files: await list(),
    };
  }

  return { run, list, start, stop, save, status, settings, state: loadState, nextAt, dir };
}

/** Opens a backup file read-only — used by the tests to prove it's a database. */
export function openBackup(file) {
  return new DatabaseSync(file, { readOnly: true });
}

export { DEFAULT_CRON, DEFAULT_KEEP, MAX_KEEP };
