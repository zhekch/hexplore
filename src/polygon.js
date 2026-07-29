// Point-in-polygon and ring area, shared by the two boundary datasets.
//
// Countries (src/countries.js) and admin-1 regions (src/regions.js) ask exactly
// the same two questions of exactly the same shape of data, and answering them
// twice in two files is how the two slowly stop agreeing about which side of a
// border a cell is on.

/**
 * Ray-cast point-in-ring, in lng/lat space.
 *
 * Indexed loads rather than `const [xi, yi] = ring[i]`: destructuring an array
 * runs the iterator protocol on every vertex, and this is the innermost loop of
 * the statistics sweep — tens of millions of iterations for one panel open.
 * Reading the two slots directly is the same arithmetic, an order of magnitude
 * faster.
 */
export function inRing(lng, lat, ring) {
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

/** A point is in a polygon when it's inside the outer ring and outside every
 *  hole. `rings` is [outer, ...holes]. */
export function inPolygon(lng, lat, rings) {
  if (!inRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lng, lat, rings[i])) return false;
  }
  return true;
}

/** Normalize either geometry kind to MultiPolygon coordinates. */
export const asMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

// --- Areas --------------------------------------------------------------------
// Ring area on a sphere, from the standard spherical-excess sum. Good to ~0.2%
// against published country areas, which is well inside the error of the
// rounded boundaries themselves.
const R_E = 6378137;
const DEG = Math.PI / 180;

export function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    sum += (lng2 - lng1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return Math.abs((sum * R_E * R_E) / 2);
}
