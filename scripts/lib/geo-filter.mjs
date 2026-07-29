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
// dropping Madeira (~8°) and the Canaries (~10°). Raise it to keep more distant
// pieces (e.g. Alaska/Hawaii for the USA, which are ~11° from the mainland and
// currently dropped); lower it to trim more aggressively.
export const OVERSEAS_GAP_DEG = 6;

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

// Absolute shoelace area of the outer ring — a cheap "which polygon is biggest"
// proxy (good enough to pick the mainland as the flood-fill seed).
function outerArea(poly) {
  const ring = poly[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
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
  const areas = polys.map(outerArea);
  let seed = 0;
  for (let i = 1; i < polys.length; i++) if (areas[i] > areas[seed]) seed = i;

  const kept = new Set([seed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < polys.length; i++) {
      if (kept.has(i)) continue;
      for (const k of kept) {
        if (bboxGap(boxes[i], boxes[k]) <= gapDeg) {
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
