// Trips: the reading of the rows that turns cells and routes into "Iceland,
// last August".
//
// Nothing about a trip is stored, so every property of one is an argument about
// the data rather than a lookup — which is exactly the kind of thing that is
// wrong in a way nobody notices until a holiday is missing from the list. The
// cases below are the ones the derivation has to get right: home is where you
// keep going back to and not a trip; a weekend away is; two weekends a month
// apart are two trips and not one long one; and a day with a bad clock on it
// doesn't invent a journey.
//
//   node scripts/test/trips.mjs

import { buildTrips, findHome, activeDays, dayDetail, dayKey, distanceKm } from '../../src/trips.js';
import { cellCenter, project } from '../../src/hexgrid.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400;
const T = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// Cells are addressed the way the map addresses them, so the coordinates below
// are real: this walks out from a known cell rather than inventing ids.
import { pointToCell, mercX, mercY, colsOf, normCol } from '../../src/hexgrid.js';
const idAt = (lng, lat, L = 0) => {
  const [c, r] = pointToCell(L, mercX(lng), mercY(lat));
  return `${L}/${normCol(c, colsOf(L))}/${r}`;
};

// A patch of cells around a point, each with the dates given.
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

// --- Home ---------------------------------------------------------------------
console.log('\nfinding home');
// Bern, visited constantly; Zermatt, visited once.
const homeCells = patch(7.44, 46.95, 6, T('2024-01-01'), T('2024-12-31'), 400);
const awayCells = patch(7.75, 46.02, 6, T('2024-08-10'), T('2024-08-12'), 1);
const home = findHome(merge(homeCells, awayCells));
check(!!home, 'a home is found');
check(distanceKm(home.lng, home.lat, 7.44, 46.95) < 5, 'and it is where the visits are, not where the trip was',
  `${distanceKm(home.lng, home.lat, 7.44, 46.95).toFixed(1)} km off`);

// --- Away, and not away -------------------------------------------------------
console.log('\ntelling a trip from a Tuesday');
const trips = buildTrips(merge(homeCells, awayCells), []);
check(trips.length === 1, 'the week away is one trip', `${trips.length} trips`);
check(trips[0].cells.length === 6, 'with the cells it covered', String(trips[0].cells.length));
check(trips[0].farKm > 90, 'and it knows how far from home it was', `${trips[0].farKm} km`);
check(!trips.some((t) => t.cells.some((c) => homeCells.has(c))), 'living at home is not a trip');

// Two weekends a month apart are two trips, not one five-week one.
const augCells = patch(7.75, 46.02, 5, T('2024-08-10'));
const sepCells = patch(8.55, 47.37, 5, T('2024-09-14'));
const two = buildTrips(merge(homeCells, augCells, sepCells), []);
check(two.length === 2, 'a month apart is two trips', `${two.length}`);
check(two[0].start > two[1].start, 'newest first');
check(dayKey(two[1].start) === '2024-08-10', 'dated by when they happened', dayKey(two[1].start));

// Consecutive days are one trip, not one per day.
const d1 = patch(7.75, 46.02, 4, T('2024-08-10'));
const d2 = patch(7.76, 46.03, 4, T('2024-08-11'));
const d3 = patch(7.77, 46.04, 4, T('2024-08-12'));
const run = buildTrips(merge(homeCells, d1, d2, d3), []);
check(run.length === 1, 'three days in a row are one trip', `${run.length}`);
check(run[0].days === 3, 'three days long', `${run[0].days}`);

// A week away arrives as a crowd of arrival dates and a crowd of departure
// dates with six days of silence between them — one stay, not two trips.
const stay = patch(7.75, 46.02, 8, T('2024-08-10'), T('2024-08-16'));
const week = buildTrips(merge(homeCells, stay), []);
check(week.length === 1, 'a week in one place is one trip, not two', `${week.length}`);
check(week[0].days === 7, 'and it lasted a week', `${week[0].days} days`);

// A weekend is two days, not one: both ends of a cell's span count even when
// they are close together.
const weekend = patch(7.75, 46.02, 6, T('2024-08-10'), T('2024-08-11'));
const wknd = buildTrips(merge(homeCells, weekend), []);
check(wknd.length === 1 && wknd[0].days === 2, 'a weekend away lasts two days', `${wknd[0]?.days}`);

// The same place months apart is still two trips — the rejoining is bounded.
// This is how the storage actually says it: one row per cell, first seen in
// August and last seen in December, which is two visits and not a four-month
// stay. (Same cell ids, so it has to be one patch — a second patch at the same
// coordinates would just overwrite the first.)
const twice = patch(7.75, 46.02, 6, T('2024-08-10'), T('2024-12-20'), 2);
check(buildTrips(merge(homeCells, twice), []).length === 2, 'twice in a year is twice',
  String(buildTrips(merge(homeCells, twice), []).length));

// --- What isn't a trip --------------------------------------------------------
console.log('\nwhat is not a trip');
const stray = patch(7.75, 46.02, 1, T('2024-08-10'));
check(buildTrips(merge(homeCells, stray), []).length === 0, 'a single stray cell is not a journey');
// …unless it drew a line, which is a thing you actually did.
const route = { id: 1, name: 'Ride', firstAt: T('2024-08-10T09:00'), lastAt: T('2024-08-10T11:00'), lengthM: 42000, bounds: [7.7, 46.0, 7.8, 46.05], place: 'Zermatt' };
const withRoute = buildTrips(merge(homeCells, stray), [route]);
check(withRoute.length === 1, 'a stray cell with a route is', `${withRoute.length}`);
check(withRoute[0].routes.length === 1 && withRoute[0].lengthM === 42000, 'and carries the route and its distance');

// Cells with no date at all cannot be placed in time and must not invent one.
const undated = new Map([['0/5/5', [{ source: 'manual', addedAt: T('2024-08-10'), firstAt: 0, lastAt: 0, hits: 1, fixes: 0 }]]]);
check(buildTrips(merge(homeCells, undated), []).length === 0, 'undated cells make no trip');

// With no home yet — one import of one holiday — everything counts, because
// then the whole map is somewhere you went.
const fresh = buildTrips(augCells, [], { home: null });
check(fresh.length === 1, 'a map with no home still finds its trip', `${fresh.length}`);

// --- The calendar -------------------------------------------------------------
console.log('\ndays');
const days = activeDays(merge(homeCells, augCells), [route]);
check(days.get('2024-08-10')?.cells === 5, 'the calendar knows how many cells a day added', JSON.stringify(days.get('2024-08-10')));
check(days.get('2024-08-10')?.routes === 1, 'and how many routes ran');
check(!days.has('2024-08-11'), 'a day nothing happened on has no dot');

const detail = dayDetail('2024-08-10', two, [route], merge(homeCells, augCells));
check(detail.routes.length === 1, 'a day opens on its routes');
check(detail.newCells === 5, 'and its new cells', String(detail.newCells));

// The last day of a stay is a day the data actually carries, so it is lit too —
// and it is not new ground, which the two counts keep apart.
const span = patch(7.75, 46.02, 4, T('2024-08-10'), T('2024-08-16'));
const spanDays = activeDays(span, []);
check(spanDays.has('2024-08-10') && spanDays.has('2024-08-16'), 'both ends of a stay get a dot');
check(!spanDays.has('2024-08-13'), 'the quiet middle does not — nothing says you were there');
const lastDay = dayDetail('2024-08-16', [], [], span);
check(lastDay.cells === 4 && lastDay.newCells === 0, 'the last day recorded cells but no new ones',
  `${lastDay.cells} cells, ${lastDay.newCells} new`);
check(detail.trip?.id === two[1].id, 'and says which trip it belonged to');
check(dayDetail('2024-08-11', two, [route], merge(homeCells, augCells)).routes.length === 0, 'an empty day is empty');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
