// What the visited areas are painted with, and what the words mean.
//
// This is the vocabulary of the *Coloring* control: the four modes, the ramps
// they run along, the palette the categorical one hands out, and the arithmetic
// that turns one rolled-up cell into a colour. Nothing here draws anything.
//
// It lives on its own because there are now two renderers asking the same
// questions of the same rows. The map (src/main.js) paints the live view; the
// image export (src/export-image.js) paints a still of it at a size and in a
// mode that may be nothing like what is on screen. A second copy of the ramps
// would be a second answer to "what colour is a cell you were at twice", and
// the two would drift the first time either was tuned.
//
// The map keeps what is genuinely its own: the MapLibre `interpolate`
// expression built from these ramps (an expression is a thing you hand a GPU,
// not a colour), the roll-up that produces the stats read below, and the
// neighbourhood arithmetic behind `near`.

import { hexToRgb, hexOpaque } from './color-picker.js';

// How far out "how often was I around here" looks. A cell is read together with
// the hex this many levels above it — level 0's neighbourhood is a level-2 hex,
// about 9 km across. Without it the finest level is almost all floor: `hits`
// counts arrivals in one 1 km hexagon, and going back to a city lands on a
// different street rather than the same hexagon, so five visits produce five
// cells seen once rather than one cell seen five times.
//
// Here rather than in main.js because `visits` below reads the field it fills
// in, and a constant a formula depends on belongs beside the formula.
export const HEAT_NEIGHBOURHOOD = 2;
// Where the hot end of a ramp is pinned. Deliberately not the maximum: a single
// cell at home can hold four orders of magnitude more arrivals than anywhere
// else, and measured against it the entire rest of the world sits in the bottom
// fifth of the ramp. Everything above this pins to the hottest colour, which is
// the honest answer — past a point, "more" stops being a distinction worth a
// shade.
export const HEAT_HOT_PERCENTILE = 0.98;

/**
 * 'flat' paints every visited region in the accent colour and merges them into
 * blobs. The other three give each cell its own colour from its rolled-up
 * stats, so the regions break back into a hex mosaic — the shape stops being
 * the message and the numbers take over.
 *
 * Ramps run cool → hot / old → new and are sampled on the per-feature value
 * `v` (0..1).
 */
export const HEAT_MODES = {
  flat: { label: 'Single color' },
  visits: {
    label: 'Most visited',
    legend: ['Rare', 'Often'],
    ramp: ['#2b3a6b', '#2f6fa8', '#39a0a0', '#8fc55f', '#f2d049', '#f08b3a', '#e4562f'],
    // A cell's own arrivals plus what a typical cell around it got, against the
    // hot percentile rather than the maximum — see HEAT_NEIGHBOURHOOD and
    // HEAT_HOT_PERCENTILE. Areas that carry their own neighbourhood (a whole
    // country) have no `near` and are read on their own count.
    value: (s, r) =>
      Math.min(1, Math.log(s.hits + (s.near ?? 0)) / Math.log(Math.max(2, r.hotHits))),
  },
  // Not a ramp: a colour per source. "Where did this part of the map come from"
  // is a question about categories, so cool→hot would be meaningless here — the
  // colours only have to be told apart, not ordered.
  type: {
    label: 'Type',
    categorical: true,
  },
  oldest: {
    label: 'First seen',
    legend: ['Long ago', 'Lately'],
    ramp: ['#5c2a3f', '#8a3d52', '#b35c5c', '#cf8560', '#dcb377', '#b9cf87', '#79c39b'],
    value: (s, r) =>
      !s.age ? UNDATED : r.maxAge > r.minAge ? (s.age - r.minAge) / (r.maxAge - r.minAge) : 1,
  },
};

// Sentinel value for "this cell has no date": painted a flat grey instead of
// being parked at one end of the ramp, where it would read as a real answer.
export const UNDATED = -1;
export const UNDATED_COLOR = '#5b6377';

// Colours for the Type mode. Picked to stay apart from each other rather than
// to run in any order, and assigned by first appearance in the source order so
// a given source keeps its colour as the map grows.
export const TYPE_COLORS = [
  '#60acff', '#ff7ab8', '#5fd0a8', '#ffcf5c', '#b98cff',
  '#ff8f5c', '#4fd4e0', '#c3e05a', '#e0607a', '#8fa0d8',
];
// Anything not on the map yet, and anything past the palette, shares this.
export const TYPE_OTHER_COLOR = '#7d8698';
export const TYPE_MAX = TYPE_COLORS.length;

/**
 * What one stored cell contributes to anything that aggregates cells: the map's
 * roll-up, the region and country levels, and the image export's per-area
 * totals.
 *
 * Shared rather than written twice because the area levels used to read their
 * numbers off a rolled-up hexagon instead of off the cells themselves, and the
 * moment they stopped, the two had to agree about what a cell is worth. `own`
 * is the cell's dominant source, and only worked out when a mode is going to
 * colour by it — it costs a comparison per provenance row and nothing reads it
 * otherwise.
 *
 * @param {Array<object>} rows one cell's provenance entries (cellMeta's value)
 * @param {boolean} [byType]  also work out which source speaks for the cell
 */
export function cellStats(rows, byType) {
  // Cells marked by hand have no fix count worth showing, so they weigh 1.
  let hits = 0;
  let time = 0;
  let age = 0;
  let own = null;
  let ownN = -1;
  for (const m of rows ?? []) {
    if (m.source !== 'manual' && m.source !== 'unknown') hits += m.hits || 0;
    if (m.lastAt > time) time = m.lastAt;
    if (m.firstAt && (!age || m.firstAt < age)) age = m.firstAt;
    if (byType) {
      const n = m.hits || 1;
      if (n > ownN || (n === ownN && m.source < own)) {
        own = m.source;
        ownN = n;
      }
    }
  }
  // No fix count (hand-marked, or carried over from before provenance) still
  // counts as one visit. Dates are left at 0 on purpose: "we don't know when"
  // is its own answer, and the date heat maps grey those cells out rather than
  // pretending they happened when they were added.
  if (!hits) hits = 1;
  if (!age) age = time;
  return { hits, time, age, own, ownN };
}

/**
 * The value the hot end of a ramp is pinned to — HEAT_HOT_PERCENTILE of the
 * counts actually present, rather than the largest of them. See the constant.
 *
 * @param {Iterable<object>|Map} entries rolled-up cells or areas
 */
export function hotOf(entries) {
  const all = [];
  for (const e of entries.values ? entries.values() : entries) all.push(e.hits + (e.near ?? 0));
  if (!all.length) return 2;
  all.sort((a, b) => a - b);
  return Math.max(2, all[Math.min(all.length - 1, Math.floor(all.length * HEAT_HOT_PERCENTILE))]);
}

/** Is this mode a heat map (per-cell colours) rather than the single-colour wash? */
export const isHeatMode = (mode) => {
  const m = HEAT_MODES[mode];
  return !!(m?.ramp || m?.categorical);
};

/**
 * The value function for one mode, or null when the regions are flat.
 *
 * A categorical mode puts a palette index in `v` instead of a 0..1 position, so
 * it skips the clamping the ramps need.
 */
export function heatMetric(mode) {
  const m = HEAT_MODES[mode];
  if (m?.categorical) return (stat) => stat.src ?? TYPE_MAX;
  if (!m?.value) return null;
  return (stat, range) => {
    const v = m.value(stat, range ?? {});
    if (v === UNDATED) return UNDATED;
    return Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 1000) / 1000;
  };
}

/**
 * Sample a ramp at t (0..1) with a straight sRGB mix — the ramps are dense
 * enough that a fancier interpolation buys nothing here.
 */
export function sampleRamp(ramp, t) {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]) ?? [0, 0, 0];
  const b = hexToRgb(ramp[i + 1]) ?? [0, 0, 0];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(
    a[2] + (b[2] - a[2]) * f,
  )})`;
}

/**
 * Per-cell colour, quantized so a whole region shares a handful of fill styles.
 *
 * @param {string} mode   a key of HEAT_MODES
 * @param {string} accent the single-colour wash's colour, used by 'flat' only
 * @param {object} range  the level's litRange entry (hotHits, minAge, maxAge…)
 * @returns {(stat:object) => string} css colour for one rolled-up cell
 */
export function cellColorOf(mode, accent, range) {
  const heat = HEAT_MODES[mode] ?? HEAT_MODES.flat;
  if (heat.categorical) return (stat) => TYPE_COLORS[stat.src] ?? TYPE_OTHER_COLOR;
  // Opaque for the same reason the vector fill is, and one more: these discs
  // are blurred and re-cut at a fixed alpha, so a translucent fill would move
  // the contour and shrink every blob instead of fading it.
  if (!heat.ramp) return () => hexOpaque(accent);
  const metric = heatMetric(mode);
  const steps = 48;
  const cache = new Map();
  return (stat) => {
    const v = metric(stat, range ?? {});
    const bucket = v < 0 ? -1 : Math.round(v * steps);
    let color = cache.get(bucket);
    if (!color) {
      color = bucket < 0 ? UNDATED_COLOR : sampleRamp(heat.ramp, bucket / steps);
      cache.set(bucket, color);
    }
    return color;
  };
}

/**
 * The same colour, from the `v` an area feature already carries rather than
 * from the stats behind it. The map hands `v` to MapLibre as an expression
 * (see `heatColorExpr` in src/main.js); anything painting on a 2D canvas needs
 * the value itself, and both have to agree about what a `v` of 0.4 looks like.
 *
 * @param {string} mode
 * @param {string} accent
 * @returns {(v:number) => string}
 */
export function areaColorOf(mode, accent) {
  const heat = HEAT_MODES[mode] ?? HEAT_MODES.flat;
  if (heat.categorical) return (v) => TYPE_COLORS[v] ?? TYPE_OTHER_COLOR;
  if (!heat.ramp) return () => hexOpaque(accent);
  return (v) => (v < 0 ? UNDATED_COLOR : sampleRamp(heat.ramp, v));
}
