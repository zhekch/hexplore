// The timed backup: does it copy the database, and — the whole point — does it
// know when *not* to?
//
// A map nobody edited for a week should leave one file behind, not seven
// identical ones, so there are two separate ways to decide nothing happened:
// the source file's size and mtime (cheap, the usual answer), and the hash of
// the copy itself (catches a write that changed nothing). Both are checked
// here, and so is the thing that makes any of it worth doing — that what lands
// on disk is a database you can open and read your cells out of.
//
//   node scripts/test/backup.mjs

import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackups, openBackup, isBackupName } from '../../server/backup.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const work = await mkdtemp(path.join(tmpdir(), 'visited-backup-'));
const dbPath = path.join(work, 'data.db');
const dir = path.join(work, 'backups');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE cell_sources(user_id INTEGER, cell_id TEXT, source TEXT)');
const addCell = db.prepare('INSERT INTO cell_sources VALUES(?, ?, ?)');
for (let i = 0; i < 200; i++) addCell.run(1, `0/${i}/${i}`, 'manual');

const backups = createBackups({ db, dbPath, dir });
const count = async () => (await backups.list()).length;

try {
  // --- The copy itself --------------------------------------------------------
  console.log('\ntaking one');
  const first = await backups.run();
  check(first.status === 'saved', 'the first backup is written', JSON.stringify(first));
  check(isBackupName(first.file ?? ''), 'named so it can be recognised later', first.file);
  check((await count()) === 1, 'one file on disk');

  const copy = openBackup(path.join(dir, first.file));
  const rows = copy.prepare('SELECT COUNT(*) AS n FROM cell_sources').get().n;
  copy.close();
  check(rows === 200, 'and it is a database with all 200 cells in it', String(rows));

  // --- Knowing when not to ----------------------------------------------------
  console.log('\nnot taking one');
  const again = await backups.run();
  check(again.status === 'unchanged', 'nothing written since — no second copy', JSON.stringify(again));
  check((await count()) === 1, 'still one file');

  // A write that leaves the data exactly as it was. The size/mtime test can't
  // see through that, so blank the recorded signature to force the run past it
  // — what's under test here is the *content* hash behind it.
  db.prepare('INSERT INTO cell_sources VALUES(?, ?, ?)').run(9, 'temp', 'temp');
  db.prepare('DELETE FROM cell_sources WHERE user_id = 9').run();
  // (the state file is the sidecar next to the backups, not a table in the map)
  await writeFile(path.join(dir, '.backup-state.json'), JSON.stringify({ ...(await backups.state()), srcSig: 'stale' }));
  const noop = await backups.run();
  check(noop.status === 'unchanged', 'a write that changed nothing is still not a backup', JSON.stringify(noop));
  check((await count()) === 1, 'still one file');
  check(!(await readdir(dir)).some((f) => f.startsWith('.tmp-')), 'and the copy it made to compare is cleaned up');

  // --- A real change ----------------------------------------------------------
  console.log('\ntaking another');
  addCell.run(1, '0/999/999', 'manual');
  const second = await backups.run();
  check(second.status === 'saved', 'a real edit is backed up', JSON.stringify(second));
  check((await count()) === 2, 'two files now');
  check(second.file !== first.file, 'under its own name', `${first.file} vs ${second.file}`);

  // Same second as the one before it: the name steps aside rather than
  // replacing what is already there.
  addCell.run(1, '0/998/998', 'manual');
  const third = await backups.run();
  check(third.status === 'saved' && (await count()) === 3, 'a third, taken in the same second, keeps its own file', third.file);

  // --- Retention --------------------------------------------------------------
  console.log('\nkeeping only so many');
  await writeFile(path.join(dir, 'notes.txt'), 'not mine');
  backups.save({ keep: 2 });
  addCell.run(1, '0/1000/1000', 'manual');
  const fourth = await backups.run();
  check(fourth.status === 'saved', 'a fourth is written');
  check((await count()) === 2, 'and the oldest are pruned back to two', String(await count()));
  const left = await backups.list();
  check(left[0].name === fourth.file, 'the newest survives', left.map((f) => f.name).join(', '));
  check((await readdir(dir)).includes('notes.txt'), 'a file it did not write is left alone');

  // --- Settings ---------------------------------------------------------------
  console.log('\nthe schedule');
  const saved = backups.save({ cron: '0 4 * * *', enabled: 1, keep: 30 });
  check(saved.cron === '0 4 * * *' && saved.keep === 30, 'a schedule is saved');
  check(backups.nextAt() > Math.floor(Date.now() / 1000), 'and has a next firing in the future');
  let refused = '';
  try {
    backups.save({ cron: 'every so often' });
  } catch (e) {
    refused = e.message;
  }
  check(!!refused, 'nonsense is refused, with a reason', refused);
  check(backups.settings().cron === '0 4 * * *', 'and the old schedule is left standing');
  check(backups.save({ keep: 9999 }).keep === 365, 'keeping "everything" is clamped to a year');
  check(backups.save({ keep: 0 }).keep === 1, 'keeping nothing is clamped to one');
  check(backups.save({ enabled: 0 }).enabled === 0 && backups.nextAt() === 0, 'switched off, nothing is due');

  const status = await backups.status();
  check(status.files.length === 2 && status.lastFile === fourth.file, 'the status names the newest file', status.lastFile);
  check(status.runs === 4 && status.skips === 2, 'and counts what it did and did not do', `${status.runs} runs, ${status.skips} skips`);
} finally {
  db.close();
  await rm(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
