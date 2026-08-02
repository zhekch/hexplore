// The phone pushing its own position, and its workouts, through the real API.
//
// This is the one connector that pushes, and pushing brings a failure the
// pollers cannot have: the app does not know whether a batch landed. A 200 that
// is lost on the way back looks exactly like a timeout, and the queue is
// retried — so "the same fixes twice" is the *normal* case rather than the
// pathological one, and a map that counted them twice would quietly inflate
// every place you have been.
//
// Both guards against that are tested here, because both are arithmetic that
// looks right until it is run: the device cursor (fixes), and the remembered
// workout ids (activities). The seam between two batches of one continuous stay
// is the third — it is the same subtraction Home Assistant does, arrived at
// through a different door.
//
//   node scripts/test/device-sync.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointsToCells } from '../../src/locations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(got === want, label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-test-'));
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
async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

const DEVICE = { id: 'A1B2C3D4-5E6F-7081-9203-A4B5C6D7E8F9', name: "Zhenya's iPhone", platform: 'iOS 26.1' };
const push = (fixes, device = DEVICE) => api('POST', '/api/device/fixes', { device, fixes });

// Somewhere real, and small enough to stay inside one cell: cells are ~900 m
// across and these span about 60.
const LAT = 46.9481;
const LNG = 7.4474;
const T0 = Math.floor(Date.UTC(2026, 5, 3, 9, 0, 0) / 1000);
const DAY = 86400;
const at = (t, i = 0) => [LAT + i * 0.0002, LNG + i * 0.0002, t];

// The cell the fixes above land in, worked out with the very function the
// server uses — the lattice has its own tests (visits.mjs, hexgrid), and what
// is being checked here is the plumbing between them.
const CELL = pointsToCells([{ lat: LAT, lng: LNG, t: T0 }])[0].id;

/** Every stored row for one cell, keyed by source. */
async function rowsFor(cellId) {
  const { body } = await api('GET', '/api/cells');
  const out = {};
  for (const [id, sourceIndex, , first, last, hits, fixes] of body.rows) {
    if (id !== cellId) continue;
    out[body.sources[sourceIndex]] = { first, last, hits, fixes };
  }
  return out;
}

try {
  if (!(await waitForServer())) throw new Error(`server never came up:\n${serverErr}`);

  // --- Nobody gets in without an account -------------------------------------
  const anon = await push([at(T0)]);
  eq(anon.status, 401, 'a phone with no session is turned away');

  const reg = await api('POST', '/api/register', { username: 'phonetest', password: 'a-long-enough-pw' });
  eq(reg.status, 200, 'register');

  // --- The device has to say who it is ---------------------------------------
  eq((await push([at(T0)], { id: 'no' })).status, 400, 'a device id too short to be a UUID is refused');
  eq(
    (await push([at(T0)], { id: '../../../etc/passwd-and-then-some' })).status,
    400,
    'a device id with path separators in it is refused',
  );

  // --- One stay ---------------------------------------------------------------
  const first = await push([at(T0), at(T0 + 60, 1), at(T0 + 120, 2)]);
  eq(first.status, 200, 'the first push is accepted');
  eq(first.body.fixes, 3, 'all three fixes are taken');
  eq(first.body.cells, 1, 'and they are one cell');
  eq(first.body.cursor, T0 + 120, 'the cursor is the newest fix');

  let rows = await rowsFor(CELL);
  eq(rows.iphone?.hits, 1, 'three fixes minutes apart are one visit');
  eq(rows.iphone?.fixes, 3, 'and three fixes');
  eq(rows.iphone?.first, T0, 'the span starts at the first');
  eq(rows.iphone?.last, T0 + 120, 'and ends at the last');

  // --- The lost 200 -----------------------------------------------------------
  // The whole reason the cursor exists: the app never heard back, so it sends
  // the same batch again from the front of its queue.
  const again = await push([at(T0), at(T0 + 60, 1), at(T0 + 120, 2)]);
  eq(again.body.fixes, 0, 'a re-sent batch adds nothing');
  eq(again.body.skipped, 3, 'and says so rather than going quiet');
  rows = await rowsFor(CELL);
  eq(rows.iphone?.hits, 1, 'the visit is still one visit');
  eq(rows.iphone?.fixes, 3, 'and the fixes were not counted twice');

  // --- The seam ---------------------------------------------------------------
  // A second batch continuing the same stay. pointsToCells counts a visit per
  // batch, so without the subtraction in mergeRow this reads as two.
  const cont = await push([at(T0 + 180, 1), at(T0 + 240)]);
  eq(cont.body.fixes, 2, 'the continuation is taken');
  rows = await rowsFor(CELL);
  eq(rows.iphone?.hits, 1, 'a stay that straddles two pushes is still one visit');
  eq(rows.iphone?.fixes, 5, 'with all five fixes behind it');
  eq(rows.iphone?.last, T0 + 240, 'and a span that has moved on');

  // --- What a broken fix looks like -------------------------------------------
  const junk = await push([
    [0, 0, T0 + 2 * DAY], //                     the null island
    [95, 7.4, T0 + 2 * DAY], //                  off the top of the world
    [46.9, 7.4, Math.floor(Date.now() / 1000) + 400 * DAY], // a clock a year out
    [46.9, 7.4, 0], //                           no timestamp at all
    ['x', 'y', T0 + 2 * DAY], //                 not numbers
  ]);
  eq(junk.body.fixes, 0, 'nothing impossible is stored');
  eq(junk.body.cells, 0, 'and no cell is invented for it');
  eq(junk.body.cursor, T0 + 240, 'and a push of nothing does not move the cursor');

  // --- Coming back ------------------------------------------------------------
  const later = await push([at(T0 + 3 * DAY), at(T0 + 3 * DAY + 60, 1)]);
  eq(later.body.fixes, 2, 'a later visit is taken');
  rows = await rowsFor(CELL);
  eq(rows.iphone?.hits, 2, 'three days later is a second visit');
  eq(rows.iphone?.fixes, 7, 'and the fixes accumulate across all of them');

  // --- Apple Health -----------------------------------------------------------
  // A short ride. It wanders rather than running straight, because a straight
  // line is exactly what Douglas–Peucker throws away — simplifySegments would
  // reduce a ruled edge to its two ends, and then the thumbnail, the point
  // count and the length would all be testing nothing.
  const wStart = T0 + 10 * DAY;
  const line = Array.from({ length: 60 }, (_, i) => [
    LNG + i * 0.0012 + Math.sin(i / 4) * 0.0006,
    LAT + i * 0.0009 + Math.cos(i / 3) * 0.0005,
    wStart + i * 20,
  ]);
  const workout = {
    id: 'F0E1D2C3-B4A5-4697-8899-AABBCCDDEEFF',
    sport: 'cycling', //                          canonicalSport turns this into "Cycling"
    start: wStart,
    end: wStart + 60 * 20,
    elevUp: 84,
    segments: [line],
  };
  const w1 = await api('POST', '/api/device/workouts', { device: DEVICE, workouts: [workout] });
  eq(w1.status, 200, 'a workout is accepted');
  eq(w1.body.taken, 1, 'and taken in');
  eq(w1.body.routes, 1, 'and saved as a route');
  check(w1.body.cells > 1, 'a ride lights up more than one cell', `got ${w1.body.cells}`);

  const routes = await api('GET', '/api/routes?geom=1');
  const saved = routes.body.routes.find((r) => r.source === 'apple-health');
  check(!!saved, 'the route is filed under Apple Health');
  eq(saved?.sport, 'Cycling', 'the activity is spelled the way the rest of the app spells it');
  eq(saved?.sportGuessed, false, 'and is known rather than guessed, because Health said so');
  eq(saved?.elevUp, 84, "the barometer's ascent is kept, not re-derived from GPS");
  eq(saved?.firstAt, wStart, 'the route starts when the workout did');
  check((saved?.lengthM ?? 0) > 1000, 'and is measured', `got ${saved?.lengthM}`);
  check((saved?.thumb ?? '').split(' ').length > 10, 'with an outline for the list', `got "${saved?.thumb}"`);
  check((saved?.points ?? 0) > 10, 'and a line that survived simplification', `got ${saved?.points}`);

  const cellsAfterWorkout = (await api('GET', '/api/cells')).body.rows.length;

  // Sent again — a re-run of the same query after a reinstall, or a retry.
  const w2 = await api('POST', '/api/device/workouts', { device: DEVICE, workouts: [workout] });
  eq(w2.body.taken, 0, 'the same workout is not taken twice');
  eq(w2.body.known, 1, 'it is recognised instead');
  eq(w2.body.cells, 0, 'and lights up no cells the second time');
  eq(
    (await api('GET', '/api/cells')).body.rows.length,
    cellsAfterWorkout,
    'so the row count is unchanged',
  );

  // --- A pause is not a straight line -----------------------------------------
  // The app splits a route wherever the watch stopped recording, so a paused
  // workout arrives as two segments rather than one. What must not happen is
  // the gap being measured, drawn or joined up: Apple's own Fitness app draws
  // that stretch dotted, because it knows it did not record it.
  const pStart = T0 + 20 * DAY;
  const leg = (lng0, lat0, t0) =>
    Array.from({ length: 40 }, (_, i) => [lng0 + i * 0.0003, lat0 + i * 0.0002, t0 + i * 20]);
  const paused = {
    id: '11112222-3333-4444-5555-666677778888',
    sport: 'walking',
    start: pStart,
    end: pStart + 5400,
    // Two legs about 15 km apart, with an hour of nothing in between.
    segments: [leg(LNG, LAT, pStart), leg(LNG + 0.2, LAT + 0.05, pStart + 4200)],
  };
  const wp = await api('POST', '/api/device/workouts', { device: DEVICE, workouts: [paused] });
  eq(wp.body.taken, 1, 'a paused workout is taken');
  const pausedRoute = (await api('GET', '/api/routes?geom=1')).body.routes.find(
    (r) => r.firstAt === pStart,
  );
  eq(pausedRoute?.geom?.length, 2, 'and stays two lines rather than becoming one');
  // Each leg is roughly 1.5 km. Joined, the jump alone would be ~15 km.
  check(
    (pausedRoute?.lengthM ?? 0) < 6000,
    'the gap is not counted as distance walked',
    `got ${pausedRoute?.lengthM} m`,
  );

  // --- A fix that stood alone --------------------------------------------------
  // The app sends a one-point segment when a fix survived the accuracy check but
  // nothing near it did — a stale position from before the watch got a lock.
  // There is no line to draw, and there must be no cell either: one bad fix is
  // enough to put a place you have never been on the map.
  const strayLat = 46.7580; //   Thun, about 25 km away
  const strayLng = 7.6280;
  const strayCell = pointsToCells([{ lat: strayLat, lng: strayLng, t: T0 }])[0].id;
  const runStart = T0 + 25 * DAY;
  const ws = await api('POST', '/api/device/workouts', {
    device: DEVICE,
    workouts: [{
      id: '99998888-7777-6666-5555-444433332222',
      sport: 'running',
      start: runStart,
      end: runStart + 800,
      segments: [
        // Stamped 23 minutes before the workout began, which is what a fix left
        // over from wherever the watch last had a lock looks like.
        [[strayLng, strayLat, runStart - 1400]],
        leg(LNG, LAT, runStart),
      ],
    }],
  });
  eq(ws.body.taken, 1, 'a workout with one stray fix in it is still taken');
  // The only Running among the test's routes; the others are Cycling and Walking.
  const strayRoute = (await api('GET', '/api/routes?geom=1')).body.routes.find(
    (r) => r.sport === 'Running',
  );
  eq(strayRoute?.geom?.length, 1, 'the lone fix is no part of the line');
  // The bug this pins: buildRoute takes firstAt as the earliest point it is
  // given, so a stray fix stamped before the workout began used to drag the
  // start back with it — a 14-minute walk that reported 37.
  eq(strayRoute?.firstAt, runStart, 'and does not drag the start time back to when it was taken');
  eq(
    Object.keys(await rowsFor(strayCell)).length,
    0,
    'and marks no cell — a fix nothing corroborates is not a place anyone went',
  );

  // A workout with nothing to draw. The app filters these out — this is the
  // same rule on the other side of the wire.
  const w3 = await api('POST', '/api/device/workouts', {
    device: DEVICE,
    workouts: [
      { id: 'no-route-1', sport: 'yoga', start: wStart, end: wStart + 600, segments: [] },
      { id: 'no-route-2', sport: 'strength training', start: wStart, end: wStart + 600 },
    ],
  });
  eq(w3.body.taken, 0, 'a workout with no geography is not a place anyone went');
  eq(w3.body.skipped, 2, 'and is reported as skipped');

  // --- What the sync screen shows ---------------------------------------------
  const status = await api('GET', '/api/device');
  const dev = status.body.devices[0];
  eq(status.body.devices.length, 1, 'one phone is listed');
  eq(dev?.name, "Zhenya's iPhone", 'under the name it gave');
  eq(dev?.totalFixes, 7, 'with every fix it has ever sent');
  eq(dev?.totalWorkouts, 3, 'and the workouts it brought');
  eq(dev?.cursor, T0 + 3 * DAY + 60, 'and how far it has got');
  check(dev?.firstSeen > 0 && dev?.lastSeen >= dev?.firstSeen, 'and when it started and last spoke');

  // A Health-only push must not blank what the logger last reported.
  eq(dev?.lastFixes, 2, 'a workout sync leaves the last location push on the board');

  // --- Reading Health again ----------------------------------------------------
  // The one destructive call, and the reason it has to exist: remembered ids
  // mean a workout stored from a bad reading can never be corrected, and merged
  // cells mean re-taking it on top would count every visit twice. So a re-read
  // needs the old copy gone. What it must not touch is anybody else's rows.
  const beforeReset = await rowsFor(CELL);
  check(!!beforeReset.iphone, 'the logger has rows on this cell before the reset');

  const reset = await api('POST', '/api/device/health/reset');
  eq(reset.status, 200, 'the reset is accepted');
  check(reset.body.routes >= 3, 'it drops the Apple Health routes', `got ${reset.body.routes}`);
  check(reset.body.cells > 0, 'and their cells', `got ${reset.body.cells}`);
  check(reset.body.workouts >= 3, 'and forgets the workout ids', `got ${reset.body.workouts}`);

  const afterReset = await rowsFor(CELL);
  eq(afterReset.iphone?.hits, beforeReset.iphone?.hits, 'the logger’s own rows are untouched');
  eq(
    (await api('GET', '/api/routes')).body.routes.filter((r) => r.source === 'apple-health').length,
    0,
    'and no Apple Health route is left',
  );

  // Which is the whole point: the same workout can now be taken again.
  const redo = await api('POST', '/api/device/workouts', { device: DEVICE, workouts: [workout] });
  eq(redo.body.taken, 1, 'so the same workout is taken again rather than recognised');
  eq(redo.body.known, 0, 'with nothing remembered against it');

  // --- Forgetting it ----------------------------------------------------------
  const forgotten = await api('POST', '/api/device/forget', { id: DEVICE.id });
  eq(forgotten.body.devices.length, 0, 'forgetting a phone drops it from the list');
  rows = await rowsFor(CELL);
  eq(rows.iphone?.hits, 2, 'and leaves the cells it brought, which came from real fixes');
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
