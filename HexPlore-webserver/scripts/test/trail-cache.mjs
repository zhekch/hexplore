// What the trails tile cache promises Waymarked Trails.
//
//   node scripts/test/trail-cache.mjs
//
// They are a volunteer project on donated hosting, and the whole argument for
// putting a cache in front of them rather than letting the browser fetch
// directly — which their CORS headers permit — is that this asks them for less.
// Every check here is a way of keeping that true, or a way of not making their
// bad afternoon worse. The upstream is a local stand-in, because the real one
// cannot be asked to answer 304 on demand and asking it repeatedly to find out
// is the exact behaviour this file exists to prevent.

import { createServer } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrailTiles } from '../../server/trail-tiles.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// A palette PNG with a tRNS chunk is what they actually serve; the bytes do not
// matter here, only that they arrive unchanged.
const TILE = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(600), 'binary');
const SYMBOL = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M1 8 8 4l7 4-7 4"/></svg>';

/** A stand-in for their nginx, with a lever on every behaviour worth testing. */
function upstream() {
  const seen = [];
  let mode = 'ok';
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'], inm: req.headers['if-none-match'] });

    if (req.url.startsWith('/api/v1/list/by_area')) {
      if (mode === 'down') return void res.writeHead(502).end('Bad Gateway');
      const bbox = new URL(req.url, 'http://x').searchParams.get('bbox');
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        bbox,
        results: [
          {
            type: 'relation',
            id: 12359033,
            ref: '1',
            name: 'Via Alpina',
            group: 'NAT',
            linear: 'yes',
            itinerary: ['Vaduz', 'Montreux'],
            symbol_description: 'weisse 1 auf grünem Rechteck',
            symbol_id: 'swiss_NAT_0031',
          },
          // A winter route, whose group is an integer rather than a token.
          { type: 'relation', id: 4242, name: 'Bort', group: 5 },
          // Junk their API would never send, which must not reach a card.
          { type: 'relation', name: 'no id' },
          null,
        ],
      }));
    }

    // The drawing of one waymark. A few hundred bytes of SVG, and the same
    // picture for everybody — which is what makes it worth a cache entry.
    if (req.url.startsWith('/api/v1/symbols/id/')) {
      if (mode === 'down') return void res.writeHead(502).end('Bad Gateway');
      return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(SYMBOL);
    }

    // Their detail record: the whole route, every coordinate of it. The point of
    // the test below is that none of this reaches a browser.
    if (req.url.startsWith('/api/v1/details/relation/')) {
      if (mode === 'down') return void res.writeHead(502).end('Bad Gateway');
      if (req.url.endsWith('/404')) return void res.writeHead(404).end('Not Found');
      if (req.url.endsWith('/999')) {
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('not json at all');
      }
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        id: 12359033,
        official_length: 50700,
        tags: { ascent: '3076', descent: '2235', distance: '50.7', type: 'superroute' },
        route: { length: 49812, main: [{ ways: Array.from({ length: 400 }, (_, i) => ({ id: i })) }] },
      }));
    }

    if (mode === 'down') return void res.writeHead(502).end('Bad Gateway');
    // Past z18 their server has nothing, which is a 404 like any other failure.
    if (/\/19\//.test(req.url)) return void res.writeHead(404).end('Not Found');
    if (req.headers['if-none-match'] === '"v1"') {
      return void res.writeHead(304, { ETag: '"v1"' }).end();
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      ETag: '"v1"',
      // What they really send: an `Expires` three hours out and no
      // `Cache-Control` at all. See the note on TILE_TTL_MS.
      Expires: new Date(Date.now() + 3 * 3600_000).toUTCString(),
    }).end(TILE);
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

const dir = await mkdtemp(path.join(tmpdir(), 'hexplore-trails-'));
const up = await upstream();
// Their real API puts each theme on its own subdomain and the `{theme}` in the
// origin is what fills that in. One stand-in serves all five here, so the
// placeholder is simply absent — which is also a small check in itself: the
// substitution must not require the token to be there.
const make = (d = dir) => createTrailTiles({ dir: d, tileOrigin: up.origin, apiOrigin: up.origin });

console.log('\nThe allowlist — this is a proxy onto somebody else\'s origin');
{
  const tt = make();
  check(await tt.tile('not_a_theme', 12, 2138, 1448) === null, 'a theme they do not publish is refused');
  check(await tt.tile('../../etc/passwd', 12, 2138, 1448) === null, 'a traversal dressed as a theme is refused');
  check(await tt.near('../secrets', '7,46,8,47') === null, 'and the same on the lookup');
  check(await tt.tile('hiking', 12, 9999, 1448) === null, 'x beyond the zoom\'s span is refused');
  check(await tt.tile('hiking', '1e1', 0, 0) === null, 'a coordinate that is not a plain integer is refused');
  check(await tt.tile('hiking', 19, 0, 0) === null, 'and a zoom past the deepest they render never leaves here');
  // That last one matters twice over: it is the one refusal that saves them a
  // request rather than saving us from ourselves.
  check(!up.seen.some((r) => /\/19\//.test(r.url)), 'so no z19 request is ever made');
}

console.log('\nWhat reaches their server');
{
  const tt = make();
  const before = up.seen.length;
  const got = await tt.tile('hiking', 12, 2138, 1448);
  const req = up.seen[before];
  check(got?.status === 200, 'a tile comes back');
  check(Buffer.compare(got.body, TILE) === 0, 'with their bytes unchanged');
  check(got.gzip === false, 'and stored as it arrived — a PNG is already compressed');
  check(req.url === '/hiking/12/2138/1448.png', 'asked for by theme and coordinate', req.url);
  check(/HexPlore/.test(req.ua) && /github/.test(req.ua),
    'and the User-Agent names the project and links to it, so this can be throttled', req.ua);
  check(up.seen.length - before === 1, 'one tile is one request');
}

console.log('\nA repeat costs them nothing, then a few hundred bytes');
{
  const tt = make();
  const before = up.seen.length;
  await tt.tile('hiking', 13, 4276, 2896);
  await tt.tile('hiking', 13, 4276, 2896);
  check(up.seen.length - before === 1, 'a second look inside the TTL is no request at all',
    `${up.seen.length - before}`);

  // Once it is stale, the ETag is what turns a tile into a 304. Their server
  // sends one; measuring that it is *used* is the difference between the
  // politeness argument being true and being a comment.
  // A second instance over the same directory — which is what a restart is, and
  // the whole reason the cache is on disk rather than in memory.
  const stale = createTrailTiles({ dir, tileOrigin: up.origin });
  const at = up.seen.length;
  const held = await stale.tile('hiking', 13, 4276, 2896);
  check(held?.status === 200 && up.seen.length === at,
    'and a second process reads the same entry off disk rather than re-fetching');
}

console.log('\nRevalidation, and what a 304 costs');
{
  // A fresh directory whose TTL has been made to have passed, by writing the
  // entry through one cache and reading it through another after the clock has
  // been moved on. Simplest honest version: ask for a tile, then ask again with
  // the entry's `fetchedAt` far enough back that it must revalidate.
  const d2 = await mkdtemp(path.join(tmpdir(), 'hexplore-trails-rv-'));
  const tt = createTrailTiles({ dir: d2, tileOrigin: up.origin });
  await tt.tile('hiking', 12, 2138, 1449);

  // Age every entry in the directory by eight days.
  const { readFile, writeFile } = await import('node:fs/promises');
  for (const shard of await readdir(d2)) {
    for (const name of await readdir(path.join(d2, shard))) {
      const file = path.join(d2, shard, name);
      const raw = await readFile(file);
      const nl = raw.indexOf(0x0a);
      const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
      meta.fetchedAt -= 8 * 24 * 3600_000;
      await writeFile(file, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), raw.subarray(nl + 1)]));
    }
  }

  const at = up.seen.length;
  const again = createTrailTiles({ dir: d2, tileOrigin: up.origin });
  const got = await again.tile('hiking', 12, 2138, 1449);
  check(up.seen.length - at === 1, 'a stale tile is one request');
  check(up.seen.at(-1).inm === '"v1"', 'and it carries If-None-Match', String(up.seen.at(-1).inm));
  check(got?.status === 200 && Buffer.compare(got.body, TILE) === 0,
    'the 304 is answered from the copy we already held');
  await rm(d2, { recursive: true, force: true });
}

console.log('\nTheir outage is not their problem twice');
{
  const d3 = await mkdtemp(path.join(tmpdir(), 'hexplore-trails-down-'));
  const tt = createTrailTiles({ dir: d3, tileOrigin: up.origin });
  up.setMode('down');

  const at = up.seen.length;
  check(await tt.tile('hiking', 12, 2000, 1400) === null, 'a tile they cannot serve is no tile');
  const asked = up.seen.length - at;
  // The single biggest thing a cache can do wrong: nothing recorded the refusal,
  // so a tile their server could not answer was asked for again on every pan.
  check(await tt.tile('hiking', 12, 2000, 1400) === null, 'and asking again still says no');
  check(up.seen.length - at === asked, 'without touching their server a second time',
    `${up.seen.length - at} requests`);

  up.setMode('ok');
  await rm(d3, { recursive: true, force: true });
}

console.log('\nAnd last week\'s tile beats no map at all');
{
  const d4 = await mkdtemp(path.join(tmpdir(), 'hexplore-trails-stale-'));
  const tt = createTrailTiles({ dir: d4, tileOrigin: up.origin });
  await tt.tile('hiking', 12, 2138, 1450);

  const { readFile, writeFile } = await import('node:fs/promises');
  for (const shard of await readdir(d4)) {
    for (const name of await readdir(path.join(d4, shard))) {
      const file = path.join(d4, shard, name);
      const raw = await readFile(file);
      const nl = raw.indexOf(0x0a);
      const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
      meta.fetchedAt -= 8 * 24 * 3600_000;
      await writeFile(file, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), raw.subarray(nl + 1)]));
    }
  }

  up.setMode('down');
  const again = createTrailTiles({ dir: d4, tileOrigin: up.origin });
  const got = await again.tile('hiking', 12, 2138, 1450);
  check(got?.status === 200 && Buffer.compare(got.body, TILE) === 0,
    'an expired tile is served rather than a hole, when they cannot confirm it');
  up.setMode('ok');
  await rm(d4, { recursive: true, force: true });
}

console.log('\nWhat runs near a point');
{
  const tt = make();
  const found = await tt.near('hiking', '7.44,46.94,7.46,46.96');
  check(Array.isArray(found?.routes), 'a lookup comes back with routes');
  // The one thing about their API that nothing anywhere documents: the box is
  // EPSG:3857 metres, and a box in degrees is a valid request that answers
  // nothing for everywhere on earth.
  const sent = new URL(up.seen.at(-1).url, 'http://x').searchParams.get('bbox');
  check(Number(sent.split(',')[0]) > 800_000, 'and the box was sent in metres, not degrees', sent);

  const [first, second] = found.routes;
  check(found.routes.length === 2, 'records without an id are dropped rather than passed on',
    `${found.routes.length}`);
  check(first.name === 'Via Alpina' && first.ref === '1' && first.group === 'NAT',
    'the fields a card shows come through');
  check(first.symbol === 'weisse 1 auf grünem Rechteck', 'including what is painted on the post');
  check(first.symbolId === 'swiss_NAT_0031', 'and the id of the drawing of it, which is what a row shows');
  check(!('symbol_id' in first) && !('linear' in first) && !('type' in first),
    'and nothing else does — their response shape is not this app\'s client contract');
  // A `'5'` and a `5` look the same on the wire and land in different halves of
  // the lookup at the other end.
  check(second.group === 5, 'a winter route keeps its integer group', JSON.stringify(second.group));

  check(await tt.near('hiking', '7.44,46.94,7.46') === null, 'three numbers is not a bbox');
  up.setMode('down');
  check(await tt.near('hiking', '7.44,46.94,7.46,46.96') === null,
    'and an outage is nothing rather than a throw');
  up.setMode('ok');
}

console.log('\nThe drawing of a waymark');
{
  const tt = make();
  const before = up.seen.length;
  const drawn = await tt.symbol('hiking', 'osmc_LOC_empty_yellow-diamond');
  check(drawn?.body?.toString() === SYMBOL, 'a symbol comes back as their bytes');
  check(/svg/.test(drawn.type), 'labelled as what it is', drawn.type);
  check(up.seen[before].url === '/api/v1/symbols/id/osmc_LOC_empty_yellow-diamond?format=svg',
    'asked for by id, on the API origin rather than the tile one', up.seen[before].url);

  // The reason this one is cached where the tap lookup is not: a waymark is the
  // same picture for everybody, and one route in the Oberland warms the entry
  // for every yellow diamond in the country.
  await tt.symbol('hiking', 'osmc_LOC_empty_yellow-diamond');
  check(up.seen.length - before === 1, 'and a second route wearing it costs them nothing');

  check(await tt.symbol('hiking', '../../etc/passwd') === null, 'a path walk is refused');
  check(await tt.symbol('not_a_theme', 'x') === null, 'and so is a theme they do not publish');
}

console.log('\nHow far a route runs, without the route');
{
  const tt = make();
  const before = up.seen.length;
  const about = await tt.details('hiking', 12359033);
  check(about?.length === 50700 && about.ascent === 3076 && about.descent === 2235,
    'the three numbers a card shows', JSON.stringify(about));
  check(about.superroute === true, 'and whether it is a route made of routes');
  check(!('route' in about) && !('tags' in about),
    'and none of the geometry that came with them');
  // The whole reason this happens on the server. Their answer is the route; what
  // is kept is under a hundred bytes of it, which is what a browser is sent and
  // what sits on disk.
  const kept = JSON.stringify(about).length;
  check(kept < 120, 'the entry is the answer, not their record', `${kept} bytes`);
  check(up.seen[before].url === '/api/v1/details/relation/12359033',
    'asked for one route at a time, because somebody asked about that route');

  await tt.details('hiking', 12359033);
  check(up.seen.length - before === 1, 'and asked once');

  check(await tt.details('hiking', 'nine') === null, 'a relation id that is not one is refused');
  check(await tt.details('hiking', 404) === null, 'a route they do not know is nothing');
  // A 200 that is not JSON is not an answer, and must not be stored as one.
  check(await tt.details('hiking', 999) === null, 'nor is a 200 that is not their record');
}

console.log('\nNothing is fetched that a person did not just look at');
{
  // The line in every tile policy worth honouring, and the one a cache is most
  // likely to break. There is no seeding, no prefetch and no bounding-box walk
  // in this module — so a fresh cache that has been asked for one tile has one
  // tile in it, and the neighbours are absent.
  const d5 = await mkdtemp(path.join(tmpdir(), 'hexplore-trails-cold-'));
  const tt = createTrailTiles({ dir: d5, tileOrigin: up.origin });
  const at = up.seen.length;
  await tt.tile('hiking', 12, 2138, 1451);
  check(up.seen.length - at === 1, 'one look is one tile', `${up.seen.length - at}`);
  let entries = 0;
  for (const shard of await readdir(d5)) entries += (await readdir(path.join(d5, shard))).length;
  check(entries === 1, 'and one entry on disk', `${entries}`);
  await rm(d5, { recursive: true, force: true });
}

await up.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
