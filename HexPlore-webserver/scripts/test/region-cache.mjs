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
import { createFineRegions } from '../../server/regions-fine.js';
import { loadRegions, regionsOf } from '../../src/regions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

await loadRegions(JSON.parse(await readFile(path.join(ROOT, 'src', 'regions.json'), 'utf8')));

const dir = await mkdtemp(path.join(tmpdir(), 'hexplore-regions-'));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
