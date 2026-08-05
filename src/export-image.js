// The image export: your map as a picture you can put somewhere else.
//
// **It is not a screenshot, and that is the whole design.** A screenshot is the
// window you happened to have open — an aspect ratio decided by the browser, a
// frame decided by where you last dragged, and a basemap that is somebody
// else's tiles with somebody else's licence attached. What people actually want
// out of a map like this is a *portrait of a place*: Switzerland, cut out of the
// world, with the ground you have covered inside it and a line or two saying how
// much. So the export draws that from the same data the map draws from, on a 2D
// canvas of whatever size is asked for, and the boundaries the app already has
// are what cut the shape out.
//
// Which is also why there is no WebGL here. Reading pixels back out of the live
// map would need `preserveDrawingBuffer`, which costs every frame of every
// session for the sake of a button most people press twice — and it would still
// only ever hand back the window. Everything below is `CanvasRenderingContext2D`
// and arithmetic, so an export is the same picture on every machine, at any
// resolution, with no map instance involved.
//
// Four choices, in the order they are asked:
//
//   1. **Shape** — vertical, horizontal or square. Sets the canvas, and through
//      it the camera, the type scale and the blob level.
//   2. **What is in it** — any number of regions, countries or continents, or
//      everywhere. This is the *cut*: the selection's outline is the mask, and
//      nothing outside it is painted.
//   3. **Detail** — how the visited ground is generalised: blobs (the cells
//      themselves, poured together the way the map does it), or filled regions,
//      countries or continents. Deliberately separate from (2): "show me
//      Switzerland" and "colour it by canton" are different questions, and
//      answering them with one control is what makes a map lie.
//   4. **Colour by** — the same four modes the map has (src/coloring.js).
//
// …and then the caption, which is the reason the numbers below exist.
//
// Nothing here is cached: an export is a one-off, and a stale poster is worse
// than a slow one. What *is* avoided is recomputing between preview frames — see
// `coverageOf`, which the dialog holds on to while you drag a colour around.

import {
  MAX_LEVEL, MAX_MERC_Y, WORLD, cellCenter, mercX, mercY, radiusOf,
} from './hexgrid.js';
import {
  allCountries, countryAreaKm2, countryCount, countryGeometry, loadCountries,
} from './countries.js';
import { loadRegions, regionAreaKm2, regionById, regionGeometry } from './regions.js';
import { continentAreaKm2, continentGeometry, countriesInContinent } from './continents.js';
import { asMulti } from './polygon.js';
import { EARTH_LAND_KM2, WHOLE_COUNTRY, computeStats, formatKm2, formatPct } from './stats.js';
import { areaColorOf, cellColorOf, isHeatMode } from './coloring.js';
import { createBlobBuffers, paintBlobSheet } from './blob-canvas.js';
import { hexOpaque } from './color-picker.js';

// --- Tuning -------------------------------------------------------------------

/**
 * The three shapes, and the pixels each is. Chosen to be what the places these
 * end up wanting: 4:5 is the tallest a feed will show without cropping, 16:9 is
 * a slide or a wallpaper, and a square is a square.
 */
export const SHAPES = {
  vertical: { label: 'Vertical', w: 1080, h: 1350 },
  horizontal: { label: 'Horizontal', w: 1920, h: 1080 },
  square: { label: 'Square', w: 1280, h: 1280 },
};

/** Multipliers on the above. 2× is a print-sized file; 1× is a post. */
export const SCALES = [
  { key: 1, label: 'Standard' },
  { key: 2, label: 'Large' },
];

// How much of the frame is margin, per side. The subject wants room to be a
// shape rather than a thing wedged into a rectangle, and the caption sits in
// that room.
const INSET = 0.075;

// Blobs: the finest level whose cells are at least this many export pixels
// across is the one drawn. Below about a pixel a cell rasterizes at partial
// alpha and the level-set cut erases it (see MIN_CELL_PX in blob-canvas.js), so
// this is the point at which asking for more detail starts costing detail.
const MIN_BLOB_PX = 1.35;

// The feather at the rim of a blob is measured in screen pixels on the map,
// where a screen pixel is a known size. An image has no screen, so it is scaled
// against a reference height instead: a poster twice as tall gets twice the
// feather and the softness reads the same at any resolution.
const FEATHER_REF_PX = 900;

// Rings smaller than this on the finished canvas are skipped. At world scale a
// country dataset is mostly islets nobody can see, and each one is still a
// path, a fill and a rasterizer pass.
const MIN_RING_PX = 0.4;

/**
 * Ready-made palettes. Each is a complete answer — background, land, the line
 * around it and the caption — because these four have to be picked against each
 * other, and a dialog of four independent colour wells is a machine for making
 * an unreadable poster. Every one of them can still be overridden.
 */
export const PALETTES = {
  night: {
    label: 'Night',
    background: '#0b0d14',
    land: '#1b2030',
    edge: '#38405a',
    text: '#ffffff',
  },
  paper: {
    label: 'Paper',
    background: '#f4f1ea',
    land: '#e2ddd1',
    edge: '#b9b2a2',
    text: '#1a1a1a',
  },
  slate: {
    label: 'Slate',
    background: '#e8eaef',
    land: '#ffffff',
    edge: '#c2c8d4',
    text: '#141821',
  },
  none: {
    label: 'Transparent',
    background: 'transparent',
    land: '#8e97ad33',
    edge: '#8e97ad66',
    text: '#ffffff',
  },
};

/**
 * Caption typefaces. Stacks rather than webfonts: nothing is fetched, so an
 * export works offline and cannot render half-drawn while a font arrives — and
 * a poster whose type silently fell back to Times would be worse than one that
 * never offered the choice.
 */
export const CAPTION_FONTS = {
  system: {
    label: 'System',
    stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Inter, sans-serif",
  },
  serif: {
    label: 'Serif',
    stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  },
  grotesk: {
    label: 'Grotesk',
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  rounded: {
    label: 'Rounded',
    stack: "'SF Pro Rounded', 'Avenir Next', Avenir, 'Trebuchet MS', sans-serif",
  },
  mono: {
    label: 'Mono',
    stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
};

/** Where the caption block sits. Nine, because a map has nine empty corners. */
export const CAPTION_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const asDate = (sec) => (sec ? dateFmt.format(new Date(sec * 1000)) : null);
const asCount = (n) => Number(n ?? 0).toLocaleString();
const asDays = (n) => `${asCount(n)} ${n === 1 ? 'day' : 'days'}`;

/**
 * A scope with nothing picked is a scope of everywhere.
 *
 * Both halves of the export have to agree about that. The picture already did —
 * an empty selection has no outline to cut with, so it draws the world — and
 * the numbers did not: an empty id set made the coverage sweep match no cell at
 * all, and the caption confidently reported a map of nothing. One normalisation
 * in one place, applied by everything that reads a scope.
 */
const settleScope = (scope) =>
  (scope?.kind === 'world' || !scope?.ids?.length ? { kind: 'world', ids: [] } : scope);

/**
 * What a caption can say, and how each line is worded.
 *
 * Every one of these is a number the app already holds — the point of the
 * export is to put them beside the shape they describe, not to work anything
 * new out. `value` returns null for a line that has no honest answer (no dates
 * in the history, no regions under the selection), and a line with no answer is
 * left out rather than printed empty.
 */
export const CAPTION_FIELDS = [
  {
    key: 'title',
    label: 'Title',
    // The one line that is not a label and a value. It is what the picture is
    // of, so it is set as a heading and everything else hangs under it.
    title: true,
    value: (n) => n.title,
  },
  { key: 'covered', label: 'Land covered', value: (n) => (n.totalKm2 ? formatPct(n.pct) : null) },
  { key: 'ground', label: 'Ground covered', value: (n) => (n.km2 ? formatKm2(n.km2) : null) },
  {
    key: 'regions',
    label: 'Regions visited',
    value: (n) => (n.regionsTotal ? `${asCount(n.regions)} of ${asCount(n.regionsTotal)}` : null),
  },
  {
    key: 'countries',
    label: 'Countries visited',
    value: (n) => (n.countriesTotal ? `${asCount(n.countries)} of ${asCount(n.countriesTotal)}` : null),
  },
  { key: 'first', label: 'First seen', value: (n) => asDate(n.firstAt) },
  { key: 'last', label: 'Last seen', value: (n) => asDate(n.lastAt) },
  { key: 'days', label: 'Days recorded', value: (n) => (n.days ? asDays(n.days) : null) },
  { key: 'streak', label: 'Longest streak', value: (n) => (n.streakDays ? asDays(n.streakDays) : null) },
  { key: 'cells', label: 'Places', value: (n) => (n.cells ? asCount(n.cells) : null) },
  { key: 'world', label: 'Share of the world', value: (n) => (n.worldPct ? formatPct(n.worldPct) : null) },
];

/** The defaults a fresh dialog opens on. */
export const DEFAULT_SPEC = {
  shape: 'vertical',
  scale: 1,
  scope: { kind: 'world', ids: [] },
  detail: 'blob',
  cellSize: 0,
  colorBy: 'flat',
  accent: '#60acff',
  strength: 1,
  palette: 'night',
  colors: {}, // overrides on top of the palette
  surroundings: false,
  outline: true,
  caption: {
    on: true,
    anchor: 'bottom-left',
    align: 'left',
    fields: ['title', 'covered', 'regions', 'first'],
    title: '',
    font: 'system',
    size: 1,
    color: '',
    shadow: true,
  },
};

// --- Geography ----------------------------------------------------------------

/** The label a scope kind wears in the dialog and in a filename. */
export const SCOPE_KINDS = {
  world: { label: 'Everywhere' },
  continent: { label: 'Continent' },
  country: { label: 'Country' },
  region: { label: 'Region' },
};

/** One selected area's outline, whichever dataset it came from. */
export function scopeGeometry(kind, id) {
  if (kind === 'continent') return continentGeometry(id);
  if (kind === 'country') return countryGeometry(id);
  // The region level stands a country in for itself where the admin-1 dataset
  // does not subdivide it (see WHOLE_COUNTRY in src/stats.js), and those ids
  // reach this far.
  if (String(id).startsWith(WHOLE_COUNTRY)) return countryGeometry(String(id).slice(WHOLE_COUNTRY.length));
  return regionGeometry(id);
}

/** Its land area in km², for the denominator of "how much of it". */
export function scopeAreaKm2(kind, id) {
  if (kind === 'continent') return continentAreaKm2(id);
  if (kind === 'country') return countryAreaKm2(id);
  if (String(id).startsWith(WHOLE_COUNTRY)) return countryAreaKm2(String(id).slice(WHOLE_COUNTRY.length));
  return regionAreaKm2(id);
}

/** What to call it on the poster. Regions carry their country, because a
 *  dozen countries have a "Central" region and none of them is the one meant. */
export function scopeName(kind, id) {
  if (kind !== 'region') return String(id);
  if (String(id).startsWith(WHOLE_COUNTRY)) return String(id).slice(WHOLE_COUNTRY.length);
  return regionById(id)?.name ?? String(id).split('/').pop();
}

/**
 * Everywhere of this kind you have actually been, biggest first.
 *
 * The picker lists these and nothing else. Offering all 4,553 admin-1 regions
 * would be a search box over places the export would draw empty — a poster of a
 * canton you have never set foot in is a blank shape, and the honest list is
 * the one the map could fill.
 *
 * @param {'continent'|'country'|'region'} kind
 * @param {Iterable<string>} cellIds
 * @param {(kind:string, cellId:string) => string|null} areaOf memoised lookup
 */
export function visitedAreas(kind, cellIds, areaOf) {
  const tally = new Map();
  for (const id of cellIds) {
    const area = areaOf(kind, id);
    if (!area) continue;
    tally.set(area, (tally.get(area) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([id, cells]) => ({
      id,
      cells,
      name: scopeName(kind, id),
      country: kind === 'region' ? regionById(id)?.country ?? null : null,
    }))
    .sort((a, b) => b.cells - a.cells || a.name.localeCompare(b.name));
}

// --- Mercator, and the seam in it ---------------------------------------------

const toMercY = (lat) => Math.max(-MAX_MERC_Y, Math.min(MAX_MERC_Y, mercY(lat)));

/**
 * A ring's longitudes made continuous.
 *
 * A polygon that crosses ±180° is stored with its coordinates snapping between
 * +179 and −179, and drawing that literally draws a line all the way back
 * across the world. Following the jumps and accumulating a whole-world offset
 * puts the ring back together on one side of the seam — past ±180°, which is
 * exactly where the world copies below expect to find it.
 */
export function unwrapRing(ring) {
  const out = new Array(ring.length);
  let shift = 0;
  for (let i = 0; i < ring.length; i++) {
    if (i > 0) {
      const d = ring[i][0] - ring[i - 1][0];
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    out[i] = [ring[i][0] + shift, ring[i][1]];
  }
  return out;
}

/**
 * The smallest span on a circle that covers every arc given — the frame for a
 * selection that may or may not straddle the seam.
 *
 * Naively taking min and max would frame Fiji as the entire Pacific, and a map
 * of Russia as the whole northern hemisphere. The trick is to look at what is
 * *not* covered: union the arcs, find the widest hole, and the answer is
 * everything else. A single hole nobody selected is what makes "New Zealand" a
 * country rather than a planet.
 *
 * @param {Array<[number, number]>} arcs [start, end] pairs, end ≥ start
 * @param {number} period
 * @returns {{min:number, max:number}|null}
 */
export function circularSpan(arcs, period) {
  const segs = [];
  for (const [s0, e0] of arcs) {
    const len = Math.min(period, Math.max(0, e0 - s0));
    if (len >= period) return { min: 0, max: period };
    const s = ((s0 % period) + period) % period;
    const e = s + len;
    if (e <= period) segs.push([s, e]);
    else {
      segs.push([s, period]);
      segs.push([0, e - period]);
    }
  }
  if (!segs.length) return null;
  segs.sort((a, b) => a[0] - b[0]);

  const merged = [segs[0].slice()];
  for (const seg of segs.slice(1)) {
    const last = merged[merged.length - 1];
    if (seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push(seg.slice());
  }

  // The wrap-around gap first: from the last segment's end round to the first
  // segment's start. Every other gap is between neighbours.
  let bestGap = merged[0][0] + (period - merged[merged.length - 1][1]);
  let gapStart = merged[merged.length - 1][1];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1];
    if (gap > bestGap) {
      bestGap = gap;
      gapStart = merged[i - 1][1];
    }
  }
  const min = gapStart + bestGap;
  return { min, max: min + (period - bestGap) };
}

/** A geometry's Mercator extent: one x-arc per polygon, and a plain y range. */
function extentOf(geometry, into) {
  for (const poly of asMulti(geometry)) {
    const ring = unwrapRing(poly[0]);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const [lng, lat] of ring) {
      const x = mercX(lng);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      const y = toMercY(lat);
      if (y < into.yMin) into.yMin = y;
      if (y > into.yMax) into.yMax = y;
    }
    if (Number.isFinite(x0)) into.arcs.push([x0, x1]);
  }
}

/**
 * The frame: the Mercator rectangle the picture covers.
 *
 * @param {Array<object>} geoms selected outlines, or none for "everywhere"
 * @param {Iterable<string>} cellIds used when there is no selection — the frame
 *   is then what you have visited, not the whole planet, because a world map
 *   with four blobs on it is a picture of a world map
 */
export function frameFor(geoms, cellIds) {
  const acc = { arcs: [], yMin: Infinity, yMax: -Infinity };
  if (geoms?.length) {
    for (const g of geoms) extentOf(g, acc);
  } else {
    for (const id of cellIds ?? []) {
      const [L, col, row] = String(id).split('/').map(Number);
      if (!Number.isFinite(L) || L > MAX_LEVEL) continue;
      const [x, y] = cellCenter(L, col, row);
      const R = radiusOf(L);
      acc.arcs.push([x - R, x + R]);
      const yy = Math.max(-MAX_MERC_Y, Math.min(MAX_MERC_Y, y));
      if (yy - R < acc.yMin) acc.yMin = yy - R;
      if (yy + R > acc.yMax) acc.yMax = yy + R;
    }
  }
  const span = circularSpan(acc.arcs, WORLD);
  if (!span || !Number.isFinite(acc.yMin)) return null;
  // A single cell, or a microstate, is a rectangle of nearly no size. Give it
  // one, or the camera divides by it.
  const floor = radiusOf(0) * 8;
  // `circularSpan` answers on a circle, so its origin can be anywhere — a frame
  // over France legitimately comes back as 358°..375°. Every path here is drawn
  // in world copies and would render that correctly, but a rectangle a world
  // east of the geometry it frames is a trap for anyone reading a number out of
  // it later. Slide the centre back into [-180, 180) without touching the
  // width, so a frame that really does straddle the seam stays continuous.
  const rawMid = (span.min + span.max) / 2;
  const xMid = rawMid - Math.round(rawMid / WORLD) * WORLD;
  const yMid = (acc.yMin + acc.yMax) / 2;
  const halfW = Math.max((span.max - span.min) / 2, floor);
  const halfH = Math.max((acc.yMax - acc.yMin) / 2, floor);
  return { xMin: xMid - halfW, xMax: xMid + halfW, yMin: yMid - halfH, yMax: yMid + halfH };
}

/**
 * Fit a Mercator rectangle into a canvas, letterboxed, north up.
 *
 * `k` is canvas pixels per Mercator metre — the same quantity MapLibre derives
 * from a zoom, which is why the blob sheet can be handed it directly.
 *
 * @returns {{k:number, x0:number, y0:number, w:number, h:number}} with
 *   px = (x - x0)·k and py = (y0 - y)·k
 */
export function fitCamera(bb, size, inset = INSET) {
  const availW = size.w * (1 - 2 * inset);
  const availH = size.h * (1 - 2 * inset);
  const k = Math.min(availW / (bb.xMax - bb.xMin), availH / (bb.yMax - bb.yMin));
  const cx = (bb.xMin + bb.xMax) / 2;
  const cy = (bb.yMin + bb.yMax) / 2;
  return {
    k,
    x0: cx - size.w / 2 / k,
    y0: cy + size.h / 2 / k,
    w: size.w,
    h: size.h,
  };
}

/** The Mercator rectangle a camera actually shows. */
const cameraRect = (cam) => ({
  xMin: cam.x0,
  xMax: cam.x0 + cam.w / cam.k,
  yMin: cam.y0 - cam.h / cam.k,
  yMax: cam.y0,
});

/**
 * The finest grid level whose cells survive being drawn at this scale, made
 * `coarser` steps blunter if asked. See MIN_BLOB_PX.
 */
export function blobLevelFor(k, coarser = 0) {
  let L = 0;
  while (L < MAX_LEVEL && radiusOf(L) * k < MIN_BLOB_PX) L++;
  return Math.max(0, Math.min(MAX_LEVEL, L + coarser));
}

// --- Paths ---------------------------------------------------------------------

/**
 * Add one geometry to a path under the camera, in every world copy that can
 * reach the frame.
 *
 * The copies are what make the seam invisible: a shape unwrapped past +180° is
 * drawn again one world to the west, and a frame that straddles the line gets
 * both halves without either being cut.
 */
function addGeometry(path, geometry, cam) {
  const view = cameraRect(cam);
  const px = (x) => (x - cam.x0) * cam.k;
  const py = (y) => (cam.y0 - y) * cam.k;

  for (const poly of asMulti(geometry)) {
    const rings = poly.map(unwrapRing);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [lng, lat] of rings[0]) {
      const x = mercX(lng);
      const y = toMercY(lat);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (!Number.isFinite(x0)) continue;
    // Too small to be a shape on this canvas. At world scale most of a country
    // dataset is islets of a fraction of a pixel, and each is still a path.
    if ((x1 - x0) * cam.k < MIN_RING_PX && (y1 - y0) * cam.k < MIN_RING_PX) continue;
    if (y1 < view.yMin || y0 > view.yMax) continue;

    const cMin = Math.ceil((view.xMin - x1) / WORLD);
    const cMax = Math.floor((view.xMax - x0) / WORLD);
    for (let c = cMin; c <= cMax; c++) {
      const dx = c * WORLD;
      for (const ring of rings) {
        if (ring.length < 3) continue;
        path.moveTo(px(mercX(ring[0][0]) + dx), py(toMercY(ring[0][1])));
        for (let i = 1; i < ring.length; i++) {
          path.lineTo(px(mercX(ring[i][0]) + dx), py(toMercY(ring[i][1])));
        }
        path.closePath();
      }
    }
  }
}

/** One Path2D over a list of geometries. */
function pathOf(geoms, cam) {
  const path = new Path2D();
  for (const g of geoms) if (g) addGeometry(path, g, cam);
  return path;
}

// --- The numbers ---------------------------------------------------------------

/**
 * Everything the caption can say about one selection.
 *
 * This is `computeStats` (src/stats.js) over the cells inside the selection,
 * plus the denominators a filtered sweep cannot know — a country's own land
 * area, how many countries a continent has. Asked once per selection and held
 * by the dialog, because it reads 20-odd thousand cells against two boundary
 * datasets and nothing about dragging a colour changes the answer.
 *
 * @param {{kind:string, ids:string[]}} scope
 * @param {object} data the accessor bundle — see renderExport
 */
export async function coverageOf(rawScope, data) {
  const { kind, ids } = settleScope(rawScope);
  const wanted = kind === 'world' ? null : new Set(ids);
  const only = wanted ? (id) => wanted.has(data.areaOf(kind, id)) : null;
  const s = await computeStats(data.cells(), data.meta(), only);

  // The share is of what was selected, not of the world: "1.2 % of Switzerland"
  // is the sentence, and its denominator is Switzerland.
  const totalKm2 = wanted
    ? [...wanted].reduce((sum, id) => sum + scopeAreaKm2(kind, id), 0)
    : EARTH_LAND_KM2;

  // Countries are counted against the frame you asked for. Everywhere and a
  // country selection are both measured against the world — you did visit 12 of
  // 195 — but a continent is its own denominator, which is the number that
  // level of the map exists to show.
  const countriesTotal =
    kind === 'continent'
      ? [...wanted].reduce((sum, name) => sum + countriesInContinent(name), 0)
      : countryCount();

  const names = wanted ? [...wanted].map((id) => scopeName(kind, id)) : [];

  return {
    title: names.length ? names.join(' · ') : 'The world',
    names,
    cells: s.cells,
    km2: s.km2,
    totalKm2,
    pct: totalKm2 ? (s.km2 / totalKm2) * 100 : 0,
    worldPct: s.worldPct,
    countries: s.countries.length,
    countriesTotal,
    regions: s.regions.length,
    // How many regions the countries under this selection are divided into.
    // `regionsReachable` is exactly that, already summed by the sweep — and it
    // is the denominator that means something: every region in a country you
    // have been to is one you could plausibly go and see.
    regionsTotal: s.regionsReachable,
    firstAt: s.firstAt,
    lastAt: s.lastAt,
    days: s.days,
    streakDays: s.streakDays,
    sources: s.sources,
  };
}

// --- The caption ---------------------------------------------------------------

/**
 * The caption as lines, before any of it is a pixel. Pure, so the wording can
 * be tested without a canvas.
 *
 * A field with no answer is dropped rather than printed blank: a poster that
 * says "First seen —" is telling you about the software.
 *
 * @param {object} caption the spec's caption block
 * @param {object} numbers from coverageOf
 * @returns {Array<{title?:boolean, label:string, value:string}>}
 */
export function captionLines(caption, numbers) {
  if (!caption?.on) return [];
  const chosen = new Set(caption.fields ?? []);
  const lines = [];
  for (const field of CAPTION_FIELDS) {
    if (!chosen.has(field.key)) continue;
    if (field.title) {
      const text = (caption.title || '').trim() || numbers.title;
      if (text) lines.push({ title: true, label: '', value: text });
      continue;
    }
    const value = field.value(numbers);
    if (value == null || value === '') continue;
    lines.push({ label: field.label, value });
  }
  return lines;
}

/**
 * The type scale, from the image's own height so it holds at any resolution —
 * which is what lets a 300 px preview be the same picture as a 2560 px file.
 * `fit` is the shrink applied when the block would not fit the frame; the
 * margin does not take it, because a margin is a property of the frame.
 */
function captionMetrics(caption, size, fit = 1) {
  const mul = (caption.size ?? 1) * fit;
  const title = Math.max(6, Math.round(size.h * 0.058 * mul));
  const body = Math.max(4, Math.round(size.h * 0.026 * mul));
  return {
    title,
    body,
    titleLead: Math.round(title * 1.16),
    bodyLead: Math.round(body * 1.62),
    gap: Math.round(body * 0.7), // between a label and its value
    margin: Math.round(Math.min(size.w, size.h) * 0.075),
  };
}

function drawCaption(ctx, lines, caption, size, color) {
  if (!lines.length) return;
  const stack = (CAPTION_FONTS[caption.font] ?? CAPTION_FONTS.system).stack;

  const layout = (scale) => {
    const m = captionMetrics(caption, size, scale);
    const titleFont = `700 ${m.title}px ${stack}`;
    const labelFont = `500 ${m.body}px ${stack}`;
    const valueFont = `650 ${m.body}px ${stack}`;
    // Measure first — the block's own width is what "centre" and "right" are
    // relative to, and a line can be a heading or a label/value pair.
    const measured = lines.map((line) => {
      if (line.title) {
        ctx.font = titleFont;
        return { ...line, w: ctx.measureText(line.value.toUpperCase()).width, lead: m.titleLead };
      }
      ctx.font = labelFont;
      const labelW = ctx.measureText(line.label).width;
      ctx.font = valueFont;
      const valueW = ctx.measureText(line.value).width;
      return { ...line, labelW, valueW, w: labelW + m.gap + valueW, lead: m.bodyLead };
    });
    return {
      m,
      titleFont,
      labelFont,
      valueFont,
      measured,
      blockW: Math.max(...measured.map((l) => l.w)),
      blockH: measured.reduce((sum, l) => sum + l.lead, 0),
    };
  };

  // Fit, rather than clip. Three continents on one line and a text size dragged
  // to the top of its range will not fit any frame, and there are only two
  // honest answers: run the title off the edge, or set it smaller. A caption
  // that has quietly shrunk still says what it says.
  let out = layout(1);
  const maxW = size.w - 2 * out.m.margin;
  const maxH = size.h - 2 * out.m.margin;
  const shrink = Math.min(1, maxW / out.blockW, maxH / out.blockH);
  if (shrink < 0.999) out = layout(shrink);

  const { m, titleFont, labelFont, valueFont, measured, blockW, blockH } = out;
  const [vert, horiz] = caption.anchor.split('-');

  const blockX =
    horiz === 'left' ? m.margin
    : horiz === 'right' ? size.w - m.margin - blockW
    : (size.w - blockW) / 2;
  let y =
    vert === 'top' ? m.margin
    : vert === 'bottom' ? size.h - m.margin - blockH
    : (size.h - blockH) / 2;

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (caption.shadow) {
    // A caption sits over whatever the map put underneath it, which on a
    // transparent export is nothing at all and on a busy one is a heat map.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = Math.round(m.body * 0.5);
    ctx.shadowOffsetY = Math.round(m.body * 0.08);
  }

  for (const line of measured) {
    // Where this line starts inside the block, which is what the alignment
    // control actually means — the block's place on the canvas is the anchor's
    // job, and the two are separate because they answer different questions.
    const slack = blockW - line.w;
    const x = blockX + (caption.align === 'right' ? slack : caption.align === 'center' ? slack / 2 : 0);
    if (line.title) {
      ctx.font = titleFont;
      ctx.fillStyle = color;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${(m.title * 0.02).toFixed(2)}px`;
      ctx.fillText(line.value.toUpperCase(), x, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    } else {
      ctx.font = labelFont;
      ctx.fillStyle = withAlpha(color, 0.62);
      ctx.fillText(line.label, x, y + (m.bodyLead - m.body) / 2);
      ctx.font = valueFont;
      ctx.fillStyle = color;
      ctx.fillText(line.value, x + line.labelW + m.gap, y + (m.bodyLead - m.body) / 2);
    }
    y += line.lead;
  }
  ctx.restore();
}

/** A hex colour at a given opacity, as something canvas will take. */
function withAlpha(color, alpha) {
  const s = String(color).trim();
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (!m) return s;
  const n = parseInt(m[1], 16);
  const a = (m[2] ? parseInt(m[2], 16) / 255 : 1) * alpha;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`;
}

// --- The picture ---------------------------------------------------------------

/** The palette a spec resolves to, overrides applied. */
export function paletteOf(spec) {
  const base = PALETTES[spec.palette] ?? PALETTES.night;
  return { ...base, ...(spec.colors ?? {}) };
}

/** The pixel size a spec asks for. */
export const sizeOf = (spec) => {
  const shape = SHAPES[spec.shape] ?? SHAPES.vertical;
  const scale = spec.scale === 2 ? 2 : 1;
  return { w: shape.w * scale, h: shape.h * scale };
};

/**
 * Draw the whole thing.
 *
 * Synchronous on purpose. Everything slow — the boundary datasets, the coverage
 * sweep — has already been awaited by the time this is called, so the preview
 * can be redrawn inside a pointermove without a promise anywhere near it.
 *
 * @param {HTMLCanvasElement} canvas sized by this function
 * @param {object} spec
 * @param {object} data  the accessor bundle src/main.js hands over. Accessors
 *   rather than values, because the map underneath can change while the dialog
 *   is open — a cell painted, a source removed — and a copy taken when the
 *   dialog opened would quietly export the map as it used to be:
 *   `{ cells(), meta(), accent(), rollUp(mode), areaFC(kind, mode), areaOf(kind, cellId) }`
 * @param {object} numbers from coverageOf
 * @param {{w:number,h:number}} [size] overrides the spec's own — the preview
 *   renders the same picture smaller
 */
export function renderExport(canvas, spec, data, numbers, size = sizeOf(spec)) {
  const caption = { ...DEFAULT_SPEC.caption, ...(spec.caption ?? {}) };
  const ctx = canvas.getContext('2d');
  canvas.width = size.w;
  canvas.height = size.h;
  ctx.clearRect(0, 0, size.w, size.h);

  const palette = paletteOf(spec);
  if (palette.background && palette.background !== 'transparent') {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, size.w, size.h);
  }

  const scope = settleScope(spec.scope);
  const scoped = scope.kind !== 'world';
  const geoms = scoped ? scope.ids.map((id) => scopeGeometry(scope.kind, id)).filter(Boolean) : [];
  const frame = frameFor(geoms, data.cells());
  if (!frame) {
    drawCaption(ctx, captionLines(caption, numbers), caption, size, caption.color || palette.text);
    return canvas;
  }
  const cam = fitCamera(frame, size);

  // The rest of the world, if it was asked for: everything the frame reaches,
  // dimmer than the subject. It is off by default because the point of the cut
  // is the cut — but a canton floating in a void is hard to place, and one grey
  // outline of the country around it is the difference between a shape and a
  // map.
  if (spec.surroundings) {
    const rest = new Path2D();
    for (const c of allCountries()) addGeometry(rest, c.geometry, cam);
    ctx.fillStyle = withAlpha(palette.land, 0.34);
    ctx.fill(rest, 'evenodd');
  }

  // The subject: the selection's own silhouette, or every country when the
  // subject is everywhere.
  const landGeoms = scoped ? geoms : allCountries().map((c) => c.geometry);
  const land = pathOf(landGeoms, cam);
  ctx.fillStyle = palette.land;
  ctx.fill(land, 'evenodd');

  // Everything you have been is painted inside that silhouette and nowhere
  // else. `clip` is the whole feature: the boundaries the app already has are
  // what cut the picture out.
  ctx.save();
  ctx.clip(land, 'evenodd');
  drawVisited(ctx, spec, data, cam, size);
  ctx.restore();

  if (spec.outline) {
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = Math.max(1, size.h * 0.0016);
    ctx.lineJoin = 'round';
    ctx.stroke(land);
  }

  drawCaption(ctx, captionLines(caption, numbers), caption, size, caption.color || palette.text);
  return canvas;
}

/** The visited ground, at whichever generalisation was asked for. */
function drawVisited(ctx, spec, data, cam, size) {
  const strength = Math.max(0, Math.min(1, spec.strength ?? 1));
  if (strength <= 0) return;
  ctx.globalAlpha = strength;
  if (spec.detail === 'blob') drawBlobs(ctx, spec, data, cam, size);
  else drawAreas(ctx, spec, data, cam);
  ctx.globalAlpha = 1;
}

// One set of scratch canvases for the whole module. There is only ever one
// export being drawn, and the preview redraws on every drag of the strength
// slider — allocating three multi-megapixel canvases per frame is how a smooth
// control becomes a stuttering one.
let blobBuffers = null;

function drawBlobs(ctx, spec, data, cam, size) {
  const level = blobLevelFor(cam.k, spec.cellSize ?? 0);
  const { litSets, litRange } = data.rollUp(spec.colorBy);
  const cells = litSets[level];
  if (!cells?.size) return;

  if (!blobBuffers) blobBuffers = createBlobBuffers();
  const bb = cameraRect(cam);
  const out = paintBlobSheet({
    buffers: blobBuffers,
    bb,
    level,
    cells,
    colorOf: cellColorOf(spec.colorBy, spec.accent, litRange[level] ?? {}),
    heat: isHeatMode(spec.colorBy),
    pxPerMerc: cam.k,
    // The canvas is the cap. Nothing is gained by rendering the sheet larger
    // than the picture, and the map's own cap is set for a viewport rather than
    // for a poster.
    maxSide: Math.max(size.w, size.h),
    featherScale: size.h / FEATHER_REF_PX,
  });
  if (!out) return;
  // The sheet's width is rounded to whole pixels, so it covers slightly more
  // ground than it was asked for. Draw it across the width it actually reached
  // rather than stretching it to the frame, or the blobs sit a fraction of a
  // pixel off the boundaries they are supposed to be inside.
  ctx.drawImage(
    blobBuffers.latest,
    0,
    0,
    (out.xMax - bb.xMin) * cam.k,
    (bb.yMax - bb.yMin) * cam.k,
  );
}

function drawAreas(ctx, spec, data, cam) {
  const fc = data.areaFC(spec.detail, spec.colorBy);
  const colorOf = areaColorOf(spec.colorBy, spec.accent);
  const flat = !isHeatMode(spec.colorBy);
  for (const f of fc.features ?? []) {
    // k=1 is a fill; k=2 is the outline ring set and k=3 a continent's label,
    // and neither is what a poster wants under its own outline.
    if (f.properties?.k !== 1 || !f.geometry) continue;
    ctx.fillStyle = flat ? hexOpaque(spec.accent) : colorOf(Number(f.properties.v ?? 0));
    ctx.fill(pathOf([f.geometry], cam), 'evenodd');
  }
}

/** A filename that says what the picture is of. */
export function exportFilename(spec, numbers) {
  const base = (numbers?.names?.length ? numbers.names.join('-') : 'hexplore')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base || 'hexplore'}-${spec.shape}.png`;
}

/**
 * The boundary datasets a spec needs before it can be drawn or listed.
 *
 * Regions are 2.5 MB and are only fetched when something actually asks for a
 * region — picking one, or colouring by them. A poster of a country never pays
 * for the cantons inside it. The coverage sweep is the exception and loads them
 * regardless, because "regions visited" is a line the caption can carry.
 */
export async function ensureGeography({ scope, detail } = {}) {
  const wants = [loadCountries()];
  if (scope === 'region' || detail === 'region') wants.push(loadRegions());
  await Promise.all(wants);
}
