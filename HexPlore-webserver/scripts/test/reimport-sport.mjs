// Re-importing a file whose activity the app had only guessed at.
//
// The question: a route is on the map with an activity worked out from its pace
// (or backfilled by the one-time migration), and then the original file — which
// *does* state what it was — is dropped in again. The file has to win, and the
// "(estimated)" flag has to come off with it.
//
// This goes through the real path rather than posting hand-written JSON: GPX
// text → parseLocationFile → buildRoutes → POST /api/routes, so a break
// anywhere between the parser and the column is caught.
//
//   node scripts/test/reimport-sport.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocationFile } from '../../src/locations.js';
import { buildRoutes } from '../../src/routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// The same ride twice: identical track points (so it keys to the same route),
// once with no <type> and once with the activity the file always knew.
function gpx({ type }) {
  const start = Date.UTC(2026, 4, 4, 9, 0, 0);
  const pts = Array.from({ length: 260 }, (_, i) => {
    const t = new Date(start + i * 20000).toISOString();
    // ~20 km/h — squarely in the band the guesser calls Cycling.
    return `<trkpt lat="${(46.94 + i * 0.001).toFixed(6)}" lon="${(7.44 + i * 0.0013).toFixed(6)}">`
      + `<ele>${560 + (i % 40)}</ele><time>${t}</time></trkpt>`;
  }).join('');
  return `<?xml version="1.0"?><gpx version="1.1" creator="SomeWatch"><trk><name>Morning outing</name>`
    + `${type ? `<type>${type}</type>` : ''}<trkseg>${pts}</trkseg></trk></gpx>`;
}

const routesFrom = (text, name) => {
  const parsed = parseLocationFile(name, text);
  return buildRoutes(parsed.tracks, { source: parsed.source, fileName: name });
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-reimport-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), ALLOW_REGISTRATION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (b) => {
  serverErr += b.toString();
});

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res.json().catch(() => null);
}

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) throw new Error(`server never came up:\n${serverErr}`);
  await api('POST', '/api/register', { username: 'reimport', password: 'a-long-enough-pw' });

  // --- 1. The file says nothing, so the app works it out from the pace -------
  const silent = routesFrom(gpx({ type: null }), 'ride.gpx');
  check(silent.length === 1, 'the file parsed to one route', `got ${silent.length}`);
  check(silent[0]?.sportGuessed === true, 'with no <type>, the activity is a guess',
    `sport="${silent[0]?.sport}" guessed=${silent[0]?.sportGuessed}`);
  check(silent[0]?.sport === 'Cycling', 'and the guess is Cycling', `got "${silent[0]?.sport}"`);
  await api('POST', '/api/routes', { routes: silent });

  let stored = (await api('GET', '/api/routes')).routes[0];
  check(stored?.sportGuessed === true, 'stored as a guess', `guessed=${stored?.sportGuessed}`);

  // --- 2. The same ride, from a file that does say -------------------------
  // Deliberately an activity the pace-guesser would never produce for a 20 km/h
  // track, so "the file won" is actually observable rather than a coincidence.
  const stated = routesFrom(gpx({ type: 'mtb' }), 'ride.gpx');
  check(stated[0]?.key === silent[0]?.key, 'the same track keys to the same route',
    `${silent[0]?.key} vs ${stated[0]?.key}`);
  check(stated[0]?.sportGuessed === false, 'a stated <type> is not a guess',
    `sport="${stated[0]?.sport}" guessed=${stated[0]?.sportGuessed}`);

  const redo = await api('POST', '/api/routes', { routes: stated });
  check(redo?.added === 0 && redo?.updated === 1, 're-import updates, does not duplicate',
    `added=${redo?.added} updated=${redo?.updated}`);

  const all = (await api('GET', '/api/routes')).routes;
  check(all.length === 1, 'still one route', `got ${all.length}`);
  stored = all[0];
  check(stored.sport === 'Mountain cycling', 'THE FILE WON: the guess was replaced by what it states',
    `got "${stored.sport}"`);
  check(stored.sportGuessed === false, 'and it is no longer flagged as estimated',
    `guessed=${stored.sportGuessed}`);

  // --- 3. A guess must not overwrite a stated value on the way back ---------
  await api('POST', '/api/routes', { routes: silent }); // the type-less file again
  stored = (await api('GET', '/api/routes')).routes[0];
  check(stored.sport === 'Mountain cycling' && stored.sportGuessed === false,
    'importing the type-less file again does not undo it',
    `sport="${stored.sport}" guessed=${stored.sportGuessed}`);

  // --- 3b. A better-informed guess replaces a poorer one --------------------
  // The backfill that filled these in worked from the length, the clock and the
  // name; parsing the file also sees the elevation track. So when both sides are
  // guesses, the one that came from the file wins — otherwise a route the server
  // called a "Walk" stays a Walk even after you hand it the file showing 900 m
  // of climb.
  const walk = routesFrom(
    (() => {
      const start = Date.UTC(2026, 4, 6, 8, 0, 0);
      // 4 km/h — a walk by pace — but climbing steadily, which makes it a hike.
      const pts = Array.from({ length: 200 }, (_, i) => {
        const t = new Date(start + i * 60000).toISOString();
        return `<trkpt lat="${(47.1 + i * 0.0006).toFixed(6)}" lon="${(8.0 + i * 0.0002).toFixed(6)}">`
          + `<ele>${600 + i * 5}</ele><time>${t}</time></trkpt>`;
      }).join('');
      return `<?xml version="1.0"?><gpx version="1.1"><trk><name>Sunday out</name><trkseg>${pts}</trkseg></trk></gpx>`;
    })(),
    'sunday.gpx',
  );
  check(walk[0]?.sport === 'Hiking' && walk[0]?.sportGuessed === true,
    'the file-side guess uses elevation and says Hiking',
    `sport="${walk[0]?.sport}" guessed=${walk[0]?.sportGuessed}`);

  // Stand in for the server backfill: the same route, guessed "Walk" from pace
  // alone because no elevation was stored to look at.
  await api('POST', '/api/routes', {
    routes: [{ ...walk[0], sport: 'Walking', sportGuessed: true, elevUp: 0 }],
  });
  let hill = (await api('GET', '/api/routes')).routes.find((r) => r.name === 'Sunday out');
  check(hill?.sport === 'Walking', 'stored as the poorer guess to begin with', `got "${hill?.sport}"`);

  await api('POST', '/api/routes', { routes: walk });
  hill = (await api('GET', '/api/routes')).routes.find((r) => r.name === 'Sunday out');
  check(hill?.sport === 'Hiking', 'the file-side guess replaces the poorer one', `got "${hill?.sport}"`);
  check(hill?.elevUp > 900, 'and the climb it was missing came with it', `got ${hill?.elevUp}`);

  // --- 4. Nor may either overwrite what you chose yourself -------------------
  // By id, not by position: the list is newest-first and there are two routes
  // in it now.
  const rideId = (await api('GET', '/api/routes')).routes.find((r) => r.name === 'Morning outing')?.id;
  await api('POST', '/api/routes/update', { id: rideId, sport: 'Ski touring' });
  await api('POST', '/api/routes', { routes: stated });
  const ride = (await api('GET', '/api/routes')).routes.find((r) => r.id === rideId);
  check(ride?.sport === 'Ski touring', 'an activity you set by hand survives a re-import',
    `got "${ride?.sport}"`);
  check(ride?.sportGuessed === false, 'and stays a fact, not a guess', `guessed=${ride?.sportGuessed}`);
} catch (e) {
  check(false, 'test run', e.message);
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
