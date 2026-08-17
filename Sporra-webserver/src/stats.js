// Coverage statistics: how much of the world (and of each country) the visited
// cells actually cover.
//
// Every cell is a Mercator hexagon, so its ground area shrinks with latitude —
// area = (mercator hex area) × cos²φ. Countries come from the same dataset the
// country zoom level uses; each cell is attributed to the country under its
// center (~22k exact point-in-country tests take well under half a second).

import { SQRT3, radiusOf, cellCenter, project, MAX_LEVEL, parseCellId, wrapLng } from './hexgrid.js';
import { loadCountries, countryAt, countryNear, countryAreaKm2, countryCount } from './countries.js';
import { loadRegions, regionNear, regionAreaKm2, regionsInCountry } from './regions.js';
import { continentOf } from './continents.js';
import { dayKey, longestStreak } from './trips.js';

// Earth's land surface, the yardstick for "% of the world" (oceans excluded —
// covering the Pacific isn't a goal anyone has).
export const EARTH_LAND_KM2 = 148_940_000;

// How these numbers are spelled, in the one place both readers of them can
// reach. The Cells tab and the image export show the same coverage; a poster
// that rounded 1.24 % to "1%" beside a panel saying "1.2%" would read as two
// different measurements of the same ground.
export const formatKm2 = (v) =>
  v >= 1000 ? `${Math.round(v).toLocaleString()} km²`
  : v >= 10 ? `${v.toFixed(0)} km²`
  : `${v.toFixed(1)} km²`;

// Coverage numbers span orders of magnitude — 7 % of Switzerland next to
// 0.005 % of the planet — so keep enough digits for the small end to survive.
export const formatPct = (v) =>
  v >= 10 ? `${v.toFixed(0)}%`
  : v >= 1 ? `${v.toFixed(1)}%`
  : v >= 0.01 ? `${v.toFixed(2)}%`
  : v >= 0.001 ? `${v.toFixed(3)}%`
  : v > 0 ? '<0.001%' // a single cell in a big country rounds to nothing
  : '0%';

// Marks a "region" that is really a whole country, for the countries the
// admin-1 dataset doesn't subdivide. The prefix can't collide: real region ids
// are "Country/Name".
export const WHOLE_COUNTRY = '\u0000country:';

/**
 * Which country, or which admin-1 region, one stored cell belongs to.
 *
 * Lives here, beside the coverage sweep, because the map's region level asks
 * exactly this question of exactly these rows and used to answer it its own
 * way — from the centre of a 9 km hexagon that a cell merely fell inside. That
 * lit regions nobody had been to (Appenzell Innerrhoden off cells in Sankt
 * Gallen) while this file, reading the cells themselves, correctly listed none
 * of them. Two answers to one question is the bug; this is the one answer.
 *
 * `countryNear`, not `countryAt`: the outlines are simplified to about a
 * kilometre, so a cell in a lagoon or a fjord is inside no polygon at all and
 * would otherwise belong nowhere. The coverage sweep below still uses
 * `countryAt`, because it has a second question to answer — how much of what
 * you covered was *sea* — and "near land" is the wrong answer to that one.
 *
 * @param {'region'|'country'|'continent'} kind
 * @param {string} id stored cell id, "L/col/row"
 * @returns {string|null} the area's id, or null for a cell in no country at all
 */
export function areaOfCell(kind, id) {
  const [L, col, row] = parseCellId(id);
  if (!Number.isFinite(L) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (L > MAX_LEVEL) return null; // stored at a level that no longer exists
  const [lng, lat] = project(cellCenter(L, col, row));
  return areaAtPoint(kind, wrapLng(lng), lat);
}

/**
 * The same lookup from a point.
 *
 * The map answers a *click* with the region's name and its country as well as
 * its id, which it has the datasets to do and this does not, so `areaAt` in
 * src/main.js asks the same two questions in the same order rather than
 * wrapping this. The image export only needs the id — clicking its preview
 * picks a place out of the selection — and takes this.
 *
 * A handful of countries have no admin-1 entry in the dataset at all
 * (microstates, some dependencies). Falling through to null would make them
 * *vanish* at the region level while still being lit one level further out,
 * which reads as a rendering bug and is one; the country stands in as its own
 * region instead. It has to be exactly that narrow — `regionNear` already
 * snaps the border and coastal slivers where the two datasets disagree, so a
 * miss here means the country really has no regions. An earlier version stood
 * the whole country in on any miss, and one stray cell in a 1 km sliver off the
 * Ligurian coast coloured in the entire of Italy underneath its cantons.
 */
export function areaAtPoint(kind, lng, lat) {
  const at = countryNear(lng, lat);
  if (!at) return null;
  // A continent is reached through its country rather than from its own
  // outline: the outline *is* the countries dissolved, so asking it directly
  // would be the same test run against a shape with more points in it, and the
  // two could still disagree at a coast where the union left a seam.
  if (kind === 'continent') return continentOf(at.id);
  if (kind !== 'region') return at.id;
  const region = regionNear(lng, lat, at.iso);
  if (region) return region.id;
  return regionsInCountry(at.iso) === 0 ? `${WHOLE_COUNTRY}${at.id}` : null;
}

// Ground area of one cell at `lat`, in km².
export function cellAreaKm2(level, lat) {
  const R = radiusOf(level);
  const mercM2 = ((3 * SQRT3) / 2) * R * R;
  const cos = Math.cos((lat * Math.PI) / 180);
  return (mercM2 * cos * cos) / 1e6;
}

// Years with nothing new still get a slot, so the bar chart's spacing matches
// real time instead of silently closing the gaps.
function fillYearGaps(pairs) {
  if (pairs.length < 2) return pairs;
  const out = [];
  for (let y = pairs[0][0]; y <= pairs[pairs.length - 1][0]; y++) {
    out.push([y, pairs.find(([py]) => py === y)?.[1] ?? 0]);
  }
  return out;
}

/**
 * Crunch the visited set into coverage numbers. Loads the country dataset on
 * first use (the same ~1.4 MB chunk the country zoom level pulls in).
 *
 * Admin-1 regions are counted in the same sweep as countries, because the
 * expensive part is projecting each cell centre and that is paid once either
 * way. The region dataset is a second lazy chunk; a lookup is given the country
 * the cell already resolved to, which drops all but a couple of dozen of the
 * 4,500 shapes before any geometry is touched.
 *
 * `only` narrows the sweep to part of the map without narrowing what is
 * measured about it. The image export asks these same questions of one country
 * or one canton — "how much of *Switzerland*, first seen when, over how many
 * days" — and every one of them is this function's answer over a subset of the
 * rows. A predicate is all it takes because the arithmetic never looks outside
 * the cell it is on; the caller supplies the denominator (a country's own area)
 * that a filtered sweep cannot know.
 *
 * @param {Iterable<string>} cellIds visited cell ids ("L/col/row")
 * @param {Map<string, Array>} cellMeta id → provenance entries
 * @param {(id:string) => boolean} [only] which cells to count; all of them by default
 */
export async function computeStats(cellIds, cellMeta, only = null) {
  await Promise.all([loadCountries(), loadRegions()]);

  const byCountry = new Map(); // id → { iso, cells, km2 }
  const byRegion = new Map(); //  id → { name, country, cells, km2 }
  const isosSeen = new Set(); // country codes touched, for the region denominator
  const bySource = new Map(); // source → cells
  let cells = 0;
  let km2 = 0;
  let oceanKm2 = 0;
  let firstAt = 0;
  let lastAt = 0;
  const byYear = new Map(); // year → cells first seen that year
  // Every calendar day the history has evidence for. Both ends of a cell's span
  // count and the quiet middle does not — the same reading of a stored row the
  // calendar dots use, so the two can never disagree about a day.
  const daysSeen = new Set();

  for (const id of cellIds) {
    const [L, col, row] = parseCellId(id);
    if (!(L <= MAX_LEVEL)) continue;
    if (only && !only(id)) continue;
    const [lng, lat] = project(cellCenter(L, col, row));
    const area = cellAreaKm2(L, lat);
    cells++;
    km2 += area;

    const at = countryAt(wrapLng(lng), lat);
    const country = at?.id ?? null;
    if (country) {
      if (at.iso) isosSeen.add(at.iso);
      const e = byCountry.get(country) ?? { iso: at.iso ?? null, cells: 0, km2: 0 };
      e.cells++;
      e.km2 += area;
      byCountry.set(country, e);

      // Snapping, not exact: a cell 1 km off a canton's simplified coastline
      // belongs to that canton, and dropping it would quietly under-count the
      // coast of every country.
      // By ISO, not by name: the two Natural Earth files disagree on twelve
      // country names, and matching on the name silently counted nothing for
      // those countries' regions.
      const region = regionNear(wrapLng(lng), lat, at.iso);
      if (region) {
        const r = byRegion.get(region.id) ?? { name: region.name, country, cells: 0, km2: 0 };
        r.cells++;
        r.km2 += area;
        byRegion.set(region.id, r);
      }
    } else {
      oceanKm2 += area; // coastal cells whose center falls just offshore
    }

    let cellFirst = 0;
    for (const m of cellMeta.get(id) ?? []) {
      bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
      if (m.firstAt && (!cellFirst || m.firstAt < cellFirst)) cellFirst = m.firstAt;
      if (m.firstAt && (!firstAt || m.firstAt < firstAt)) firstAt = m.firstAt;
      if (m.lastAt > lastAt) lastAt = m.lastAt;
      if (m.firstAt) daysSeen.add(dayKey(m.firstAt));
      if (m.lastAt) daysSeen.add(dayKey(m.lastAt));
    }
    if (cellFirst) {
      const y = new Date(cellFirst * 1000).getFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + 1);
    }
  }

  const countries = [...byCountry.entries()]
    .map(([id, e]) => {
      const total = countryAreaKm2(id);
      return {
        id,
        iso: e.iso,
        cells: e.cells,
        km2: e.km2,
        totalKm2: total,
        pct: total ? (e.km2 / total) * 100 : 0,
        // How many regions the country has at all, so a country can say "5 of
        // 26" about itself when you open it up.
        regionsTotal: e.iso ? regionsInCountry(e.iso) : 0,
      };
    })
    // Sorted at all so the order is deterministic; the panel re-sorts by
    // whichever question is being asked of it (see SORTS in src/stats-ui.js).
    .sort((a, b) => b.pct - a.pct || b.km2 - a.km2);

  const regions = [...byRegion.entries()]
    .map(([id, e]) => {
      const total = regionAreaKm2(id);
      return { id, name: e.name, country: e.country, cells: e.cells, km2: e.km2, totalKm2: total, pct: total ? (e.km2 / total) * 100 : 0 };
    })
    .sort((a, b) => b.pct - a.pct || b.km2 - a.km2);

  // "12 of 4,553 in the world" is a number nobody can feel. The denominator
  // that means something is the countries you have actually been to: every
  // region in them is one you could plausibly go and see.
  let regionsReachable = 0;
  for (const iso of isosSeen) regionsReachable += regionsInCountry(iso);

  const streak = longestStreak(daysSeen);

  return {
    cells,
    km2,
    oceanKm2,
    worldPct: (km2 / EARTH_LAND_KM2) * 100,
    countries,
    countryTotal: countryCount(),
    regions,
    regionsReachable,
    // Days the map has evidence for, and the longest unbroken run of them.
    days: daysSeen.size,
    streakDays: streak.days,
    streakEnd: streak.endsAt,
    sources: [...bySource.entries()].map(([key, n]) => ({ key, cells: n })).sort((a, b) => b.cells - a.cells),
    years: fillYearGaps([...byYear.entries()].sort((a, b) => a[0] - b[0])),
    firstAt,
    lastAt,
  };
}
