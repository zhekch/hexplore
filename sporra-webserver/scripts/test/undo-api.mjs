// The two server-side halves of Undo, and the backup endpoints, over real HTTP.
//
// Undo is only as good as what it can put back. Clearing a cell drops every
// source's claim on it — the dates, the visit counts, which app it came from —
// so undoing that has to restore *rows*, not ids, and a route that comes back
// without its geometry is a name with nothing under it. Both of those are
// server behaviour, and both are the kind of thing that looks fine in the page
// until you reload it, so they're checked here against the actual API.
//
// The backup endpoints are here for the part no unit test can see: that they
// belong to the account that made the map and answer 403 to anyone else.
//
//   node scripts/test/undo-api.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3187;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-undo-test-'));
const backupDir = path.join(dir, 'backups');
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(dir, 'test.db'),
    BACKUP_DIR: backupDir,
    ALLOW_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
let serverOut = '';
server.stderr.on('data', (b) => {
  serverErr += b.toString();
});
server.stdout.on('data', (b) => {
  serverOut += b.toString();
});

// Wait for *our* server, not for something answering on that port.
//
// Worth the extra care: a forgotten dev server left listening here makes every
// request succeed against whatever code it happens to be running, and the test
// then reports failures in endpoints that are perfectly fine. So this waits for
// the child's own startup line and gives up the moment the child dies — which
// is what an already-taken port looks like from here.
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) {
      throw new Error(`the test server exited (${server.exitCode}) — is port ${PORT} already in use?\n${serverErr}`);
    }
    if (serverOut.includes(`localhost:${PORT}`)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the test server never announced itself:\n${serverOut}\n${serverErr}`);
}

// Two accounts, two cookie jars: the second one exists only to be told no.
const jars = { owner: '', other: '' };
let who = 'owner';
async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jars[who] ? { Cookie: jars[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars[who] = setCookie.split(';')[0];
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* the download answers with a database, not with JSON */
  }
  return { status: res.status, body: parsed, text, res };
}

const geom = [Array.from({ length: 40 }, (_, i) => [7.44 + i * 0.001, 46.94 + i * 0.0008])];

try {
  await waitForServer();
  check((await api('POST', '/api/register', { username: 'owner', password: 'a-long-enough-pw' })).status === 200, 'register the owner');

  // --- Putting cleared cells back -------------------------------------------
  console.log('\nundoing a clear');
  // An imported cell, with everything an import knows about it.
  await api('POST', '/api/cells/import', {
    source: 'google-timeline',
    cells: [['0/100/200', 1600000000, 1700000000, 12, 480]],
  });
  const beforeRows = (await api('GET', '/api/cells')).body;
  const before = beforeRows.rows.find((r) => r[0] === '0/100/200');
  check(!!before, 'the imported cell is there');

  await api('POST', '/api/cells/mutate', { add: [], remove: ['0/100/200'] });
  check(!(await api('GET', '/api/cells')).body.rows.some((r) => r[0] === '0/100/200'), 'clearing drops it');

  // What the page holds in cellMeta, handed straight back.
  const restore = await api('POST', '/api/cells/restore', {
    rows: [['0/100/200', 'google-timeline', before[2], before[3], before[4], before[5], before[6]]],
  });
  check(restore.status === 200 && restore.body.restored === 1, 'restore takes the row back', JSON.stringify(restore.body));

  const after = (await api('GET', '/api/cells')).body;
  const back = after.rows.find((r) => r[0] === '0/100/200');
  check(!!back, 'the cell is lit again');
  // The point of the whole endpoint: not "a cell", but *that* cell.
  check(after.sources[back[1]] === 'google-timeline', 'still from Google Timeline, not a manual mark', after.sources[back[1]]);
  check(back[3] === 1600000000 && back[4] === 1700000000, 'with its dates');
  check(back[5] === 12 && back[6] === 480, 'and its visit and fix counts', `${back[5]} visits, ${back[6]} fixes`);
  check(back[2] === before[2], 'and the day it first landed on the map — an old cell does not come back as new');

  const tooMany = await api('POST', '/api/cells/restore', { rows: Array(50001).fill(['0/1/1', 'manual', 1, 0, 0, 1, 0]) });
  check(tooMany.status === 400, 'a restore of everything at once is refused', String(tooMany.status));

  // --- Putting a deleted route back ------------------------------------------
  console.log('\nundoing a route delete');
  await api('POST', '/api/routes', {
    routes: [{ key: 'undo-test-key', name: 'Thunersee loop', place: 'Thun', sport: 'Cycling', source: 'komoot', geom, lengthM: 4200, elevUp: 61, firstAt: 1700000000, lastAt: 1700007200 }],
  });
  const listed = (await api('GET', '/api/routes')).body.routes;
  check(listed.length === 1, 'the route is saved');

  const del = await api('POST', '/api/routes/delete', { id: listed[0].id });
  check(del.status === 200 && del.body.removed === 1, 'deleting it works');
  // Without this the page has a name and nothing to draw: the routes layer is
  // lazy, so the line may never have been loaded in the first place.
  check(!!del.body.route, 'and the answer carries the whole row away with it');
  check(del.body.route.geom?.[0]?.length === 40, 'geometry included', String(del.body.route.geom?.[0]?.length));
  check(!!del.body.route.key, 'and the key it was stored under');

  const put = await api('POST', '/api/routes', { routes: [del.body.route] });
  check(put.status === 200 && put.body.added === 1, 'undo puts it back');
  const again = (await api('GET', '/api/routes?geom=1')).body.routes;
  check(again.length === 1, 'one route again');
  check(again[0].name === 'Thunersee loop' && again[0].place === 'Thun', 'with its name and place');
  check(again[0].sport === 'Cycling' && again[0].elevUp === 61, 'its activity and its climb');
  check(again[0].geom?.[0]?.length === 40, 'and the line itself', String(again[0].geom?.[0]?.length));

  // --- Backups ---------------------------------------------------------------
  console.log('\nbackups');
  const status = (await api('GET', '/api/backup')).body.backup;
  check(!!status && status.enabled === true, 'they are on by default', JSON.stringify(status?.enabled));
  check(status.cron === '0 4 * * *', 'every day at 04:00', status.cron);
  check(status.description === 'At 04:00 every day', 'described in words for the dialog', status.description);
  check(status.nextRun > Math.floor(Date.now() / 1000), 'with a next run in the future');

  const saved = (await api('POST', '/api/backup', { cron: '0 */6 * * *', keep: 5, enabled: true })).body.backup;
  check(saved.cron === '0 */6 * * *' && saved.keep === 5, 'the schedule can be changed');
  check(saved.description === 'Every 6 hours, at :00', 'and is described back', saved.description);
  const bad = await api('POST', '/api/backup', { cron: 'whenever' });
  check(bad.status === 400 && /five fields/.test(bad.body.error ?? ''), 'nonsense is refused in words', JSON.stringify(bad.body));

  const ran = await api('POST', '/api/backup/run');
  check(ran.status === 200 && ran.body.status === 'saved', 'a backup can be taken now', JSON.stringify(ran.body?.status));
  check((await readdir(backupDir)).some((f) => f === ran.body.file), 'and the file is on disk', ran.body.file);
  const twice = await api('POST', '/api/backup/run');
  check(twice.body.status === 'unchanged', 'a second one right after says nothing changed', JSON.stringify(twice.body?.reason));

  const dl = await api('GET', `/api/backup/download?name=${ran.body.file}`);
  check(dl.status === 200, 'a backup can be downloaded');
  check(dl.text.startsWith('SQLite format 3'), 'and what comes back is a database', dl.text.slice(0, 15));
  check(dl.res.headers.get('content-disposition')?.includes(ran.body.file), 'offered as a file, under its own name');
  for (const name of ['../data.db', 'data.db', '..%2Fdata.db', 'visited-map-2026-01-01-000000.db']) {
    const bad2 = await api('GET', `/api/backup/download?name=${encodeURIComponent(name)}`);
    check(bad2.status === 400 || bad2.status === 404, `"${name}" is not downloadable`, String(bad2.status));
  }

  // --- Whose backups they are ------------------------------------------------
  console.log('\nwho may touch them');
  who = 'other';
  await api('POST', '/api/register', { username: 'someone-else', password: 'a-long-enough-pw' });
  check((await api('GET', '/api/me')).body.username === 'someone-else', 'a second account exists');
  check((await api('GET', '/api/backup')).status === 403, 'it cannot read the backup settings');
  check((await api('POST', '/api/backup', { enabled: false })).status === 403, 'or change them');
  check((await api('POST', '/api/backup/run')).status === 403, 'or take one');
  check((await api('GET', `/api/backup/download?name=${ran.body.file}`)).status === 403, 'or download the whole map');
  // Its own cells are still its own business.
  check((await api('POST', '/api/cells/restore', { rows: [['0/5/5', 'manual', 0, 0, 0, 1, 0]] })).status === 200, 'but restoring its own cells is fine');
  check(!(await api('GET', '/api/cells')).body.rows.some((r) => r[0] === '0/100/200'), 'and it did not inherit the owner’s');

  who = 'owner';
  check((await api('GET', '/api/backup')).status === 200, 'the owner still gets in');
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
