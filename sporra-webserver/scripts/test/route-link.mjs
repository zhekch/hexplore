// Storing the way back to a Komoot tour — and refusing to store anything else.
//
// The link is the one field in a route that becomes an `href`, and an `href` is
// where `javascript:` runs. So it is validated on the way in *and* again at
// render, and both are checked here. The referral tail Komoot appends when you
// copy a share link is stripped: it records who shared what with whom and is
// nobody's business once the tour is on your map.
//
//   node scripts/test/route-link.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKomootUrl, tourUrl, isKomootTourUrl } from '../../src/komoot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// --- Building the canonical link --------------------------------------------
const messy =
  'https://www.komoot.com/tour/3129274755?share_token=akGQmnIM7WF7tEW0zwhz0BWZutRQgAGS39VBeNHqYY3Q44B3Cg'
  + '&ref=profile&t_s=referral&t_cid=route_share&t_ref_username=4003394184850';
const clean = tourUrl(parseKomootUrl(messy));
check(
  clean === 'https://www.komoot.com/tour/3129274755?share_token=akGQmnIM7WF7tEW0zwhz0BWZutRQgAGS39VBeNHqYY3Q44B3Cg',
  'the referral tail is stripped, the share token is kept', clean,
);
check(tourUrl({ id: '2504447881', shareToken: '' }) === 'https://www.komoot.com/tour/2504447881',
  'a public tour needs no token');
check(tourUrl({ id: 'nope' }) === '', 'a non-numeric id produces no link');

// --- What may become an href ------------------------------------------------
for (const bad of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'http://www.komoot.com/tour/123456',      // not https
  'https://evil.com/tour/123456',           // not komoot
  'https://komoot.com.evil.io/tour/123456', // lookalike host
  'https://www.komoot.com/user/123456',     // not a tour
  '',
]) {
  check(!isKomootTourUrl(bad), `refuses ${JSON.stringify(bad).slice(0, 44)}`);
}
check(isKomootTourUrl(clean), 'accepts a real tour link');
check(isKomootTourUrl('https://www.komoot.de/smarttour/9999999'), 'accepts a smarttour on another domain');

// --- Through the API --------------------------------------------------------
const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-link-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), ALLOW_REGISTRATION: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let cookie = '';
const api = async (m, u, b) => {
  const res = await fetch(`${BASE}${u}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res.json().catch(() => null);
};
const geom = [Array.from({ length: 30 }, (_, i) => [7.44 + i * 0.001, 46.94 + i * 0.0008])];

try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await api('POST', '/api/register', { username: 'linktest', password: 'a-long-enough-pw' });
  await api('POST', '/api/routes', {
    routes: [
      { key: 'k-good', name: 'Tour', source: 'komoot', geom, lengthM: 9000, link: clean },
      { key: 'k-evil', name: 'Nasty', source: 'komoot', geom, lengthM: 9000, link: 'javascript:alert(1)' },
      { key: 'k-none', name: 'Plain', source: 'gpx', geom, lengthM: 9000 },
    ],
  });
  const routes = (await api('GET', '/api/routes')).routes ?? [];
  const by = (name) => routes.find((r) => r.name === name);
  check(by('Tour')?.link === clean, 'a valid link round-trips', `got "${by('Tour')?.link}"`);
  check(by('Nasty')?.link === '', 'a javascript: link is refused at the server', `got "${by('Nasty')?.link}"`);
  check(by('Plain')?.link === '', 'a route with no link has none', `got "${by('Plain')?.link}"`);

  // Re-importing fills a missing link in, and never overwrites one.
  await api('POST', '/api/routes', {
    routes: [{ key: 'k-none', name: 'Plain', source: 'komoot', geom, lengthM: 9000, link: clean }],
  });
  const filled = (await api('GET', '/api/routes')).routes.find((r) => r.name === 'Plain');
  check(filled?.link === clean, 're-importing fills in a missing link', `got "${filled?.link}"`);
} catch (e) {
  check(false, 'test run', e.message);
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
