// Coverage statistics: the numbers the Cells tab is made of, against the real
// boundary datasets.
//
// Everything here is arithmetic over 6 MB of shapes, which is exactly the kind
// of code that is quietly wrong — a percentage that divides by the wrong total,
// a region attributed to the wrong country, a count that says "5 of 3". The
// cases below pin the ones the panel shows: that a country's share is a share of
// that country, that every region lands under the country it belongs to and is
// counted against how many that country has, and that the day counts read the
// stored rows the same way the calendar does.
//
//   node scripts/test/stats.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, cellAreaKm2, EARTH_LAND_KM2 } from '../../src/stats.js';
import { loadCountries, countryAt } from '../../src/countries.js';
import { loadRegions, regionsInCountry } from '../../src/regions.js';
import { loadPlaces } from '../../src/places.js';
import { buildTrips, nameTrips } from '../../src/trips.js';
import { nearestTown } from '../../src/places.js';
import { regionNear } from '../../src/regions.js';
import { pointToCell, mercX, mercY, colsOf, normCol } from '../../src/hexgrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (name) => JSON.parse(await readFile(path.join(ROOT, 'src', name), 'utf8'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const T = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// Node can't import JSON without an attribute Vite dislikes, so each module
// takes the parsed data — the same door the build scripts use.
await Promise.all([
  loadCountries(await json('countries.json')),
  loadRegions(await json('regions.json')),
  loadPlaces(await json('places.json')),
]);

const idAt = (lng, lat, L = 0) => {
  const [c, r] = pointToCell(L, mercX(lng), mercY(lat));
  return `${L}/${normCol(c, colsOf(L))}/${r}`;
};

/** n cells walking east from a point, with the dates and visits given. */
function patch(lng, lat, n, firstAt, lastAt = firstAt, hits = 1) {
  const meta = new Map();
  const [L, col, row] = idAt(lng, lat).split('/').map(Number);
  for (let i = 0; i < n; i++) {
    meta.set(`${L}/${col + i}/${row}`, [{ source: 'test', addedAt: firstAt, firstAt, lastAt, hits, fixes: 0 }]);
  }
  return meta;
}
const merge = (...maps) => {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
};

// Bern (Switzerland), six days in Rome and a day trip to Florence (Italy), one
// day in Vienna (Austria).
const meta = merge(
  patch(7.44, 46.95, 40, T('2024-01-02'), T('2024-01-03'), 60),
  patch(12.49, 41.90, 10, T('2024-05-02'), T('2024-05-03'), 8),
  patch(12.47, 41.88, 10, T('2024-05-04'), T('2024-05-05'), 8),
  patch(12.51, 41.92, 10, T('2024-05-06'), T('2024-05-07'), 8),
  patch(11.25, 43.77, 30, T('2024-05-08')),
  patch(16.37, 48.21, 12, T('2024-09-14')),
);
const s = await computeStats(new Set(meta.keys()), meta);

console.log('\nwhat the panel says at the top');
check(s.cells === meta.size, 'every cell is counted', `${s.cells} of ${meta.size}`);
check(s.km2 > 0 && s.km2 < 200, 'a hundred-odd sub-kilometre cells cover a hundred-odd km²', `${s.km2.toFixed(1)} km²`);
check(Math.abs(s.worldPct - (s.km2 / EARTH_LAND_KM2) * 100) < 1e-9, 'the world share divides by the land area');
// Ground area shrinks with latitude, and the statistics are the only place that
// shows it: the same cell is worth less the further north it is.
check(cellAreaKm2(0, 60) < cellAreaKm2(0, 0) * 0.5, 'a cell at 60° is worth under half one at the equator',
  `${cellAreaKm2(0, 60).toFixed(3)} vs ${cellAreaKm2(0, 0).toFixed(3)} km²`);

console.log('\ncountries');
const byId = new Map(s.countries.map((c) => [c.id, c]));
check(byId.has('Switzerland') && byId.has('Italy') && byId.has('Austria'),
  'all three countries are found', [...byId.keys()].join(', '));
const ch = byId.get('Switzerland');
check(ch.pct > 0 && ch.pct < 1, 'a share is a share of that country, not of the biggest one on the list',
  `${ch.pct.toFixed(4)}%`);
check(Math.abs(ch.pct - (ch.km2 / ch.totalKm2) * 100) < 1e-9, 'and it is its own km² over its own total');
check(Math.abs(ch.totalKm2 - 41285) / 41285 < 0.05, 'Switzerland is about 41,285 km²', `${Math.round(ch.totalKm2)} km²`);
check(ch.iso === 'CHE', 'each country carries its ISO code, which is what the regions join on', String(ch.iso));
check(ch.regionsTotal === regionsInCountry('CHE') && ch.regionsTotal > 20,
  'and how many regions it has at all', `${ch.regionsTotal} cantons`);
// The bar is the share, so the biggest bar is no longer guaranteed to be full:
// this is the case that made the old one confusing.
check(Math.max(...s.countries.map((c) => c.pct)) < 5,
  'nothing on this list is anywhere near covered — no bar should be full',
  `${Math.max(...s.countries.map((c) => c.pct)).toFixed(3)}% at most`);

console.log('\nregions, under their country');
const regionsOf = (country) => s.regions.filter((r) => r.country === country);
check(regionsOf('Italy').length >= 1, 'Italy has regions', regionsOf('Italy').map((r) => r.name).join(', '));
check(regionsOf('Switzerland').length >= 1, 'so does Switzerland',
  regionsOf('Switzerland').map((r) => r.name).join(', '));
check(s.regions.every((r) => byId.has(r.country)),
  'every region belongs to a country that is on the list too');
check(s.regions.every((r) => r.pct > 0 && r.pct <= 100), 'and every region share is a percentage');
for (const c of s.countries) {
  const n = regionsOf(c.id).length;
  if (n) {
    check(n <= Math.max(n, c.regionsTotal), `${c.id} never says "${n} of fewer than ${n}"`, `${n} of ${c.regionsTotal}`);
    break;
  }
}
// Italy is divided into its 110 provinces in this dataset, not its 20 regions —
// which is why the level is chosen per country by unit count (see regions-fine)
// rather than assumed.
const roma = regionsOf('Italy').find((r) => /^(Roma|Lazio)$/i.test(r.name));
check(!!roma, 'the cells around Rome are attributed to the province of Roma',
  regionsOf('Italy').map((r) => r.name).join(', '));
check(roma && roma.km2 <= byId.get('Italy').km2 + 1e-9, 'and a region can never cover more than its country');
check(s.regionsReachable >= s.regions.length, 'the region denominator holds the regions of the countries visited',
  `${s.regions.length} of ${s.regionsReachable}`);

console.log('\ndays');
// Both ends of every stored row, and nothing in between — the same reading the
// calendar dots use. Two days in January, the seven of the Italian trip, one in
// September.
check(s.days === 10, 'the days the history actually carries', `${s.days}`);
check(s.streakDays === 7, 'the longest run of them', `${s.streakDays}`);
check(s.streakEnd === '2024-05-08', 'and when that run ended', s.streakEnd);

console.log('\nnaming a trip from the real datasets');
// The whole point of naming by evidence rather than by the middle. This trip is
// six days in Rome and a day out to Florence; the point halfway between them is
// a hill town in the province of Viterbo, and "Montefiascone" is what the middle
// used to call a week in Rome.
const trips = buildTrips(meta, []);
const at = (lng, lat) => {
  const country = countryAt(lng, lat);
  const town = nearestTown(lng, lat);
  const region = country ? regionNear(lng, lat, country.iso) : null;
  return {
    town: town?.name, pop: town?.pop ?? 0,
    region: region?.name, regionId: region?.id,
    country: country?.id ?? undefined,
  };
};
nameTrips(trips, at);
const italy = trips.find((t) => t.country === 'Italy');
check(!!italy, 'the Italian trip is found', trips.map((t) => t.name).join(' | '));
// Proof the case discriminates: the old name is still there to be asked for.
const middle = at(italy.center[0], italy.center[1]);
check(middle.town !== 'Rome' && middle.region !== 'Roma',
  'the middle of it is nowhere it stayed', `${middle.town}, ${middle.region}`);
check(italy?.name === 'Rome, Italy', 'and it is named after Rome anyway', italy?.name);
check(/^(Roma|Lazio)$/i.test(italy?.region ?? ''), 'from the region it spent the week in', italy?.region);
const vienna = trips.find((t) => t.country === 'Austria');
check(vienna?.name === 'Vienna, Austria', 'the day in Vienna is named too', vienna?.name);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
