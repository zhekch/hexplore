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
// The result is handed to MapLibre as a canvas source pinned to the padded
// viewport rectangle in Mercator space (the map never rotates or pitches, so
// that rectangle maps linearly and the image stays registered while panning).

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
export const BLOB_EDGE = 0.3; // single color
export const BLOB_HEAT_EDGE = 0.6; // visits / recent / first seen
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
export const BLOB_FEATHER_PX = 1; // single color
export const BLOB_HEAT_FEATHER_PX = 5; // visits / recent / first seen
// Cells are painted as discs, not hexagons: a disc has no orientation, so the
// silhouette can never give the lattice away. The six neighbours of a cell all
// sit √3·R away, so a radius above 0.87·R makes them overlap — comfortably
// above that, or diagonal neighbours pinch into a string of beads instead of
// flowing into one ribbon.
const CELL_RADIUS = 0.9;

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
  const span = r * 2 + 1;
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
      dst[at] = r0 / span;
      dst[at + 1] = g0 / span;
      dst[at + 2] = b0 / span;
      dst[at + 3] = a0 / span;
      const add = base + Math.min(inner - 1, i + r + 1) * stepIn;
      const drop = base + Math.max(0, i - r) * stepIn;
      r0 += src[add] - src[drop];
      g0 += src[add + 1] - src[drop + 1];
      b0 += src[add + 2] - src[drop + 2];
      a0 += src[add + 3] - src[drop + 3];
    }
  }
}

function blurRgba(data, w, h, sigma) {
  // Radius whose three box passes come out at this standard deviation.
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const n = w * h * 4;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
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
function blurInto(context, src, w, h, sigma, edge) {
  context.clearRect(0, 0, w, h);
  const blur = Math.min(90, Math.max(0.5, sigma));
  if (nativeBlur()) {
    context.filter = `blur(${blur.toFixed(2)}px)`;
    context.drawImage(src, 0, 0);
    context.filter = 'none';
    if (edge !== null) cutAtLevel(context, w, h, edge);
    return;
  }
  context.drawImage(src, 0, 0);
  const img = context.getImageData(0, 0, w, h);
  blurRgba(img.data, w, h, blur);
  if (edge !== null) applyLut(img.data, alphaLut(edge));
  context.putImageData(img, 0, 0);
}

// Re-cut a blurred layer at BLOB_LEVEL, in place. Only the alpha channel is
// touched, so the blurred (and therefore blended) colors survive untouched.
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

function cutAtLevel(context, w, h, edge) {
  const img = context.getImageData(0, 0, w, h);
  const lut = alphaLut(edge);
  if (LE) {
    // One 32-bit read/write per pixel, and empty pixels — most of the canvas —
    // cost a single compare.
    const words = new Uint32Array(img.data.buffer);
    for (let i = 0; i < words.length; i++) {
      const px = words[i];
      const a = px >>> 24;
      if (a === 0) continue;
      words[i] = (px & 0x00ffffff) | (lut[a] << 24);
    }
  } else {
    const data = img.data;
    for (let i = 3; i < data.length; i += 4) data[i] = lut[data[i]];
  }
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
  featherScale = 1,
  maxFeatherCells = Infinity,
}) {
  const { latest, latestCtx, sheet, sheetCtx, work, workCtx } = buffers;
  const mercW = bb.xMax - bb.xMin;
  const mercH = bb.yMax - bb.yMin;
  if (!(mercW > 0) || !(mercH > 0)) return null;

  const edge = edgeOverride ?? (heat ? BLOB_HEAT_EDGE : BLOB_EDGE);
  const featherPx = featherOverride ?? (heat ? BLOB_HEAT_FEATHER_PX : BLOB_FEATHER_PX);

  const k = Math.min(pxPerMerc, maxSide / mercW, maxSide / mercH);
  const w = Math.max(1, Math.round(mercW * k));
  const h = Math.max(1, Math.round(mercH * k));
  const xMax = bb.xMin + w / k;

  sheet.width = w;
  sheet.height = h;
  latest.width = w;
  latest.height = h;
  work.width = w;
  work.height = h;

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

  // Mercator → canvas pixels (y grows north in Mercator, down on canvas).
  const px = (x) => (x - bb.xMin) * k;
  const py = (y) => (bb.yMax - y) * k;

  // Grouping by color keeps this to one path per distinct shade instead of one
  // fill call per cell.
  const paths = new Map();
  const margin = rPx + 2;
  const colMin = Math.floor((bb.xMin - R) / colSp);
  const colMax = Math.ceil((xMax + R) / colSp);

  for (const [key, stat] of cells) {
    const sep = key.indexOf('/');
    const nc = +key.slice(0, sep);
    const row = +key.slice(sep + 1);
    const cyM = row * rowSp; // parity offset added per world copy below

    // Every world-copy instance of this canonical column in the window.
    const kMin = Math.ceil((colMin - nc) / N);
    const kMax = Math.floor((colMax - nc) / N);
    for (let wc = kMin; wc <= kMax; wc++) {
      const col = nc + wc * N;
      const cx = px(col * colSp);
      const cy = py(cyM + (col & 1 ? 0.5 * rowSp : 0));
      if (cx < -margin || cy < -margin || cx > w + margin || cy > h + margin) continue;

      const color = colorOf(stat);
      let path = paths.get(color);
      if (!path) paths.set(color, (path = new Path2D()));
      path.moveTo(cx + rPx, cy);
      path.arc(cx, cy, rPx, 0, Math.PI * 2);
    }
  }

  for (const [color, path] of paths) {
    sheetCtx.fillStyle = color;
    sheetCtx.fill(path);
  }

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
    blurInto(dctx, src, w, h, sigma, round === BLOB_ROUNDS - 1 ? edge : SHAPE_EDGE);
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
  const feather = Math.min(featherPx * featherScale, unit * maxFeatherCells);
  if (feather > 0.5) {
    blurInto(workCtx, latest, w, h, feather, null);
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
  // reach the GPU. Two things make that easy to get wrong: the upload runs
  // it happens inside the render pass and is skipped entirely until the source
  // has a tile to draw into, so "one animation frame" is not enough. Playing
  // until the map goes idle covers both, with a cap in case it never does.
  let pauseTimer = null;
  let stopUpload = null;
  function upload() {
    const src = map.getSource(id);
    if (!src) return;
    if (stopUpload) stopUpload();
    src.play();
    map.triggerRepaint();
    stopUpload = () => {
      clearTimeout(pauseTimer);
      map.off('idle', stopUpload);
      stopUpload = null;
      src.pause();
    };
    map.once('idle', stopUpload);
    pauseTimer = setTimeout(() => stopUpload?.(), 2500);
  }

  function setCoords(next) {
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
   */
  function paint({ bb, level, cells, colorOf, heat = false }) {
    // Screen scale straight from the zoom (MapLibre's world is 512·2^z px).
    // The feather takes the same scale, so a width measured in CSS pixels stays
    // the same on screen whatever the display density.
    const scale = displayScale();
    const out = paintBlobSheet({
      buffers,
      bb,
      level,
      cells,
      colorOf,
      heat,
      pxPerMerc: ((512 * 2 ** map.getZoom()) / WORLD) * scale,
      featherScale: scale,
    });
    if (!out) return;

    latestRect = { xMin: bb.xMin, xMax: out.xMax, yMin: bb.yMin, yMax: bb.yMax };
    compose();
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
    canvas.width = w + nudge; // also clears
    canvas.height = h;

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
