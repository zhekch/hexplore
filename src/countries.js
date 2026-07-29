// Country boundaries for the coarsest ("country") zoom level. The dataset
// (src/countries.json, built by scripts/build-countries.mjs) is ~1.4 MB, so
// it is dynamic-imported: Vite splits it into its own chunk that only loads
// the first time the map zooms out far enough to show countries — nothing is
// paid for it on a normal phone-sized session that never zooms all the way out.
// The point-in-polygon and area maths is shared with the admin-1 regions
// (src/regions.js), which asks the same questions of the same shape of data.
import { inPolygon, asMulti, ringAreaM2, unionGeometries } from './polygon.js';

let COUNTRIES = null; // [{ id, bbox:[w,s,e,n], geometry }]
let loading = null;

export function countriesLoaded() {
  return COUNTRIES !== null;
}

// Kick off (or reuse) the one-time fetch. Resolves when the data is ready.
export function loadCountries() {
  if (!loading) {
    loading = import('./countries.json').then((m) => {
      COUNTRIES = m.default;
      return COUNTRIES;
    });
  }
  return loading;
}

/**
 * Which country contains this point, as its whole record, or null (ocean / not
 * loaded). The bbox prefilter rejects almost every country in one comparison.
 *
 * Callers that go on to ask about *regions* must use `.iso`, not `.id`: the two
 * Natural Earth files disagree on twelve names — this one says "Czechia" where
 * the admin-1 file says "Czech Republic" — and joining them on the name painted
 * the whole of Czechia as one flat shape.
 *
 * @returns {{id:string, iso:string|null}|null}
 */
export function countryAt(lng, lat) {
  if (!COUNTRIES) return null;
  for (const c of COUNTRIES) {
    const [w, s, e, n] = c.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const g = c.geometry;
    if (g.type === 'Polygon') {
      if (inPolygon(lng, lat, g.coordinates)) return c;
    } else {
      for (const poly of g.coordinates) {
        if (inPolygon(lng, lat, poly)) return c;
      }
    }
  }
  return null;
}

/** Just the display name, for everything that only wants to show it. */
export const countryIdAt = (lng, lat) => countryAt(lng, lat)?.id ?? null;

// --- Areas (for the coverage statistics) --------------------------------------
const areaMemo = new Map();

// Land area of one country in km², or 0 if it isn't in the dataset.
export function countryAreaKm2(id) {
  if (areaMemo.has(id)) return areaMemo.get(id);
  const c = COUNTRIES?.find((x) => x.id === id);
  let km2 = 0;
  if (c) {
    for (const poly of asMulti(c.geometry)) {
      km2 += ringAreaM2(poly[0]);
      for (let i = 1; i < poly.length; i++) km2 -= ringAreaM2(poly[i]);
    }
    km2 /= 1e6;
  }
  areaMemo.set(id, km2);
  return km2;
}

export const countryCount = () => COUNTRIES?.length ?? 0;

/** Countries whose name matches, for the search box. Same deal as regions:
 *  nothing until the dataset is already in memory. */
export function searchCountries(query, limit = 2) {
  if (!COUNTRIES) return [];
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const c of COUNTRIES) {
    const name = String(c.id).toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ rank: name === q ? 0 : at === 0 ? 1 : 2, name: c.id, bbox: c.bbox, kind: 'country' });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  return hits.slice(0, limit);
}

// One country's raw geometry — used by the heat maps, which color countries
// individually instead of dissolving them together.
export const countryGeometry = (id) => COUNTRIES?.find((c) => c.id === id)?.geometry ?? null;

// Union the lit countries into one dissolved shape: touching countries merge
// with no border between them. Returns the fill (MultiPolygon coordinates) and
// every boundary ring (outer rings + holes) for the outline.
export function mergeCountries(litIds) {
  if (!COUNTRIES || !litIds.size) return { fill: [], rings: [] };
  const geoms = [];
  for (const c of COUNTRIES) {
    if (litIds.has(c.id)) geoms.push(asMulti(c.geometry));
  }
  return unionGeometries(geoms);
}
