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

import {
  buildTrips, nameTrips, findHome, activeDays, dayDetail, dayKey, distanceKm, longestStreak,
} from '../../src/trips.js';
import { cellCenter, project } from '../../src/hexgrid.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400;
// Local midday for a bare date, not UTC midnight. Which day a timestamp belongs
// to is worked out in local time (dayKey), so a fixture pinned to midnight UTC
// lands on the day before for anyone west of Greenwich, and the calendar
// assertions below quietly failed there.
const T = (iso) => Math.floor(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).getTime() / 1000);

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

// --- The western hemisphere ---------------------------------------------------
// Cell columns count east from the antimeridian, so a projected cell centre in
// Iceland is longitude 338, not −22 — and a bounding box from 338 to 338.1 asks
// the map to frame the planet. This is the bug that made clicking a trip zoom
// all the way out.
console.log('\nlongitudes');
const iceland = patch(-21.94, 64.15, 5, T('2025-06-03'), T('2025-06-09'));
const ice = buildTrips(merge(homeCells, iceland), []);
check(ice.length === 1, 'a trip in the western hemisphere is found');
check(ice[0].bbox[0] >= -180 && ice[0].bbox[2] <= 180, 'and its box is in real longitudes',
  ice[0].bbox.map((n) => n.toFixed(1)).join(', '));
check(Math.abs(ice[0].center[0] + 21.94) < 1, 'centred where it actually is', String(ice[0].center[0]));
check(ice[0].bbox[2] - ice[0].bbox[0] < 2, 'and no wider than the place it covers',
  String(ice[0].bbox[2] - ice[0].bbox[0]));

// --- Naming -------------------------------------------------------------------
// A trip is named after where it mostly *was*, which is not where its middle is.
// The datasets that answer "what is at this coordinate" are 6 MB of lazy chunks,
// so the cases below hand naming a pretend gazetteer of longitude bands: the
// argument being tested is which places a trip weighs most, not which shapes are
// where.
console.log('\nnaming');

const gazetteer = (bands, country = 'Italy') => (lng) => {
  const b = bands.find((x) => lng < x.to) ?? bands[bands.length - 1];
  return b.empty
    ? {}
    : { region: b.region, regionId: `${country}/${b.region}`, country, town: b.town, pop: b.pop };
};

// Rome for a week, and a day's drive down the motorway through Abruzzo. The
// drive lights nearly seven times as much ground as the week does — the point
// of the test is that the week still wins.
const italy = gazetteer([
  { to: 12.9, region: 'Lazio', town: 'Rome', pop: 2600 },
  { to: 13.9, region: 'Abruzzo', town: 'Avezzano', pop: 42 },
  { to: 99, region: 'Campania', town: 'Naples', pop: 950 },
]);
const rome = merge(
  patch(12.40, 41.90, 2, T('2024-05-02'), T('2024-05-03'), 6),
  patch(12.50, 41.92, 2, T('2024-05-04'), T('2024-05-05'), 6),
  patch(12.60, 41.94, 2, T('2024-05-06'), T('2024-05-07'), 6),
);
const motorway = patch(13.20, 42.10, 40, T('2024-05-08'));
const holiday = buildTrips(merge(homeCells, rome, motorway), []);
check(holiday.length === 1, 'the week and the drive home are one trip', `${holiday.length}`);
nameTrips(holiday, italy);
// Proof that the case discriminates: the middle of the trip is out on the
// motorway, which is what the name used to be taken from.
check(italy(holiday[0].center[0]).region === 'Abruzzo',
  'the middle of it is in the region it only drove through', italy(holiday[0].center[0]).region);
check(holiday[0].name === 'Rome, Italy', 'and it is named after the week, not the drive', holiday[0].name);
check(holiday[0].region === 'Lazio', 'and it knows the region that won', holiday[0].region);

// Within the winning region, the name is the biggest place — nobody calls a week
// in Rome "Fiumicino" — as long as the time spent is comparable.
const lazio = gazetteer([
  { to: 12.55, region: 'Lazio', town: 'Fiumicino', pop: 80 },
  { to: 99, region: 'Lazio', town: 'Rome', pop: 2600 },
]);
const both = merge(
  patch(12.40, 41.80, 6, T('2024-05-02'), T('2024-05-03'), 3),
  patch(12.70, 41.90, 6, T('2024-05-02'), T('2024-05-03'), 3),
);
const evenly = buildTrips(merge(homeCells, both), []);
nameTrips(evenly, lazio);
check(evenly[0].name === 'Rome, Italy', 'two towns, same days: the city takes the name', evenly[0].name);

// …but time still decides. A week in the village beats an afternoon in the city.
const village = merge(
  patch(12.40, 41.80, 6, T('2024-05-02'), T('2024-05-08'), 20),
  patch(12.40, 41.86, 6, T('2024-05-04'), T('2024-05-06'), 20),
  patch(12.70, 41.90, 2, T('2024-05-05'), T('2024-05-05'), 1),
);
const stayed = buildTrips(merge(homeCells, village), []);
nameTrips(stayed, lazio);
check(stayed[0].name === 'Fiumicino, Italy', 'a week in the small place beats an afternoon in the big one',
  stayed[0].name);

// Ground that resolves to nothing is not a place you were. The country outlines
// are rounded to ~1 km, so cells just off a coast fall outside every country —
// and pooling all of them into one nameless region let four days at sea out-day
// the city the trip was actually in.
const aegean = gazetteer([
  { to: 12.0, empty: true }, // open water: the datasets have nothing here
  { to: 99, region: 'Attiki', town: 'Athens', pop: 3150 },
], 'Greece');
const sailing = merge(
  patch(10.60, 41.00, 4, T('2024-07-03'), T('2024-07-04'), 3),
  patch(11.40, 41.20, 4, T('2024-07-05'), T('2024-07-06'), 3),
  patch(12.50, 41.90, 20, T('2024-07-01'), T('2024-07-02'), 30),
  patch(12.70, 41.95, 20, T('2024-07-07'), T('2024-07-07'), 30),
);
const sailed = buildTrips(sailing, [], { home: null });
nameTrips(sailed, aegean);
check(sailed.length === 1, 'the sailing week is one trip', `${sailed.length}`);
check(sailed[0].name === 'Athens, Greece', 'four days at sea do not outvote three days in the city',
  sailed[0].name);
check(sailed[0].country === 'Greece', 'and the trip keeps the country, so the search box can find it',
  `region=${sailed[0].region} country=${sailed[0].country}`);

// Visits are the tie-break under days — and they belong to the stored row, not
// to each end of it. Both towns here are the same size and were seen on the same
// two days, so only the visit counts can decide: Aville's two cells each span
// both days (one row, two events) for 10 visits, Bville's two don't, for 14.
// Counting a row's visits at both of its ends would make Aville 20 and flip it.
const evenSize = gazetteer([
  { to: 12.55, region: 'Lazio', town: 'Aville', pop: 80 },
  { to: 99, region: 'Lazio', town: 'Bville', pop: 80 },
]);
const visits = merge(
  patch(12.40, 41.80, 2, T('2024-05-02'), T('2024-05-03'), 5),
  patch(12.70, 41.90, 1, T('2024-05-02'), T('2024-05-02'), 7),
  patch(12.70, 41.95, 1, T('2024-05-03'), T('2024-05-03'), 7),
);
const tie = buildTrips(merge(homeCells, visits), []);
nameTrips(tie, evenSize);
check(tie[0].name === 'Bville, Italy', 'visits break a tie between places seen on the same days, counted once',
  tie[0].name);

// A trip that is nothing but a route still has a position and a date, so it
// still has a name.
const ride = { id: 7, name: 'Ride', firstAt: T('2024-06-01T09:00'), lastAt: T('2024-06-01T12:00'), lengthM: 60000, bounds: [12.3, 41.8, 12.5, 41.95] };
const rideTrip = buildTrips(new Map(), [ride], { home: null });
nameTrips(rideTrip, italy);
check(rideTrip.length === 1 && rideTrip[0].name === 'Rome, Italy', 'a route on its own is named too',
  rideTrip[0]?.name);

// Nowhere on the map: say what kind of nowhere, and take a landmark over
// nothing at all.
const nowhere = buildTrips(merge(patch(-30.0, 35.0, 5, T('2024-07-01'), T('2024-07-04'))), [], { home: null });
nameTrips(nowhere, gazetteer([{ to: 99, empty: true }]));
check(nowhere[0].name === 'At sea or off the map', 'a trip with nothing under it says so', nowhere[0].name);
nameTrips(nowhere, gazetteer([{ to: 99, region: 'Irkutsk Oblast', town: '', pop: 0 }], 'Russia'), () => 'Lake Baikal');
check(nowhere[0].name === 'Lake Baikal, Russia',
  'a landmark beats the administrative region it is in', nowhere[0].name);

// --- Streaks ------------------------------------------------------------------
console.log('\nstreaks');
check(longestStreak([]).days === 0, 'no days, no streak');
check(longestStreak(['2024-05-01']).days === 1, 'one day is a streak of one');
check(longestStreak(['2024-05-01', '2024-05-02', '2024-05-03', '2024-05-09']).days === 3,
  'three in a row', String(longestStreak(['2024-05-01', '2024-05-02', '2024-05-03', '2024-05-09']).days));
check(longestStreak(['2024-05-31', '2024-06-01', '2024-06-02']).days === 3, 'across the end of a month',
  String(longestStreak(['2024-05-31', '2024-06-01', '2024-06-02']).days));
check(longestStreak(['2024-12-30', '2024-12-31', '2025-01-01']).days === 3, 'and the end of a year');
// The clocks going forward must not shorten a streak: this is why the days are
// counted as calendar days and not as divisions of a timestamp.
check(longestStreak(['2024-03-29', '2024-03-30', '2024-03-31', '2024-04-01']).days === 4,
  'and across the spring clock change', String(longestStreak(['2024-03-29', '2024-03-30', '2024-03-31', '2024-04-01']).days));
check(longestStreak(['2024-05-01', '2024-05-01', '2024-05-02']).days === 2, 'the same day twice is one day');
check(longestStreak(['2024-05-04', '2024-05-05', '2024-05-01']).endsAt === '2024-05-05',
  'and it says when the streak ended', longestStreak(['2024-05-04', '2024-05-05', '2024-05-01']).endsAt);

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
