// Saving and reading routes back through the real HTTP API.
//
// This exists because of a bug that every other kind of test missed. Adding the
// `sport_guessed` column meant adding a bind to `insRoute`, and one of the two
// call sites silently didn't get it — so the geometry landed in the column
// before it and SQLite rejected the row with "NOT NULL constraint failed:
// routes.geom". Nothing caught it: the schema was right, the unit tests never
// touched SQL, and the server started perfectly. It took importing a real file
// in a browser to see it.
//
// So: start the actual server, POST an actual route, read it back, and check
// every field survived. Any future column added to `routes` will break this
// loudly the moment a bind is forgotten.
//
//   node scripts/test/routes-api.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

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

// A short but genuine line: two segments, real coordinates, enough points to survive.
const geom = [
  Array.from({ length: 40 }, (_, i) => [7.44 + i * 0.001, 46.94 + i * 0.0008]),
  Array.from({ length: 12 }, (_, i) => [7.5 + i * 0.001, 46.98 + i * 0.0008]),
];

try {
  if (!(await waitForServer())) throw new Error(`server never came up:\n${serverErr}`);

  const reg = await api('POST', '/api/register', { username: 'routetest', password: 'a-long-enough-pw' });
  check(reg.status === 200, 'register', `got ${reg.status} ${JSON.stringify(reg.body)}`);

  // Two routes: one whose activity was read from a file, one worked out from pace.
  const save = await api('POST', '/api/routes', {
    routes: [
      {
        key: 'k-known', name: 'Bern → Thun', place: 'Bern → Thun', source: 'komoot',
        sport: 'Cycling', sportGuessed: false, elevUp: 640,
        firstAt: 1746345600, lastAt: 1746358800, lengthM: 62700, geom,
      },
      {
        key: 'k-guessed', name: 'Hike', place: 'Frutigen', source: 'gpx',
        sport: 'Hike', sportGuessed: true, elevUp: 0,
        firstAt: 1746000000, lastAt: 1746020000, lengthM: 12000, geom,
      },
    ],
  });
  check(save.status === 200, 'POST /api/routes succeeds', `got ${save.status} ${JSON.stringify(save.body)}`);
  check(save.body?.added === 2, 'both routes were added', `added=${save.body?.added} skipped=${save.body?.skipped}`);

  const list = await api('GET', '/api/routes?geom=1');
  check(list.status === 200, 'GET /api/routes');
  const known = list.body?.routes?.find((r) => r.name === 'Bern → Thun');
  const guessed = list.body?.routes?.find((r) => r.name === 'Hike');

  check(!!known && !!guessed, 'both routes come back');
  if (known && guessed) {
    // The bind-order bug showed up exactly here: geometry ends up NULL, or a
    // value lands in the wrong column.
    check(Array.isArray(known.geom) && known.geom.length === 2, 'geometry survived as two segments',
      `got ${JSON.stringify(known.geom)?.slice(0, 60)}`);
    check(known.points === 52, 'point count is right', `got ${known.points}`);
    check(known.sport === 'Cycling', 'sport survived', `got "${known.sport}"`);
    check(known.sportGuessed === false, 'a sport read from a file is not flagged as a guess',
      `got ${known.sportGuessed}`);
    check(guessed.sportGuessed === true, 'a worked-out sport is flagged as a guess',
      `got ${guessed.sportGuessed}`);
    check(known.elevUp === 640, 'climb survived', `got ${known.elevUp}`);
    check(known.source === 'komoot', 'source survived', `got "${known.source}"`);
    check(known.place === 'Bern → Thun', 'place survived', `got "${known.place}"`);
    check(Math.round(known.lengthM) === 62700, 'length survived', `got ${known.lengthM}`);
    check(known.firstAt === 1746345600, 'dates survived', `got ${known.firstAt}`);
    check(
      Math.abs(known.bounds[0] - 7.44) < 0.01 && Math.abs(known.bounds[3] - 47.0) < 0.05,
      'bounds were computed', `got ${JSON.stringify(known.bounds)}`,
    );

    // Editing by hand promotes a guess to a fact.
    const upd = await api('POST', '/api/routes/update', { id: guessed.id, sport: 'Ski touring' });
    check(upd.status === 200, 'POST /api/routes/update');
    const after = (await api('GET', '/api/routes')).body?.routes?.find((r) => r.id === guessed.id);
    check(after?.sport === 'Ski touring', 'the edit stuck', `got "${after?.sport}"`);
    check(after?.sportGuessed === false, 'editing clears the guess flag', `got ${after?.sportGuessed}`);
  }

  // --- Re-importing the same file -------------------------------------------
  // The question this answers: drop in a GPX you already imported, back when
  // routes carried no elevation. It must not duplicate, and it must not just
  // shrug — it should take what the file now knows and leave your edits alone.
  const old = await api('POST', '/api/routes', {
    routes: [{
      key: 'k-reimport', name: '2025-04-21', source: 'gpx', place: '',
      sport: '', elevUp: 0, firstAt: 1745000000, lastAt: 1745010000, lengthM: 12000, geom,
    }],
  });
  check(old.body?.added === 1, 'the original import lands', `added=${old.body?.added}`);

  const redo = await api('POST', '/api/routes', {
    routes: [{
      key: 'k-reimport', name: 'Bern → Thun', source: 'gpx', place: 'Bern → Thun',
      sport: 'Hike', sportGuessed: false, elevUp: 640,
      firstAt: 1745000000, lastAt: 1745010000, lengthM: 12000, geom,
    }],
  });
  check(redo.body?.added === 0 && redo.body?.updated === 1, 're-import updates rather than duplicating',
    `added=${redo.body?.added} updated=${redo.body?.updated}`);

  const all = (await api('GET', '/api/routes')).body?.routes ?? [];
  const one = all.filter((r) => r.name === 'Bern → Thun' && r.source === 'gpx');
  check(one.length === 1, 'still exactly one route, not two', `found ${one.length}`);
  check(one[0]?.elevUp === 640, 'the missing climb was filled in', `got ${one[0]?.elevUp}`);
  check(one[0]?.sport === 'Hike', 'the missing activity was filled in', `got "${one[0]?.sport}"`);
  check(one[0]?.place === 'Bern → Thun', 'the missing place was filled in', `got "${one[0]?.place}"`);
  check(one[0]?.name === 'Bern → Thun', 'a placeholder date name was replaced', `got "${one[0]?.name}"`);

  // …but a value you chose yourself is not something an import may overwrite.
  await api('POST', '/api/routes/update', { id: one[0].id, name: 'My favourite loop', sport: 'Ski touring' });
  await api('POST', '/api/routes', {
    routes: [{
      key: 'k-reimport', name: 'Bern → Thun', source: 'gpx', place: 'Somewhere else',
      sport: 'Hike', sportGuessed: false, elevUp: 999,
      firstAt: 1745000000, lastAt: 1745010000, lengthM: 12000, geom,
    }],
  });
  const kept = (await api('GET', '/api/routes')).body?.routes?.find((r) => r.id === one[0].id);
  check(kept?.name === 'My favourite loop', 're-import does not overwrite a name you set', `got "${kept?.name}"`);
  check(kept?.sport === 'Ski touring', 're-import does not overwrite an activity you set', `got "${kept?.sport}"`);
  check(kept?.place === 'Bern → Thun', 're-import does not overwrite a place already worked out', `got "${kept?.place}"`);
  check(kept?.elevUp === 640, 're-import does not re-derive a climb it already has', `got ${kept?.elevUp}`);

  // A guessed activity, though, should yield to one the file actually states.
  await api('POST', '/api/routes', {
    routes: [{ key: 'k-guess2', name: 'x', source: 'gpx', sport: 'Walk', sportGuessed: true, geom, lengthM: 9000 }],
  });
  await api('POST', '/api/routes', {
    routes: [{ key: 'k-guess2', name: 'x', source: 'gpx', sport: 'Hike', sportGuessed: false, geom, lengthM: 9000 }],
  });
  const promoted = (await api('GET', '/api/routes')).body?.routes?.find((r) => r.name === 'x');
  check(promoted?.sport === 'Hike' && promoted?.sportGuessed === false,
    'a guessed activity yields to one the file states',
    `sport="${promoted?.sport}" guessed=${promoted?.sportGuessed}`);
} catch (e) {
  check(false, 'test run', e.message);
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
