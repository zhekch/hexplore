// The MapTiler tile cache, against a stand-in that can be asked for things the
// real one cannot be asked for on demand — a 304, a 403, an empty square.
//
// Five things here, and the first one shipped broken once:
//
//   - **What is stored has to be what the `gzip` flag says it is.** Their tiles
//     are gzip on the wire, which makes "keep the bytes as they arrived" the
//     obvious thing to write and the wrong one: `fetch` has already decoded them
//     by the time `arrayBuffer()` resolves, so the obvious version stores
//     protobuf and labels it compressed. The browser then gets
//     `Content-Encoding: gzip` over data that is not, and fails inside the
//     transport with `incorrect header check` — before a line of this app's code
//     runs, which is why it reads as the server being broken rather than as a
//     tile being wrong.
//   - **An empty body is an answer.** Most of the planet has no trails on it and
//     their server says so with 200 and zero bytes. Not storing that means
//     asking them again for nothing on every pan over open country.
//   - **The key must not be part of the cache key.** The tile at 14/8504/5833 is
//     the same tile whoever fetched it, so keying on the account would store one
//     copy per person of identical bytes — and would put the key on the disk.
//   - **A rejected key must not be remembered for long.** It is the one failure
//     here that somebody fixes from a dialog, and half an hour of remembering
//     "your key is wrong" after they have pasted a right one looks exactly like
//     the new key being wrong too.
//   - **Nothing is fetched that a person did not just look at**, and a key that
//     could spell a second query parameter never reaches their origin.
//
//   node scripts/test/maptiler-cache.mjs

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const { createMaptilerTiles } = await import('../../server/maptiler-tiles.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`,
);

// --- A stand-in for api.maptiler.com ----------------------------------------------

const REAL = Buffer.from('not really protobuf, but it is bytes and it compresses');
const GOOD_KEY = 'V7kQ2mXbNp4TzR8wLcYs';

let asked = [];
let mode = 'ok';

const upstream = createServer((req, res) => {
  asked.push(req.url);
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (key !== GOOD_KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Invalid key - Get your FREE key at https://cloud.maptiler.com/account/keys/');
  }
  if (req.url.startsWith('/tiles/outdoor/tiles.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"tilejson":"2.1.0"}');
  }
  if (mode === 'empty') {
    // Exactly what they answer for a square with no trails in it.
    res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
    return res.end();
  }
  if (mode === '304' && req.headers['if-modified-since']) {
    res.writeHead(304);
    return res.end();
  }
  if (mode === '500') {
    res.writeHead(500);
    return res.end('nope');
  }
  // Gzip on the wire, exactly as they send it. Node's client decodes this before
  // the cache ever sees it, which is the whole trap.
  const body = gzipSync(REAL);
  res.writeHead(200, {
    'Content-Type': 'application/x-protobuf',
    'Content-Encoding': 'gzip',
    'Cache-Control': 'public, max-age=14400',
    'Last-Modified': 'Tue, 02 Sep 2025 11:48:35 GMT',
  });
  res.end(body);
});

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const dir = await mkdtemp(path.join(tmpdir(), 'hexplore-mt-'));
const make = () => createMaptilerTiles({ dir, origin });

// --- What is stored is what the flag says ------------------------------------------

console.log('\nA tile, and what is on the disk after it');
let tiles = make();
let got = await tiles.tile(GOOD_KEY, 14, 8504, 5833);
check(!!got, 'a tile comes back');
eq(got.status, 200, 'as a 200');
check(got.gzip === true, 'flagged gzipped');
// The assertion the bug would have failed: the flag and the bytes must agree.
let unzipped = null;
try {
  unzipped = gunzipSync(got.body);
} catch (e) {
  check(false, 'and the stored bytes really are gzip', e.message);
}
if (unzipped) {
  check(true, 'and the stored bytes really are gzip');
  eq(unzipped.toString(), REAL.toString(), 'round-tripping to exactly what they sent');
}
check(got.body.length !== REAL.length, 'stored compressed rather than as it arrived');
eq(got.type, 'application/x-protobuf', 'with their content type');

console.log('\nAnd it is not asked for twice');
asked = [];
got = await tiles.tile(GOOD_KEY, 14, 8504, 5833);
eq(asked, [], 'a second read touches nobody');
check(!!got?.body?.length, 'and still answers');

// --- The key is not part of the cache key -------------------------------------------

console.log('\nWhose key paid for it makes no difference to what is stored');
asked = [];
// A second, equally valid key. The stand-in would 403 it — so if this reaches
// upstream at all, the cache keyed on the key and the test fails loudly.
got = await tiles.tile('adifferentkeyentirely', 14, 8504, 5833);
eq(asked, [], 'a different key hits the same entry rather than fetching again');
check(!!got?.body?.length, 'and gets the tile');

// --- An empty square -----------------------------------------------------------------

console.log('\nA square with no trails in it');
mode = 'empty';
got = await tiles.tile(GOOD_KEY, 14, 1, 1);
eq(got.status, 204, 'is a 204 rather than a failure');
eq(got.body.length, 0, 'with nothing in it');
check(got.gzip === false, 'and is not claimed to be compressed');
asked = [];
got = await tiles.tile(GOOD_KEY, 14, 1, 1);
eq(asked, [], 'and it is remembered, so panning over open country asks nobody');
eq(got.status, 204, 'still a 204');

// --- Revalidation ---------------------------------------------------------------------

console.log('\nA second instance over the same directory');
// The cache is on disk and has no index, so a restarted server finds what the
// last one stored. Revalidation itself is not reachable from here without
// waiting out a week-long TTL; what it does on a 304 is one branch, and the
// live run against their server is what exercises it.
const restarted = createMaptilerTiles({ dir, origin });
asked = [];
got = await restarted.tile(GOOD_KEY, 14, 8504, 5833);
check(!!got?.body?.length, 'finds what the last one stored');
eq(asked, [], 'and asks nobody');

// --- Refusals ---------------------------------------------------------------------------

console.log('\nWhat it will not ask for');
mode = 'ok';
asked = [];
eq(await tiles.tile('has/a/slash', 14, 8504, 5833), null, 'a key that could reach another host is refused here');
eq(await tiles.tile('short', 14, 8504, 5833), null, 'and one too short to be a key');
eq(await tiles.tile(`${GOOD_KEY}&x=1`, 14, 8504, 5833), null, 'and one that could spell a second query parameter');
eq(await tiles.tile(GOOD_KEY, 15, 1, 1), null, 'z15 is past their ceiling and is refused');
eq(await tiles.tile(GOOD_KEY, 14, 2 ** 14, 0), null, 'and x has to fit the zoom');
eq(asked, [], 'none of which touched their server at all');

console.log('\nA key their server rejects');
tiles = make();
asked = [];
got = await tiles.tile(GOOD_KEY, 12, 7, 7); // stand-in 403s only on a wrong key…
// …so ask with a well-shaped key the stand-in does not know.
got = await tiles.tile('abcdefghijklmnop', 12, 9, 9);
eq(got, null, 'is a refusal rather than a tile');
check(asked.length > 0, 'and it did reach them, which is what makes it a 403 and not a shape error');

console.log('\nThe key check');
eq((await tiles.check(GOOD_KEY)).ok, true, 'a good key checks out');
const bad = await tiles.check('abcdefghijklmnop');
eq(bad.ok, false, 'a wrong one does not');
eq(bad.why, 'rejected', 'and says which kind of no it was');
eq((await tiles.check('has/a/slash')).why, 'not-a-key', 'a key that is not one is caught before asking');

// --- The key never reaches the disk -------------------------------------------------------

console.log('\nAnd the key is nowhere on the disk');
const { readdir, readFile } = await import('node:fs/promises');
let found = false;
for (const shard of await readdir(dir).catch(() => [])) {
  for (const name of await readdir(path.join(dir, shard)).catch(() => [])) {
    if (name.includes(GOOD_KEY)) found = true;
    const raw = await readFile(path.join(dir, shard, name)).catch(() => Buffer.alloc(0));
    // Only the metadata line, which is where a key would end up if it were
    // stored — the body is somebody else's bytes and may contain anything.
    const nl = raw.indexOf(0x0a);
    if (nl > 0 && raw.subarray(0, nl).toString('utf8').includes(GOOD_KEY)) found = true;
  }
}
check(!found, 'not in a filename and not in an entry’s metadata');

upstream.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
