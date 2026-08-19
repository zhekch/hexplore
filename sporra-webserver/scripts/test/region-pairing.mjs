// Pairing our regions against a detailed boundary set, when the names don't help.
//
// `pairFineRegions` pairs by name first and by geometry second, and the second
// path is not a rare fallback — it is the *only* path for whole countries. Not
// one Ukrainian name pairs: geoBoundaries calls every unit "<name> Oblast" where
// Natural Earth calls it "<name>", so all 25 fall through to geometry.
//
// Which is fine until a region is shaped like a ring around its capital. The
// average of a ring's vertices is its centre, and its centre is the hole — so
// asking one point what it is standing on asks the capital, the size guard
// correctly refuses to pair a 28,000 km² oblast with a 1,600 km² city, and that
// one region keeps the overview shape while all its neighbours sharpen. That is
// what happened to Kyiv oblast, and it is the shape of every
// capital-inside-a-province in the world.
//
// The fixture is that geometry and nothing else: a round province with its
// capital cut out, and the two datasets disagreeing about exactly where the
// capital is — which is the whole of the bug, because the two datasets always
// disagree about exactly where anything is.
//
//   node scripts/test/region-pairing.mjs

import {
  loadRegions, pairFineRegions, interiorPoints, regionAt, addFineRegions, fineRegionsVersion,
  seamedRegion, addFineOutline, fineCountryOutline, fineRegionsLoaded,
} from '../../src/regions.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const poly = (rings) => ({ type: 'Polygon', coordinates: rings });

// A round province a degree across. Round rather than square so the average of
// its vertices really is its middle — a square ring closes on its first corner
// and drags the average into that corner, which would hide the very thing this
// is testing.
const OUTER = [];
for (let i = 0; i <= 64; i++) {
  const a = (i / 64) * Math.PI * 2;
  OUTER.push([11 + Math.cos(a), 51 + Math.sin(a)]);
}
// The capital, cut out of the middle of it — ours, and then theirs, drawn a
// little to the north-east of ours. That offset is all "two datasets" ever means.
const OUR_CAPITAL = box(10.95, 50.95, 11.25, 51.25);
const THEIR_CAPITAL = box(11.05, 51.05, 11.35, 51.35);

await loadRegions([
  {
    id: 'Fixture/Province', name: 'Province', country: 'Fixture', iso: 'FIX',
    bbox: [10, 50, 12, 52], geometry: poly([OUTER, OUR_CAPITAL]),
  },
  {
    id: 'Fixture/Capital', name: 'Capital', country: 'Fixture', iso: 'FIX',
    bbox: [10.95, 50.95, 11.25, 51.25], geometry: poly([OUR_CAPITAL]),
  },
  // An overseas one, half an ocean away and touching nothing — the Netherlands'
  // Bonaire, France's Guyane, and the reason a coverage ratio is the wrong test.
  {
    id: 'Fixture/Island', name: 'Island', country: 'Fixture', iso: 'FIX',
    bbox: [-40, 10, -39.8, 10.2], geometry: poly([box(-40, 10, -39.8, 10.2)]),
  },
]);

const theirProvince = [OUTER, THEIR_CAPITAL];

console.log('\none point inside a ring is the wrong point');
const first = interiorPoints(theirProvince)[0];
check(regionAt(first[0], first[1], 'FIX')?.id === 'Fixture/Capital',
  'the first point their province offers is standing on our capital',
  `${first.map((v) => v.toFixed(3))} → ${regionAt(first[0], first[1], 'FIX')?.id}`);

console.log('\nso the pairing votes rather than sampling once');
const paired = pairFineRegions('FIX', [
  // A name that pairs with nothing, exactly like every Ukrainian oblast.
  { properties: { shapeName: 'Province Oblast' }, geometry: poly(theirProvince) },
]);
check(paired.has('Fixture/Province'),
  'the ring-shaped province gains its detailed shape',
  `paired: ${[...paired.keys()].join(', ') || 'nothing'}`);
check(paired.get('Fixture/Province')?.coordinates?.length === 2,
  'and it is theirs — the one with their capital cut out of it');

console.log('\nand the size guard still refuses a bad pair');
// The guard that made the failure quiet rather than wrong is untouched: a shape
// may only pair with a region of about its own size, whatever the vote says.
// This is what stopped one Italian province colouring in a fifth of Italy.
const wrongSize = pairFineRegions('FIX', [
  { properties: { shapeName: 'Province Oblast' }, geometry: poly([box(11.4, 51.4, 11.45, 51.45)]) },
]);
check(!wrongSize.has('Fixture/Province'),
  'a shape a thousandth of the size pairs with nothing',
  `paired: ${[...wrongSize.keys()].join(', ') || 'nothing'}`);

console.log('\nmixing two resolutions is refused only where they would meet');
// Two resolutions cannot tile: where a detailed region meets an overview one the
// two disagree by up to a kilometre, so the border is ruled twice and the union
// leaves a sliver between them. But that is a question about *seams*, not about
// how much of the country paired — and a ratio was the first test written. The
// Netherlands pairs 12 of 15 and the three it misses are in the Caribbean; a
// 90% threshold threw the whole country's detail away over them.
check(seamedRegion('FIX', { 'Fixture/Province': 1, 'Fixture/Capital': 1 }) === null,
  'an unpaired region an ocean away is no seam at all',
  String(seamedRegion('FIX', { 'Fixture/Province': 1, 'Fixture/Capital': 1 })));
check(seamedRegion('FIX', { 'Fixture/Province': 1, 'Fixture/Island': 1 }) === 'Capital',
  'one sitting inside a paired neighbour is',
  String(seamedRegion('FIX', { 'Fixture/Province': 1, 'Fixture/Island': 1 })));
check(seamedRegion('FIX', { 'Fixture/Province': 1, 'Fixture/Capital': 1, 'Fixture/Island': 1 }) === null,
  'and a complete set never is');

console.log('\nand arriving detail says so');
// The signal anything holding *built* geometry watches, so that it can tell its
// answer is now the blunt one. The image export fetches its own boundaries — it
// calls loadFineRegions directly, for every country in its frame — so a cache
// keyed only on the map's own comings and goings served the shapes it had built
// before the sharpening it had just waited on.
const before = fineRegionsVersion();
check(addFineRegions({ 'Fixture/Capital': poly([OUR_CAPITAL]) }) === 1, 'detail lands');
check(fineRegionsVersion() > before, 'and the version moves',
  `${before} → ${fineRegionsVersion()}`);
const still = fineRegionsVersion();
check(addFineRegions({ 'Nowhere/At all': poly([OUR_CAPITAL]) }) === 0, 'geometry for regions we do not have is ignored');
check(fineRegionsVersion() === still, '…and does not move it', `${still} → ${fineRegionsVersion()}`);

console.log('\nand a country whose regions never pair still gets an outline');
{
  // Hungary's 43 units against their 20, Luxembourg's three abolished districts
  // against their twelve cantons: there is nothing to pair, so there is nothing
  // to dissolve, so the country level had the shipped outline at every zoom.
  // ADM0 needs no pairing — it is one shape, and every country has one.
  const OUTLINE = poly([[[9, 49], [13, 49], [13, 53], [9, 53], [9, 49]]]);
  check(fineCountryOutline('NOP') === null, 'a country nothing has been fetched for has none');
  const before = fineRegionsVersion();
  check(addFineOutline('NOP', OUTLINE) === 1, 'an outline lands');
  check(fineRegionsVersion() > before, 'and the version moves, so anything holding built shapes rebuilds');
  check(fineCountryOutline('NOP') !== null, 'and the country now has a sharp shape');
  check(addFineOutline('NOP', OUTLINE) === 0, 'the same one twice is not news');
  // The gate that decides whether the map draws sharply at all used to count
  // only regions, so a fetched outline was something sharper to draw that
  // nothing would look at.
  check(fineRegionsLoaded(), 'and an outline on its own is enough to draw sharply');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
