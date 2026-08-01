#!/usr/bin/env node
// Recount the stored visits of already-imported history.
//
// `hits` is computed when a file is read, not when it is displayed, so changing
// what a visit *is* (see VISIT_GAP_SEC in src/locations.js) does nothing to
// history that is already in the database. The raw fixes behind those rows were
// never stored — only their first date, their last date and their count — so
// there is nothing to recompute from. The source files have to be read again.
//
// That is all this does: re-parse the exports in ./import, fold them into cells
// with today's rule, and write the result over the rows those same files put
// there. It is the offline twin of dropping the files back into "Import
// locations" in the app, which does exactly the same thing through the API —
// this one just does every file at once and shows you the difference first.
//
//   node scripts/recount-visits.mjs             # show what would change
//   node scripts/recount-visits.mjs --apply     # write it
//
//   --user=<username>   whose map to rewrite (default: the only account, or
//                       IMPORT_OWNER when there are several)
//   --db=<path>         default ./data.db, or $DB_PATH
//   --dir=<path>        default ./import
//
// **Stop the server first.** It holds the same file open, and a half-applied
// rewrite is worth avoiding even though SQLite would not corrupt anything.
// Sources the server fetches for itself — Home Assistant, Strava, Komoot — are
// deliberately left alone: their rows were merged a slice at a time and cannot
// be rebuilt from a file, and they converge on the new rule as they keep
// syncing, because the merge subtracts a shared visit using the current gap.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseLocationFile, pointsToCells, sourceLabel, VISIT_GAP_SEC } from '../src/locations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(arg('db', process.env.DB_PATH ?? path.join(ROOT, 'data.db')));
const IMPORT_DIR = path.resolve(arg('dir', path.join(ROOT, 'import')));
const WANT_USER = arg('user', process.env.IMPORT_OWNER ?? null);

const EXTS = /\.(json|geojson|kml|gpx|xml|csv|tsv|txt)$/i;
const n = (v) => v.toLocaleString();

const db = new DatabaseSync(DB_PATH);

// Which account. Being wrong about this rewrites the wrong person's history, so
// it refuses to guess when there is more than one and nobody said.
const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
if (!users.length) {
  console.error('No accounts in this database.');
  process.exit(1);
}
const user = WANT_USER ? users.find((u) => u.username === WANT_USER) : users.length === 1 ? users[0] : null;
if (!user) {
  console.error(
    WANT_USER
      ? `No account called ${WANT_USER}. Accounts here: ${users.map((u) => u.username).join(', ')}`
      : `Several accounts here (${users.map((u) => u.username).join(', ')}) — say which with --user=<username>.`,
  );
  process.exit(1);
}

// --- Read the files exactly as an import would -------------------------------

let files;
try {
  files = readdirSync(IMPORT_DIR).filter((f) => EXTS.test(f));
} catch {
  console.error(`Import folder not found: ${IMPORT_DIR}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`No location exports in ${IMPORT_DIR} — this can only recount what it can re-read.`);
  process.exit(1);
}

console.log(`${DB_PATH}\naccount ${user.username}, a visit is ${VISIT_GAP_SEC / 3600}h of silence\n`);

const bySource = new Map();
for (const f of files) {
  let parsed;
  try {
    parsed = parseLocationFile(f, readFileSync(path.join(IMPORT_DIR, f), 'utf8'));
  } catch (err) {
    console.error(`  skipping ${f}: ${err.message}`);
    continue;
  }
  if (!parsed.points.length) {
    console.error(`  skipping ${f}: ${parsed.error ?? 'no coordinates found'}`);
    continue;
  }
  const group = bySource.get(parsed.source) ?? [];
  group.push(...parsed.points);
  bySource.set(parsed.source, group);
  console.log(`  ${f}: ${n(parsed.points.length)} fixes → ${sourceLabel(parsed.source)}`);
}
if (!bySource.size) process.exit(1);

// --- Compare, then (maybe) write ---------------------------------------------

const before = db.prepare(
  'SELECT source, COUNT(*) cells, COALESCE(SUM(hits), 0) hits FROM cell_sources WHERE user_id = ? GROUP BY source',
).all(user.id);
const had = new Map(before.map((r) => [r.source, r]));

// The same two statements the API's importer uses, for the same reason: a
// re-import replaces its own rows rather than adding to them, and a real
// reading takes the place of the 'unknown' placeholder left by the migration
// that predates provenance.
const upsert = db.prepare(`
  INSERT INTO cell_sources(user_id, cell_id, source, added_at, first_at, last_at, hits, fixes)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, cell_id, source) DO UPDATE SET
    first_at = excluded.first_at, last_at = excluded.last_at,
    hits = excluded.hits, fixes = excluded.fixes
`);
const dropUnknown = db.prepare('DELETE FROM cell_sources WHERE user_id = ? AND source = ? AND cell_id = ?');

const at = Math.floor(Date.now() / 1000);
const rows = [];
let unknownCleared = 0;
const seenUnknown = db.prepare(
  "SELECT 1 FROM cell_sources WHERE user_id = ? AND source = 'unknown' AND cell_id = ?",
);

console.log('\nsource            cells      visits now   →   after      change');
for (const [source, points] of bySource) {
  const cells = pointsToCells(points);
  const after = cells.reduce((s, c) => s + c.hits, 0);
  const was = had.get(source);
  for (const c of cells) {
    rows.push([source, c]);
    if (seenUnknown.get(user.id, c.id)) unknownCleared++;
  }
  const delta = was ? `${(((after - was.hits) / was.hits) * 100).toFixed(0)}%` : 'new';
  console.log(
    `${sourceLabel(source).padEnd(16)} ${String(n(cells.length)).padStart(7)} ${String(n(was?.hits ?? 0)).padStart(12)}   →   ${String(n(after)).padStart(7)} ${delta.padStart(11)}`,
  );
}

// Everything this cannot reach, said out loud rather than left to be noticed.
// A recount that quietly covers two thirds of a map and reports only the two
// thirds is the kind of half-answer this whole change exists to stop.
const POLLED = new Set(['home-assistant', 'strava', 'komoot']);
const untouched = before.filter((r) => !bySource.has(r.source));
if (untouched.length) {
  console.log('\nleft alone:');
  for (const r of untouched) {
    const why = r.source === 'unknown'
      ? 'dateless placeholders from before provenance — nothing to count'
      : r.source === 'manual'
        ? 'marked by hand, so it has no visits to count'
        : POLLED.has(r.source)
          ? 'fetched by the server, and converges as it keeps syncing'
          : `imported from a file that is not in ${path.basename(IMPORT_DIR)} any more — put it back to include it`;
    console.log(`  ${sourceLabel(r.source).padEnd(16)} ${String(n(r.cells)).padStart(7)} cells — ${why}`);
  }
}
console.log(
  unknownCleared
    ? `\n${n(unknownCleared)} placeholder 'unknown' rows would be replaced by a real reading.`
    : "\nNo 'unknown' placeholders overlap these files, so none are replaced.",
);

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to keep it.');
  process.exit(0);
}

db.exec('BEGIN');
try {
  for (const [source, c] of rows) {
    upsert.run(user.id, c.id, source, at, c.first, c.last, c.hits, c.fixes);
    if (source !== 'unknown') dropUnknown.run(user.id, 'unknown', c.id);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`\nNothing written — ${err.message}`);
  process.exit(1);
}

const total = db.prepare(
  'SELECT COUNT(*) cells, COALESCE(SUM(hits), 0) hits FROM cell_sources WHERE user_id = ?',
).get(user.id);
console.log(`\nWritten. ${n(total.cells)} rows, ${n(total.hits)} visits in total.`);
console.log('Restart the server so it re-derives the trips, coverage and calendar.');
