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

/** A gap longer than this starts a new trip. */
export const TRIP_GAP_DAYS = 2;
/**
 * …unless the two sides of the gap are the same place, in which case they are
 * one stay with a quiet middle, and this is how long that middle may be.
 *
 * A cell records when it was first and last seen and nothing in between, so a
 * week in one village arrives as a crowd of arrival dates, a crowd of departure
 * dates, and six days of silence — which the gap rule above reads as two trips
 * to the same place, four days apart. It isn't: it's a week. Two clusters near
 * each other in space and within a fortnight in time are therefore rejoined.
 */
export const TRIP_MERGE_DAYS = 16;
/** How close "the same place" is, for that rejoining. */
export const TRIP_MERGE_KM = 150;
/** Nearer than this to home and you weren't away, you were living. */
export const HOME_RADIUS_KM = 55;
/** Below this, a "trip" is a stray fix with a bad clock. */
export const MIN_TRIP_CELLS = 3;
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
  let sumLng = 0;
  let sumLat = 0;
  let sumW = 0;
  for (const c of top) {
    const [lng, lat] = project(cellCenter(c.L, c.col, c.row));
    sumLng += lng * c.hits;
    sumLat += lat * c.hits;
    sumW += c.hits;
  }
  return { lng: sumLng / sumW, lat: sumLat / sumW, hits: top[0].hits };
}

// Mean position of a cluster's events, memoised because the merge pass asks
// for it once per neighbour.
function centerOf(c) {
  if (!c.center) {
    let lng = 0;
    let lat = 0;
    for (const e of c.events) {
      lng += e.lng;
      lat += e.lat;
    }
    c.center = [lng / c.events.length, lat / c.events.length];
  }
  return c.center;
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
      if (!lngLat) lngLat = project(cellCenter(L, col, row));
      out.push({ at, lng: lngLat[0], lat: lngLat[1], cell: id });
      // Both ends, whenever they differ. A cell you passed through in March and
      // again in September belongs to two trips; a cell seen on the Friday and
      // again on the Sunday is one trip that has to know it lasted the weekend.
      // Emitting only the far-apart ones made every short stay a day long.
      if (e.lastAt && e.lastAt > at) {
        out.push({ at: e.lastAt, lng: lngLat[0], lat: lngLat[1], cell: id });
      }
    }
  }
  for (const r of routes ?? []) {
    const at = r.firstAt || r.lastAt;
    if (!at) continue;
    const b = r.bounds ?? [];
    const lng = b.length === 4 ? (b[0] + b[2]) / 2 : null;
    const lat = b.length === 4 ? (b[1] + b[3]) / 2 : null;
    if (lng === null || !Number.isFinite(lng)) continue;
    out.push({ at, lng, lat, route: r });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Work the stored history into trips.
 *
 * @param {Map<string, Array>} cellMeta
 * @param {Array<object>} routes  saved routes (metadata is enough)
 * @param {{home?:{lng:number,lat:number}, gapDays?:number, radiusKm?:number, minCells?:number}} [opts]
 * @returns {Array<object>} newest first
 */
export function buildTrips(cellMeta, routes = [], opts = {}) {
  const gap = (opts.gapDays ?? TRIP_GAP_DAYS) * DAY;
  const radius = opts.radiusKm ?? HOME_RADIUS_KM;
  const minCells = opts.minCells ?? MIN_TRIP_CELLS;
  // `home: null` explicitly means "there isn't one" — distinct from leaving it
  // out, which means "work it out".
  const home = 'home' in opts ? opts.home : findHome(cellMeta);
  const all = events(cellMeta, routes);
  if (!all.length) return [];

  // Being away is what makes it a trip. Without a home to be away from —
  // a brand-new account, one import of one holiday — every cluster counts,
  // because then the whole map is somewhere you went.
  const away = home
    ? all.filter((e) => distanceKm(home.lng, home.lat, e.lng, e.lat) > radius)
    : all;

  const clusters = [];
  let cur = null;
  for (const e of away) {
    if (!cur || e.at - cur.end > gap) {
      cur = { start: e.at, end: e.at, events: [e] };
      clusters.push(cur);
    } else {
      cur.end = e.at;
      cur.events.push(e);
    }
  }

  // Rejoin the halves of a stay — see TRIP_MERGE_DAYS. Done on the clusters
  // rather than on the finished trips so the merged one is summarised once,
  // from all of its events, instead of having two summaries added together.
  const mergeGap = (opts.mergeDays ?? TRIP_MERGE_DAYS) * DAY;
  const mergeKm = opts.mergeKm ?? TRIP_MERGE_KM;
  const trips = [];
  for (const c of clusters) {
    const prev = trips[trips.length - 1];
    if (prev && c.start - prev.end <= mergeGap && distanceKm(...centerOf(prev), ...centerOf(c)) <= mergeKm) {
      prev.end = Math.max(prev.end, c.end);
      prev.events.push(...c.events);
      prev.center = null; // it moved
    } else {
      trips.push(c);
    }
  }

  const out = [];
  for (const t of trips) {
    const cells = new Set();
    const tripRoutes = [];
    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    let sumLng = 0;
    let sumLat = 0;
    for (const e of t.events) {
      if (e.cell) cells.add(e.cell);
      if (e.route) tripRoutes.push(e.route);
      if (e.lng < bbox[0]) bbox[0] = e.lng;
      if (e.lat < bbox[1]) bbox[1] = e.lat;
      if (e.lng > bbox[2]) bbox[2] = e.lng;
      if (e.lat > bbox[3]) bbox[3] = e.lat;
      sumLng += e.lng;
      sumLat += e.lat;
    }
    // A day trip that lit two cells is noise unless it also drew a line.
    if (cells.size < minCells && !tripRoutes.length) continue;
    const center = [sumLng / t.events.length, sumLat / t.events.length];
    out.push({
      // Stable across rebuilds (it's derived from the data, not from the
      // order it was derived in), so the UI can select one and find it again.
      id: `trip-${t.start}`,
      start: t.start,
      end: t.end,
      days: Math.max(1, Math.round((t.end - t.start) / DAY) + 1),
      cells: [...cells],
      routes: tripRoutes,
      lengthM: tripRoutes.reduce((m, r) => m + (r.lengthM || 0), 0),
      bbox,
      center,
      farKm: home ? Math.round(distanceKm(home.lng, home.lat, center[0], center[1])) : 0,
      name: '', // filled in by nameTrips(), which needs the place dataset
    });
  }
  out.sort((a, b) => b.start - a.start);
  return out;
}

/**
 * Give each trip a name from the ground it covered.
 *
 * Kept apart from buildTrips because the place dataset is a 2 MB browser chunk
 * loaded on demand: trips can be counted, dated and drawn without it, and only
 * naming has to wait.
 *
 * @param {Array<object>} trips
 * @param {(lng:number, lat:number) => {name:string}|null} nearestTown
 * @param {(bounds:Array) => string|null} [lakeAround]
 */
export function nameTrips(trips, nearestTown, lakeAround) {
  for (const t of trips) {
    // The routes went where you meant to go; the cells include the motorway
    // getting there. So a route's own place name wins when there is one.
    const fromRoute = t.routes.find((r) => r.place)?.place;
    const town = nearestTown?.(t.center[0], t.center[1]);
    const lake = lakeAround?.(t.bbox);
    t.name = fromRoute || town?.name || lake || 'Away';
  }
  return trips;
}

/**
 * Everything that happened on one calendar day: the trip it belongs to, the
 * routes that ran, and how many cells were first seen.
 *
 * @param {string} key "YYYY-MM-DD"
 */
export function dayDetail(key, trips, routes, cellMeta) {
  const start = new Date(`${key}T00:00:00`).getTime() / 1000;
  const end = start + DAY;
  const inDay = (at) => at >= start && at < end;
  const dayRoutes = (routes ?? []).filter((r) => inDay(r.firstAt || r.lastAt || 0));
  // Two different counts, because they answer two different questions: how
  // much of the map you were on that day, and how much of it was new.
  let cells = 0;
  let newCells = 0;
  for (const entries of cellMeta.values()) {
    let seen = false;
    let fresh = false;
    for (const e of entries) {
      if (inDay(e.firstAt || 0)) {
        seen = true;
        fresh = true;
      } else if (inDay(e.lastAt || 0)) {
        seen = true;
      }
    }
    if (seen) cells++;
    if (fresh) newCells++;
  }
  const trip = (trips ?? []).find((t) => t.start < end && t.end >= start) ?? null;
  return { key, start, end, routes: dayRoutes, cells, newCells, trip };
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
