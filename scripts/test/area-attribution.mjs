// Which region a cell belongs to — the question the map's region level and the
// statistics panel both ask, and for a long time answered differently.
//
// The map used to resolve a cell's region from the centre of the 9 km hexagon
// it had been rolled up into. Plenty of regions are smaller than that hexagon,
// so the centre regularly landed somewhere the cells did not: a real map lit
// Appenzell Innerrhoden and reported "3 visits" off seven cells that were all
// in Sankt Gallen, and did the same to Liechtenstein's Mauren and the Aosta
// Valley. The statistics panel, reading each cell where it actually is, listed
// none of the three — so the map and the panel disagreed about the same rows,
// and the panel was right.
//
// The cases below pin the fix from both ends: a cell is attributed to the
// region it is in and not to whichever region a hexagon around it is centred
// on, and the set of regions the map lights is exactly the set the statistics
// count. The fixtures are named towns rather than anyone's history — the bug
// is a property of the geometry, and needs no location data to show.
//
//   node scripts/test/area-attribution.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaOfCell, computeStats } from '../../src/stats.js';
import { loadCountries, countryAreaKm2 } from '../../src/countries.js';
import { loadRegions } from '../../src/regions.js';
import { pointToCell, mercX, mercY, colsOf, normCol, parentOf } from '../../src/hexgrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (name) => JSON.parse(await readFile(path.join(ROOT, 'src', name), 'utf8'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

await Promise.all([loadCountries(await json('countries.json')), loadRegions(await json('regions.json'))]);

const COLS = colsOf(0);
/** The stored cell one coordinate falls in — the same level everything imports at. */
function cellAt(lng, lat) {
  const [col, row] = pointToCell(0, mercX(lng), mercY(lat));
  return `0/${normCol(col, COLS)}/${row}`;
}

/** The cell as the old code saw it: rolled up to level 2, ~9 km across. */
function rolledUp(id, level = 2) {
  let [L, col, row] = id.split('/').map(Number);
  for (let l = L; l < level; l++) [col, row] = parentOf(l, col, row);
  return `${level}/${col}/${row}`;
}

// Eastern Switzerland is the sharpest test there is: Appenzell Innerrhoden is
// 172 km² and entirely surrounded by two neighbours, the Austrian border runs
// down the Rhine a few kilometres east, and Liechtenstein's communes are
// smaller still. Coordinates are town centres.
const TOWNS = {
  'Gais AR': [9.457, 47.361],
  'Rüthi SG': [9.535, 47.29],
  'Altstätten SG': [9.548, 47.377],
  'Sennwald SG': [9.481, 47.263],
  'Herisau AR': [9.279, 47.386],
  'Appenzell AI': [9.409, 47.331],
};
const cellFor = (town) => cellAt(...TOWNS[town]);

console.log('a cell is attributed to the region it is actually in');

// Gais is in Appenzell Ausserrhoden, and the 9 km hexagon it rolls up into is
// centred in Innerrhoden. This one case is the whole bug.
{
  const id = cellFor('Gais AR');
  const own = areaOfCell('region', id);
  const hex = areaOfCell('region', rolledUp(id));
  check(own === 'Switzerland/Appenzell Ausserrhoden', 'Gais is in Appenzell Ausserrhoden', own);
  check(
    hex === 'Switzerland/Appenzell Innerrhoden' && hex !== own,
    'and the 9 km hexagon around it is not — which is what used to decide',
    `hexagon said ${hex}`,
  );
}

// The same failure across a national border, which is worse: the roll-up put
// Swiss cells in an Austrian state.
{
  const id = cellFor('Rüthi SG');
  const own = areaOfCell('region', id);
  check(own === 'Switzerland/Sankt Gallen', 'Rüthi is in Sankt Gallen', own);
  check(areaOfCell('country', id) === 'Switzerland', 'and in Switzerland', areaOfCell('country', id));
  check(
    areaOfCell('region', rolledUp(id)) === 'Austria/Vorarlberg',
    'while its 9 km hexagon lands in Austria',
    areaOfCell('region', rolledUp(id)),
  );
}

// The fix must not go the other way: a cell genuinely inside a small region
// still lights it.
{
  const own = areaOfCell('region', cellFor('Appenzell AI'));
  check(own === 'Switzerland/Appenzell Innerrhoden', 'a cell in Appenzell Innerrhoden lights it', own);
}

console.log('\nno region is lit without a cell in it');

// Five towns, none of them in Appenzell Innerrhoden, all of them within a few
// kilometres of it.
const AROUND = ['Gais AR', 'Rüthi SG', 'Altstätten SG', 'Sennwald SG', 'Herisau AR'];
const cells = AROUND.map(cellFor);
const lit = new Set(cells.map((id) => areaOfCell('region', id)).filter(Boolean));
const litByRollUp = new Set(cells.map((id) => areaOfCell('region', rolledUp(id))).filter(Boolean));

check(
  !lit.has('Switzerland/Appenzell Innerrhoden'),
  'a map with no cell in Appenzell Innerrhoden does not light it',
  [...lit].join(', '),
);
check(
  litByRollUp.has('Switzerland/Appenzell Innerrhoden'),
  'the roll-up this replaced did light it, so the case is a real one',
);

// The general form, which is what would catch a future roll-up creeping back
// in: every region the map lights has to hold a cell that says so itself.
{
  const orphans = [...lit].filter((r) => !cells.some((id) => areaOfCell('region', id) === r));
  check(!orphans.length, 'every lit region holds at least one of the cells', orphans.join(', '));
}

console.log('\nthe map and the statistics panel agree');

// Same cells, both readings. The panel has always resolved per cell; the point
// of the fix is that the map now does too, so the two sets must be identical.
{
  const stats = await computeStats(cells, new Map());
  const counted = new Set(stats.regions.map((r) => r.id));
  const missing = [...counted].filter((r) => !lit.has(r));
  const extra = [...lit].filter((r) => !counted.has(r));
  check(!missing.length && !extra.length, 'the lit regions are exactly the counted regions',
    `lit-only ${extra.join(', ') || 'none'}; counted-only ${missing.join(', ') || 'none'}`);
  check(
    !counted.has('Switzerland/Appenzell Innerrhoden'),
    'and neither of them counts Appenzell Innerrhoden',
  );
}

console.log('\na state is not an overseas territory');

// Alaska used to be missing from the country dataset outright.
// `stripDetachedTerritories` drops pieces more than 6° from the mainland so
// that one cell in French Guiana doesn't light the whole of France, and Alaska
// is 7.6° from Washington state — so it was dropped along with the colonies.
// That did not merely leave it unlit: `countryAt` returned null there, so an
// Alaskan cell was in no country, counted as ocean by the coverage sweep,
// named "at sea or off the map", and left a hole in North America at the
// continent level. See src/geo-filter.js.
{
  const towns = { Anchorage: [-149.9, 61.22], Fairbanks: [-147.72, 64.84], Juneau: [-134.42, 58.3] };
  for (const [town, at] of Object.entries(towns)) {
    const country = areaOfCell('country', cellAt(...at));
    check(country === 'United States of America', `${town} is in the United States`, country);
  }
  const region = areaOfCell('region', cellAt(...towns.Anchorage));
  check(region === 'United States of America/Alaska', 'and in Alaska', region);
  // The region dataset always had Alaska — it is the *country* file that was
  // filtered — so before the fix the region lookup found nothing either, because
  // it is only ever asked inside the country a cell already resolved to.
  check(
    countryAreaKm2('United States of America') > 9e6,
    'the country it is part of is measured with it in',
    Math.round(countryAreaKm2('United States of America')).toLocaleString(),
  );
}

// The other half of the same rule: distance still drops what it is for. Both of
// these resolve to nothing, which is the deliberate cost of not letting a
// remote holding light a mainland — a Canary Islands cell is counted as ocean.
// Pinned so that widening the gap to rescue somewhere else has to face it.
{
  const away = { Honolulu: [-157.86, 21.31], 'Tenerife': [-16.55, 28.29], 'Cayenne': [-52.33, 4.92] };
  for (const [place, at] of Object.entries(away)) {
    const country = areaOfCell('country', cellAt(...at));
    check(country === null, `${place} is still outside the filtered outlines`, country);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
