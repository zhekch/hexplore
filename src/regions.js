// Admin-1 regions — states, provinces, cantons, départements — for the finer
// half of the coverage statistics.
//
// Countries answer "where in the world have I been"; this answers "how much of
// where I live". Twenty-three of a hundred and ninety-five is a number that
// moves once a year and never for the country you actually live in;
// Switzerland is one country and twenty-six cantons, and that number moves on a
// weekend.
//
// The dataset (src/regions.json, built by scripts/build-regions.mjs) is ~2.5 MB
// and dynamic-imported, so nothing pays for it until the statistics panel is
// opened on a section that needs it.
//
// It is also fourteen times as many shapes as the country set, which is why
// there's a grid index below: the country lookup can afford to scan its ~250
// bboxes for every one of ~20k cells, and this one cannot.

import polygonClipping from 'polygon-clipping';
import { inPolygon, asMulti, ringAreaM2 } from './polygon.js';

let REGIONS = null; // [{ id, name, country, bbox:[w,s,e,n], geometry }]
let index = null; //   "gx/gy" → region indices whose bbox touches that tile
let loading = null;

// 5° tiles: ~550 km, comfortably bigger than all but a handful of regions, so
// most land in one or two buckets. Small enough that a bucket holds a few
// dozen candidates rather than a continent's worth.
const TILE = 5;

const tileKey = (lng, lat) => `${Math.floor(lng / TILE)}/${Math.floor(lat / TILE)}`;

function buildIndex() {
  index = new Map();
  for (let i = 0; i < REGIONS.length; i++) {
    const [w, s, e, n] = REGIONS[i].bbox;
    // A bbox spanning the antimeridian would enumerate the globe; the few
    // regions that do (Chukotka) are entered under both ends instead.
    const spans = e < w;
    const xs = spans ? [[-180, e], [w, 180]] : [[w, e]];
    for (const [x0, x1] of xs) {
      for (let gx = Math.floor(x0 / TILE); gx <= Math.floor(x1 / TILE); gx++) {
        for (let gy = Math.floor(s / TILE); gy <= Math.floor(n / TILE); gy++) {
          const key = `${gx}/${gy}`;
          const bucket = index.get(key);
          if (bucket) bucket.push(i);
          else index.set(key, [i]);
        }
      }
    }
  }
}

export const regionsLoaded = () => REGIONS !== null;

/** Kick off (or reuse) the one-time fetch. Resolves when the data is ready. */
export function loadRegions() {
  if (!loading) {
    loading = import('./regions.json').then((m) => {
      REGIONS = m.default;
      buildIndex();
      return REGIONS;
    });
  }
  return loading;
}

/**
 * The region containing a point, or null (ocean, or a country the dataset
 * doesn't subdivide).
 *
 * @param {number} lng
 * @param {number} lat
 * @param {string} [country] the country already worked out for this point, if
 *   there is one. Regions elsewhere are then skipped without a geometry test,
 *   which is most of them — the statistics sweep already knows the country.
 * @returns {{id:string, name:string, country:string}|null}
 */
export function regionAt(lng, lat, country) {
  if (!REGIONS) return null;
  const bucket = index.get(tileKey(lng, lat));
  if (!bucket) return null;
  for (const i of bucket) {
    const r = REGIONS[i];
    if (country && r.country !== country) continue;
    const [w, s, e, n] = r.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const g = r.geometry;
    if (g.type === 'Polygon') {
      if (inPolygon(lng, lat, g.coordinates)) return r;
    } else {
      for (const poly of g.coordinates) {
        if (inPolygon(lng, lat, poly)) return r;
      }
    }
  }
  return null;
}

const areaMemo = new Map();

/** Land area of one region in km², or 0 if it isn't in the dataset. */
export function regionAreaKm2(id) {
  if (areaMemo.has(id)) return areaMemo.get(id);
  const r = REGIONS?.find((x) => x.id === id);
  let km2 = 0;
  if (r) {
    for (const poly of asMulti(r.geometry)) {
      km2 += ringAreaM2(poly[0]);
      for (let i = 1; i < poly.length; i++) km2 -= ringAreaM2(poly[i]);
    }
    km2 /= 1e6;
  }
  areaMemo.set(id, km2);
  return km2;
}

/** How many regions one country is divided into (0 if it isn't in the set). */
export function regionsInCountry(country) {
  if (!REGIONS) return 0;
  let n = 0;
  for (const r of REGIONS) if (r.country === country) n++;
  return n;
}

export const regionCount = () => REGIONS?.length ?? 0;

/** One region's raw geometry — used by the heat maps, which colour each region
 *  separately instead of dissolving them together. */
export const regionGeometry = (id) => REGIONS?.find((r) => r.id === id)?.geometry ?? null;

/**
 * Union the lit regions into one dissolved shape, exactly as the country level
 * does: touching cantons merge with no border between them. Returns the fill
 * and every boundary ring for the outline.
 */
export function mergeRegions(litIds) {
  if (!REGIONS || !litIds.size) return { fill: [], rings: [] };
  const geoms = [];
  for (const r of REGIONS) {
    if (litIds.has(r.id)) geoms.push(asMulti(r.geometry));
  }
  if (!geoms.length) return { fill: [], rings: [] };
  const merged = polygonClipping.union(geoms[0], ...geoms.slice(1));
  const rings = [];
  for (const poly of merged) {
    for (const ring of poly) rings.push(ring);
  }
  return { fill: merged, rings };
}

/**
 * Regions whose name matches, for the search box. Returns nothing when the
 * dataset isn't loaded rather than loading it: 2.5 MB is not a reasonable price
 * for a keystroke, and by the time anyone searches, the trips have usually
 * pulled it in already.
 */
export function searchRegions(query, limit = 3) {
  if (!REGIONS) return [];
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const r of REGIONS) {
    const name = r.name.toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ rank: name === q ? 0 : at === 0 ? 1 : 2, name: r.name, country: r.country, bbox: r.bbox, kind: 'region' });
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  return hits.slice(0, limit);
}
