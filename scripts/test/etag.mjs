// Conditional GETs on the per-account reads.
//
// The point of an ETag here is that a map of 25,000 cells is a megabyte of JSON
// that almost never changes, so the interesting cases are not "does it send a
// tag" but the two ways a tag can lie:
//
//   • **too sticky** — the answer changed and the tag didn't, so the client is
//     told 304 and goes on showing the old one. Both real instances of this are
//     pinned below: renaming a route (which moves none of the aggregates the
//     signature is built from) and setting your home (which is an input to
//     every trip and is not a row at all).
//   • **too loose** — the answer didn't change and the tag did, so nothing is
//     ever a 304 and the whole exercise was for nothing. Hence the checks that
//     a repeat read matches, and that a route edit leaves the *cells* alone.
//
//   node scripts/test/etag.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-etag-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), ALLOW_REGISTRATION: '1' },
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

let cookie = '';
async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return {
    status: res.status,
    etag: res.headers.get('etag'),
    cacheControl: res.headers.get('cache-control'),
    text,
    body: text ? JSON.parse(text) : null,
  };
}

/** Read it, then read it again saying what we already have. */
async function revalidate(url) {
  const first = await api('GET', url);
  const second = await api('GET', url, undefined, { 'If-None-Match': first.etag ?? '' });
  return { first, second };
}

const DAY = 86400;
const AUG = Math.floor(new Date('2024-08-10T09:00:00Z').getTime() / 1000);
// Somewhere you keep going back to, so the account has a home to have trips
// measured from; the ids are the ones scripts/test/derive.mjs uses.
const homeCells = Array.from({ length: 15 }, (_, i) => [`0/2000/${3000 + i}`, AUG - 200 * DAY + i * DAY, AUG - 10 * DAY, 40, 100]);
const awayCells = Array.from({ length: 20 }, (_, i) => [`0/1076/${6668 + i}`, AUG + i * 3600, AUG + i * 3600 + 600, 1, 9]);

const geom = [Array.from({ length: 40 }, (_, i) => [7.44 + i * 0.001, 46.94 + i * 0.0008])];

try {
  if (!(await waitForServer())) throw new Error(`server never came up:\n${serverErr}`);

  const reg = await api('POST', '/api/register', { username: 'etagtest', password: 'a-long-enough-pw' });
  check(reg.status === 200, 'register', `got ${reg.status} ${JSON.stringify(reg.body)}`);
  await api('POST', '/api/cells/import', { source: 'gpx', cells: [...homeCells, ...awayCells] });

  // --- The plain case ---------------------------------------------------------

  console.log('\na read that has not changed answers 304');
  {
    const { first, second } = await revalidate('/api/cells');
    check(first.status === 200 && !!first.etag, 'the first read carries an ETag', `status=${first.status} etag=${first.etag}`);
    check(/^W\//.test(first.etag ?? ''), 'weak, because a body may be gzipped or not', `got ${first.etag}`);
    // `If-None-Match` is a comma-separated list, so a tag holding one tears in
    // half on the way back and matches nothing. That is not a hypothetical: the
    // home coordinates were written "lng,lat" and every derived read silently
    // stopped revalidating.
    check(!first.etag?.includes(','), 'and holds no comma, which the header uses as a separator', `got ${first.etag}`);
    check(first.cacheControl === 'private, no-cache',
      'and may be stored but never used without asking', `got ${first.cacheControl}`);
    check(second.status === 304, 'the second read is told nothing changed', `got ${second.status}`);
    check(second.text === '', 'and carries no body at all', `got ${second.text.length} bytes`);
    check(second.etag === first.etag, 'the 304 repeats the tag', `${second.etag} vs ${first.etag}`);
  }

  console.log('\nand a read that has changed does not');
  {
    const before = await api('GET', '/api/cells');
    await api('POST', '/api/cells/mutate', { add: ['0/1076/6700'], remove: [] });
    const after = await api('GET', '/api/cells', undefined, { 'If-None-Match': before.etag });
    check(after.status === 200, 'marking a cell makes the next read a full one', `got ${after.status}`);
    check(after.etag !== before.etag, 'because the tag moved', `${after.etag} vs ${before.etag}`);
    check(after.body?.rows?.length === before.body.rows.length + 1, 'and the new cell is in it',
      `${after.body?.rows?.length} vs ${before.body.rows.length}`);
  }

  // --- Renaming a route: the edit the aggregates cannot see --------------------

  console.log('\nrenaming a route is a change, though it moves no total');
  {
    await api('POST', '/api/routes', {
      routes: [{ key: 'k1', name: 'Route', source: 'gpx', sport: 'Cycling', firstAt: AUG, lastAt: AUG + 3600, lengthM: 40000, geom }],
    });
    const before = await api('GET', '/api/routes');
    const id = before.body?.routes?.[0]?.id;
    check(!!id, 'the route saved', `got ${JSON.stringify(before.body)?.slice(0, 120)}`);

    const cellsBefore = await api('GET', '/api/cells');
    const rename = await api('POST', '/api/routes/update', { id, name: 'Thunersee loop' });
    check(rename.status === 200, 'renaming it succeeds', `got ${rename.status}`);

    // The count, the newest added_at and the total length are all exactly what
    // they were. Only reading the row itself can tell.
    const after = await api('GET', '/api/routes', undefined, { 'If-None-Match': before.etag });
    check(after.status === 200, 'the routes list is re-sent rather than 304', `got ${after.status}`);
    check(after.body?.routes?.[0]?.name === 'Thunersee loop', 'with the new name on it',
      `got ${after.body?.routes?.[0]?.name}`);

    // …and the cells, which the rename cannot possibly have touched, are not
    // dragged along with it. A shared tag would re-send a megabyte to say this.
    const cellsAfter = await api('GET', '/api/cells', undefined, { 'If-None-Match': cellsBefore.etag });
    check(cellsAfter.status === 304, 'while the cells are still 304', `got ${cellsAfter.status}`);
  }

  // --- Setting home: an input to every trip, and not a row at all --------------

  console.log('\nsetting home changes which trips there are');
  {
    const before = await api('GET', '/api/trips');
    check(before.status === 200 && Array.isArray(before.body?.trips), 'trips derive at all',
      `got ${before.status} ${JSON.stringify(before.body)?.slice(0, 120)}`);

    // Home moved onto the ground the trip was on: the week away is now a week
    // at home, so the list cannot be the same list.
    const moved = { lng: 8.28, lat: 46.95, name: 'Somewhere else' };
    const set = await api('POST', '/api/prefs', { prefs: { home: moved } });
    check(set.status === 200, 'the home is saved', `got ${set.status}`);

    const after = await api('GET', '/api/trips', undefined, { 'If-None-Match': before.etag });
    check(after.status === 200, 'the trips are re-derived rather than 304', `got ${after.status}`);
    check(after.body?.home?.lng === moved.lng && after.body?.home?.lat === moved.lat,
      'from the home that was set', `got ${JSON.stringify(after.body?.home)}`);
    check(JSON.stringify(after.body?.trips) !== JSON.stringify(before.body?.trips),
      'and the answer really is a different one', 'the trip list is unchanged');

    // Asking twice with the same home is still one derivation.
    const again = await api('GET', '/api/trips', undefined, { 'If-None-Match': after.etag });
    check(again.status === 304, 'asking again with nothing changed is a 304', `got ${again.status}`);
  }

  console.log('\nthe other derived reads carry tags too');
  {
    for (const url of ['/api/stats', '/api/days', '/api/day/2024-08-10']) {
      const { first, second } = await revalidate(url);
      check(first.status === 200 && !!first.etag && second.status === 304,
        `${url} revalidates`, `first=${first.status} etag=${first.etag} second=${second.status}`);
    }
    // Two days are two answers, so one tag must not stand for the other.
    const a = await api('GET', '/api/day/2024-08-10');
    const b = await api('GET', '/api/day/2024-08-11', undefined, { 'If-None-Match': a.etag });
    check(b.status === 200, 'and one day is not answered with another day’s tag', `got ${b.status}`);
  }

  console.log('\nnothing is served to someone without a session');
  {
    const saved = cookie;
    cookie = '';
    const res = await api('GET', '/api/cells', undefined, { 'If-None-Match': 'W/"anything"' });
    check(res.status === 401, 'a stranger holding a tag is still refused', `got ${res.status}`);
    cookie = saved;
  }
} catch (e) {
  check(false, 'test run', e.message);
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
