// Coverage statistics: how much of the world (and of each country) the visited
// cells actually cover.
//
// Every cell is a Mercator hexagon, so its ground area shrinks with latitude —
// area = (mercator hex area) × cos²φ. Countries come from the same dataset the
// country zoom level uses; each cell is attributed to the country under its
// center (~22k exact point-in-country tests take well under half a second).

import { SQRT3, radiusOf, cellCenter, project, MAX_LEVEL } from './hexgrid.js';
import { loadCountries, countryIdAt, countryAreaKm2, countryCount } from './countries.js';
import { loadRegions, regionAt, regionAreaKm2, regionsInCountry } from './regions.js';

// Earth's land surface, the yardstick for "% of the world" (oceans excluded —
// covering the Pacific isn't a goal anyone has).
export const EARTH_LAND_KM2 = 148_940_000;

const wrapLng = (lng) => (((lng + 180) % 360) + 360) % 360 - 180;

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
 * @param {Iterable<string>} cellIds visited cell ids ("L/col/row")
 * @param {Map<string, Array>} cellMeta id → provenance entries
 */
export async function computeStats(cellIds, cellMeta) {
  await Promise.all([loadCountries(), loadRegions()]);

  const byCountry = new Map(); // id → { cells, km2 }
  const byRegion = new Map(); //  id → { name, country, cells, km2 }
  const bySource = new Map(); // source → cells
  let cells = 0;
  let km2 = 0;
  let oceanKm2 = 0;
  let firstAt = 0;
  let lastAt = 0;
  const byYear = new Map(); // year → cells first seen that year

  for (const id of cellIds) {
    const [L, col, row] = id.split('/').map(Number);
    if (L > MAX_LEVEL) continue;
    const [lng, lat] = project(cellCenter(L, col, row));
    const area = cellAreaKm2(L, lat);
    cells++;
    km2 += area;

    const country = countryIdAt(wrapLng(lng), lat);
    if (country) {
      const e = byCountry.get(country) ?? { cells: 0, km2: 0 };
      e.cells++;
      e.km2 += area;
      byCountry.set(country, e);

      const region = regionAt(wrapLng(lng), lat, country);
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
    }
    if (cellFirst) {
      const y = new Date(cellFirst * 1000).getFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + 1);
    }
  }

  const countries = [...byCountry.entries()]
    .map(([id, e]) => {
      const total = countryAreaKm2(id);
      return { id, cells: e.cells, km2: e.km2, totalKm2: total, pct: total ? (e.km2 / total) * 100 : 0 };
    })
    // Sorted by share, so the bars step down the list instead of jumping
    // around — "how much of this country have I covered" is the question the
    // bar answers, and ground covered is right there in the sub-line.
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
  for (const c of byCountry.keys()) regionsReachable += regionsInCountry(c);

  return {
    cells,
    km2,
    oceanKm2,
    worldPct: (km2 / EARTH_LAND_KM2) * 100,
    countries,
    countryTotal: countryCount(),
    regions,
    regionsReachable,
    sources: [...bySource.entries()].map(([key, n]) => ({ key, cells: n })).sort((a, b) => b.cells - a.cells),
    years: fillYearGaps([...byYear.entries()].sort((a, b) => a[0] - b[0])),
    firstAt,
    lastAt,
  };
}
