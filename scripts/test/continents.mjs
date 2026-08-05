// The coarsest zoom level: which continent a cell is on, and what the label on
// it counts.
//
// A continent here is not an outline of its own — it is the countries of
// src/countries.json dissolved together, and a cell reaches it through the
// country the level below already put it in. That is the property worth pinning:
// the two coarsest levels cannot disagree about where a cell is, because one of
// them is derived from the other. The cases below check that from both ends,
// and cover the two ways the membership table can be wrong — a country nobody
// placed, and an island Natural Earth files under the open ocean.
//
//   node scripts/test/continents.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaOfCell } from '../../src/stats.js';
import { loadCountries, allCountries, countryNear } from '../../src/countries.js';
import {
  continentOf, continentGeometry, continentAreaKm2, continentAnchor, countriesInContinent,
  mergeContinents,
} from '../../src/continents.js';
import { inPolygon } from '../../src/polygon.js';
import { pointToCell, mercX, mercY, colsOf, normCol } from '../../src/hexgrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

await loadCountries(JSON.parse(await readFile(path.join(ROOT, 'src', 'countries.json'), 'utf8')));

const COLS = colsOf(0);
/** The stored cell one coordinate falls in — the same level everything imports at. */
const cellAt = (lng, lat) => {
  const [col, row] = pointToCell(0, mercX(lng), mercY(lat));
  return `0/${normCol(col, COLS)}/${row}`;
};

// Town centres, one per continent, plus the awkward cases: Istanbul because
// Natural Earth calls all of Turkey Asia, and Malé because the Maldives is
// filed under the open ocean and had to be placed by hand.
const PLACES = {
  Bern: [7.447, 46.948],
  Tokyo: [139.767, 35.681],
  Nairobi: [36.822, -1.292],
  'Buenos Aires': [-58.381, -34.603],
  Chicago: [-87.63, 41.878],
  Auckland: [174.763, -36.848],
  Istanbul: [28.979, 41.008],
  'Malé': [73.509, 4.175],
};

console.log('a cell is on the continent of the country it is in');

const EXPECTED = {
  Bern: 'Europe',
  Tokyo: 'Asia',
  Nairobi: 'Africa',
  'Buenos Aires': 'South America',
  Chicago: 'North America',
  Auckland: 'Oceania',
  Istanbul: 'Asia',
  'Malé': 'Asia',
};

for (const [place, want] of Object.entries(EXPECTED)) {
  const got = areaOfCell('continent', cellAt(...PLACES[place]));
  check(got === want, `${place} is in ${want}`, got);
}

// The whole point of deriving one from the other. If this can be made to fail,
// a cell is lit on a continent the country level says it isn't on.
{
  const disagree = Object.keys(PLACES).filter((p) => {
    const id = cellAt(...PLACES[p]);
    return areaOfCell('continent', id) !== continentOf(areaOfCell('country', id));
  });
  check(!disagree.length, 'and on the continent of whatever country the level below names', disagree.join(', '));
}

// Open sea is nowhere, at both levels — the mid-Atlantic, well past the 5 km
// `countryNear` looks around a coast.
{
  const id = cellAt(-30, 25);
  check(areaOfCell('country', id) === null && areaOfCell('continent', id) === null,
    'a cell in the mid-Atlantic is on no continent at all');
}

console.log('\nevery country the map draws is on a continent');

// A country with no continent is drawn at the country level and then vanishes
// one zoom out — a hole in the middle of a landmass, which reads as a bug and
// is one. Natural Earth files eight of them under "Seven seas (open ocean)";
// scripts/build-continents.mjs places those by hand.
{
  const orphans = allCountries().filter((c) => !continentOf(c.id)).map((c) => c.id);
  check(!orphans.length, 'no country falls through the membership table', orphans.join(', '));
}

// Three of the eight are sovereign states somebody can spend a fortnight in.
{
  const islands = { Mauritius: 'Africa', Seychelles: 'Africa', Maldives: 'Asia' };
  const wrong = Object.entries(islands).filter(([id, want]) => continentOf(id) !== want);
  check(!wrong.length, 'the ocean islands are placed, not dropped',
    wrong.map(([id]) => `${id}: ${continentOf(id)}`).join(', '));
}

console.log('\nthe shapes are the countries dissolved');

// Every continent has to be drawable and labellable, or a lit one shows as
// nothing at all.
{
  const names = [...new Set(allCountries().map((c) => continentOf(c.id)).filter(Boolean))];
  check(names.length === 7, 'there are seven of them', names.join(', '));
  const undrawable = names.filter((n) => !continentGeometry(n));
  check(!undrawable.length, 'each one dissolves to a shape', undrawable.join(', '));
  const unplaced = names.filter((n) => !continentAnchor(n));
  check(!unplaced.length, 'and has somewhere to put its label', unplaced.join(', '));
}

// The dissolved shape has to contain the countries it was made of. Bern is
// inside Europe and outside Africa — if the union dropped or misplaced a
// polygon this is where it shows.
{
  const inside = (name, [lng, lat]) => {
    const g = continentGeometry(name);
    return !!g && g.coordinates.some((poly) => inPolygon(lng, lat, poly));
  };
  check(inside('Europe', PLACES.Bern), 'Bern is inside the dissolved Europe');
  check(!inside('Africa', PLACES.Bern), 'and not inside Africa');
  check(inside('Africa', PLACES.Nairobi), 'Nairobi is inside the dissolved Africa');
}

// A union of two continents holds both, and holds them as one feature set — the
// same call the map makes for the lit set.
{
  const { fill, rings } = mergeContinents(new Set(['Europe', 'Africa']));
  const has = ([lng, lat]) => fill.some((poly) => inPolygon(lng, lat, poly));
  check(fill.length > 0 && rings.length >= fill.length, 'merging two continents gives a fill and its rings',
    `${fill.length} polygons, ${rings.length} rings`);
  check(has(PLACES.Bern) && has(PLACES.Nairobi), 'holding both of them');
  check(!has(PLACES.Tokyo), 'and not a third');
}

console.log('\nthe numbers on the label');

// A country belongs to one continent whole, and Natural Earth — like the UN's
// M49 scheme — puts all of Russia in Europe and all of Turkey in Asia. So
// Europe is 23M km² here rather than the 10M an atlas prints, and Asia is 31M
// rather than 45M. That is the deliberate answer: splitting a country across
// two continents would break both the shape (which is its countries dissolved)
// and the count (which would then have to place Russia twice, or nowhere).
{
  const km2 = { Europe: continentAreaKm2('Europe'), Asia: continentAreaKm2('Asia') };
  check(continentOf('Russia') === 'Europe', 'Russia is filed under Europe, whole', continentOf('Russia'));
  check(continentOf('Turkey') === 'Asia', 'and Turkey under Asia, whole', continentOf('Turkey'));
  check(km2.Europe > km2.Asia / 2, 'which is why Europe is the size it is here', `${Math.round(km2.Europe / 1e6)}M km²`);
}

// The denominators, against the figures those choices imply. Loose bounds:
// these are simplified 1:50m outlines with the detached territories stripped,
// so the answer is meant to be the right order of magnitude and not a survey.
{
  const bands = {
    Africa: [28e6, 32e6],
    Asia: [29e6, 34e6],
    Europe: [21e6, 25e6],
    'South America': [17e6, 19e6],
  };
  for (const [name, [lo, hi]] of Object.entries(bands)) {
    const km2 = continentAreaKm2(name);
    check(km2 > lo && km2 < hi, `${name} is ${Math.round(km2 / 1e6)}M km²`, Math.round(km2).toLocaleString());
  }
}

// The count each continent can offer as a denominator has to match what the
// membership table actually holds, or "12 countries" is counted against a set
// nothing else uses.
{
  const tally = new Map();
  for (const c of allCountries()) {
    const n = continentOf(c.id);
    if (n) tally.set(n, (tally.get(n) ?? 0) + 1);
  }
  const wrong = [...tally].filter(([n, count]) => countriesInContinent(n) !== count);
  check(!wrong.length, 'countriesInContinent counts the countries in it', wrong.map(([n]) => n).join(', '));
}

// The map resolves a *tap* through countryNear rather than through a cell, and
// the card it opens has to name the same continent the fill was built from.
{
  const wrong = Object.entries(PLACES).filter(([, [lng, lat]]) => {
    const country = countryNear(lng, lat);
    return continentOf(country?.id) !== areaOfCell('continent', cellAt(lng, lat));
  });
  check(!wrong.length, 'a tap resolves to the continent the cells under it lit', wrong.map(([p]) => p).join(', '));
}

// "Countries visited" is the distinct countries among the cells, grouped by
// continent — the same answers the fill is built from, read a second way. If
// these ever came from separate lookups the card could say four while the map
// lit three, which is the failure the whole level is arranged to prevent.
{
  const cells = Object.values(PLACES).map(([lng, lat]) => cellAt(lng, lat));
  const perContinent = new Map();
  for (const id of cells) {
    const country = areaOfCell('country', id);
    const name = continentOf(country);
    if (!name) continue;
    if (!perContinent.has(name)) perContinent.set(name, new Set());
    perContinent.get(name).add(country);
  }
  check(perContinent.get('Asia')?.size === 3, 'three countries counted in Asia',
    [...(perContinent.get('Asia') ?? [])].join(', '));
  check(perContinent.get('Europe')?.size === 1, 'and one in Europe',
    [...(perContinent.get('Europe') ?? [])].join(', '));
  // Every continent the count is offered for is one the fill lights, and never
  // more of them: the numerator cannot outrun its own denominator either.
  const overCounted = [...perContinent].filter(([n, seen]) => seen.size > countriesInContinent(n));
  check(!overCounted.length, 'no continent counts more countries than it has',
    overCounted.map(([n]) => n).join(', '));
}

console.log('\nsomewhere you have never been is still a shape with answers');

// A tap on an empty country or continent now opens a card rather than closing
// one, so everything that card is built from has to answer without a single
// cell involved. Ground covered is the only row that needs the history; the
// name, the size and the denominator are facts about the world.
{
  const empty = [
    ['Kazakhstan', [67.0, 48.0], 'Asia'],
    ['Chad', [18.5, 15.0], 'Africa'],
    ['Mongolia', [103.0, 46.5], 'Asia'],
  ];
  for (const [want, [lng, lat], continent] of empty) {
    const country = countryNear(lng, lat);
    const name = continentOf(country?.id);
    check(country?.id === want && name === continent,
      `a tap in the middle of ${want} resolves to ${want} and ${continent}`,
      `${country?.id} / ${name}`);
  }
  // The denominators the empty card prints: "0 of 54" and a size in km². A zero
  // here would read as "this continent has no countries", which is worse than
  // no card at all — the thing the fall-through used to give.
  const denominators = ['Asia', 'Africa'].filter(
    (n) => !(countriesInContinent(n) > 0 && continentAreaKm2(n) > 0),
  );
  check(!denominators.length, 'and to a denominator to be nought out of', denominators.join(', '));
}

// Open sea still has no shape, so the tap still falls through to the cell card
// and closes it. Somewhere you have not been is not the same as nowhere.
{
  const [lng, lat] = [-30, 25];
  check(countryNear(lng, lat) === null, 'the mid-Atlantic resolves to no country');
  check(continentOf(countryNear(lng, lat)?.id) === null, 'and to no continent, so no card opens there');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
