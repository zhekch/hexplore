// What the train-tracks tile cache promises OpenRailwayMap.
//
//   node scripts/test/rail-cache.mjs
//
// Every one of these is a line in their usage policy or a way of not making
// their bad afternoon worse. The upstream here is a local stand-in, because the
// real one cannot be asked to answer 304 on demand and asking it repeatedly to
// find out is the exact behaviour this file exists to prevent.

import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRailTiles, spritePaths, validTileCoords } from '../../server/rail-tiles.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const SOURCES = new Set(['railway_line_high', 'railway_line_high,railway_text_km', 'sick_source']);
const TILE = Buffer.from('not really a protobuf, but it compresses like one'.repeat(40));

/** A stand-in for their Martin, with a lever on every behaviour worth testing. */
function upstream() {
  const seen = [];
  let mode = 'ok';
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, referer: req.headers.referer, ua: req.headers['user-agent'] });
    if (!req.headers.referer) {
      // Exactly what openrailwaymap.app does to a request without one.
      res.writeHead(403).end('Forbidden');
      return;
    }
    // One permanently broken source alongside healthy ones — which is exactly
    // how openrailwaymap.app behaves: their ten-source `standard` composite 502s
    // every request while the track geometry answers every one.
    if (req.url.startsWith('/sick_source')) return void res.writeHead(502).end('Bad Gateway');
    if (mode === 'down') return void res.writeHead(502).end('Bad Gateway');
    if (mode === '404') return void res.writeHead(404).end('Not Found');
    if (mode === 'empty') return void res.writeHead(204).end();
    if (mode === '304' && req.headers['if-none-match'] === '"v1"') {
      return void res.writeHead(304, { ETag: '"v1"' }).end();
    }
    if (req.url.startsWith('/railway_line_high')) {
      res.writeHead(200, {
        'Content-Type': 'application/x-protobuf',
        ETag: '"v1"',
        'Cache-Control': 'max-age=86400',
      }).end(TILE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' })
      .end(JSON.stringify({ tilejson: '3.0.0', tiles: ['https://openrailwaymap.app/x/{z}/{x}/{y}'], maxzoom: 15, attribution: 'theirs' }));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${srv.address().port}`,
      seen,
      setMode: (m) => { mode = m; },
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
const up = await upstream();
const make = () => createRailTiles({ dir, sources: SOURCES, origin: up.origin });
const REF = 'https://maps.example';

console.log('\nThe allowlist — this is a proxy onto somebody else\'s origin');
{
  const rt = make();
  check(await rt.tile('not_a_source', 1, 0, 0, REF) === null, 'a source the style never asks for is refused');
  check(await rt.tile('../../etc/passwd', 1, 0, 0, REF) === null, 'a traversal dressed as a source list is refused');
  check(await rt.sprite('sprite/../../secrets.json', REF) === null, 'a sprite name outside the enumerated set is refused');
  check(await rt.tile('railway_line_high', 1, 9, 0, REF) === null, 'x beyond the zoom\'s span is refused');
  check(await rt.tile('railway_line_high', '1e1', 0, 0, REF) === null, 'a coordinate that is not a plain integer is refused');
  check(validTileCoords(21, 0, 0) === null, 'a zoom past the maximum is refused');
  check(spritePaths().size === 8, 'the sprite set is eight enumerated files', `got ${spritePaths().size}`);
}

console.log('\nWhat reaches their server');
{
  const rt = make();
  const before = up.seen.length;
  const got = await rt.tile('railway_line_high', 12, 2145, 1436, REF);
  const req = up.seen[before];
  check(got?.status === 200, 'a tile comes back');
  check(req.referer === `${REF}/`, 'the Referer is our own origin', req.referer);
  check(!/openrailwaymap/i.test(req.referer), 'the Referer does not claim to be theirs');
  check(/HexPlore/.test(req.ua) && /github/.test(req.ua), 'the User-Agent names the project and links to it', req.ua);
}

console.log('\nA repeat costs them nothing');
{
  const rt = make();
  const before = up.seen.length;
  await rt.tile('railway_line_high', 12, 2145, 1437, REF);
  const afterFirst = up.seen.length;
  await rt.tile('railway_line_high', 12, 2145, 1437, REF);
  await rt.tile('railway_line_high', 12, 2145, 1437, REF);
  check(afterFirst - before === 1, 'the first ask is one request', `${afterFirst - before}`);
  check(up.seen.length === afterFirst, 'the next two are none at all', `${up.seen.length - afterFirst}`);
}

console.log('\nOne flight per tile, however many browsers ask at once');
{
  const rt = make();
  const before = up.seen.length;
  await Promise.all(Array.from({ length: 12 }, () => rt.tile('railway_line_high', 13, 4290, 2874, REF)));
  check(up.seen.length - before === 1, 'twelve simultaneous asks are one request', `${up.seen.length - before}`);
}

console.log('\nA stale entry is revalidated, not re-downloaded');
{
  // A fresh cache dir so the entry below is the only thing in it, then the
  // stored timestamp is dragged into the past to make it stale on purpose.
  const staleDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: staleDir, sources: SOURCES, origin: up.origin });
  const first = await rt.tile('railway_line_high', 14, 8580, 5748, REF);
  check(first?.etag === '"v1"', 'their ETag is kept', first?.etag);
  check(first?.ttl === 86400000, 'their max-age wins over our default', String(first?.ttl));

  // Rewrite the entry's header so it reads as fetched a fortnight ago.
  const { readFile, writeFile, readdir } = await import('node:fs/promises');
  const shard = (await readdir(staleDir))[0];
  const name = (await readdir(path.join(staleDir, shard)))[0];
  const file = path.join(staleDir, shard, name);
  const raw = await readFile(file);
  const nl = raw.indexOf(0x0a);
  const meta = JSON.parse(raw.subarray(0, nl).toString());
  meta.fetchedAt = Date.now() - 14 * 24 * 3600 * 1000;
  await writeFile(file, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), raw.subarray(nl + 1)]));

  up.setMode('304');
  const before = up.seen.length;
  const again = await rt.tile('railway_line_high', 14, 8580, 5748, REF);
  up.setMode('ok');
  check(up.seen[before]?.url.includes('8580'), 'the stale entry is asked about');
  check(again?.body?.length === first.body.length, 'a 304 keeps the body we already had');
  await rm(staleDir, { recursive: true, force: true });
}

console.log('\nTheir outage is not their problem twice');
{
  const outDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: outDir, sources: SOURCES, origin: up.origin });
  const good = await rt.tile('railway_line_high', 15, 17160, 11496, REF);
  up.setMode('down');
  const during = await rt.tile('railway_line_high', 15, 17160, 11496, REF);
  check(during?.body?.length === good.body.length, 'a cached tile still serves while they are down');

  const cold = await rt.tile('railway_line_high', 15, 17160, 11497, REF);
  check(cold === null, 'a tile we never had is a miss, not an invention');
  up.setMode('ok');
  await rm(outDir, { recursive: true, force: true });
}

console.log('\nA refusal is remembered — the biggest thing this used to get wrong');
{
  const failDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: failDir, sources: SOURCES, origin: up.origin });
  up.setMode('down');
  const before = up.seen.length;
  await rt.tile('railway_line_high', 13, 4300, 2880, REF);
  const afterFirst = up.seen.length;
  // Every pan back across the same ground used to be a fresh request each time.
  await rt.tile('railway_line_high', 13, 4300, 2880, REF);
  await rt.tile('railway_line_high', 13, 4300, 2880, REF);
  await rt.tile('railway_line_high', 13, 4300, 2880, REF);
  check(afterFirst - before === 1, 'the failure costs one request', `${afterFirst - before}`);
  check(up.seen.length === afterFirst, 'and panning back over it costs none', `${up.seen.length - afterFirst} more`);
  up.setMode('ok');
  await rm(failDir, { recursive: true, force: true });
}

console.log('\nA burst of distinct tiles is one request each, and no more');
{
  // There is no circuit breaker any more — see the note where it used to be.
  // What stops a failing upstream being hammered is the per-tile backoff, so the
  // property to hold is that a viewport's worth of *distinct* tiles costs one
  // request each and a second pass over the same ground costs nothing.
  const burstDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: burstDir, sources: SOURCES, origin: up.origin });
  up.setMode('down');
  const before = up.seen.length;
  for (let i = 0; i < 40; i++) await rt.tile('railway_line_high', 13, 4400 + i, 2900, REF);
  const firstPass = up.seen.length - before;
  for (let i = 0; i < 40; i++) await rt.tile('railway_line_high', 13, 4400 + i, 2900, REF);
  const secondPass = up.seen.length - before - firstPass;
  check(firstPass === 40, 'forty new tiles are forty requests', String(firstPass));
  check(secondPass === 0, 'and panning back over all forty is none', String(secondPass));
  up.setMode('ok');
  await rm(burstDir, { recursive: true, force: true });
}

console.log('\nHow much detail is worth asking for');
{
  // When their origin is down, a working tile is one Cloudflare still has
  // cached, and the deeper the zoom the less likely that is. Rather than draw
  // nothing, the client caps the source's maxzoom and lets MapLibre overzoom a
  // parent — so the server has to notice which zooms are answerable, and notice
  // when they become answerable again.
  const dDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: dDir, sources: SOURCES, origin: up.origin, healthWindowMs: 600 });
  const SRC = 'railway_line_high,railway_text_km';
  // Coordinates wrapped into the zoom's own span — at z5 there is no tile 700,
  // and an out-of-range ask is refused before it can teach the cache anything.
  const burst = async (z, x0, n) => {
    const span = 2 ** z;
    for (let i = 0; i < n; i++) {
      await rt.tile(SRC, z, (x0 + i) % span, 7 % span, REF);
    }
  };

  check(Object.keys(rt.detail()).length === 0, 'nothing is capped before there is any evidence');

  // A handful of misses is not evidence — empty countryside should not cost detail.
  up.setMode('down');
  await burst(14, 8600, 3);
  check(rt.detail()[SRC] === undefined, 'a few misses at one zoom are not enough to cap it', JSON.stringify(rt.detail()));

  // A sustained run at z14 is.
  await burst(14, 8700, 25);
  check(rt.detail()[SRC] === 13, 'a zoom that keeps failing caps the one below it', String(rt.detail()[SRC]));

  // Their whole origin down, shallower zooms failing too — the cap follows down.
  await burst(11, 1070, 25);
  check(rt.detail()[SRC] === 10, 'and it follows the shallowest failing zoom', String(rt.detail()[SRC]));

  // Never past the floor, however bad it gets.
  await burst(5, 8, 25);
  check(rt.detail()[SRC] === 8, 'but never coarser than the floor', String(rt.detail()[SRC]));

  // And when they recover, the evidence ages out and the detail comes back on
  // its own — nothing has to be restarted or cleared.
  // A remembered refusal has to count too. Once the backoff has swallowed every
  // request, no tile reaches upstream — and if only real requests were evidence
  // the window would empty, the cap would lift, and the overlay would go back to
  // asking for a zoom it already knew was unavailable. Which is what happened:
  // after a page reload the railways stopped rendering until the cache was
  // cleared, because clearing it was the only way to make real requests happen.
  up.setMode('down');
  await burst(13, 4400, 25);
  const capped = rt.detail()[SRC];
  // Wait most of the window out, then pan back over the same ground. Every one
  // of these is a negative-cache hit and reaches upstream not at all, so by the
  // time the first pass has aged out the *only* evidence left is the remembered
  // failures — which is exactly the state a page reload lands in.
  await new Promise((r) => setTimeout(r, 450));
  const before = up.seen.length;
  await burst(13, 4400, 25);
  check(up.seen.length === before, 'a second pass reaches upstream not at all', `${up.seen.length - before}`);
  await new Promise((r) => setTimeout(r, 250)); // first pass is now older than the window
  // Still capped is the whole point. The exact value moves — the older, shallower
  // evidence has aged out, so the cap relaxes from the floor to just under z13 —
  // but without remembered failures counting there would be no evidence at all
  // and no cap, which is the bug.
  check(rt.detail()[SRC] !== undefined, 'and a cap survives on remembered failures alone', `${capped} -> ${rt.detail()[SRC]}`);

  up.setMode('ok');
  await new Promise((r) => setTimeout(r, 700)); // longer than healthWindowMs
  check(rt.detail()[SRC] === undefined, 'stale evidence expires and the cap lifts itself', JSON.stringify(rt.detail()));
  await rm(dDir, { recursive: true, force: true });
}

console.log('\nA 404 is a failure, not an empty tile');
{
  // Martin answers 404 for a source it does not recognise. Cached as "empty",
  // a redeploy that renamed something would read as "no railways here" for a
  // day after it was fixed.
  const nfDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: nfDir, sources: SOURCES, origin: up.origin });
  up.setMode('404');
  const gone = await rt.tile('railway_line_high', 9, 268, 179, REF);
  check(gone === null, 'a 404 is not served as an empty tile', JSON.stringify(gone?.status));
  up.setMode('ok');
  // Short backoff, so recovery is picked up rather than waited out for a day.
  await new Promise((r) => setTimeout(r, 1100));
  await rm(nfDir, { recursive: true, force: true });
}

console.log('\nAn empty tile is an answer worth remembering');
{
  const emptyDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: emptyDir, sources: SOURCES, origin: up.origin });
  up.setMode('empty');
  const first = await rt.tile('railway_line_high', 6, 33, 22, REF);
  const before = up.seen.length;
  const second = await rt.tile('railway_line_high', 6, 33, 22, REF);
  up.setMode('ok');
  check(first?.status === 204, 'ocean comes back as 204', String(first?.status));
  check(up.seen.length === before, '"still nothing" is not asked twice');
  check(second?.body?.length === 0, 'and the second answer is still empty');
  await rm(emptyDir, { recursive: true, force: true });
}

console.log('\nWhat comes back is the tile itself');
{
  const bodyDir = await mkdtemp(path.join(tmpdir(), 'hexplore-rail-'));
  const rt = createRailTiles({ dir: bodyDir, sources: SOURCES, origin: up.origin });
  const got = await rt.tile('railway_line_high,railway_text_km', 12, 2145, 1436, REF);
  check(got?.gzip === true, 'stored compressed — vector tiles are protobuf');
  check(Buffer.compare(gunzipSync(got.body), TILE) === 0, 'and the bytes survive the round trip');
  check(got.type === 'application/x-protobuf', 'their content type is passed through', got.type);
  await rm(bodyDir, { recursive: true, force: true });
}

await up.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
