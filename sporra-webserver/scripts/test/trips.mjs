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
  buildTrips, nameTrips, findHome, activeDays, dayDetail, dayCells, tripDays, dayKey, distanceKm,
  longestStreak, nextRecordedDay,
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

// --- Coming home ---------------------------------------------------------------
// The cases that made a summer read as one trip. A trip is a run of days you
// did not come home, so a day at home ends one however tightly the away-evidence
// on either side is packed.
console.log('\ncoming home ends a trip');

// Portugal, one day at home, then Slovakia. Nothing in a list of away-events
// says you were ever back, and this used to come out as one 58-day trip.
const lisbon = merge(
  patch(-9.14, 38.72, 8, T('2024-06-23'), T('2024-06-25'), 4),
  patch(-9.16, 38.74, 8, T('2024-06-26'), T('2024-06-30'), 4),
);
const backHome = patch(7.45, 46.94, 6, T('2024-07-01'), T('2024-07-01'), 20);
const bratislava = merge(
  patch(17.11, 48.15, 8, T('2024-07-02'), T('2024-07-05'), 4),
  patch(17.13, 48.17, 8, T('2024-07-06'), T('2024-07-09'), 4),
);
const twoTrips = buildTrips(merge(homeCells, lisbon, backHome, bratislava), []);
check(twoTrips.length === 2, 'a day at home between two trips makes them two trips', `${twoTrips.length}`);
check(twoTrips[1].days === 8 && twoTrips[0].days === 8, 'each the length it really was',
  twoTrips.map((t) => `${t.days}d`).join(', '));
check(dayKey(twoTrips[0].start) === '2024-07-02', 'and the second starts when you left again',
  dayKey(twoTrips[0].start));

// Without the day at home in the middle, it is one journey — which is what
// Bratislava with an excursion to Prague actually is.
const oneRun = buildTrips(merge(homeCells, lisbon, bratislava), []);
check(oneRun.length === 1, 'and without it, one continuous absence is one trip', `${oneRun.length}`);

// Driving somewhere and back every day is not a 70-day trip. Each day has
// evidence far from home *and* evidence at home; only the second kind decides.
// (Each day is walked north rather than east, so one day's patch can't overlap
// the next one's cells and silently overwrite its dates.)
let commute = new Map();
for (let d = 1; d <= 20; d++) {
  const day = `2024-03-${String(d).padStart(2, '0')}`;
  commute = merge(
    commute,
    patch(8.50, 47.00 + d * 0.02, 4, T(day), T(day), 2), // ~80 km away
    patch(7.44, 46.80 + d * 0.02, 6, T(day), T(day), 30), // and home again by night
  );
}
const daily = buildTrips(merge(homeCells, commute), []);
check(daily.length === 0, 'twenty days of driving out and back is not a trip',
  daily.map((t) => `${t.days}d`).join(', '));

// …but a day out that really was a day out still shows, on its own.
const dayOut = patch(9.53, 46.85, 8, T('2024-04-06'), T('2024-04-06'), 3);
const outing = buildTrips(merge(homeCells, dayOut), []);
check(outing.length === 1 && outing[0].days === 1, 'a single day away is a one-day trip',
  `${outing.length} trips, ${outing[0]?.days}d`);

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

// --- Somewhere you go, not somewhere you went ----------------------------------
// "Away from home" is a distance, and distance can't tell a holiday from a
// habit. A place that turns up in the list over and over is not a destination,
// it is part of your week — so day runs to it stop counting, all of them or
// none. Five Saturdays in the same city, and one weekend somewhere else.
console.log('\na place you keep going back to');
const often = new Map();
for (let i = 0; i < 5; i++) {
  // Walked north each time so one visit's cells can't overwrite the next's.
  for (const [k, v] of patch(8.54, 47.37 + i * 0.02, 5, T(`2024-0${i + 3}-12`))) often.set(k, v);
}
const once = patch(12.49, 41.90, 5, T('2024-08-10'), T('2024-08-12'));
const habits = buildTrips(merge(homeCells, often, once), []);
check(habits.length === 1, 'five day runs to the same city are not five trips', `${habits.length}`);
check(dayKey(habits[0].start) === '2024-08-10', 'and the one somewhere else still is',
  dayKey(habits[0].start));
// Proof the case discriminates: without the rule they are all trips.
check(buildTrips(merge(homeCells, often, once), [], { familiarTrips: 0 }).length === 6,
  'switching the rule off gives all six back',
  `${buildTrips(merge(homeCells, often, once), [], { familiarTrips: 0 }).length}`);

// Two things say this one was different, and both override it.
const sameCityNight = merge(often, patch(8.54, 47.50, 5, T('2024-09-14'), T('2024-09-15')));
const sameCitySlept = buildTrips(merge(homeCells, sameCityNight), []);
check(sameCitySlept.some((t) => t.days > 1), 'a night away in the same city is still a trip',
  sameCitySlept.map((t) => `${t.days}d`).join(', '));

const saturdayRide = {
  id: 7, name: 'Saturday ride', firstAt: T('2024-04-12T10:00:00'), lastAt: T('2024-04-12T12:00:00'),
  lengthM: 42000, bounds: [8.5, 47.35, 8.6, 47.42],
};
const habitWithRoute = buildTrips(merge(homeCells, often), [saturdayRide]);
check(habitWithRoute.length === 1 && habitWithRoute[0].routes.length === 1,
  'and so is one you bothered to record a route on',
  `${habitWithRoute.length} trips`);

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

// --- A day out, named after where the day went --------------------------------
// The case this was rebuilt for. Within one day every place has the same number
// of days, so days can't separate them and the old measure fell through to size:
// a town three times bigger took the name off the place the day was spent in,
// on the strength of five cells of motorway. Time is what tells them apart.
console.log('\nwhere the day actually went');

// One cell every five minutes through the big town, then four hours in the
// small one. The drive lights *more* ground than the stay does, on purpose:
// ground covered is what the old measure could see and it is the wrong answer.
function timed(lng, lat, n, from, stepSec) {
  const meta = new Map();
  const [L, col, row] = idAt(lng, lat).split('/').map(Number);
  for (let i = 0; i < n; i++) {
    const at = from + i * stepSec;
    meta.set(`${L}/${col + i}/${row}`, [{ source: 'gpx', addedAt: at, firstAt: at, lastAt: at, hits: 1, fixes: 3 }]);
  }
  return meta;
}
const alps = gazetteer([
  { to: 12.55, region: 'Graubünden', town: 'Bigtown', pop: 35 },
  { to: 99, region: 'Graubünden', town: 'Smallville', pop: 5 },
], 'Switzerland');
const driveAndStay = merge(
  timed(12.40, 41.80, 8, T('2024-05-02T09:00:00'), 300), // 40 min, eight cells
  timed(12.70, 41.90, 3, T('2024-05-02T10:00:00'), 4800), // 4 h, three cells
);
const dayTrip = buildTrips(merge(homeCells, driveAndStay), []);
nameTrips(dayTrip, alps);
check(dayTrip.length === 1 && dayTrip[0].days === 1, 'the day out is one one-day trip',
  `${dayTrip.length} trips, ${dayTrip[0]?.days}d`);
// Proof the case discriminates: on ground covered, and on size, the drive wins.
const spotsAt = (t, lng) => t.spots.filter((s) => (lng < 12.55 ? s.lng < 12.55 : s.lng >= 12.55));
check(spotsAt(dayTrip[0], 12.4).length > spotsAt(dayTrip[0], 12.7).length,
  'the drive covered more ground than the stay',
  `${spotsAt(dayTrip[0], 12.4).length} vs ${spotsAt(dayTrip[0], 12.7).length} cells`);
check(dayTrip[0].name === 'Smallville, Switzerland',
  'and it is named after the four hours, not the forty minutes through somewhere bigger',
  dayTrip[0].name);

// …but size still breaks a *near* tie, which is the other half of the bargain
// and the reason time is square-rooted rather than counted straight. Here the
// small place holds a bit under twice the time of the big one — the shape of a
// week where you sleep in the suburb and spend the days in the city — and the
// city takes the name anyway.
//
// The fixture is built so that only the intended rule can produce the answer.
// The small place comes first, so a tie would go to it on iteration order; it
// also has more time, so ignoring size would give it the name; and the margin
// sits between the size ratio (1.44×) and its square (2.07×), so counting time
// straight instead of rooted would give it the name too.
const suburb = merge(
  timed(12.70, 41.90, 5, T('2024-05-02T09:00:00'), 1500), // 100 min, and first
  timed(12.40, 41.80, 5, T('2024-05-02T10:35:00'), 900), // 60 min, in the city
);
const nearTie = buildTrips(merge(homeCells, suburb), []);
nameTrips(nearTie, alps);
const secsOf = (t, small) => t.spots
  .filter((s) => (small ? s.lng >= 12.55 : s.lng < 12.55))
  .reduce((n, s) => n + s.secs, 0);
check(secsOf(nearTie[0], true) > secsOf(nearTie[0], false),
  'the small place holds more of the time',
  `${secsOf(nearTie[0], true)}s vs ${secsOf(nearTie[0], false)}s`);
check(secsOf(nearTie[0], true) < secsOf(nearTie[0], false) * 2.07,
  'but not twice as much — inside the margin size is allowed to win',
  `${(secsOf(nearTie[0], true) / secsOf(nearTie[0], false)).toFixed(2)}×`);
check(nearTie[0].name === 'Bigtown, Switzerland',
  'so the better-known place takes the name', nearTie[0].name);

// How long a sighting says you stayed, bounded at both ends. Read off the trip
// directly: this is the measurement everything above is built on, and inferring
// it through two more layers of scoring would only pin it approximately.
//
// Four cells: twenty minutes apart, then two hours, then a fifteen-hour silence
// before the last. A gap is worth what it says up to the cap, the cap after
// that — a phone switched off overnight is not evidence of fifteen hours in the
// last hexagon it saw — and the final sighting, with nothing after it to
// measure against, is worth the floor.
const gaps = merge(
  timed(12.40, 41.80, 2, T('2024-05-02T09:00:00'), 1200),
  timed(12.42, 41.80, 1, T('2024-05-02T09:20:00') + 1200, 0),
  timed(12.44, 41.80, 1, T('2024-05-03T02:00:00'), 0),
);
const measured = buildTrips(merge(homeCells, gaps), [])[0];
const secs = measured.spots.map((s) => s.secs);
check(secs[0] === 1200, 'a twenty-minute gap is twenty minutes', `${secs[0]}s`);
check(secs[2] === 6 * 3600, 'and a fifteen-hour one is capped, not believed', `${secs[2]}s`);
check(secs[3] === 300, 'the last sighting has nothing after it, so it gets the floor', `${secs[3]}s`);
check(secs.every((s) => s >= 300 && s <= 6 * 3600), 'and nothing is outside the bounds',
  secs.join(', '));

// Ground the gazetteer has no name for is still ground you were on. When more
// of your time went there than to any place it *can* name, naming a trip after
// a town it merely passed is worse than naming the region — which does cover
// the ground the time was actually spent on.
const engadin = gazetteer([
  { to: 12.55, region: 'Graubünden', town: 'Bigtown', pop: 35 },
  { to: 99, region: 'Graubünden' }, // a valley with no settlement in the dataset
], 'Switzerland');
const nameless = merge(
  timed(12.40, 41.80, 4, T('2024-05-02T09:00:00'), 600),
  timed(12.70, 41.90, 3, T('2024-05-02T11:00:00'), 5400),
);
const valley = buildTrips(merge(homeCells, nameless), []);
nameTrips(valley, engadin);
check(valley[0].name === 'Graubünden, Switzerland',
  'a valley with no town in it names the trip after the canton, not the town it drove through',
  valley[0].name);
check(valley[0].region === 'Graubünden', 'and it still knows its region', valley[0].region);

// --- Tags ---------------------------------------------------------------------
// Everywhere it went, not just what it ended up called — otherwise a trip named
// after a canton is unfindable by any place you remember being in.
console.log('\ntags');
check(valley[0].tags.includes('Bigtown'), 'a trip keeps the towns it passed through',
  (valley[0].tags ?? []).join(', '));
check(valley[0].tags.includes('Graubünden') && valley[0].tags.includes('Switzerland'),
  'and the region and country around them');
check(!valley[0].tags.includes(''), 'and nothing empty');
check(holiday[0].tags.includes('Avezzano') && holiday[0].tags.includes('Abruzzo'),
  'the week in Rome is findable by the region it only drove through',
  holiday[0].tags.join(', '));
check(new Set(valley[0].tags).size === valley[0].tags.length, 'each one once');

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

// --- A day you can look at -----------------------------------------------------
// A dot in the calendar used to be the end of the road: it said the day had
// ground on it and gave you no way to see where. These are the points the map
// draws for one, and they have to be placed, dated and in order — a track drawn
// in storage order is a zigzag with a confident line through it.
console.log('\nwhere a day was');
// A morning walk east, three minutes a cell, plus a patch from another day that
// must not turn up in it.
const walk = new Map();
{
  const [L, col, row] = idAt(7.75, 46.02).split('/').map(Number);
  for (let i = 0; i < 6; i++) {
    const at = T('2024-08-10T09:00:00') + i * 180;
    walk.set(`${L}/${col + i}/${row}`, [{ source: 'gpx', addedAt: at, firstAt: at, lastAt: at, hits: 1, fixes: 3 }]);
  }
}
const other = patch(8.55, 47.37, 3, T('2024-08-12'));
const walked = dayCells('2024-08-10', merge(walk, other));
check(walked.length === 6, 'a day holds the cells that day recorded', String(walked.length));
check(walked.every((c) => !other.has(c.id)), 'and only those — another day is another day');
check(walked.every((c) => Number.isFinite(c.lng) && Number.isFinite(c.lat)), 'each one is placed');
check(walked.every((c, i) => i === 0 || c.at >= walked[i - 1].at), 'in the order they happened');
// The one that discriminates: storage order is insertion order here, so a sort
// that did nothing would still pass the check above. Reverse the map and the
// answer has to come back the same way round.
const backwards = new Map([...walk].reverse());
check(dayCells('2024-08-10', backwards).map((c) => c.id).join() === walked.map((c) => c.id).join(),
  'however they come out of storage');
check(walked.every((c) => c.fresh), 'ground first seen that day is new');
// Both ends of a stored row are days the data carries; only one of them is new.
const spanPoints = dayCells('2024-08-16', span);
check(spanPoints.length === 4 && spanPoints.every((c) => !c.fresh),
  'the last day of a stay is ground you were on, but not new ground',
  `${spanPoints.length} cells, ${spanPoints.filter((c) => c.fresh).length} new`);
check(dayCells('2024-08-13', span).length === 0, 'and the quiet middle has nothing to show');
check(dayDetail('2024-08-10', [], [], merge(walk, other)).points.length === 6,
  'the day panel carries them too, so its count and its map agree');

// --- A trip, as one shape in the calendar --------------------------------------
console.log('\na trip across the month grid');
// A fortnight whose middle is silent: arrived on the 2nd, seen again on the
// 15th, nothing in between.
const fortnight = patch(12.49, 41.90, 5, T('2024-06-02'), T('2024-06-15'), 4);
const longTrip = buildTrips(merge(homeCells, fortnight), []);
const marked = tripDays(longTrip);
check(longTrip.length === 1, 'the fortnight is one trip', `${longTrip.length}`);
check(marked.get('2024-06-02') === longTrip[0] && marked.get('2024-06-15') === longTrip[0],
  'both ends of it are marked');
check(marked.get('2024-06-08') === longTrip[0],
  'and so is the quiet Saturday in the middle — you did not come home for it');
check(!marked.has('2024-06-01') && !marked.has('2024-06-16'), 'the days either side are not');
check(marked.size === 14, 'every day of it, and no more', `${marked.size} days`);
check(tripDays([]).size === 0 && tripDays(null).size === 0, 'no trips, nothing marked');
// Two trips must never claim the same day — the pill would be drawn twice and
// the second would win silently.
const spans = new Map();
let clash = false;
for (const t of two) {
  for (const [k, v] of tripDays([t])) {
    if (spans.has(k)) clash = true;
    spans.set(k, v);
  }
}
check(!clash, 'and two trips never claim the same day');

// --- The spots a trip is drawn from --------------------------------------------
// The map draws a trip from its spots, so each one has to know when it was
// first reached; without that there is no order to thread them in.
console.log('\nthe order a trip happened in');
const threaded = buildTrips(merge(homeCells, walk), [])[0];
check(threaded.spots.length === 6, 'a spot per place the trip has evidence for', `${threaded.spots.length}`);
check(threaded.spots.every((s) => s.at > 0), 'each dated');
check(threaded.spots.every((s, i) => i === 0 || s.at >= threaded.spots[i - 1].at), 'and in order');
// The date is when you *arrived*, and the case that tells the two apart is a
// row seen over several days: it carries an event at each end, and taking the
// later one would date the whole trip by when it ended.
const overDays = buildTrips(merge(homeCells, span), [])[0];
check(overDays.spots.every((s) => s.at === T('2024-08-10')),
  'from when a place was first reached, not last',
  overDays.spots.map((s) => dayKey(s.at)).join(', '));

// --- Days out, not days leavingTrips ---------------------------------------------------
// Five Saturdays of sightseeing around one country used to read as one seven-day
// trip. The share rule alone cannot tell them apart from a week abroad: it
// counts cells, and driving across a canton lights far more of them than
// walking around your own village, so the morning and evening at home are
// outvoted by the middle of the day. What separates the two is *when* you were
// home, not how much.
console.log('\ndays out are not days away');

// A day that leaves home in the morning, covers ground, and is back by evening.
const saturdayOut = (lng, lat, date, n = 8) => merge(
  patch(7.44, 46.95, 1, T(`${date}T08:00:00`)),          // home, first thing
  patch(lng, lat, n, T(`${date}T13:00:00`)),             // the day itself
  patch(7.45, 46.95, 1, T(`${date}T19:00:00`)),          // home again
);

const outingTrips = buildTrips(
  merge(homeCells, saturdayOut(8.55, 47.37, '2024-03-02'), saturdayOut(8.54, 47.38, '2024-03-03')),
  [], { home },
);
check(outingTrips.length === 0 || outingTrips.every((t) => t.days === 1),
  'two Saturdays out do not fuse into one trip',
  outingTrips.map((t) => `${dayKey(t.start)}..${dayKey(t.end)}`).join(' | ') || '(none)');

// The discriminating half: a day that leaves and does *not* come back is the
// first day of something, and must still join the days after it. Without this,
// the rule would shorten every real trip by its first day.
const leavingDay = merge(
  homeCells,
  patch(7.44, 46.95, 1, T('2024-05-10T08:00:00')),       // home in the morning…
  patch(12.33, 45.44, 6, T('2024-05-10T20:00:00')),      // …Venice by night
  patch(12.34, 45.44, 6, T('2024-05-11T12:00:00')),
  patch(12.35, 45.44, 6, T('2024-05-12T12:00:00')),
);
const leavingTrips = buildTrips(leavingDay, [], { home });
check(leavingTrips.length === 1 && leavingTrips[0].days === 3, 'a day you leave on still belongs to the trip',
  leavingTrips.map((t) => `${dayKey(t.start)}..${dayKey(t.end)} (${t.days}d)`).join(' | ') || '(none)');

// And a day out that goes somewhere worth naming is still somewhere you went —
// it stands on its own rather than being erased. Whether it earns a place in
// the list is dropRoutine's call, not this rule's.
const farDayTrips = buildTrips(merge(homeCells, saturdayOut(9.84, 46.50, '2024-06-15', 20)), [], { home });
check(farDayTrips.length === 1 && farDayTrips[0].days === 1, 'but a day out is still a day somewhere',
  farDayTrips.map((t) => `${dayKey(t.start)} (${t.days}d)`).join(' | ') || '(none)');

console.log('\nthe day either side of a day');
{
  // What the chip on the map steps through when it is swiped: the days with
  // something on them, which is the same set the calendar dots.
  const recorded = ['2026-07-06', '2026-07-02', '2026-07-13', '2025-12-31', '2026-08-01'];
  check(nextRecordedDay(recorded, '2026-07-06', 1) === '2026-07-13',
    'forwards skips the days the phone was off', nextRecordedDay(recorded, '2026-07-06', 1));
  check(nextRecordedDay(recorded, '2026-07-06', -1) === '2026-07-02', 'and backwards does too');
  check(nextRecordedDay(recorded, '2026-08-01', 1) === null, 'the last day has nothing after it');
  check(nextRecordedDay(recorded, '2025-12-31', -1) === null, 'nor the first before it');
  // Compared as strings, so the year and the month have to carry rather than
  // the day being read on its own.
  check(nextRecordedDay(recorded, '2026-07-13', 1) === '2026-08-01', 'it crosses a month');
  check(nextRecordedDay(recorded, '2025-12-31', 1) === '2026-07-02', 'and a year');
  // A day nothing was recorded on is where a swipe lands from a trip that was
  // shown instead — it still has neighbours, and is not one of them.
  check(nextRecordedDay(recorded, '2026-07-07', -1) === '2026-07-06',
    'a day that is not in the set still has a day before it');
  check(nextRecordedDay(recorded, '2026-07-07', 1) === '2026-07-13', 'and one after it');
  check(nextRecordedDay([], '2026-07-06', 1) === null, 'an empty history is not a crash');
  check(nextRecordedDay(recorded, '', 1) === null, 'and neither is stepping from nowhere');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
