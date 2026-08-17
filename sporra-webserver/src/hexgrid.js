// Shared hex-lattice math — used by the app (src/main.js) and by the data
// import scripts (scripts/*.mjs). Pure functions only: no DOM, no MapLibre.
//
// The grid lives in Web Mercator space, so every hexagon renders as a
// perfect, identically-oriented hexagon at any location and zoom.
// Orientation is flat-top (flat edges at top and bottom). The trade-off of a
// Mercator grid: ground size shrinks with latitude (×cos φ).

export const R_E = 6378137;
export const WORLD = 2 * Math.PI * R_E; // mercator world width ≈ 40_075_017 m
export const MAX_MERC_Y = WORLD / 2; // web-mercator latitude clamp (±85.05°)
export const SQRT3 = Math.sqrt(3);

export const MAX_LEVEL = 4;
// Columns around the globe at level 0. The `n · 3^MAX_LEVEL` form keeps the
// column count integer AND even at every level, so the odd-column vertical
// offset wraps seamlessly at the antimeridian. With n = 642 the base cell is
// ~0.9 km flat-to-flat near the equator; double the multiplier to halve the
// cell (must stay even).
export const BASE_COLS = 642 * 3 ** MAX_LEVEL; // 52_002
export const COL_SP0 = WORLD / BASE_COLS; // level-0 column spacing = 1.5·R0
export const R0 = COL_SP0 / 1.5; // level-0 circumradius

// --- Mercator helpers --------------------------------------------------------
export const mercX = (lng) => (lng / 360) * WORLD;
export const mercY = (lat) => {
  const s = Math.min(0.9999999, Math.max(-0.9999999, Math.sin((lat * Math.PI) / 180)));
  return R_E * Math.atanh(s);
};
export const lngOf = (x) => (x / WORLD) * 360;
export const latOf = (y) => (Math.atan(Math.sinh(y / R_E)) * 180) / Math.PI;
export const project = ([x, y]) => [lngOf(x), latOf(y)];

// --- Lattice helpers -----------------------------------------------------------
// Flat-top hexes, "odd-q" offset layout: odd columns shift up half a row.
// col spacing = 1.5·R, row spacing = √3·R.
//
// There are only five levels, and `parentOf` asks about one above the level it
// is given, so every answer either function can be asked for in anger fits in a
// six-entry table. Worth building because these two are the innermost thing in
// the roll-up: every stored cell walks up to MAX_LEVEL, and each step calls
// `radiusOf` twice and `colsOf` once, so a map of twenty thousand cells raises
// `3 ** L` some quarter of a million times to get one of six answers back.
// The table is filled from the same expressions, so the values are bit-identical
// to computing them; anything off the end (a fractional or out-of-range level)
// falls through to the arithmetic and is answered exactly as before.
const LEVEL_R = [];
const LEVEL_COLS = [];
for (let L = 0; L <= MAX_LEVEL + 1; L++) {
  LEVEL_R[L] = R0 * 3 ** L;
  LEVEL_COLS[L] = BASE_COLS / 3 ** L;
}
export const radiusOf = (L) => LEVEL_R[L] ?? R0 * 3 ** L;
export const colsOf = (L) => LEVEL_COLS[L] ?? BASE_COLS / 3 ** L; // integer & even by construction
export const normCol = (col, N) => ((col % N) + N) % N;

/**
 * Split a stored cell id — "L/col/row" — into its three numbers.
 *
 * One definition of what a cell id *is*, because four modules were each opening
 * one with `id.split('/').map(Number)`: the map's roll-up, the statistics, the
 * trips panel and the image export. That form allocates two arrays and three
 * substrings per cell and calls `Number` through a callback, which makes it the
 * single hottest thing in the roll-up simply because it runs once per stored
 * cell — measured at about 15% of it on a twenty-thousand-cell map.
 *
 * Anything that is not three slash-separated parts comes back as NaNs rather
 * than as a short array with `undefined` in it. Callers already guard with
 * `Number.isFinite`, and a NaN fails every comparison it is put through, which
 * is the safer way for a malformed id to be wrong.
 *
 * @param {string} id
 * @returns {[number, number, number]} level, column, row
 */
export function parseCellId(id) {
  const s = String(id);
  const a = s.indexOf('/');
  const b = a < 0 ? -1 : s.indexOf('/', a + 1);
  if (b < 0 || s.indexOf('/', b + 1) >= 0) return [NaN, NaN, NaN];
  return [+s.slice(0, a), +s.slice(a + 1, b), +s.slice(b + 1)];
}

/**
 * Fold a longitude into [-180, 180).
 *
 * Cell columns are stored normalized, so `cellCenter` hands back longitudes in
 * [0, 360) and every western-hemisphere cell — Portugal, Spain, the Americas —
 * lands near +350° unless it comes through here first. Here rather than in each
 * of the three modules that were carrying their own identical copy, because it
 * is a fact about the lattice's coordinates and not about any one of them.
 */
export const wrapLng = (lng) => (((lng + 180) % 360) + 360) % 360 - 180;

export function cellCenter(L, col, row) {
  const R = radiusOf(L);
  return [1.5 * R * col, SQRT3 * R * (row + (col & 1 ? 0.5 : 0))];
}

// Point → containing cell, via axial coords + cube rounding.
export function pointToCell(L, x, y) {
  const R = radiusOf(L);
  const qf = ((2 / 3) * x) / R;
  const rf = (-x / 3 + (SQRT3 / 3) * y) / R;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(-qf - rf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - (-qf - rf));
  if (dq > dr && dq > ds) q = -s - r;
  else if (dr > ds) r = -q - s;
  return [q, r + (q - (q & 1)) / 2]; // axial → odd-q offset
}

// Parent cell one level up (the coarse hex containing this cell's center).
export function parentOf(L, col, row) {
  const [cx, cy] = cellCenter(L, col, row);
  const [pc, pr] = pointToCell(L + 1, cx, cy);
  return [normCol(pc, colsOf(L + 1)), pr];
}
