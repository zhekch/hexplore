// Drop far-detached overseas territories from a country geometry so that, at
// the zoomed-out "country" level, visiting (say) French Guiana doesn't light up
// all of France, and mainland Spain isn't tied to the Canary Islands.
//
// Heuristic: proximity flood-fill. Start from the country's largest polygon and
// keep every polygon that chains within OVERSEAS_GAP_DEG of an already-kept one
// (measured as the gap between bounding boxes, in degrees). Genuine archipelago
// and two-landmass nations (Japan, Indonesia, the UK, Malaysia's peninsula +
// Borneo, …) stay whole because their parts sit close together; territories on
// another continent or across an ocean (France's colonies, the Canaries,
// Azores/Madeira, the Dutch Caribbean, …) fall outside the gap and are dropped.
//
// 6° keeps Malaysia's peninsula joined to Borneo (~5.2° apart) while still
// dropping Madeira, the Azores and the Canaries. Lower it to trim more
// aggressively.
export const OVERSEAS_GAP_DEG = 6;

// …but distance alone cannot decide, and the case that proves it is Alaska.
//
// Alaska's bounding box is 7.6° from the contiguous United States and the
// Canaries' is 8.6° from mainland Spain. There is no single distance that keeps
// a state and drops an archipelago when the two are the same distance away, and
// for a long time the answer was to drop both — which did not merely leave
// Alaska unlit. It left it *off the dataset*: `countryAt` returned null there,
// so a cell in Anchorage was in no country, counted as ocean by the statistics,
// filed under "at sea or off the map" by the naming pass, and left a hole in
// North America at the continent level.
//
// Size is what tells them apart, because it is what the question was always
// about. Alaska is 18% of the contiguous United States; the Canaries are 0.4%
// of mainland Spain, the Galápagos 1.9% of Ecuador, Hawaii 0.13%. So a second
// reason to keep a piece: it is *large* and still on the same side of the
// world. Both bounds have an order of magnitude of slack on every case they
// decide except Alaska's own distance, which has a third — and French Guiana,
// which is 16% of France and would qualify on size, is 59° away and never gets
// asked.
//
// Measured against Natural Earth 1:50m, exactly three countries turn on this:
// the United States gains Alaska, and Micronesia and French Polynesia gain the
// far half of their own archipelagos. Hawaii (30° out) stays dropped, as do the
// Canaries, the Azores, Madeira, the Galápagos and every French colony.
export const MAJOR_PART_GAP_DEG = 10;
export const MAJOR_PART_SHARE = 0.1;

import { ringAreaM2 } from '../../src/polygon.js';

// A "poly" is GeoJSON polygon coordinates: [outerRing, ...holes].
function polyBbox(poly) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of poly) {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (y < s) s = y;
      if (x > e) e = x;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

// Ground area of one polygon in km², outer ring less its holes. Real spherical
// area, shared with everything else that measures a country (src/polygon.js),
// rather than the flat shoelace this used to pick the seed with: a share of the
// mainland has to mean the same thing at 65°N as at 25°N, and in degrees² it
// does not — Alaska alone would read three times its size.
function polyKm2(poly) {
  let m2 = ringAreaM2(poly[0]);
  for (let i = 1; i < poly.length; i++) m2 -= ringAreaM2(poly[i]);
  return m2 / 1e6;
}

// Shortest gap between two bounding boxes (0 if they overlap), in degrees.
function bboxGap(a, b) {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  return Math.hypot(dx, dy);
}

// Returns a new geometry with detached territories removed. Polygons and
// single-part MultiPolygons pass through unchanged. If filtering leaves one
// part, it's returned as a Polygon to match build-countries' output shape.
export function stripDetachedTerritories(geometry, gapDeg = OVERSEAS_GAP_DEG) {
  if (!geometry || geometry.type !== 'MultiPolygon') return geometry;
  const polys = geometry.coordinates;
  if (polys.length < 2) return geometry;

  const boxes = polys.map(polyBbox);
  const areas = polys.map(polyKm2);
  let seed = 0;
  for (let i = 1; i < polys.length; i++) if (areas[i] > areas[seed]) seed = i;
  // What counts as a piece of the country in its own right, rather than a
  // holding of it. Measured against the mainland, not the whole country: the
  // whole country is the thing being decided.
  const major = areas[seed] * MAJOR_PART_SHARE;

  const kept = new Set([seed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < polys.length; i++) {
      if (kept.has(i)) continue;
      for (const k of kept) {
        const gap = bboxGap(boxes[i], boxes[k]);
        if (gap <= gapDeg || (gap <= MAJOR_PART_GAP_DEG && areas[i] >= major)) {
          kept.add(i);
          grew = true;
          break;
        }
      }
    }
  }

  if (kept.size === polys.length) return geometry;
  const keptPolys = polys.filter((_, i) => kept.has(i));
  if (keptPolys.length === 1) return { type: 'Polygon', coordinates: keptPolys[0] };
  return { type: 'MultiPolygon', coordinates: keptPolys };
}

// Recompute [w, s, e, n] over an entire geometry (after filtering shrinks it).
export function bboxOfGeometry(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    const [pw, ps, pe, pn] = polyBbox(poly);
    if (pw < w) w = pw;
    if (ps < s) s = ps;
    if (pe > e) e = pe;
    if (pn > n) n = pn;
  }
  return [w, s, e, n];
}
