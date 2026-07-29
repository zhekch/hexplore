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
export const radiusOf = (L) => R0 * 3 ** L;
export const colsOf = (L) => BASE_COLS / 3 ** L; // integer & even by construction
export const normCol = (col, N) => ((col % N) + N) % N;

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
