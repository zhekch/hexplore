// Closing an account, through the real HTTP API.
//
// Two things are being checked, and the second is the one that will still be
// earning its keep in a year.
//
// **That it deletes everything.** There are no foreign keys in this database,
// so nothing cascades: `DELETE FROM users` on its own leaves the cells, the
// routes, the connections and the remembered workouts behind, attached to an id
// that no longer belongs to anybody. So the account is filled with a row in
// every table first, and the check afterwards is that not one of them survived.
//
// **That the list of tables is still complete.** `USER_TABLES` in
// server/index.js is written out by hand, and the failure mode of a hand-written
// list is a table added six months later that nobody thinks to add to it —
// which is silent, because deleting an account still *looks* like it worked.
// So this reads `PRAGMA table_info` for every table in the live schema and
// fails if one carries a user_id the server would not have cleared. That check
// is why this file exists; the rest is the ordinary path.
//
//   node scripts/test/account-delete.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3207;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-test-'));
const DB = path.join(dir, 'test.db');
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ALLOW_REGISTRATION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (b) => {
  serverErr += b.toString();
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

const jar = new Map();
async function api(method, url, body, who = 'a') {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.has(who) ? { Cookie: jar.get(who) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar.set(who, setCookie.split(';')[0]);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

try {
  if (!(await waitForServer())) throw new Error(`server never came up: ${serverErr}`);

  // --- The list of tables is the whole safety net, so check it first ----------
  console.log('\nevery table with a user_id is cleared');
  const source = await readFile(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const listed = new Set(
    (source.match(/const USER_TABLES = \[([\s\S]*?)\]/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );
  check(listed.size > 0, 'USER_TABLES is readable from the server source', `${listed.size} tables`);

  const db = new DatabaseSync(DB);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const withUserId = tables.filter((t) =>
    db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'user_id'));
  // `users` keys on `id`, not `user_id`, and is deleted separately.
  const missing = withUserId.filter((t) => !listed.has(t));
  check(missing.length === 0, 'no table in the schema carries a user_id the delete would miss',
    missing.length ? `missed: ${missing.join(', ')}` : '');
  const stale = [...listed].filter((t) => !withUserId.includes(t));
  check(stale.length === 0, 'and none of the listed tables has since gone away',
    stale.length ? `listed but absent: ${stale.join(', ')}` : '');
  check(withUserId.length >= 9, 'the schema really does have that many', `${withUserId.length} tables`);

  // --- Fill an account with something in every one of them -------------------
  console.log('\nan account with a row in every table');
  await api('POST', '/api/register', { username: 'doomed', password: 'correct-horse' });
  // A second account, whose data must be untouched by the first one leaving.
  await api('POST', '/api/register', { username: 'bystander', password: 'battery-staple' }, 'b');

  await api('POST', '/api/cells/import', {
    source: 'manual',
    cells: [['8/4/9', 1700000000, 1700000100, 1, 3], ['8/4/10', 1700000200, 1700000300, 1, 2]],
  });
  await api('POST', '/api/prefs', { prefs: { accent: '#ff0000' } });
  await api('POST', '/api/routes', {
    routes: [{
      key: 'doomedroute1', name: 'A ride', source: 'gpx', firstAt: 1700000000, lastAt: 1700003600,
      lengthM: 9000, points: 3, bbox: [7.4, 46.9, 7.5, 47.0], sport: 'Cycling',
      geom: [[[7.4, 46.9], [7.45, 46.95], [7.5, 47.0]]],
    }],
  });
  await api('POST', '/api/ha', {
    baseUrl: 'http://homeassistant.local:8123', token: 'x'.repeat(40), entities: ['person.someone'],
  });
  await api('POST', '/api/strava', { clientId: '12345', clientSecret: 'shh' });
  await api('POST', '/api/device/fixes', {
    device: { id: 'device-uuid-1', name: 'iPhone', platform: 'ios' },
    fixes: [[46.95, 7.45, 1700000000], [46.96, 7.46, 1700000600]],
  });
  // Ten seconds and ~33 m apart: `splitOnGaps` cuts a track wherever two fixes
  // are far apart in both time and space, and a workout cut into single points
  // is not a line and lands nowhere.
  const track = Array.from({ length: 8 }, (_, i) => [7.45, 46.95 + i * 0.0003, 1700010000 + i * 10]);
  await api('POST', '/api/device/workouts', {
    device: { id: 'device-uuid-1', name: 'iPhone', platform: 'ios' },
    workouts: [{ id: 'workout-uuid-1', sport: 'Running', segments: [track] }],
  });

  const rowsFor = (id) => Object.fromEntries([...listed].map((t) =>
    [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(id).n]));
  const doomedId = db.prepare('SELECT id FROM users WHERE username = ?').get('doomed').id;
  const bystanderId = db.prepare('SELECT id FROM users WHERE username = ?').get('bystander').id;

  // `cell_sets` is the pre-provenance blob. Nothing has written it since cells
  // grew per-source rows, so it is put there by hand — a table the app no
  // longer fills is exactly the kind the delete would be quietly wrong about,
  // and one an old account on a long-lived database still has a row in.
  db.prepare('INSERT INTO cell_sets(user_id, data, updated_at) VALUES(?, ?, ?)')
    .run(doomedId, '["8/4/9"]', new Date().toISOString());
  db.prepare('INSERT INTO cell_sets(user_id, data, updated_at) VALUES(?, ?, ?)')
    .run(bystanderId, '["8/9/4"]', new Date().toISOString());

  const before = rowsFor(doomedId);
  const emptyBefore = Object.entries(before).filter(([, n]) => !n).map(([t]) => t);
  check(emptyBefore.length === 0, 'every table has at least one row to delete',
    emptyBefore.length ? `nothing in: ${emptyBefore.join(', ')}` : JSON.stringify(before));
  const bystanderBefore = rowsFor(bystanderId);

  // --- The password is the gate ----------------------------------------------
  console.log('\nthe password is asked for again');
  const noPw = await api('POST', '/api/account/delete', {});
  check(noPw.status === 403, 'a live session alone is not enough', `got ${noPw.status}`);
  const wrongPw = await api('POST', '/api/account/delete', { password: 'not-it' });
  check(wrongPw.status === 403, 'and neither is the wrong password', `got ${wrongPw.status}`);
  check(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(doomedId).n === 1,
    'the account is still there after a refused attempt');
  const anon = await fetch(`${BASE}/api/account/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-horse' }),
  });
  check(anon.status === 401, 'and a caller with no session at all gets 401', `got ${anon.status}`);

  // --- The delete itself -----------------------------------------------------
  console.log('\nand then it takes everything');
  const done = await api('POST', '/api/account/delete', { password: 'correct-horse' });
  check(done.status === 200, 'the right password is accepted', `got ${done.status}: ${JSON.stringify(done.data)}`);
  check(done.data?.username === 'doomed', 'the answer names the account it closed');
  check(done.data?.removed?.cell_sources >= 2 && done.data?.removed?.routes >= 1,
    'and reports what it removed', JSON.stringify(done.data?.removed));

  const after = rowsFor(doomedId);
  const left = Object.entries(after).filter(([, n]) => n).map(([t, n]) => `${t}=${n}`);
  check(left.length === 0, 'not one row survives in any table',
    left.length ? `left behind: ${left.join(', ')}` : '');
  check(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(doomedId).n === 0,
    'and the account row is gone');

  console.log('\nwhat it does not touch');
  const bystanderAfter = rowsFor(bystanderId);
  check(JSON.stringify(bystanderAfter) === JSON.stringify(bystanderBefore),
    'the other account on this map is untouched', JSON.stringify(bystanderAfter));
  check(db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('bystander').n === 1,
    'and is still signed in on its own session');
  const stillThere = await api('GET', '/api/me', undefined, 'b');
  check(stillThere.status === 200 && stillThere.data?.username === 'bystander',
    'and its session still works', `got ${stillThere.status}`);

  console.log('\nthe session goes with it');
  const dead = await api('GET', '/api/me');
  check(dead.status === 401, 'the cookie it was holding is no longer a session', `got ${dead.status}`);
  const relogin = await api('POST', '/api/login', { username: 'doomed', password: 'correct-horse' });
  check(relogin.status === 401, 'and the username cannot be logged into any more', `got ${relogin.status}`);
  // Freed rather than reserved: the name is nobody's now.
  const retaken = await api('POST', '/api/register', { username: 'doomed', password: 'a-new-one-entirely' }, 'c');
  check(retaken.status === 200, 'the name is free to be registered again', `got ${retaken.status}`);
  const fresh = db.prepare('SELECT id FROM users WHERE username = ?').get('doomed');
  const inherited = rowsFor(fresh.id);
  // Its own registration session is the one row it is entitled to. Everything
  // else being zero is the point: ids come from AUTOINCREMENT so this is a new
  // number today, but a row left behind under an old one is a row waiting for
  // the day it isn't.
  check(inherited.sessions === 1, 'the new account has its own session and no more',
    `sessions=${inherited.sessions}`);
  const ghosts = Object.entries(inherited)
    .filter(([t, n]) => t !== 'sessions' && n).map(([t, n]) => `${t}=${n}`);
  check(ghosts.length === 0, 'and inherits none of the old account\'s data',
    ghosts.length ? `inherited: ${ghosts.join(', ')}` : '');

  db.close();
} catch (err) {
  check(false, 'the test itself ran', err?.message ?? String(err));
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
