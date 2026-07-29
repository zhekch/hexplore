// Country boundaries for the coarsest ("country") zoom level. The dataset
// (src/countries.json, built by scripts/build-countries.mjs) is ~1.4 MB, so
// it is dynamic-imported: Vite splits it into its own chunk that only loads
// the first time the map zooms out far enough to show countries — nothing is
// paid for it on a normal phone-sized session that never zooms all the way out.
import polygonClipping from 'polygon-clipping';

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

// Ray-cast point-in-polygon in lng/lat space.
//
// Indexed loads rather than `const [xi, yi] = ring[i]`: destructuring an array
// runs the iterator protocol on every vertex, and this is the innermost loop of
// the statistics sweep — tens of millions of iterations for one panel open.
// Reading the two slots directly is the same arithmetic, an order of magnitude
// faster.
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const yi = a[1];
    const yj = b[1];
    if (yi > lat !== yj > lat && lng < ((b[0] - a[0]) * (lat - yi)) / (yj - yi) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

// A point is in a polygon when it's inside the outer ring and outside every
// hole. `rings` is [outer, ...holes].
function inPolygon(lng, lat, rings) {
  if (!inRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lng, lat, rings[i])) return false;
  }
  return true;
}

// Which country contains this point, or null (ocean / not loaded). The bbox
// prefilter rejects almost every country in one comparison.
export function countryIdAt(lng, lat) {
  if (!COUNTRIES) return null;
  for (const c of COUNTRIES) {
    const [w, s, e, n] = c.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const g = c.geometry;
    if (g.type === 'Polygon') {
      if (inPolygon(lng, lat, g.coordinates)) return c.id;
    } else {
      for (const poly of g.coordinates) {
        if (inPolygon(lng, lat, poly)) return c.id;
      }
    }
  }
  return null;
}

// Normalize either geometry kind to MultiPolygon coordinates.
const asMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

// --- Areas (for the coverage statistics) --------------------------------------
// Ring area on a sphere, from the standard spherical-excess sum. Holes are
// subtracted. Good to ~0.2% against published country areas, which is well
// inside the error of the 1 km-rounded boundaries themselves.
const R_E = 6378137;
const DEG = Math.PI / 180;

function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    sum += (lng2 - lng1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return Math.abs((sum * R_E * R_E) / 2);
}

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
  if (!geoms.length) return { fill: [], rings: [] };
  const merged = polygonClipping.union(geoms[0], ...geoms.slice(1)); // MultiPolygon
  const rings = [];
  for (const poly of merged) {
    for (const ring of poly) rings.push(ring);
  }
  return { fill: merged, rings };
}
