// Blob rendering.
//
// Visited cells are hexagons in storage, but nobody wants to look at a
// honeycomb. Each lit cell is painted into an offscreen canvas and the whole
// sheet is then blurred, which does two things at once: the hexagon edges
// dissolve into an organic silhouette, and neighbouring cells of different
// colors bleed into each other so a heat map reads as a continuous field
// instead of a mosaic. A few alpha passes over the blurred sheet firm the rim
// back up — the classic "metaball" trick — so blobs still have a defined edge.
//
// The result is handed to MapLibre as a canvas source pinned to a rectangle of
// *ground* — four lng/lat corners — rather than to the window. That is what
// lets the map be turned: the sheet is drawn by the same matrix as the basemap,
// so it rotates, foreshortens under a pitch and drapes over terrain without
// anything here knowing that any of those happened.
//
// What the camera does decide is which rectangle to ask for, and that arrives
// as an argument (`bb`). src/view.js works it out from the camera — bearing and
// pitch included — and a still image being exported answers it for itself. The
// pipeline below has never known which of the two it is drawing for.

import { SQRT3, radiusOf, colsOf, normCol, WORLD, lngOf, latOf } from './hexgrid.js';

// Canvas pixels per CSS pixel. Well below 1 because everything here is about
// to be blurred and re-cut: the softness hides the lower resolution, and the
// smoothing rounds read every pixel back, so pixel count is the main cost of a
// repaint.
const QUALITY = 0.3;
// ...but a CSS pixel is not a screen pixel. Measured per CSS pixel alone, the
// sheet came out ~6× smaller than the display on a normal retina laptop and ~9×
// on a phone, and stretching it that far turns every soft edge into visible
// stair-steps — which is what made the map look coarse on mobile and fine on a
// non-retina monitor. Scaling by the device ratio keeps the same apparent
// sharpness on every screen instead of quietly depending on the hardware.
//
// Capped at 3 so a very high-density display doesn't quadruple the work for a
// difference nobody can see through the blur; MAX_SIDE still bounds the rest.
// Where the blur has to run in JS, every extra pixel is paid for six times over
// (three box passes, two directions), so the density is followed only part of
// the way: measured, a full dpr-3 sheet costs ~110 ms per repaint on a fast
// desktop and perhaps three times that on the phone that would be asking for
// it. 1.5 keeps the sheet noticeably sharper than it was while staying inside a
// moveend's budget.
const displayScale = () =>
  QUALITY * Math.min(window.devicePixelRatio || 1, nativeBlur() ? 3 : 1.5);
const MAX_SIDE = 2800; // hard cap on either canvas dimension

// Most pixels the sheet may have **when the blur is running in JS**.
//
// The dpr cap above bounds the sheet's *density* and nothing bounds its *area*,
// which is the number a desktop window changes. Measured in a WKWebView on a
// retina Mac, where `nativeBlur()` is false (WebKit has no canvas `filter` at
// all — `'filter' in CanvasRenderingContext2D.prototype` is false, so the
// property assignment in `blurInto` is an ordinary JS property that blurs
// nothing, which is exactly what the probe above exists to catch):
//
//   iPhone-sized sheet   246×532 = 131k px   ~9 ms per repaint
//   1440×900 window      907×567 = 514k px  ~35 ms per repaint
//
// Same code, same density, four times the work — purely because the window is
// bigger. That is the whole of why zooming feels fine on the phone and in
// Chrome (which has a native blur and never takes this path) and drags on a
// Mac: a level change pays that cost, and the crossfade that follows it
// recomposites a canvas of the same size on every frame.
//
// 300k is ~20 ms of blur at the worst case and never binds below roughly a
// 1100×700 window, so a phone is untouched and a small window is untouched;
// only a large one gives up density it was only spending on a sheet that is
// about to be blurred anyway. Raising it trades smoothness for sharpness on
// big screens; the honest fix is a blur that is not in JavaScript.
//
// Deliberately not applied when the blur is native: there an extra pixel costs
// one GPU pass rather than six CPU ones, and the image export wants every pixel
// it can have (see `maxPixels` in paintBlobSheet).
const JS_BLUR_MAX_PX = 300_000;

// ...and what the sheet may have while the camera is still moving.
//
// A zoom that crosses a level boundary has to paint the new level *during* the
// gesture — that is the one repaint the "never mid-gesture" rule above cannot
// refuse, because the dissolve has nothing to dissolve into without it. It then
// recomposites a sheet of this size on every frame of a 620 ms crossfade, while
// the map is still rendering the basemap under a moving camera.
//
// So the gesture gets a smaller sheet: measured in a WKWebView, 300k px is a
// 23 ms paint and 120k is 9 ms, and every frame of the crossfade that follows
// carries the same ratio through the canvas composite and the texture upload.
// Nothing is given up permanently — main.js repaints at the full budget once the
// camera has settled and the dissolve has landed, and until then the difference
// is the sharpness of a soft-edged wash that is sliding across the screen.
const MOVING_MAX_PX = 120_000;

// Blur sigma as a fraction of a cell's on-screen radius. Everything narrower
// than this — dents between cells, corners, kinks along a road — is smoothed
// away, so this is the knob that decides "cells with soft corners" vs "one
// poured shape".
export const BLOB_BLUR = 1;
// How many blur → re-cut rounds. Each one relaxes the outline further without
// growing it; two is enough to lose every trace of the lattice.
export const BLOB_ROUNDS = 2;
// Alpha level taken as the blob's edge. Cutting at roughly half alpha is what
// keeps the smoothed shape the same size as the cells underneath — lower
// inflates it, higher eats thin ribbons.
export const BLOB_LEVEL = 0.3;
// --- Edge softness ------------------------------------------------------------
// Two knobs, and the single-color and heat maps get their own of each, because
// the edge is doing a different job in the two modes. A flat wash is a hint you
// read the map through, so it can dissolve as gently as you like. A heat map is
// the data itself: every pixel of ramp is also a fade toward transparent, so a
// wide edge makes the outermost cells read as a *lower value* than they hold,
// and the softer the rim the more of the mosaic it eats.
//
// Both pairs start at the same value, so changing nothing changes nothing.
//
// 1. BLOB_EDGE — width of the alpha ramp on the final cut, in units of a cell:
//    0.05 is a crisp edge, 0.5 fades out over roughly one cell. Capped
//    internally so the ramp can never reach alpha 0 (that would tint the whole
//    canvas and draw its rectangular edge across the map), so it is safe to
//    turn all the way up. Scales with cell size, so it holds its shape relative
//    to the blobs at every level.
//
//    The heat maps get the *tighter* of the two, which is what the reasoning
//    above always said and what the code did not do: they shipped at 0.6
//    against the wash's 0.3, and 0.6 is wide enough to stop being a cut at all.
//    The band runs from `BLOB_LEVEL - edge` to `BLOB_LEVEL + edge`, so 0.6
//    against a level of 0.3 clamps to [ALPHA_FLOOR, 0.9] — very nearly the
//    whole alpha range, mapped almost linearly. Nothing was firmed up: a pixel
//    came out roughly as opaque as the blur left it, and the blur only leaves
//    full alpha in the middle of something large. Measured, that is what made
//    Type and Most-visited look like fog — a seven-cell cluster peaked at 0.25
//    alpha where the same cluster in the wash peaked at 1.00, purely because
//    the wash still had a cut and the heat maps had given theirs away.
export const BLOB_EDGE = 0.3; // single color
export const BLOB_HEAT_EDGE = 0.2; // visits / recent / first seen
// The band used by the shaping rounds — deliberately tight, see the loop in
// paint(). Not a look knob.
const SHAPE_EDGE = 0.1;
// 2. BLOB_FEATHER_PX — final feather in CSS pixels, applied once the shape is
//    settled. Everything else here works in units of a cell, and a cell's
//    on-screen size swings 3× within a zoom level — which is why edges look
//    soft zoomed in and hard zoomed out. This last blur is measured in screen
//    pixels instead, so the fade from color to map is the same width at every
//    zoom. Nothing is re-cut afterwards, so the tail keeps its true colors and
//    simply runs out.
//
//    Same correction, and it mattered more than the edge did. A cell's radius on
//    screen is between 2.2 and 6.7 CSS pixels at every level — that is what the
//    zoom ladder is *for* — so a five-pixel feather was wider than the cell it
//    was feathering, and it ran after the last cut with nothing to re-firm it.
//    A heat map is the data itself; blurring it by a cell and a half is not a
//    soft edge, it is a lower reading. One pixel, like the wash: the rim is
//    already as gradual as BLOB_HEAT_EDGE makes it.
export const BLOB_FEATHER_PX = 1; // single color
export const BLOB_HEAT_FEATHER_PX = 1; // visits / recent / first seen
// Cells are painted as discs, not hexagons: a disc has no orientation, so the
// silhouette can never give the lattice away. The six neighbours of a cell all
// sit √3·R away, so a radius above 0.87·R makes them overlap — comfortably
// above that, or diagonal neighbours pinch into a string of beads instead of
// flowing into one ribbon.
const CELL_RADIUS = 0.9;

// --- Cells with nothing around them ---------------------------------------------
// The level-set cut cannot keep a feature narrower than the blur, and one cell
// is narrower than the blur: a disc of 0.9·R blurred by a sigma of 1·R peaks at
// about a third of full alpha, which is barely over BLOB_LEVEL, and the second
// round then finishes it off. Measured over the whole zoom ladder, a lone cell
// came out between alpha 0.00 and 0.08 while *any* cluster came out at 1.00. So
// an isolated cell was never faint — it was erased, at every zoom and on every
// display, and no amount of tuning the cut brings it back: lowering the level to
// save it inflates every blob on the map instead.
//
// The ratio is what decides it, so the fix is to draw those cells at the size
// the cut can hold rather than at their own. `SPARSE_GROW` is that size in cells
// and `SPARSE_MIN_PX` is the floor underneath it, for the coarse sheets where a
// cell is barely one pixel across and a multiple of nothing is still nothing.
//
// Applied only to cells with at most `SPARSE_NEIGHBOURS` lit neighbours, and
// that is the part that makes it safe rather than a global inflation: every cell
// along the edge of a real blob has at least two, so no blob anywhere changes
// shape. What grows is a cell on its own, both halves of a pair, and the tip of
// a one-cell-wide trail — where a rounder cap is the whole of the difference.
//
// It is the bargain MIN_CELL_PX already makes, and the one any map makes to keep
// a city dot on screen: past the point where a thing is too small to draw
// honestly, drawing it slightly too big beats drawing nothing at all.
const SPARSE_NEIGHBOURS = 1;
const SPARSE_GROW = 1.9;
const SPARSE_MIN_PX = 2;

// The six neighbours of a cell, by column parity. Flat-top, odd-q: odd columns
// sit half a row north, so which two rows the next column along contributes
// depends on which parity you are standing on. Column counts are even at every
// level by construction (see BASE_COLS), so a world copy never changes a
// column's parity and the canonical column can be asked directly.
const NEIGHBOURS_ODD = [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]];
const NEIGHBOURS_EVEN = [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];

// Smallest a cell is ever drawn, in canvas pixels. See the note in paint():
// anything under a pixel rasterizes at partial alpha and the level-set cut
// deletes it, so a pinned fine level vanished as you zoomed out.
const MIN_CELL_PX = 0.85;

// How opaque the regions sit on the basemap. Single-color regions are a wash
// you read the map through; a heat map is the thing you're reading, so it sits
// heavier. main.js drives both the canvas layer and the vector fallback from
// these, so this is the one place to change it.
export const BLOB_ALPHA = 0.3;
export const BLOB_HEAT_ALPHA = 0.5;

// Blobs only need a canvas, which everything has — the blur itself is done
// natively where that exists and in JS where it doesn't (see blurRgba).
export function blobsSupported() {
  try {
    return !!document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

// Does ctx.filter actually blur anything?
//
// Safari has never shipped CanvasRenderingContext2D.filter (WebKit bug 198416).
// Assigning it there succeeds — it just becomes an ordinary JS property — and
// reading it back returns exactly what you set, so the obvious feature test
// (`ctx.filter !== 'none'`) reports support and every blur silently does
// nothing. That is what left iOS drawing bare hard-edged discs while every
// other browser showed blobs.
//
// So probe the behaviour instead: blur a dot and look for ink somewhere only a
// blur could have put it.
const nativeBlur = (() => {
  let known;
  return () => {
    if (known !== undefined) return known;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.filter = 'blur(4px)';
      ctx.fillStyle = '#fff';
      ctx.fillRect(12, 12, 8, 8);
      ctx.filter = 'none';
      // 6px clear of the rect: only reachable by a blur that ran.
      known = ctx.getImageData(6, 16, 1, 1).data[3] > 0;
    } catch {
      known = false;
    }
    return known;
  };
})();

// --- Blur without ctx.filter ----------------------------------------------------
// Three box passes approximate a Gaussian closely enough that nothing here can
// tell the difference, and each pass is a running sum, so the cost does not grow
// with the radius — which matters, because the radius is a whole cell.
//
// The alpha channel has to be carried into the color channels first
// (premultiplied) and taken back out afterwards. Blurring straight RGBA drags
// every edge toward the transparent pixels' stored color, which is black — the
// blobs would come out with a dark rim exactly where they are supposed to be
// dissolving into the map.
function boxPass(src, dst, w, h, r, vertical) {
  const outer = vertical ? w : h;
  const inner = vertical ? h : w;
  const stepIn = (vertical ? w : 1) * 4;
  const stepOut = (vertical ? 1 : w) * 4;
  // Reciprocal rather than a divide in the inner loop: this runs four times per
  // pixel per pass and there are six passes, so it is the most-executed
  // arithmetic in the file.
  const span = 1 / (r * 2 + 1);
  for (let o = 0; o < outer; o++) {
    const base = o * stepOut;
    let r0 = 0;
    let g0 = 0;
    let b0 = 0;
    let a0 = 0;
    // Seed the window, clamping at the edges (edge pixels repeat).
    for (let i = -r; i <= r; i++) {
      const k = base + Math.min(inner - 1, Math.max(0, i)) * stepIn;
      r0 += src[k];
      g0 += src[k + 1];
      b0 += src[k + 2];
      a0 += src[k + 3];
    }
    for (let i = 0; i < inner; i++) {
      const at = base + i * stepIn;
      dst[at] = r0 * span;
      dst[at + 1] = g0 * span;
      dst[at + 2] = b0 * span;
      dst[at + 3] = a0 * span;
      const add = base + Math.min(inner - 1, i + r + 1) * stepIn;
      const drop = base + Math.max(0, i - r) * stepIn;
      r0 += src[add] - src[drop];
      g0 += src[add + 1] - src[drop + 1];
      b0 += src[add + 2] - src[drop + 2];
      a0 += src[add + 3] - src[drop + 3];
    }
  }
}

// The two float planes the box passes bounce between, kept between calls.
//
// They are the size of the sheet — at the map's cap, two 4.8 MB arrays — and a
// paint runs the blur three times, so allocating them per call asks the
// collector for ~29 MB per repaint and pays to zero every byte of it. Measured
// in a WKWebView that alone is the difference between a 24 ms paint and the
// occasional 107 ms one, which is what a level change felt like: not slow so
// much as intermittently stuck. Grown, never shrunk — the sheet's size is
// bounded by the caps above, so this settles after the first few repaints.
let planeA = new Float32Array(0);
let planeB = new Float32Array(0);

// Radius whose three box passes come out at the given standard deviation, and
// the range of sigmas the passes are actually run over. Shared with the ink box
// below, which has to know exactly how far each round can spread the paint.
const clampSigma = (sigma) => Math.min(90, Math.max(0.5, sigma));
const boxRadius = (sigma) => Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));

/** Blur `data` in place. `w`/`h` describe `data`, which may be a sub-rectangle
 *  of the canvas it came from — see the ink box in paintBlobSheet. */
function blurRgba(data, w, h, sigma) {
  const r = boxRadius(sigma);
  const n = w * h * 4;
  if (planeA.length < n) {
    planeA = new Float32Array(n);
    planeB = new Float32Array(n);
  }
  const a = planeA;
  const b = planeB;
  for (let i = 0; i < n; i += 4) {
    const al = data[i + 3] / 255;
    a[i] = data[i] * al;
    a[i + 1] = data[i + 1] * al;
    a[i + 2] = data[i + 2] * al;
    a[i + 3] = data[i + 3];
  }
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, false);
    boxPass(b, a, w, h, r, true);
  }
  for (let i = 0; i < n; i += 4) {
    const al = a[i + 3];
    const inv = al > 0.5 ? 255 / al : 0;
    data[i] = a[i] * inv;
    data[i + 1] = a[i + 1] * inv;
    data[i + 2] = a[i + 2] * inv;
    data[i + 3] = al;
  }
}

// Alpha transfer curves, cached by softness. Mapping the blurred alpha through
// a smoothstep centred on BLOB_LEVEL is the "re-cut": below the band the pixel
// is outside the blob, above it it is inside, and the band itself is the rim.
//
// The band's low end is clamped to ALPHA_FLOOR and never allowed to reach 0.
// Without that, a wide band (BLOB_EDGE approaching BLOB_LEVEL) starts below
// zero and lifts *every* pixel — including the empty ones — to a visible
// alpha, washing the whole canvas rectangle and drawing its straight edge
// across the map. The floor also discards the blur's outermost tail, where the
// stored color is a rounding artefact of a nearly-zero alpha and reads as dirt.
export const ALPHA_FLOOR = 0.05;
const lutCache = new Map();

// Exported so the iOS port can be checked against it rather than against a
// second copy of the formula: this curve is what decides a blob's outline, and
// a Metal shader that disagrees with it draws a different map.
export function alphaLut(edge) {
  let lut = lutCache.get(edge);
  if (lut) return lut;
  lut = new Uint8Array(256);
  const lo = Math.max(ALPHA_FLOOR, BLOB_LEVEL - edge) * 255;
  // Capped at full alpha as well, so a wide ramp lengthens the fade instead of
  // leaving the blob's core translucent.
  const hi = Math.min(255, Math.max(lo + 1, (BLOB_LEVEL + edge) * 255));
  for (let a = 0; a < 256; a++) {
    const t = Math.min(1, Math.max(0, (a - lo) / (hi - lo)));
    lut[a] = Math.round(255 * t * t * (3 - 2 * t));
  }
  lut[0] = 0;
  lutCache.set(edge, lut);
  return lut;
}

// Little-endian machines pack RGBA into one word as 0xAABBGGRR, which lets the
// alpha pass below walk the image a word at a time instead of a byte at a time.
const LE = (() => {
  const probe = new Uint8Array(4);
  new Uint32Array(probe.buffer)[0] = 0x11223344;
  return probe[3] === 0x11;
})();

// Blur `src` into `context`, then optionally re-cut the result. Both halves are
// done in one getImageData round trip when the blur is ours, which is fewer
// passes over the pixels than the native path needs.
//
// `box` is the only part of the sheet that can hold ink: outside it every pixel
// is transparent, blurring transparent pixels leaves them transparent, and the
// re-cut maps alpha 0 to alpha 0. So the JS blur reads and writes that
// rectangle alone. The native path ignores it — there an extra pixel is one GPU
// pass, and the clip would cost more to set up than it saves.
function blurInto(context, src, w, h, sigma, edge, box) {
  context.clearRect(0, 0, w, h);
  const blur = clampSigma(sigma);
  if (nativeBlur()) {
    context.filter = `blur(${blur.toFixed(2)}px)`;
    context.drawImage(src, 0, 0);
    context.filter = 'none';
    if (edge !== null) cutAtLevel(context, w, h, edge);
    return;
  }
  context.drawImage(src, 0, 0);
  const img = context.getImageData(box.x, box.y, box.w, box.h);
  blurRgba(img.data, box.w, box.h, blur);
  if (edge !== null) applyLut(img.data, alphaLut(edge));
  context.putImageData(img, box.x, box.y);
}

// Re-cut a blurred layer at BLOB_LEVEL, in place. Only the alpha channel is
// touched, so the blurred (and therefore blended) colors survive untouched.
//
// On a little-endian machine that is one 32-bit read/write per pixel, and empty
// pixels — most of the canvas — cost a single compare.
function applyLut(data, lut) {
  if (LE) {
    const words = new Uint32Array(data.buffer);
    for (let i = 0; i < words.length; i++) {
      const px = words[i];
      const a = px >>> 24;
      if (a === 0) continue;
      words[i] = (px & 0x00ffffff) | (lut[a] << 24);
    }
    return;
  }
  for (let i = 3; i < data.length; i += 4) data[i] = lut[data[i]];
}

// The same cut, for the native-blur path: there the blur happened on the GPU, so
// the pixels have to be fetched and put back around it.
function cutAtLevel(context, w, h, edge) {
  const img = context.getImageData(0, 0, w, h);
  applyLut(img.data, alphaLut(edge));
  context.putImageData(img, 0, 0);
}

/**
 * The three canvases one run of the pipeline needs: the sharp discs, the
 * ping-pong partner the shaping rounds bounce between, and the finished sheet.
 *
 * Handed in rather than allocated per call because the map repaints on every
 * moveend and a fresh pair of multi-megapixel canvases each time is a garbage
 * collector's problem. Anything painting once — the image export — can simply
 * ask for its own set.
 */
export function createBlobBuffers() {
  const latest = document.createElement('canvas'); // the finished sheet
  const sheet = document.createElement('canvas'); // sharp discs, pre-blur
  const work = document.createElement('canvas'); // ping-pong for extra rounds
  latest.width = latest.height = sheet.width = sheet.height = work.width = work.height = 1;
  return {
    latest,
    sheet,
    work,
    latestCtx: latest.getContext('2d', { willReadFrequently: true }),
    sheetCtx: sheet.getContext('2d'),
    workCtx: work.getContext('2d', { willReadFrequently: true }),
  };
}

/**
 * Paint every lit cell of one level as discs, blur them, and re-cut the result
 * at a fixed alpha level — the whole of what makes a honeycomb look poured.
 * The finished sheet is left in `buffers.latest`.
 *
 * Everything the map knows and a still image does not — the zoom, the display
 * density, which canvas the result is composed into — arrives as `pxPerMerc`
 * and `featherScale` rather than being read off a map, which is what lets the
 * export render the same shapes at poster resolution.
 *
 * @param {object} o
 * @param {ReturnType<createBlobBuffers>} o.buffers
 * @param {{xMin:number,xMax:number,yMin:number,yMax:number}} o.bb  the rectangle
 *   to draw, in Mercator metres
 * @param {number} o.level      grid level being drawn
 * @param {Map} o.cells         "col/row" → rolled-up stats
 * @param {(stat:object)=>string} o.colorOf  css color for a cell
 * @param {boolean} [o.heat]    a heat map rather than the single-color wash;
 *                              picks which pair of edge knobs applies
 * @param {number} [o.edge]     override the alpha-ramp width on the final cut,
 *                              in units of a cell. The map wants a wash that
 *                              dissolves into the basemap; a still image is not
 *                              sitting on a basemap and wants an edge.
 * @param {number} [o.featherPx] override the final feather, likewise
 * @param {number} o.pxPerMerc  canvas pixels per Mercator metre, before capping
 * @param {number} [o.maxSide]  hard cap on either dimension
 * @param {number} [o.featherScale] canvas pixels per unit of BLOB_FEATHER_PX
 * @param {number} [o.maxFeatherCells] cap the feather at this many cell radii.
 *   The map has no use for it — its feather is a screen-pixel width against
 *   cells that are several pixels across — but an image scales the feather with
 *   its own height, and at the finest level a poster's cells are barely a pixel
 *   while the feather is fifteen. The blobs then dissolve into nothing at
 *   exactly the setting that asked for the most detail.
 * @returns {{w:number, h:number, xMax:number}|null} the sheet's size, and the
 *   eastern edge it actually reached (rounding to whole pixels moves it)
 */
export function paintBlobSheet({
  buffers,
  bb,
  level,
  cells,
  colorOf,
  heat = false,
  edge: edgeOverride,
  featherPx: featherOverride,
  pxPerMerc,
  maxSide = MAX_SIDE,
  // Bounds the sheet's area, where `maxSide` bounds its sides. Only the JS blur
  // is priced per pixel steeply enough to need it — see JS_BLUR_MAX_PX. The
  // export passes Infinity: it paints once, and it wants the pixels.
  maxPixels = nativeBlur() ? Infinity : JS_BLUR_MAX_PX,
  featherScale = 1,
  maxFeatherCells = Infinity,
}) {
  const { latest, latestCtx, sheet, sheetCtx, work, workCtx } = buffers;
  const mercW = bb.xMax - bb.xMin;
  const mercH = bb.yMax - bb.yMin;
  if (!(mercW > 0) || !(mercH > 0)) return null;

  const edge = edgeOverride ?? (heat ? BLOB_HEAT_EDGE : BLOB_EDGE);
  const featherPx = featherOverride ?? (heat ? BLOB_HEAT_FEATHER_PX : BLOB_FEATHER_PX);

  // Area as well as sides: `k` scales both dimensions, so bounding w·h means
  // bounding k by the square root of the budget over the rectangle's area.
  const k = Math.min(
    pxPerMerc,
    maxSide / mercW,
    maxSide / mercH,
    Math.sqrt(maxPixels / (mercW * mercH)),
  );
  const w = Math.max(1, Math.round(mercW * k));
  const h = Math.max(1, Math.round(mercH * k));
  const xMax = bb.xMin + w / k;

  // Assigning a dimension clears the canvas, which is why it was written this
  // way — but it also throws the backing store away and builds a new one, three
  // times over, on a canvas that is very nearly always the size it already was.
  //
  // Nearly always, because the sheet's size does not actually depend on the
  // camera: mercW·pxPerMerc is the padded viewport measured in canvas pixels,
  // and the zoom cancels out of it. A window that is not being resized paints
  // the same w×h every time, at every level and every zoom, until one of the
  // caps starts binding. So resize when it really is a new size, and clear in
  // place when it is not.
  //
  // Each canvas is asked separately: clear() empties `latest` and leaves the
  // other two at their old size, so one shared test would decide from the wrong
  // canvas and hand the pipeline a 1×1 sheet.
  const resize = (c, ctx) => {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    } else if (ctx) {
      ctx.clearRect(0, 0, w, h);
    }
  };
  resize(sheet, sheetCtx);
  resize(latest, latestCtx); // cleared for the early-out below; blurInto clears it otherwise
  resize(work, null); // never read before something clears and writes it

  const R = radiusOf(level);
  const colSp = 1.5 * R;
  const rowSp = SQRT3 * R;
  const N = colsOf(level);

  // How big one cell is on this canvas, with a floor. Below about a pixel a
  // disc only ever covers a fraction of one, so it comes out of the rasterizer
  // at a fraction of full alpha — and the level-set cut then reads that as
  // "outside the shape" and erases it. Pinning Detail to a fine level and
  // zooming out made everything disappear for exactly that reason.
  //
  // The floor only bites once a cell is too small to draw honestly, so at every
  // zoom where the cells are visible at all nothing changes. Past that point a
  // cell is drawn slightly larger than it really is, which is the same bargain
  // any map makes to keep a city dot on screen — the alternative here is
  // drawing nothing.
  const unit = Math.max(R * k, MIN_CELL_PX);
  const rPx = unit * CELL_RADIUS;
  // What a cell with nothing around it is drawn at instead — see SPARSE_GROW.
  const sparsePx = Math.max(rPx * SPARSE_GROW, SPARSE_MIN_PX);

  // Has this cell got enough lit neighbours for the blur to leave it alone?
  // Counted on the canonical column, which is the one the keys are written in,
  // and stopped the moment the answer is no longer in doubt.
  const sparse = (nc, row) => {
    let n = 0;
    for (const [dc, dr] of nc & 1 ? NEIGHBOURS_ODD : NEIGHBOURS_EVEN) {
      if (cells.has(`${normCol(nc + dc, N)}/${row + dr}`) && ++n > SPARSE_NEIGHBOURS) return false;
    }
    return true;
  };

  // Mercator → canvas pixels (y grows north in Mercator, down on canvas).
  const px = (x) => (x - bb.xMin) * k;
  const py = (y) => (bb.yMax - y) * k;

  // Grouping by color keeps this to one path per distinct shade instead of one
  // fill call per cell.
  const paths = new Map();
  const margin = sparsePx + 2;
  const colMin = Math.floor((bb.xMin - R) / colSp);
  const colMax = Math.ceil((xMax + R) / colSp);
  // Bounds of the disc centres actually drawn. The sheet covers the padded
  // viewport, which is nearly three times the area of what is on screen, and a
  // window at the top of a country or the edge of a coastline lights a fraction
  // of it. Blur cost is flatly linear in pixels, so knowing where the paint
  // stops is worth the four comparisons per cell it takes to find out.
  let inkX0 = Infinity;
  let inkY0 = Infinity;
  let inkX1 = -Infinity;
  let inkY1 = -Infinity;
  // Largest disc actually drawn, which is what the blur has to reach past.
  let inkR = rPx;

  for (const [key, stat] of cells) {
    const sep = key.indexOf('/');
    const nc = +key.slice(0, sep);
    const row = +key.slice(sep + 1);
    const cyM = row * rowSp; // parity offset added per world copy below
    // Asked once per canonical cell and only when one of its copies is on the
    // sheet: six lookups is cheap, but the padded viewport holds a lot of cells
    // and most repaints draw a fraction of what is stored.
    let r = 0;

    // Every world-copy instance of this canonical column in the window.
    const kMin = Math.ceil((colMin - nc) / N);
    const kMax = Math.floor((colMax - nc) / N);
    for (let wc = kMin; wc <= kMax; wc++) {
      const col = nc + wc * N;
      const cx = px(col * colSp);
      const cy = py(cyM + (col & 1 ? 0.5 * rowSp : 0));
      if (cx < -margin || cy < -margin || cx > w + margin || cy > h + margin) continue;

      if (!r) {
        r = sparse(nc, row) ? sparsePx : rPx;
        if (r > inkR) inkR = r;
      }
      const color = colorOf(stat);
      let path = paths.get(color);
      if (!path) paths.set(color, (path = new Path2D()));
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, Math.PI * 2);
      if (cx < inkX0) inkX0 = cx;
      if (cx > inkX1) inkX1 = cx;
      if (cy < inkY0) inkY0 = cy;
      if (cy > inkY1) inkY1 = cy;
    }
  }

  // Nothing lit in this window: the buffers were cleared by the resize above and
  // three blurs of an empty sheet would only confirm it.
  if (!paths.size) return { w, h, xMax };

  for (const [color, path] of paths) {
    sheetCtx.fillStyle = color;
    sheetCtx.fill(path);
  }

  // How far the paint can travel from a disc's centre before the pipeline is
  // done with it: the disc's own radius, plus three box passes of every round
  // that follows. Anything beyond this is transparent in every buffer, so the
  // rectangle below is the whole of what the JS blur has to touch.
  //
  // Deliberately the sum of all the rounds rather than each round's own reach.
  // One rectangle for the whole pipeline costs a little more work per round than
  // a shrinking one would save, and it removes the question of whether round two
  // can see everything round one wrote.
  const feather = Math.min(featherPx * featherScale, unit * maxFeatherCells);
  let reach = inkR + 2;
  for (let round = 0; round < BLOB_ROUNDS; round++) {
    reach += 3 * boxRadius(clampSigma(unit * BLOB_BLUR * (round === 0 ? 1 : 0.62)));
  }
  if (feather > 0.5) reach += 3 * boxRadius(clampSigma(feather));
  const box = {
    x: Math.max(0, Math.floor(inkX0 - reach)),
    y: Math.max(0, Math.floor(inkY0 - reach)),
  };
  box.w = Math.min(w, Math.ceil(inkX1 + reach)) - box.x;
  box.h = Math.min(h, Math.ceil(inkY1 + reach)) - box.y;

  // Blur, then re-cut the shape at a fixed alpha level — a level-set smoothing
  // step. The blur is what merges cells and blends their colors; taking the
  // ~half-alpha contour afterwards is what keeps the blob the size it should be
  // while every dent narrower than the blur fills in and every corner sharper
  // than the blur rounds off. Repeating it rounds harder without inflating
  // anything, which is the whole trick: the cells never grow, the outline just
  // relaxes.
  let src = sheet;
  let dst = latest;
  for (let round = 0; round < BLOB_ROUNDS; round++) {
    // Later rounds work on an already-smooth shape, so they need less blur.
    const sigma = unit * BLOB_BLUR * (round === 0 ? 1 : 0.62);
    const dctx = dst === latest ? latestCtx : workCtx;
    // Intermediate rounds exist to shape the outline, so they cut tightly — a
    // soft cut halfway through would just get blurred again and lose the
    // definition the next round needs. Only the last cut is the visible rim,
    // which is why the edge knob means "how gradually the blob dissolves into
    // the map" and nothing else.
    blurInto(dctx, src, w, h, sigma, round === BLOB_ROUNDS - 1 ? edge : SHAPE_EDGE, box);
    src = dst;
    dst = dst === latest ? work : latest;
  }
  if (src !== latest) {
    latestCtx.clearRect(0, 0, w, h);
    latestCtx.drawImage(work, 0, 0);
  }

  // Feather the finished shape by a fixed number of screen pixels, so the
  // dissolve looks the same at every zoom instead of tracking cell size.
  // Deliberately no cut afterwards: the tail is left as the blur made it, so it
  // fades out with correct colors all the way down to nothing.
  if (feather > 0.5) {
    blurInto(workCtx, latest, w, h, feather, null, box);
    latestCtx.clearRect(0, 0, w, h);
    latestCtx.drawImage(work, 0, 0);
  }

  return { w, h, xMax };
}

/**
 * The blob layer. Level changes cross-dissolve *inside* this one canvas rather
 * than between two map layers: a canvas source uploads its pixels to the GPU
 * asynchronously, so handing over between two of them shows whatever texture
 * the incoming layer happened to be holding — blank, or the level before last —
 * for a frame or two. One canvas can never be out of sync with itself.
 */
export function createBlobLayer(map, id) {
  const canvas = document.createElement('canvas'); // what the map samples
  const ctx = canvas.getContext('2d');
  const buffers = createBlobBuffers();
  const { latest } = buffers;
  const outgoing = document.createElement('canvas'); // level being dissolved away
  const outgoingCtx = outgoing.getContext('2d');
  canvas.width = canvas.height = 1;
  outgoing.width = outgoing.height = 1;

  // Mercator rectangle each buffer covers, so the outgoing image can be placed
  // at its own geography while the new one is drawn over it.
  let latestRect = null;
  let outRect = null;
  let fadeT = 1; // 0 = only the outgoing level, 1 = only the newest

  // Somewhere harmless until the first paint replaces it.
  let coords = [
    [-0.01, 0.01],
    [0.01, 0.01],
    [0.01, -0.01],
    [-0.01, -0.01],
  ];
  let installed = false;

  const layerId = `${id}-layer`;

  function install(beforeId, opacity = 0) {
    // A basemap switch rebuilds the style and lands here with a fresh source.
    // Whatever the old one was doing is over, and the new one starts paused.
    stopUpload?.();
    map.addSource(id, { type: 'canvas', canvas, animate: false, coordinates: coords });
    map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: id,
        paint: {
          'raster-opacity': opacity,
          'raster-fade-duration': 0,
          'raster-resampling': 'linear',
        },
      },
      beforeId,
    );
    installed = true;
  }

  // The canvas source only re-reads the canvas while it is "playing", so a
  // repaint has to happen between play() and pause() for the new pixels to
  // reach the GPU. That upload runs inside the render pass, and is skipped
  // entirely until the source has a tile to draw into, so "one animation frame"
  // is not enough. Playing until the map goes idle covers both, with a cap in
  // case it never does.
  //
  // Started once and left running until the pixels stop changing, rather than
  // stopped and restarted per repaint. A crossfade calls this on every frame,
  // and `pause()` is not free: it runs the source's `prepare()`, which uploads
  // the whole canvas to the GPU — so pausing and replaying around each frame
  // uploaded the texture twice, once on the way out and again in the render
  // that followed.
  let pauseTimer = null;
  let stopUpload = null;
  function upload() {
    if (!map.getSource(id)) return;
    if (!stopUpload) {
      stopUpload = () => {
        clearTimeout(pauseTimer);
        map.off('idle', stopUpload);
        stopUpload = null;
        // Looked up now rather than captured: a basemap switch rebuilds the
        // source under us, and pausing the one that has been thrown away would
        // leave the live one playing for ever.
        map.getSource(id)?.pause();
      };
      map.once('idle', stopUpload);
      map.getSource(id).play();
    } else {
      clearTimeout(pauseTimer); // still changing — push the deadline back
    }
    map.triggerRepaint();
    pauseTimer = setTimeout(() => stopUpload?.(), 2500);
  }

  function setCoords(next) {
    // The rectangle is unchanged for every frame of a dissolve, and
    // `setCoordinates` is not a setter: it recomputes the source's tile, walks
    // every zoom level to find the ones it overlaps, and fires a source
    // `content` event — which makes MapLibre reload and re-evaluate the whole
    // tile cache. Sixty times a second, for a rectangle that did not move.
    if (coords.every((c, i) => c[0] === next[i][0] && c[1] === next[i][1])) return;
    coords = next;
    map.getSource(id)?.setCoordinates(next);
  }

  /**
   * Paint every lit cell of one level onto the sheet the map samples.
   *
   * @param {object} o
   * @param {{xMin:number,xMax:number,yMin:number,yMax:number}} o.bb padded viewport in Mercator metres
   * @param {number} o.level      grid level being drawn
   * @param {Map} o.cells         "col/row" → rolled-up stats
   * @param {(stat:object)=>string} o.colorOf  css color for a cell
   * @param {boolean} [o.heat]    a heat map rather than the single-color wash;
   *                              picks which pair of edge knobs applies
   * @param {boolean} [o.moving]  the camera is still under the gesture, so paint
   *                              to MOVING_MAX_PX and expect to be called again
   * @returns {boolean} whether the sheet was painted to the reduced budget, and
   *   therefore still owes a full-resolution repaint
   */
  function paint({ bb, level, cells, colorOf, heat = false, moving = false }) {
    // Screen scale straight from the zoom (MapLibre's world is 512·2^z px).
    // The feather takes the same scale, so a width measured in CSS pixels stays
    // the same on screen whatever the display density.
    const scale = displayScale();
    // Only where the blur is ours. A browser with a native blur pays one GPU
    // pass per pixel and was never the browser that stuttered.
    const coarse = moving && !nativeBlur();
    const out = paintBlobSheet({
      buffers,
      bb,
      level,
      cells,
      colorOf,
      heat,
      pxPerMerc: ((512 * 2 ** map.getZoom()) / WORLD) * scale,
      featherScale: scale,
      maxPixels: coarse ? MOVING_MAX_PX : undefined,
    });
    if (!out) return false;

    latestRect = { xMin: bb.xMin, xMax: out.xMax, yMin: bb.yMin, yMax: bb.yMax };
    compose();
    return coarse;
  }

  // Draw what the map actually samples: the outgoing level underneath, the
  // newest one over it, both weighted by the dissolve. Doing this here rather
  // than with two map layers is what keeps a level change to a single visible
  // change — there is one texture, and it is always complete.
  function compose() {
    if (!latestRect) return;
    const w = latest.width;
    const h = latest.height;
    // A canvas source re-reads its pixels when it is playing OR when the canvas
    // changes size, and the size path is the reliable one. Nudging the width by
    // a pixel guarantees it for a settled repaint; mid-dissolve the map is
    // already rendering every frame, and nudging there would visibly jitter the
    // rectangle. The extra pixel is paid back by widening the mapped rectangle
    // to match, so the projection stays exact either way.
    const nudge = fadeT >= 1 && canvas.width === w ? 1 : 0;
    // Assigning a dimension is what clears the canvas, but it also throws the
    // backing store away and builds a new one — which is the wrong trade on the
    // frames of a dissolve, where the size never changes and only the contents
    // do. Clear those in place and let the size path stand for the settled
    // repaint it was written for.
    if (canvas.width === w + nudge && canvas.height === h) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      canvas.width = w + nudge; // also clears
      canvas.height = h;
    }

    if (fadeT < 1 && outRect && outgoing.width > 1) {
      const k = w / (latestRect.xMax - latestRect.xMin);
      ctx.globalAlpha = 1 - fadeT;
      ctx.drawImage(
        outgoing,
        (outRect.xMin - latestRect.xMin) * k,
        (latestRect.yMax - outRect.yMax) * k,
        (outRect.xMax - outRect.xMin) * k,
        (outRect.yMax - outRect.yMin) * k,
      );
    }
    ctx.globalAlpha = fadeT;
    ctx.drawImage(latest, 0, 0);
    ctx.globalAlpha = 1;

    const k = w / (latestRect.xMax - latestRect.xMin);
    const xMax = latestRect.xMax + nudge / k;
    setCoords([
      [lngOf(latestRect.xMin), latOf(latestRect.yMax)],
      [lngOf(xMax), latOf(latestRect.yMax)],
      [lngOf(xMax), latOf(latestRect.yMin)],
      [lngOf(latestRect.xMin), latOf(latestRect.yMin)],
    ]);
    upload();
  }

  return {
    id,
    layerId,
    install,
    paint,
    /**
     * Let go of the map, because the map is about to stop existing.
     *
     * `upload()` leaves two things outstanding that both reach back for the
     * source: an `idle` handler and a 2.5-second timer. A map switching *style*
     * survives them — the source is rebuilt and the lookups find the new one —
     * but a map being **removed** does not, and the timer fires a couple of
     * seconds later into a torn-down `map.style` and throws. That is the one
     * thing an engine switch does that a basemap switch never did; see
     * switchEngine() in main.js, which is the only caller.
     */
    dispose() {
      clearTimeout(pauseTimer);
      pauseTimer = null;
      if (stopUpload) map.off('idle', stopUpload);
      stopUpload = null;
      installed = false;
    },
    isInstalled: () => installed && !!map.getLayer(layerId),
    setOpacity(v) {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, 'raster-opacity', v);
    },
    // Freeze what is on screen as the outgoing image, ready for the next
    // paint() to dissolve into. Call this *before* painting the new level.
    beginTransition() {
      if (!latestRect || latest.width < 2) return false;
      outgoing.width = latest.width;
      outgoing.height = latest.height;
      outgoingCtx.drawImage(latest, 0, 0);
      outRect = latestRect;
      fadeT = 0;
      return true;
    },
    // 0 → the outgoing level, 1 → the new one. Recomposites in place.
    setFade(t) {
      fadeT = Math.min(1, Math.max(0, t));
      if (fadeT >= 1) outRect = null;
      compose();
    },
    inTransition: () => fadeT < 1,
    clear() {
      if (!latestRect && canvas.width <= 1) return; // already empty
      latestRect = null;
      outRect = null;
      fadeT = 1;
      latest.width = latest.height = 1;
      canvas.width = canvas.height = 1;
      upload();
    },
  };
}
