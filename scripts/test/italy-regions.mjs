// Italy is held as its twenty regioni, not as Natural Earth's 110 province.
//
// Natural Earth files the province as Italy's admin-1 units, which is a level
// below the one the country is organised into and a level below what anyone
// means by "which parts of Italy have I been to". `scripts/build-regions.mjs`
// dissolves them by the regione Natural Earth already records on each one.
//
// It fixes the detailed boundaries at the same time, which is the other half of
// the reason. `server/regions-fine.js` picks a geoBoundaries level by unit
// count, and their Italian hierarchy is ADM1 = 5 macro-regions, ADM2 = the 20
// regioni, ADM3 = 107 province. At 110 units we paired against ADM3; at 20 we
// pair against ADM2 exactly.
//
// The fixtures are city centres and published region names — facts about Italy,
// not about anyone's history.
//
//   node scripts/test/italy-regions.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegions, regionNear, regionsInCountry, regionsOf } from '../../src/regions.js';
import { loadCountries } from '../../src/countries.js';
import { areaOfCell } from '../../src/stats.js';
import { pointToCell, mercX, mercY, colsOf, normCol } from '../../src/hexgrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (name) => JSON.parse(await readFile(path.join(ROOT, 'src', name), 'utf8'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

await Promise.all([loadRegions(await json('regions.json')), loadCountries(await json('countries.json'))]);

console.log('Italy is twenty regions');

check(regionsInCountry('ITA') === 20, 'the dataset holds 20 Italian regions', String(regionsInCountry('ITA')));

// All twenty, in the local short form the rest of the file uses — which is also
// the form geoBoundaries uses, so every one of them pairs by name.
const EXPECTED = [
  'Abruzzo', 'Basilicata', 'Calabria', 'Campania', 'Emilia-Romagna', 'Friuli-Venezia Giulia',
  'Lazio', 'Liguria', 'Lombardia', 'Marche', 'Molise', 'Piemonte', 'Puglia', 'Sardegna',
  'Sicilia', 'Toscana', 'Trentino-Alto Adige', 'Umbria', "Valle d'Aosta", 'Veneto',
];
{
  const got = [...regionsOf('ITA')].map((r) => r.name).sort();
  const missing = EXPECTED.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !EXPECTED.includes(n));
  check(!missing.length && !extra.length, 'and they are the twenty regioni',
    `missing ${missing.join(', ') || 'none'}; unexpected ${extra.join(', ') || 'none'}`);
  // The two Natural Earth gives in English. Getting these wrong is invisible
  // until someone reads the panel, and it also costs the name pairing.
  check(got.includes('Puglia') && !got.includes('Apulia'), 'Puglia is not "Apulia"');
  check(got.includes('Sicilia') && !got.includes('Sicily'), 'Sicilia is not "Sicily"');
}

console.log('\nand a cell lands in the right one');

const COLS = colsOf(0);
const cellAt = (lng, lat) => {
  const [c, r] = pointToCell(0, mercX(lng), mercY(lat));
  return `0/${normCol(c, COLS)}/${r}`;
};

// One city per region that used to be several provinces, plus the two islands
// and the two smallest — the cases a bad dissolve would break first.
const CITIES = [
  ['Milano', 9.19, 45.46, 'Lombardia'],
  ['Roma', 12.5, 41.9, 'Lazio'],
  ['Firenze', 11.26, 43.77, 'Toscana'],
  ['Napoli', 14.27, 40.85, 'Campania'],
  ['Bologna', 11.34, 44.49, 'Emilia-Romagna'],
  ['Palermo', 13.36, 38.12, 'Sicilia'],
  ['Bari', 16.87, 41.12, 'Puglia'],
  ['Cagliari', 9.11, 39.22, 'Sardegna'],
  ['Trieste', 13.77, 45.65, 'Friuli-Venezia Giulia'],
  ['Aosta', 7.32, 45.73, "Valle d'Aosta"],
  ['Bolzano', 11.35, 46.5, 'Trentino-Alto Adige'],
  ['Campobasso', 14.66, 41.56, 'Molise'],
];
for (const [city, lng, lat, want] of CITIES) {
  const got = areaOfCell('region', cellAt(lng, lat));
  check(got === `Italy/${want}`, `${city} is in ${want}`, String(got));
}

console.log('\nthe dissolve left no gaps between the provinces it merged');

// The union runs on raw Natural Earth geometry, before simplification, so the
// provinces still share exact vertices and nothing opens between them. Doing it
// the other way round is the failure documented against `unionGeometries`.
{
  const holes = [];
  for (const r of regionsOf('ITA')) {
    const polys = r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
    for (const poly of polys) for (let i = 1; i < poly.length; i++) holes.push({ id: r.id, pts: poly[i].length });
  }
  // Natural Earth's Italian provinces do not quite meet at several tripoints,
  // so the dissolve inherits 5–13 km² holes inland. `dropCoverageGaps` offers
  // each one to the rest of the dataset: ground nobody else claims is a gap in
  // the source's coverage and goes, ground a neighbouring region's province
  // does claim is that neighbour's and stays a hole. Two of the four are
  // dropped on those terms and two are kept, which is the whole point — the
  // test is that the question gets asked, not that every hole disappears.
  check(holes.length <= 3, 'the twenty regions hold almost no holes at all',
    `${holes.length}: ${holes.map((h) => `${h.id}/${h.pts}pts`).join(', ')}`);
  check(holes.every((h) => h.id === 'Italy/Marche' || h.id === 'Italy/Emilia-Romagna'),
    'and the ones kept are ground a neighbouring region claims',
    holes.map((h) => h.id).join(', '));
}

// A border point still resolves, which is what `regionNear`'s snapping is for —
// and Venice is the case that motivated it (see scripts/test/stats.mjs).
{
  const veneto = regionNear(12.3388, 45.4341, 'ITA');
  check(veneto?.name === 'Veneto', 'St Mark’s Square snaps to Veneto', String(veneto?.name));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
