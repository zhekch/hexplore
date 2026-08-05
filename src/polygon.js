import polygonClipping from 'polygon-clipping';

// Point-in-polygon, dissolving and ring area, shared by the two boundary
// datasets.
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

// A dissolve leaves a gap wherever two neighbours disagree about the border
// they share, and they always disagree: `scripts/build-regions.mjs` simplifies
// each region against *its own* size, so two adjacent cantons thin the same
// border to different vertices. The two polylines then cross back and forth,
// and the union opens a thin triangle at every crossing. Dissolving
// Switzerland's 26 cantons produced one outer ring and **110 holes**.
//
// They are not merely wrong — solid Switzerland is what dissolving its cantons
// means — they break the renderer. A near-zero-width hole tessellates into a
// fan that reaches the far side of the polygon, so a map of Zurich grew two
// translucent wedges spanning nineteen degrees of longitude. It came and went
// with the zoom, because the fan depends on where the tile clip falls, and it
// vanished in the heat modes, which draw each region separately and never
// dissolve anything.
//
// Only the ones that are unambiguously nothing are dropped, and the reason for
// that restraint is worth keeping, because the obvious rule is wrong.
//
// The obvious rule is vertex count: over a nine-country dissolve, 1,643 of
// 1,666 holes had six vertices or fewer, and every real enclave in *that* set
// had many more — Luxembourg 35, Andorra 16, San Marino 14. But sweep the whole
// dataset and the four- and five-vertex holes are mostly real: Llívia inside
// Pyrénées-Orientales, Céligny inside Vaud, the Azerbaijani exclaves inside
// Tavush, Moscow inside Moskovskaya, Addis Ababa inside Oromiya. A small
// enclave simplifies to a quad exactly like a border gap does.
//
// And they cannot be told apart by shape either. The gap this file was written
// for — a 4.4 km² triangle where Marche, Umbria and Toscana meet — scores
// compactness 0.594; Llívia, which is a real Spanish town, is 5.4 km² at 0.498.
// The artifact is the smaller *and* the rounder of the two, and both work out
// to an effective width of 0.91 km. No threshold on area, roundness or vertex
// count separates them, because there is nothing to separate: they are the same
// shape, and only their history differs.
//
// So the test is degeneracy, not size. A lens left where two simplified borders
// cross has near-zero width for its length — the worst in Switzerland was
// 0.211 km² spread over 28 km of perimeter, compactness 0.0033 — and that is
// what makes the renderer fan it across the polygon. Everything real sits an
// order of magnitude above the threshold: the least compact enclave found
// anywhere in the set scores 0.30. Small round gaps do survive, and they are
// drawn as the small round holes they look like rather than as wedges.
//
// The gaps themselves are a build problem, not a drawing one — see the note on
// per-region simplification in ARCHITECTURE.md. This is the guard, not the fix.
const SLIVER_MIN_COMPACTNESS = 0.1;

/** Ring perimeter in metres — only ever compared against the ring's own area. */
function ringPerimeterM(ring) {
  let m = 0;
  for (let i = 1; i < ring.length; i++) {
    const [lng1, lat1] = ring[i - 1];
    const [lng2, lat2] = ring[i];
    const dx = (lng2 - lng1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG) * R_E;
    const dy = (lat2 - lat1) * DEG * R_E;
    m += Math.hypot(dx, dy);
  }
  return m;
}

/**
 * Is this hole a gap the dissolve opened rather than a place?
 *
 * Polsby–Popper compactness (4πA/P²): 1 for a circle, ~0 for a lens. Only ever
 * asked of holes — an outer ring may legitimately be as thin as it likes, and
 * plenty are (a barrier island, a fjord's far shore).
 */
function isSliverHole(ring) {
  if (ring.length < 4) return true; // not an area at all
  const p = ringPerimeterM(ring);
  if (!p) return true;
  return (4 * Math.PI * ringAreaM2(ring)) / (p * p) < SLIVER_MIN_COMPACTNESS;
}

/** Dissolve a list of geometries into one shape, and hand back every boundary
 *  ring with it. Both boundary datasets merge their lit shapes exactly this
 *  way — touching areas join with no border between them. */
export function unionGeometries(geoms) {
  if (!geoms.length) return { fill: [], rings: [] };
  const merged = polygonClipping.union(geoms[0], ...geoms.slice(1));
  const fill = [];
  const rings = [];
  for (const poly of merged) {
    // Ring 0 is the outer one and is kept whatever its shape; the rest are
    // holes, and are kept only if they are somewhere rather than nothing.
    const kept = [poly[0]];
    for (let i = 1; i < poly.length; i++) {
      if (!isSliverHole(poly[i])) kept.push(poly[i]);
    }
    fill.push(kept);
    // The outline is drawn from these, so a dropped hole must not leave a
    // border ringing a gap that is no longer there.
    for (const ring of kept) rings.push(ring);
  }
  return { fill, rings };
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
