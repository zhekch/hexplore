// A cached set of detailed boundaries must not outlive the regions it is keyed
// to.
//
// The boundary cache never expires on purpose: the geoBoundaries commit is
// pinned, so their side of it cannot change. Our side can. Italy's 110
// provinces became its 20 regioni, and the cached answer — written when the map
// held `Italy/Vercelli` and friends — went on being served to a map whose
// regions are now `Italy/Veneto`. Every id missed, nothing gained detail, and
// Italy alone sat on the overview geometry for good, because Italy alone had
// had its regions moved under it.
//
// So a cached payload carries a fingerprint of our region ids for that country
// and is thrown away when they no longer match. Nothing here touches the
// network: the cache decision is the thing under test, and it is reached before
// any fetch.
//
//   node scripts/test/region-cache.mjs

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFineRegions, gbIso, fileUrl } from '../../server/regions-fine.js';
import { loadRegions, regionsOf, regionsInCountry, regionTerm } from '../../src/regions.js';
import { simplifyGeometry, pointCount } from '../../src/polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

await loadRegions(JSON.parse(await readFile(path.join(ROOT, 'src', 'regions.json'), 'utf8')));

const dir = await mkdtemp(path.join(tmpdir(), 'sporra-regions-'));
const fine = createFineRegions({ dir, log: () => {} });
const italianIds = [...regionsOf('ITA')].map((r) => r.id);

/** Write a cache file by hand, the way a previous run would have left one. */
const seed = (iso, payload) => writeFile(path.join(dir, `${iso}.json`), JSON.stringify(payload));

// Nothing here goes near the network, deliberately — a test suite should not
// fetch a megabyte of Italian boundaries every time it runs. A cache that is
// *accepted* never fetches at all; for the ones that must be rejected, the
// stand-in is a country our dataset has no regions for, where `build` returns
// "no regions here" before it would reach for anything. What is under test is
// which of those two paths a given cache file lands on.
const NO_REGIONS = 'VAT'; // a real ISO3 the region dataset has nothing under

console.log('a cache keyed to regions we still have is used as-is');

{
  // The legacy shape: written before fingerprints existed, keyed by ids that
  // are still ours. Thrown away, every country would refetch on the deploy that
  // introduces the fingerprint, so this one is kept.
  await seed('ITA', { iso: 'ITA', level: 'ADM2', regions: Object.fromEntries(italianIds.map((id) => [id, null])) });
  const got = await fine.get('ITA');
  check(got?.level === 'ADM2', 'a legacy cache whose ids are still ours is kept', String(got?.level));
  check(Object.keys(got?.regions ?? {}).length === italianIds.length,
    'with all of its geometry', String(Object.keys(got?.regions ?? {}).length));
}

console.log('\na cache keyed to regions that are gone is not served');

{
  // Exactly the shape the real stale file had: Natural Earth's Italian
  // provinces, none of which is a region this map has any more. Under a country
  // code that rebuilds instantly, so the assertion is about the decision.
  await seed(NO_REGIONS, {
    iso: NO_REGIONS,
    level: 'ADM3',
    regions: { 'Italy/Vercelli': null, 'Italy/Turin': null, 'Italy/Aoste': null },
  });
  const got = await fine.get(NO_REGIONS);
  check(got?.level !== 'ADM3', 'the stale answer is not handed back', String(got?.level));
  check(!Object.keys(got?.regions ?? {}).includes('Italy/Vercelli'),
    'and none of its dead ids survives into the answer');
}

console.log('\nand a fingerprint that no longer matches beats matching ids');

{
  await seed(NO_REGIONS, {
    iso: NO_REGIONS,
    level: 'ADM2',
    fingerprint: 'notthehash',
    regions: { 'Italy/Veneto': null },
  });
  const got = await fine.get(NO_REGIONS);
  check(got?.fingerprint !== 'notthehash', 'a wrong fingerprint is rebuilt through',
    String(got?.fingerprint));
}

await rm(dir, { recursive: true, force: true });

console.log('\nand a country is asked for under the code its files are filed under');
{
  // Our region set is Natural Earth's, which coins its own codes for the places
  // ISO has not settled. Asking geoBoundaries for "SDS" is a 404, remembered as
  // "nobody has boundaries for South Sudan" — whose ten states pair exactly
  // against our ten under `SSD`.
  check(gbIso('SDS') === 'SSD', 'South Sudan');
  check(gbIso('KOS') === 'XKX', 'Kosovo');
  check(gbIso('PSX') === 'PSE', 'the West Bank');
  check(gbIso('CHE') === 'CHE', 'and a code that is already the right one is left alone');
  check(fileUrl('SDS', 'ADM1').includes('/SSD/ADM1/geoBoundaries-SSD-ADM1'),
    'the alias reaches the URL, both times it appears in it', fileUrl('SDS', 'ADM1'));
  // …and nowhere else: everything downstream of the fetch is keyed by our own
  // code, because our region ids are.
  check(regionsInCountry('SDS') === 10, 'our side still answers to our code',
    String(regionsInCountry('SDS')));
}

console.log('\nand two countries take their regions from the detailed set');
{
  // Hungary's 43 Natural Earth units — 19 counties, 23 city-counties and a
  // capital — are a shape nobody else's data has, so nothing paired and the
  // country could never sharpen. Luxembourg's three districts were abolished in
  // 2015. Both are built from geoBoundaries ADM1 now (see `REPLACE_FROM_FINE`
  // in scripts/build-regions.mjs), which is what makes the runtime pairing
  // exact rather than partial.
  check(regionsInCountry('HUN') === 19, 'Hungary is its 19 counties', String(regionsInCountry('HUN')));
  check(regionsInCountry('LUX') === 12, 'Luxembourg is its 12 cantons', String(regionsInCountry('LUX')));
  const hun = [...regionsOf('HUN')].map((r) => r.name);
  check(hun.includes('Pest') && hun.includes('Baranya'), 'named as the detailed set names them');
  // The names carry no term of their own — "Canton Echternach" would read as
  // "Canton Echternach Canton" beside the word the UI supplies.
  const lux = [...regionsOf('LUX')].map((r) => r.name);
  check(lux.every((n) => !/^Canton /.test(n)), 'and without the word for the unit in them', lux.join(', '));
  check(regionTerm('LUX') === 'Canton' && regionTerm('HUN') === 'County',
    'which the term table supplies instead');
}

console.log('\nand an outline too big to send is thinned rather than dropped');
{
  // Norway's ADM0 is 85,311 points of fjord — 2.6 MB — for a shape that is at
  // most a screen wide when anybody is looking at it.
  const ring = [];
  for (let i = 0; i <= 4000; i++) {
    const a = (i / 4000) * Math.PI * 2;
    // A circle with a fine sawtooth on it: thinning should take the teeth and
    // leave the circle.
    const r = 1 + (i % 2 ? 0.0004 : 0);
    ring.push([10 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  const g = { type: 'Polygon', coordinates: [ring] };
  check(pointCount(g) === 4001, 'the fixture is as big as it looks', String(pointCount(g)));
  const thin = simplifyGeometry(g, 0.002);
  check(pointCount(thin) < 400, 'thinning takes most of it', String(pointCount(thin)));
  check(pointCount(thin) > 8, 'and leaves a shape rather than a triangle', String(pointCount(thin)));
  // A ring that thins below a shape is dropped, and a geometry with nothing
  // left is returned as it was rather than as nothing.
  const tiny = { type: 'Polygon', coordinates: [[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]] };
  check(pointCount(simplifyGeometry(tiny, 1)) === 4, 'a shape thinned out of existence keeps what it had');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
