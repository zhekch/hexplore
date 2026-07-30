// Trips: the object between a cell and a route.
//
// The map stores two things. A cell is ground you covered and says nothing
// about when you meant to be there; a route is one line on one afternoon. What
// is missing is the shape memory actually uses — *Iceland, last August* — and
// it is the thing that makes a map browsable by what you remember rather than
// by which file it came out of.
//
// Nothing new is stored for this. Every trip below is worked out from dates and
// positions the cells and routes already carry, which means it costs no import
// path, no schema and no migration, and it re-derives itself the moment new
// history arrives. The price is that a trip cannot be renamed — it isn't a row,
// it's a reading of the rows — and that a trip only knows about days the data
// knows about. A week in a country with your phone off is a week that didn't
// happen, which is the same honesty the rest of the map keeps.

import { cellCenter, project } from './hexgrid.js';

/** Silence longer than this ends a trip. Being home ends one at any length. */
export const TRIP_GAP_DAYS = 2;
/**
 * The longest stay one stored row is allowed to imply.
 *
 * A row records when a cell was first and last seen and nothing in between, so
 * a week in one village arrives as a crowd of arrival dates, a crowd of
 * departure dates, and six days of silence — which the gap rule alone reads as
 * two trips to the same place. It isn't: it's a week. A row whose two ends are
 * this close together is therefore read as one continuous stay, and the days
 * between them count as days away.
 *
 * Bounded, because the same shape of row means the opposite when the ends are
 * far apart: first seen in August, last seen in December is two visits, not a
 * four-month residency.
 *
 * This replaced a rule that merged whole *clusters* that were near each other
 * in space and time. That rule could chain — each merge moved the cluster's
 * centre, which brought the next one within range — and on real data it glued a
 * fortnight in Portugal, a week in Slovakia and every day trip in between into
 * one 58-day "trip". A row can only ever imply its own span, so it cannot
 * chain.
 */
export const TRIP_STAY_DAYS = 16;
/**
 * How much of a day's evidence has to be away from home before it counts as a
 * day away rather than a day out.
 *
 * Days, not events, are what a trip is made of — and the difference between a
 * fortnight in Rome and a fortnight of driving to the next canton and back is
 * not where you went, it is whether you came home at night. Both produce
 * evidence far from home every day; only one produces evidence *at* home every
 * day too. A day whose evidence is mostly around home is a day you were living
 * at home, whatever else you did with it.
 *
 * Half, because the two sides are counted in the same unit — cells the day
 * touched — and the day you fly out legitimately touches a few near home on the
 * way to the airport.
 */
export const AWAY_DAY_SHARE = 0.5;
/** Nearer than this to home and you weren't away, you were living. */
export const HOME_RADIUS_KM = 55;
/** Below this, a "trip" is a stray fix with a bad clock. */
export const MIN_TRIP_CELLS = 3;
/**
 * How near two day-runs have to be to count as the same destination, and how
 * many of them it takes before that destination is somewhere you *go* rather
 * than somewhere you *went*. See `dropRoutine`.
 *
 * 25 km is a city and its approaches — near enough that two runs into the same
 * place always pair up, far enough apart that two genuinely different towns
 * don't. Three, because twice is a coincidence and a fourth run to the same
 * city in the same list is a habit.
 */
export const FAMILIAR_KM = 25;
export const FAMILIAR_TRIPS = 3;
/**
 * The longest stay one sighting is allowed to imply, and the shortest.
 *
 * How long you were somewhere is the thing naming actually wants to know, and
 * the stored history never says it — but it does say when each cell was first
 * seen, and the next cell's timestamp is when you had stopped being there. That
 * gap is the estimate.
 *
 * It needs both ends bounded. A gap can be a fortnight — the phone was off, or
 * the row is a stay held across its own silence — and a fortnight credited to
 * whichever cell happened to be last would settle the name of a whole trip from
 * one arbitrary hexagon. Six hours is long enough that any real stop counts in
 * full, and short enough that a night, a flight or a dead battery can't outvote
 * a day.
 *
 * The floor matters just as much, for the opposite case: plenty of imports
 * carry one timestamp for a whole afternoon's cells, so every gap is zero and
 * the measure collapses to nothing. A floor per sighting makes it degrade to
 * "how much ground did you cover here" — the old proxy — instead of to silence.
 */
export const STAY_CAP_SEC = 6 * 3600;
export const STAY_FLOOR_SEC = 300;

/**
 * How much evidence of *returning* it takes before somewhere counts as home.
 *
 * Home is not "where most of your cells are" — on an account holding one
 * imported holiday, that is the holiday, and the whole trip then reads as
 * ordinary life and disappears from the list. It has to be somewhere you went
 * back to, so it needs repeat visits to claim the title, and a map that has
 * never seen you come back has no home yet and is all trip.
 */
export const HOME_MIN_HITS = 5;

const DAY = 86400;
const R_KM = 6371;
const DEG = Math.PI / 180;

// Cell columns count eastwards from the antimeridian, so projecting a cell
// centre gives a longitude in 0…360 — 338 for Reykjavík, not −22. Everything
// here compares and bounds longitudes, and a box from 338 to 338.1 asks the map
// to frame the whole planet: clicking a trip anywhere in the western hemisphere
// zoomed all the way out. The country statistics already wrap for the same
// reason; this is that, applied at the point the coordinate is made.
const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

export function distanceKm(aLng, aLat, bLng, bLat) {
  const dLat = (bLat - aLat) * DEG;
  const dLng = (bLng - aLng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Epoch seconds → the local calendar day it falls in, as "YYYY-MM-DD". */
export function dayKey(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A day key as a number that can be compared and stepped through.
 *
 * Counted as calendar days rather than as divisions of a timestamp, so the
 * clocks going forward doesn't make two adjacent days look 1.04 days apart.
 */
export function dayNumber(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
    ? Date.UTC(y, m - 1, d) / 86400000
    : NaN;
}

/** …and back, for stepping across the quiet middle of a stay. */
function keyOfDay(n) {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Where you live, as a point — the centre of gravity of the cells you go back
 * to most.
 *
 * Not the single most-visited cell: that is one 900 m hexagon, and which of the
 * three around your flat wins is decided by GPS drift. Weighting the top of the
 * list by visit count lands in the middle of them and stays put as more history
 * arrives.
 *
 * Returns null when nothing in the data has been visited often enough to be a
 * home — see HOME_MIN_HITS.
 *
 * @param {Map<string, Array>} cellMeta id → provenance entries
 * @returns {{lng:number, lat:number, hits:number}|null}
 */
export function findHome(cellMeta) {
  const scored = [];
  for (const [id, entries] of cellMeta) {
    const [L, col, row] = id.split('/').map(Number);
    if (!Number.isFinite(L)) continue;
    let hits = 0;
    for (const e of entries) hits += e.hits || 0;
    if (hits > 0) scored.push({ id, hits, L, col, row });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.hits - a.hits);
  if (scored[0].hits < HOME_MIN_HITS) return null; // nowhere has earned it yet
  const top = scored.slice(0, 12);
  // Averaged around the circle, not along the number line. A cell centre
  // projects to an unwrapped longitude — 351 for Lisbon, not −9 — and a plain
  // mean of those puts the home of anyone with a well-visited cell in the
  // western hemisphere somewhere in the middle of Europe instead. Summing unit
  // vectors is right wherever the cells are, including across the antimeridian.
  let sumX = 0;
  let sumY = 0;
  let sumLat = 0;
  let sumW = 0;
  for (const c of top) {
    const [lng, lat] = project(cellCenter(c.L, c.col, c.row));
    sumX += Math.cos(lng * DEG) * c.hits;
    sumY += Math.sin(lng * DEG) * c.hits;
    sumLat += lat * c.hits;
    sumW += c.hits;
  }
  return { lng: (Math.atan2(sumY, sumX) / DEG), lat: sumLat / sumW, hits: top[0].hits };
}

// One dated thing that happened somewhere: a cell's first sighting, or a route.
function events(cellMeta, routes) {
  const out = [];
  for (const [id, entries] of cellMeta) {
    const [L, col, row] = id.split('/').map(Number);
    if (!Number.isFinite(L)) continue;
    let lngLat = null;
    for (const e of entries) {
      // A cell with no date at all can't be placed in time, and guessing would
      // put a trip where there wasn't one.
      const at = e.firstAt || e.lastAt;
      if (!at) continue;
      if (!lngLat) {
        const p = project(cellCenter(L, col, row));
        lngLat = [wrapLng(p[0]), p[1]];
      }
      out.push({
        at,
        // How long this one row says the cell went on being seen — what the
        // stay rule reads. 0 when the row is a single moment.
        until: e.lastAt && e.lastAt > at ? e.lastAt : 0,
        lng: lngLat[0],
        lat: lngLat[1],
        cell: id,
        hits: Math.max(1, e.hits || 0),
      });
      // Both ends, whenever they differ. A cell you passed through in March and
      // again in September belongs to two trips; a cell seen on the Friday and
      // again on the Sunday is one trip that has to know it lasted the weekend.
      // Emitting only the far-apart ones made every short stay a day long.
      //
      // The visits belong to the row, not to either end of it, so the second
      // event carries none: naming weighs a place by how much evidence there is
      // of you being in it, and counting one row's visits twice would weigh
      // every long stay double for having lasted.
      if (e.lastAt && e.lastAt > at) {
        out.push({ at: e.lastAt, lng: lngLat[0], lat: lngLat[1], cell: id, hits: 0 });
      }
    }
  }
  for (const r of routes ?? []) {
    const at = r.firstAt || r.lastAt;
    if (!at) continue;
    const b = r.bounds ?? [];
    const lng = b.length === 4 ? wrapLng((b[0] + b[2]) / 2) : null;
    const lat = b.length === 4 ? (b[1] + b[3]) / 2 : null;
    if (lng === null || !Number.isFinite(lng)) continue;
    out.push({ at, lng, lat, route: r, hits: 1 });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** How long one sighting says you were there — the floor when it says nothing. */
const stayOf = (e, next) => {
  const gap = next && next.at > e.at ? next.at - e.at : 0;
  return Math.min(STAY_CAP_SEC, Math.max(STAY_FLOOR_SEC, gap));
};

/**
 * Work the stored history into trips.
 *
 * A trip is a run of **days you didn't come home**, which is a different
 * question from a run of events far from home and the reason this is built a
 * day at a time. Someone who drives an hour out and back every day produces
 * evidence beyond the home radius on every one of those days: read as events,
 * that is one unbroken run and it came out as a 77-day "trip" to the next
 * canton. Read as days, every one of them also has evidence at home, so none of
 * them is a night away and there is no trip at all — while a fortnight in
 * Portugal has eight days with no home evidence whatsoever.
 *
 * It is also what tells two trips apart when they are close together: going to
 * Portugal, coming home for a day, and leaving again for Slovakia used to be
 * one 58-day trip, because nothing in a list of away-events says you were ever
 * back. One home day in the middle now ends the first trip and starts the
 * second, which is what actually happened.
 *
 * @param {Map<string, Array>} cellMeta
 * @param {Array<object>} routes  saved routes (metadata is enough)
 * @param {{home?:{lng:number,lat:number}, gapDays?:number, stayDays?:number,
 *   radiusKm?:number, minCells?:number, awayShare?:number, familiarKm?:number,
 *   familiarTrips?:number}} [opts] `familiarTrips: 0` keeps the routine runs
 *   this otherwise drops — see `dropRoutine`.
 * @returns {Array<object>} newest first
 */
export function buildTrips(cellMeta, routes = [], opts = {}) {
  const gap = opts.gapDays ?? TRIP_GAP_DAYS;
  const stay = (opts.stayDays ?? TRIP_STAY_DAYS) * DAY;
  const radius = opts.radiusKm ?? HOME_RADIUS_KM;
  const minCells = opts.minCells ?? MIN_TRIP_CELLS;
  const share = opts.awayShare ?? AWAY_DAY_SHARE;
  // `home: null` explicitly means "there isn't one" — distinct from leaving it
  // out, which means "work it out".
  const home = 'home' in opts ? opts.home : findHome(cellMeta);
  const all = events(cellMeta, routes);
  if (!all.length) return [];

  // What each day has to say for itself: how much of its evidence was away from
  // home, how much was at home, and whether a stay was passing through it.
  // Without a home to be away from — a brand-new account, one import of one
  // holiday — everything counts as away, because then the whole map is
  // somewhere you went.
  const ledger = new Map();
  const dayOf = (key) => {
    let d = ledger.get(key);
    if (!d) ledger.set(key, (d = { away: 0, home: 0, held: 0, events: [] }));
    return d;
  };
  for (const e of all) {
    const far = !home || distanceKm(home.lng, home.lat, e.lng, e.lat) > radius;
    const day = dayOf(dayKey(e.at));
    if (far) {
      day.away++;
      day.events.push(e);
    } else {
      day.home++;
    }
    // One row seen over a few days is one stay, and the days in between are
    // days it was there — see TRIP_STAY_DAYS. They are *held*, not counted as
    // away: an inference about time, not a sighting, so it can carry a day that
    // has nothing else on it but never outvote a day that has.
    if (!far || !e.until || e.until - e.at > stay) continue;
    const last = dayNumber(dayKey(e.until));
    for (let n = dayNumber(dayKey(e.at)) + 1; n < last; n++) dayOf(keyOfDay(n)).held++;
  }

  // A day is a day away when it has evidence away from home and that evidence
  // isn't swamped by evidence at home; a day with nothing but a held stay
  // running through it counts too.
  const dayList = [...ledger.entries()]
    .map(([key, d]) => ({ key, n: dayNumber(key), ...d }))
    .sort((a, b) => a.n - b.n);
  const trips = [];
  let cur = null;
  for (const d of dayList) {
    const seen = d.away + d.home;
    const awayDay = seen ? d.away > 0 && d.away / seen >= share : d.held > 0;
    if (!awayDay) {
      cur = null; // you were home: whatever was running has ended
      continue;
    }
    // Silence is not the same as being home — nothing at all happened, which
    // says nothing either way — so a short one carries the trip on.
    if (cur && d.n - cur.lastDay <= gap + 1) {
      cur.lastDay = d.n;
      cur.events.push(...d.events);
    } else {
      trips.push((cur = { lastDay: d.n, events: [...d.events] }));
    }
  }

  const out = [];
  for (const t of trips) {
    const cells = new Set();
    const tripRoutes = [];
    // One entry per place the trip has evidence for, with how much evidence:
    // which days it was seen on, and how many separate visits it records. This
    // is what naming weighs (see nameTrips) — the geometric middle of a trip is
    // often a motorway, and the middle of Reykjavík–Vík is neither of them.
    const spots = new Map();
    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    let sumLng = 0;
    let sumLat = 0;
    for (let i = 0; i < t.events.length; i++) {
      const e = t.events[i];
      if (e.cell) cells.add(e.cell);
      if (e.route) tripRoutes.push(e.route);
      // Cells key by id, routes by identity — a route that hasn't been saved yet
      // has no id, and two of them must not merge into one place.
      const key = e.cell ?? e.route;
      let spot = spots.get(key);
      // `at` is when you first got there, which is what threads the spots into
      // the order they happened — the map draws a trip as its own track, and a
      // track needs a direction. Events arrive sorted, so the first one wins.
      if (!spot) spots.set(key, (spot = { lng: e.lng, lat: e.lat, hits: 0, secs: 0, at: e.at, days: new Set() }));
      spot.hits += e.hits ?? 0;
      spot.secs += stayOf(e, t.events[i + 1]);
      if (e.at < spot.at) spot.at = e.at;
      spot.days.add(dayKey(e.at));
      if (e.lng < bbox[0]) bbox[0] = e.lng;
      if (e.lat < bbox[1]) bbox[1] = e.lat;
      if (e.lng > bbox[2]) bbox[2] = e.lng;
      if (e.lat > bbox[3]) bbox[3] = e.lat;
      sumLng += e.lng;
      sumLat += e.lat;
    }
    // A day trip that lit two cells is noise unless it also drew a line. A run
    // of days held open by a stay with nothing dated inside it has no events at
    // all, and is nothing on its own.
    if (!t.events.length || (cells.size < minCells && !tripRoutes.length)) continue;
    const center = [sumLng / t.events.length, sumLat / t.events.length];
    // The first and last thing that actually happened, not the run's outer
    // edges: a stay held across a quiet middle must not be dated by the silence.
    const start = t.events[0].at;
    const end = t.events[t.events.length - 1].at;
    out.push({
      // Stable across rebuilds (it's derived from the data, not from the
      // order it was derived in), so the UI can select one and find it again.
      id: `trip-${start}`,
      start,
      end,
      // Calendar days, counted as calendar days — a trip that starts on Friday
      // evening and ends on Sunday morning lasted three days, not 1.6. Measured
      // between the same two dates the row shows, so the two can't disagree.
      days: dayNumber(dayKey(end)) - dayNumber(dayKey(start)) + 1,
      cells: [...cells],
      routes: tripRoutes,
      lengthM: tripRoutes.reduce((m, r) => m + (r.lengthM || 0), 0),
      bbox,
      center,
      // Sorted, though the events they were built from already arrive in order:
      // the map threads these into a line and a scribble is what it draws if
      // they ever stop being ordered. One line here is cheaper than that being
      // a property of how events happen to be gathered.
      spots: [...spots.values()]
        .map((s) => ({ lng: s.lng, lat: s.lat, hits: s.hits, secs: s.secs, at: s.at, days: [...s.days] }))
        .sort((a, b) => a.at - b.at),
      farKm: home ? Math.round(distanceKm(home.lng, home.lat, center[0], center[1])) : 0,
      name: '', // filled in by nameTrips(), which needs the place dataset
    });
  }
  out.sort((a, b) => b.start - a.start);
  return dropRoutine(out, opts);
}

/**
 * Somewhere you keep going back to isn't a trip, it's your week.
 *
 * "Away from home" is a distance, and distance alone can't tell a holiday from
 * a commute. Someone who drives to the same city a dozen times a year gets a
 * dozen entries in a list they opened to remember holidays by, and the honest
 * signal is sitting right there in the list: **a place that shows up in it over
 * and over is not somewhere you went, it is somewhere you go.**
 *
 * So a day out is dropped when `FAMILIAR_TRIPS` other day-runs landed within
 * `FAMILIAR_KM` of it. Symmetric, so it is all of them or none — the fourth
 * visit to a place is not more routine than the first, and keeping three of the
 * twelve would be arbitrary.
 *
 * Two things override it, because both say this one was different:
 *
 *   **it lasted more than a day** — you slept somewhere else, and a weekend in
 *   a city you often visit is still a weekend away;
 *   **you recorded a route on it** — bothering to save the track is a statement
 *   that the day was worth keeping, and no derived rule should overrule it.
 */
function dropRoutine(trips, opts) {
  const near = opts.familiarKm ?? FAMILIAR_KM;
  const enough = opts.familiarTrips ?? FAMILIAR_TRIPS;
  if (!(enough > 0)) return trips;
  return trips.filter((t) => {
    if (t.days > 1 || t.routes.length) return true;
    let seen = 0;
    for (const other of trips) {
      if (other === t) continue;
      if (distanceKm(t.center[0], t.center[1], other.center[0], other.center[1]) <= near) seen++;
      if (seen >= enough) return false;
    }
    return true;
  });
}

/**
 * How much of a trip happened at one place, in seconds.
 *
 * Time, and nothing but time. This used to be *days* plus a bounded fraction of
 * the region's visits, which was the best the data supported before a spot knew
 * when it was reached — and it has a floor of one whole day under every place a
 * trip touched at all. Within a single day that floor is the entire measure:
 * every candidate scores 1.0-something, differences of 3× in the actual time
 * spent compress into differences of 15%, and the population factor decides
 * everything.
 *
 * That is how a day trip to a village came out named after the town it drove
 * through on the way: five cells' worth of motorway in a place of 35,000 beat
 * four hours in a place of 11,000, because the four hours were worth 0.27 and
 * being three times larger was worth 1.23.
 *
 * Seconds have the range the question needs. A week somewhere is ~40× a
 * four-hour stop, so days still dominate whenever days differ — which is what
 * the old measure was really trying to say.
 *
 * Square-rooted, because raw seconds have *too much* range for the other half
 * of the question. Size is supposed to break near-ties — nobody calls a week in
 * Lisbon "Lumiar" after the parish they happened to sleep in — and against
 * unbounded time it never could: the place you sleep always holds more hours
 * than the place you go. The root leaves a 5× difference in time worth 2.2×,
 * enough to beat any size gap that matters, while a 1.5× difference is worth
 * 1.2× and loses to a city ten times the size. Both of those are real cases:
 * four hours in St. Moritz against minutes in Chur, and eight nights in a
 * Lisbon parish against eight days in Lisbon.
 */
const dwell = (e) => Math.sqrt(Math.max(1, e.secs || 0));

/**
 * How much bigger a place has to be before its size is worth mentioning.
 *
 * A trip is remembered by the biggest thing in it — nobody calls a week in Rome
 * "Fiumicino" — so a place competes on time spent *times* a factor that grows
 * with its population. It grows slowly, by design: a city of half a million is
 * worth about twice a village, so it takes the name only when the time spent is
 * comparable. Sleep in the village all week and the village keeps it.
 */
const size = (popThousands) => 1 + Math.log10(1 + Math.max(0, popThousands || 0));

// Days, then time, then visits, then ground.
//
// Days lead because a region is the coarse question: a fortnight in Lazio with
// one long day in Tuscany is a trip to Lazio, whatever hours that day held.
// Within the same number of days it is time, for exactly the reason the whole
// naming pass exists — a day driving right across one canton to spend six hours
// in the next one used to be named after the canton it drove across, which had
// twice the cells and not one stop in it. Counts measure ground covered; only
// time measures being somewhere.
const byDwell = (a, b) =>
  b.days.size - a.days.size || b.secs - a.secs || b.hits - a.hits || b.spots - a.spots;

/**
 * Where a trip mostly *was*: the region holding the most of it, and the
 * best-known settlement inside that region.
 *
 * @returns {{region:string, country:string, town:string, days:number}|null}
 */
function heartOf(trip, placeAt) {
  if (!placeAt || !trip.spots?.length) return null;
  const regions = new Map();
  const tags = new Set();
  for (const s of trip.spots) {
    const at = placeAt(s.lng, s.lat) ?? {};
    // Everywhere the trip went, whether or not it ends up in the name — the
    // search box matches these, so a week in the Engadin is findable by the
    // canton it was in, the town it drove through and the country around it.
    for (const n of [at.town, at.region, at.country]) if (n) tags.add(n);
    // Ground the datasets can't place is not somewhere you were — it is the
    // absence of an answer, and it must not compete with the places that have
    // one. The country outlines are rounded to ~1 km, so cells just off a coast
    // fall outside every country (the same ones the statistics book as
    // offshore); pooling them made a single nameless "region" holding *every*
    // countryless day of the trip, which then out-dayed the city the trip was
    // actually in. A week in Athens with four days' sailing came out as "At sea
    // or off the map", with no country left on it for the search box to match.
    // A trip that is nothing but such ground still ends up there, by finding no
    // region at all and falling through to its centre.
    if (!at.country && !at.region) continue;
    // By id where there is one: two countries can both have a Córdoba, and
    // merging them would invent a region you spent twice as long in.
    const key = at.regionId || (at.region ? `${at.country}/${at.region}` : at.country);
    let r = regions.get(key);
    if (!r) {
      regions.set(key, (r = {
        region: at.region ?? '', country: at.country ?? '',
        days: new Set(), hits: 0, secs: 0, spots: 0, nameless: 0, towns: new Map(),
      }));
    }
    for (const d of s.days) r.days.add(d);
    r.hits += s.hits;
    r.secs += s.secs || 0;
    r.spots++;
    // Ground inside a region that no settlement is near enough to claim. The
    // gazetteer stops at towns of ~5,000, so a whole valley can be nameless —
    // and the time spent in one is still time spent, which is why it is counted
    // here rather than dropped.
    if (!at.town) {
      r.nameless += s.secs || 0;
      continue;
    }
    let w = r.towns.get(at.town);
    if (!w) {
      r.towns.set(at.town, (w = { name: at.town, pop: at.pop || 0, days: new Set(), hits: 0, secs: 0, spots: 0 }));
    }
    for (const d of s.days) w.days.add(d);
    w.hits += s.hits;
    w.secs += s.secs || 0;
    w.spots++;
    if ((at.pop || 0) > w.pop) w.pop = at.pop;
  }
  let best = null;
  for (const r of regions.values()) if (!best || byDwell(best, r) > 0) best = r;
  if (!best) return { region: '', country: '', town: '', days: 0, tags: [...tags] };
  let town = null;
  let bestScore = -1;
  for (const w of best.towns.values()) {
    const score = dwell(w) * size(w.pop);
    if (score > bestScore) {
      bestScore = score;
      town = w;
    }
  }
  // A town has to hold more of your time than the ground no town could be found
  // for. Otherwise it is naming the trip after somewhere you passed on the way
  // to the place the map has no word for — and the region, which does cover
  // that ground, is the truthful answer. "Graubünden" is a worse label than
  // "St. Moritz" and a much better one than the town you drove through.
  if (town && town.secs < best.nameless) town = null;
  return {
    region: best.region,
    country: best.country,
    town: town?.name ?? '',
    days: best.days.size,
    tags: [...tags],
  };
}

/**
 * Give each trip a name: where it mostly happened, then the country it is in.
 *
 * "Zermatt, Switzerland" — a label, not a description. Route names get the
 * descriptive treatment ("Bern → Thun", "Thunersee loop") because a route *is*
 * a shape and the shape is the point; a trip is a week somewhere, and the only
 * thing worth saying about it is where.
 *
 * **Where it mostly happened, not where its middle is.** Naming a trip after
 * the point halfway between its extremes is only right for a trip that stayed
 * put: a fortnight in Rome with a day out to Naples used to be named after a
 * field south of Latina, and Reykjavík–Vík after the sand between them. So the
 * name comes from the region the trip has the most *evidence* in — see
 * `heartOf` — and then from the best-known place inside that region.
 *
 * The chain is deliberate. A town beats the landmark it is beside, a landmark
 * beats the region, a region beats the country, and only genuinely remote
 * ground — the middle of an ocean, an icefield, a desert with no settlement
 * within 30 km — falls through to something vaguer, and then says *what kind*
 * of nowhere it was rather than "Away". A name that can't distinguish two trips
 * isn't a name.
 *
 * Everywhere it went is kept as well, in `tags`, so the search box can find a
 * trip by a place that isn't in its name.
 *
 * @param {Array<object>} trips
 * @param {(lng:number, lat:number) =>
 *   {town?:string, pop?:number, region?:string, regionId?:string, country?:string}} placeAt
 * @param {(trip:object) => (string|null)} [landmarkFor] the lake (or other named
 *   feature) a trip sits on — asked only when the region it spent its days in
 *   has no settlement in it
 */
export function nameTrips(trips, placeAt, landmarkFor) {
  for (const t of trips) {
    // The centre is the fallback, not the answer: a trip with no spots at all
    // (nothing but undated evidence) still deserves whatever its middle knows.
    const heart = heartOf(t, placeAt) ?? {
      ...(placeAt?.(t.center[0], t.center[1]) ?? {}),
      days: 0,
    };
    const where = heart.town || landmarkFor?.(t) || heart.region || heart.country || '';
    t.place = where;
    t.region = heart.region ?? '';
    t.country = heart.country ?? '';
    // Everywhere it went, not just what it ended up called. A trip named after
    // one canton is still the trip that passed through Davos, and typing
    // "davos" should find it.
    t.tags = heart.tags ?? [];
    t.name = where
      ? (heart.country && where !== heart.country ? `${where}, ${heart.country}` : where)
      // No town, no region, no country under any of it. That is either water or
      // somewhere with nothing on the map, and saying which is more use than
      // saying "Away" — which was every western-hemisphere trip back when their
      // coordinates came out unwrapped, and told you nothing.
      : 'At sea or off the map';
  }
  return trips;
}

/**
 * The longest run of consecutive days in a set of them, for "longest streak".
 *
 * Calendar days, counted as calendar days: converting each key to a UTC day
 * number rather than dividing a timestamp means the clocks going forward
 * doesn't shorten a March streak by a day.
 *
 * @param {Iterable<string>} dayKeys "YYYY-MM-DD"
 */
export function longestStreak(dayKeys) {
  const nums = [];
  for (const k of dayKeys) {
    const [y, m, d] = String(k).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      nums.push(Date.UTC(y, m - 1, d) / 86400000);
    }
  }
  if (!nums.length) return { days: 0, endsAt: '' };
  nums.sort((a, b) => a - b);
  let best = 1;
  let bestEnd = nums[0];
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1]) continue;
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    if (run > best) {
      best = run;
      bestEnd = nums[i];
    }
  }
  const end = new Date(bestEnd * 86400000);
  return {
    days: best,
    endsAt: `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`,
  };
}

/** The seconds spanned by one local calendar day. */
const dayBounds = (key) => {
  const start = new Date(`${key}T00:00:00`).getTime() / 1000;
  return [start, start + DAY];
};

/**
 * Where you were on one calendar day, in the order you were there.
 *
 * The same reading as the calendar's dots — both ends of every stored row, and
 * nothing in between — but placed and timed rather than counted, because a day
 * with a dot on it is a day you should be able to *look* at. Sorted by time so
 * the map can thread the points into the track they came from.
 *
 * @param {string} key "YYYY-MM-DD"
 * @param {Map<string, Array>} cellMeta
 * @returns {Array<{id:string, lng:number, lat:number, at:number, fresh:boolean}>}
 */
export function dayCells(key, cellMeta) {
  const [start, end] = dayBounds(key);
  const inDay = (at) => at >= start && at < end;
  const out = [];
  for (const [id, entries] of cellMeta ?? []) {
    const [L, col, row] = id.split('/').map(Number);
    if (!Number.isFinite(L)) continue;
    let at = 0;
    let fresh = false;
    for (const e of entries) {
      // First seen and last seen are both dates the row actually carries; a
      // cell whose row merely *spans* this day says nothing about it.
      const hit = inDay(e.firstAt || 0) ? e.firstAt : inDay(e.lastAt || 0) ? e.lastAt : 0;
      if (!hit) continue;
      if (inDay(e.firstAt || 0)) fresh = true;
      if (!at || hit < at) at = hit;
    }
    if (!at) continue;
    const p = project(cellCenter(L, col, row));
    out.push({ id, lng: wrapLng(p[0]), lat: p[1], at, fresh });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Everything that happened on one calendar day: the trip it belongs to, the
 * routes that ran, and the ground you covered.
 *
 * @param {string} key "YYYY-MM-DD"
 */
export function dayDetail(key, trips, routes, cellMeta) {
  const [start, end] = dayBounds(key);
  const inDay = (at) => at >= start && at < end;
  const dayRoutes = (routes ?? []).filter((r) => inDay(r.firstAt || r.lastAt || 0));
  // Two different counts, because they answer two different questions: how
  // much of the map you were on that day, and how much of it was new.
  const cells = dayCells(key, cellMeta);
  const trip = (trips ?? []).find((t) => t.start < end && t.end >= start) ?? null;
  return {
    key,
    start,
    end,
    routes: dayRoutes,
    cells: cells.length,
    newCells: cells.filter((c) => c.fresh).length,
    points: cells,
    trip,
  };
}

/**
 * Which trip each calendar day belongs to.
 *
 * A trip is one journey, and a month grid that shows it as five loose dots is
 * describing five errands. Every day between the first and last thing that
 * happened is mapped, including the quiet ones in the middle: you didn't come
 * home on the Wednesday just because the phone recorded nothing. Days can't
 * collide — the derivation gives each one to at most one trip.
 *
 * @returns {Map<string, object>} day key → the trip covering it
 */
export function tripDays(trips) {
  const out = new Map();
  for (const t of trips ?? []) {
    const from = dayNumber(dayKey(t.start));
    const to = dayNumber(dayKey(t.end));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    for (let n = from; n <= to; n++) out.set(keyOfDay(n), t);
  }
  return out;
}

/**
 * Which calendar days have anything on them — for the calendar's dots.
 *
 * @returns {Map<string, {cells:number, routes:number}>}
 */
export function activeDays(cellMeta, routes) {
  const days = new Map();
  const bump = (at, what) => {
    if (!at) return;
    const key = dayKey(at);
    const d = days.get(key) ?? { cells: 0, routes: 0 };
    d[what]++;
    days.set(key, d);
  };
  // Both ends of a cell's span, not just the first: a cell recorded on the
  // Saturday and again on the Wednesday is evidence of two days, and neither is
  // an inference — they are both dates the data actually carries. The days in
  // between stay dark, because nothing says you were there.
  for (const entries of cellMeta.values()) {
    for (const e of entries) {
      bump(e.firstAt, 'cells');
      if (e.lastAt && dayKey(e.lastAt) !== dayKey(e.firstAt || e.lastAt)) bump(e.lastAt, 'cells');
    }
  }
  for (const r of routes ?? []) bump(r.firstAt || r.lastAt, 'routes');
  return days;
}
