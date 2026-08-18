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
  MAX_LEVEL, MAX_MERC_Y, SQRT3, WORLD, cellCenter, latOf, lngOf, mercX, mercY, parseCellId,
  radiusOf,
} from './hexgrid.js';
import {
  allCountries, countryAreaKm2, countryCount, countryGeometry, countryIso, loadCountries,
} from './countries.js';
import {
  countriesInView, fineCountryOutline, loadFineRegions, loadRegions, regionAreaKm2,
  regionById, regionGeometry, regionsLoaded, regionsOf,
} from './regions.js';
import {
  allContinents, continentAreaKm2, continentGeometry, countriesInContinent,
} from './continents.js';
import { asMulti } from './polygon.js';
import {
  EARTH_LAND_KM2, WHOLE_COUNTRY, areaAtPoint, computeStats, formatKm2, formatPct,
} from './stats.js';
import { areaColorOf, cellColorOf, isHeatMode } from './coloring.js';
import { createBlobBuffers, paintBlobSheet } from './blob-canvas.js';
import { hexOpaque } from './color-picker.js';

// --- Tuning -------------------------------------------------------------------

/**
 * The three shapes, and the proportions each comes in.
 *
 * Two levels rather than one, because "vertical" is the decision and "4:5 or
 * 9:16" is a detail of it — and a flat list of eleven ratios is a list nobody
 * reads. The first preset of each family is what that word means if you do not
 * go looking: a feed post, a slide, a square.
 *
 * The pixel counts are the 1× ones, and are deliberately modest. Quality is a
 * separate multiplier below, so the same ratio can be a post or something you
 * put through a printer without either being the default.
 */
export const SHAPES = {
  vertical: {
    label: 'Vertical',
    presets: [
      { key: '4x5', label: '4 : 5 · post', w: 1080, h: 1350 },
      { key: '2x3', label: '2 : 3 · print', w: 1080, h: 1620 },
      { key: '9x16', label: '9 : 16 · story', w: 1080, h: 1920 },
      { key: 'a4', label: 'A4 · 210×297', w: 1240, h: 1754 },
    ],
  },
  horizontal: {
    label: 'Horizontal',
    presets: [
      { key: '16x9', label: '16 : 9 · screen', w: 1920, h: 1080 },
      { key: '3x2', label: '3 : 2 · print', w: 1620, h: 1080 },
      { key: '21x9', label: '21 : 9 · wide', w: 2520, h: 1080 },
      { key: 'a4l', label: 'A4 · 297×210', w: 1754, h: 1240 },
    ],
  },
  square: {
    label: 'Square',
    presets: [
      { key: '1x1', label: '1 : 1 · post', w: 1080, h: 1080 },
      { key: '1x1p', label: '1 : 1 · print', w: 1748, h: 1748 },
    ],
  },
};

/** Multipliers on a preset. Nothing here is resampled — it is drawn again. */
export const SCALES = [1, 2, 3, 4];

/**
 * The most pixels an export may be.
 *
 * Not a taste judgement: a canvas has a hard area limit and it is not the same
 * one everywhere — Safari has historically refused anything over about 16 MP
 * and simply hands back a blank bitmap rather than an error. 4× of the widest
 * preset is 43 MP, which is a real thing to ask for and a real way to get an
 * empty file. So the size is clamped, and the dialog says what it clamped to
 * rather than quietly producing something smaller than the number on screen.
 */
export const MAX_PIXELS = 36_000_000;
/** And no side longer than any browser's per-dimension cap. */
export const MAX_SIDE_PX = 12_000;

// How much of the frame is margin, per side. The subject wants room to be a
// shape rather than a thing wedged into a rectangle, and the caption sits in
// that room.
const INSET = 0.075;

// Blobs: the finest level whose cells are at least this many export pixels
// across is the one drawn. Below about a pixel a cell rasterizes at partial
// alpha and the level-set cut erases it (see MIN_CELL_PX in blob-canvas.js), so
// this is the point at which asking for more detail starts costing detail.
const MIN_BLOB_PX = 1.35;

// --- How sharply a blob stops -----------------------------------------------
//
// **Two different softnesses, and only one of them is wanted here.** `BLOB_BLUR`
// (src/blob-canvas.js) is the blur that merges neighbouring cells and bleeds
// their colours into each other — that is the thing that makes a honeycomb read
// as poured ink, and it is untouched. What follows is the *rim*: how gradually
// a blob stops being a blob and becomes nothing.
//
// The map wants that rim wide, because the wash is a hint you read the basemap
// through and a hard edge would look pasted on. An image is not sitting on a
// basemap. There is nothing behind the blob for it to dissolve into, so the
// same setting reads as a smear with no shape — and the finer the cells, the
// more of the picture the smear eats.
//
// These are the two knobs to turn if it is still not right:
//
//   BLOB_RIM            width of the alpha ramp on the final cut, in units of a
//                       cell. 0.3–0.6 is what the map uses; 0.5 fades out over
//                       roughly half a cell. Raise for a softer edge.
//   BLOB_RIM_FEATHER_PX a last blur over the finished shape, in pixels of a
//                       900px-tall image (see FEATHER_REF_PX). 0 turns it off.
const BLOB_RIM = 0.08;
const BLOB_RIM_FEATHER_PX = 0.6;

// The feather at the rim is measured in screen pixels on the map, where a
// screen pixel is a known size. An image has no screen, so it is scaled against
// a reference height instead: a poster twice as tall gets twice the feather and
// the softness reads the same at any resolution.
const FEATHER_REF_PX = 900;
// …but never wider than the cells it is softening. That scaling is right while
// a cell is comfortably bigger than the feather and catastrophic when it is not:
// at the finest level a poster's cells are a pixel or so across against a
// feather of fifteen, so every blob was smeared below the threshold of being
// visible at all — at exactly the setting that asked for the most detail. Half a
// cell radius of ramp is as soft as a shape can be and still be a shape.
const MAX_FEATHER_CELLS = 0.5;

// How many countries the *preview* will fetch detailed boundaries for. Past
// this the fetch is megabytes and the preview is redrawn on every drag of a
// slider — see ensureSharpBoundaries.
//
// Thirty, and the number is not a taste. Ten was chosen for the frame around
// one country, and a frame around one *canton* in Europe holds twenty: a
// picture of the ground around Bern reaches France, Italy, Germany, Poland,
// Croatia, Austria, Hungary, Czechia, Serbia, the Netherlands, Slovakia,
// Bosnia, Switzerland, Belgium, Slovenia, Montenegro, Luxembourg,
// Liechtenstein, San Marino and Monaco. So the bail fired on every picture
// anyone would actually make, and fetched nothing at all — which is the worst
// of the three outcomes, because the overview set is the one that cannot
// dissolve cleanly (see DETAIL_KM_PX).
//
// The file has no limit: `ensureSharpBoundaries(..., { all: true })`. The
// picture being saved is the thing itself, and a European framing reaches more
// than thirty countries easily.
const FINE_COUNTRY_LIMIT = 30;

// How small a kilometre may get before the detailed boundaries stop being worth
// having, in pixels on the finished canvas.
//
// The overview set is simplified to about a kilometre, so below this the two
// resolutions are the same picture. Above it they are not, and not merely in
// sharpness: `build-regions.mjs` thins each region as a fraction of *its own*
// size, so two neighbours thin the border they share to different vertices, the
// two polylines cross back and forth, and dissolving them opens a bay at every
// crossing. That is the ragged doubled border in a picture of cantons — it is
// the overview data, not the drawing, and the only cure is the detailed set.
//
// So this is the threshold for two decisions that must agree: whether to fetch
// the detail, and whether to draw from it.
const DETAIL_KM_PX = 0.5;

/** Is a kilometre big enough on this canvas for the overview set to show? */
const detailShows = (cam) => 1000 * cam.k > DETAIL_KM_PX;

// Rings smaller than this on the finished canvas are skipped. At world scale a
// country dataset is mostly islets nobody can see, and each one is still a
// path, a fill and a rasterizer pass.
const MIN_RING_PX = 0.4;

// …and the same judgement applied one level down, to the points inside a ring
// that is worth drawing: a step shorter than this on the finished canvas is
// dropped rather than turned into a `lineTo`.
//
// The boundaries here are national-survey geometry, whose whole point is being
// exact at a scale nothing on screen is. "Borders inside" is the case that made
// this matter — it draws every admin-1 unit the frame reaches rather than only
// the lit ones, so a European frame is a few hundred thousand points, and the
// preview rebuilds that path on every frame of a drag because the camera it is
// projected through has moved. At a preview's ~600 px that was a slideshow.
//
// Measured against the last point actually emitted, so the drawn line never
// wanders further than this from the true one — the error is bounded by the
// threshold rather than accumulating along a slow curve. And it scales with the
// picture by construction: a poster keeps the vertices a poster can resolve, and
// drops the ones it cannot, which is a thing no fixed simplification can do.
const MIN_STEP_PX = 0.35;

/**
 * Ready-made palettes. Each is a complete answer — background, land, the line
 * around it, the caption and the visited wash — because those five have to be
 * picked against each other, and a dialog of five independent colour wells is a
 * machine for making an unreadable poster. Every one of them can still be
 * overridden.
 *
 * **The four under the wash are all quiet, and that is the constraint rather
 * than a taste.** The subject of the picture is the visited wash; anything under
 * it competing for the same attention turns the poster into two maps arguing. So
 * `background`, `land` and `edge` are each a near-neutral or a single
 * desaturated tone, and the distance between `background` and `land` is small —
 * enough to read as *there is ground there*, never enough to read as data.
 *
 * `accent` is the exception, and the reason the rest hold back. It is the only
 * saturated colour on the page, and it is chosen by three rules:
 *
 * - **Against the temperature of the ground.** Warm paper takes a cool or deep
 *   ink (Prussian blue on cream, verdigris on a sepia atlas); a cool or dark
 *   ground takes a warm luminous one (gold on navy, sand on cyanotype). The wash
 *   then separates by hue as well as by lightness, which is what stops it
 *   reading as a darker patch of land.
 * - **Past 3:1 against `land`.** The wash is a large shape rather than type, so
 *   that is the honest threshold; most are well past it. Pinned by
 *   `scripts/test/export-image.mjs`, because it is not visible from the hex.
 * - **One hue each.** Twelve looks that all resolved to gold would be one look.
 *
 * The other rule is that `land` is not always the lighter of the two. `chart`
 * inverts it deliberately, the way a sea chart does: pale water, paler land, and
 * the coastline legible because those two are close rather than because they are
 * far apart.
 *
 * Order is the order they appear in the dialog — the three that were here first,
 * then the lights, then the darks, then the one that is not a colour at all.
 */
export const PALETTES = {
  // Navy and gold, which is the oldest answer there is to "one warm thing on a
  // deep blue field" — and the warm end of the wash is what keeps the map from
  // reading as more night sky.
  night: {
    label: 'Night',
    background: '#0b0d14',
    land: '#1b2030',
    edge: '#38405a',
    text: '#ffffff',
    accent: '#f0b429',
  },
  // Prussian blue on cream: the colour that was actually in the pen. Cream with
  // a terracotta wash is the other obvious pairing and a far more tired one.
  paper: {
    label: 'Paper',
    background: '#f4f1ea',
    land: '#e2ddd1',
    edge: '#b9b2a2',
    text: '#1a1a1a',
    accent: '#134b70',
  },
  // Cool grey and white take a carmine, for the same reason a Swiss poster does:
  // on a ground with no warmth in it at all, one deep red is the whole design.
  slate: {
    label: 'Slate',
    background: '#e8eaef',
    land: '#ffffff',
    edge: '#c2c8d4',
    text: '#141821',
    accent: '#ae2b46',
  },
  // An old atlas: paper that has gone brown and ink that was never black. The
  // wash is verdigris — oxidised copper is what went green on plates this old.
  sepia: {
    label: 'Sepia',
    background: '#efe4cf',
    land: '#e0cfae',
    edge: '#a89069',
    text: '#3b2c1b',
    accent: '#26645a',
  },
  // A sea chart, and the one palette whose land is lighter than its background.
  // Magenta because that is the overprint colour a real chart uses for the
  // things that are not the sea floor.
  chart: {
    label: 'Chart',
    background: '#d9e7ef',
    land: '#f7f2e4',
    edge: '#87a6b6',
    text: '#1d3441',
    accent: '#b83367',
  },
  // No colour at all under the wash, for the case where it should be the only
  // hue on the page — and for a printer that is going to make this decision
  // anyway. So the wash is the loudest blue here: one flat pigment on newsprint.
  ink: {
    label: 'Ink',
    background: '#fafafa',
    land: '#e8e8e8',
    edge: '#8f8f8f',
    text: '#111111',
    accent: '#1f3ea6',
  },
  // Night's neutral twin: the same picture with the blue taken out of it. Jade
  // rather than gold, so the two do not arrive as the same poster twice.
  carbon: {
    label: 'Carbon',
    background: '#101010',
    land: '#1e1e1e',
    edge: '#3d3d3d',
    text: '#f2f2f2',
    accent: '#3ecb98',
  },
  // Cyanotype. The one dark palette with a hue you would name, and the wash is
  // the warm sand a blueprint never has in it.
  blueprint: {
    label: 'Blueprint',
    background: '#0e253c',
    land: '#173653',
    edge: '#3d6f9e',
    text: '#dceaf7',
    accent: '#e1b57f',
  },
  // Deep green and a dusty rose, which is the pairing that stops a forest-dark
  // poster reading as camouflage. The rose is muted on purpose: at full chroma
  // it stops being antique and starts being sugar.
  moss: {
    label: 'Moss',
    background: '#0d1712',
    land: '#182a20',
    edge: '#314c3b',
    text: '#e6f0e8',
    accent: '#cb7f8a',
  },
  // Aubergine and citron. The complement of a violet this deep is a yellow-green
  // that would be unbearable anywhere else and is the whole point here.
  plum: {
    label: 'Plum',
    background: '#160f1e',
    land: '#251a33',
    edge: '#453257',
    text: '#f0e8f7',
    accent: '#bec96a',
  },
  // The one palette named after a light source, so the wash is the light: warm
  // on warm, separated by how much brighter it is rather than by hue.
  ember: {
    label: 'Ember',
    background: '#180f0a',
    land: '#2a1a12',
    edge: '#563325',
    text: '#f7e9e2',
    accent: '#e8783f',
  },
  // The accent that cannot see its ground: this one is dropped onto a slide, a
  // photograph, anything. #8a5cd6 sits at the lightness where white and black
  // are exactly as far away as each other (4.6:1 both ways), which is the most a
  // colour can promise when it does not know what it will land on.
  none: {
    label: 'Transparent',
    background: 'transparent',
    land: '#8e97ad33',
    edge: '#8e97ad66',
    text: '#ffffff',
    accent: '#8a5cd6',
  },
};

/**
 * The swatch rows the export's colour pickers offer, by what the colour is for.
 *
 * The map has one colour and one row of ten bright ones, which is right for a
 * wash you read a map through and useless here: nothing in that row is a text
 * colour, and picking type out of a hue wheel is how a poster ends up with
 * #000000 type on #FFFFFF paper. These are the values that actually look
 * composed together — near-blacks that are not black, papers that are not
 * white, and a set of inks with some warmth in them.
 */
export const SWATCH_PRESETS = {
  // The visited wash. The map's own row, because it is the same decision.
  accent: [
    '#60acff', '#7c8cff', '#b98cff', '#ff7ab8', '#ff7a6b',
    '#ff9f43', '#ffd25c', '#8fd14f', '#3ecf8e', '#2fd4c8',
  ],
  // Type, and the halo behind it. Never pure black — #1a1a1a is the one that
  // reads as ink rather than as a hole in the page.
  ink: [
    '#1a1a1a', '#2b2b2b', '#0f172a', '#26303f', '#4b5563',
    '#8a8a8a', '#d6d3cc', '#f4f1ea', '#ffffff', '#00000000',
  ],
  // Paper, land, and the line around it: the tones a map is printed on.
  surface: [
    '#0b0d14', '#12141c', '#1b2030', '#2f3547', '#38405a',
    '#8e97ad', '#c2c8d4', '#e2ddd1', '#f4f1ea', '#ffffff',
  ],
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

// Where the caption block ended up, per canvas, so the dialog can work out
// whether a press landed on the text.
//
// Held here rather than recomputed by the UI because working it out means
// measuring the text, which means the font, the fit-shrink and a canvas context
// — the whole of drawCaption. A second implementation of that would agree with
// this one until the day somebody changed one of them.
//
// Keyed by canvas so the preview and the full-size render cannot overwrite each
// other's answer; weak so neither keeps a canvas alive.
const captionRects = new WeakMap();

/** Where the caption was last drawn on this canvas, in its pixels, or null. */
export const captionRectOf = (canvas) => captionRects.get(canvas) ?? null;

/**
 * The caption's place, as the anchor decides it and the drag moves it.
 *
 * `nudge` is a fraction of the canvas rather than pixels, so a caption dragged
 * into place on a 1080px preview is in the same place on a 5,760px export — the
 * one property that makes dragging a preview mean anything at all.
 *
 * It is a nudge *from the anchor* rather than an absolute position because the
 * anchor still has a job after the drag: it is what the block is measured from,
 * so a caption pinned bottom-right stays bottom-right when the shape changes
 * from a square to a wide one, carrying its offset with it.
 */
export function captionPlace(caption, size, blockW, blockH, margin) {
  const [vert, horiz] = String(caption.anchor ?? 'bottom-left').split('-');
  const baseX =
    horiz === 'left' ? margin
    : horiz === 'right' ? size.w - margin - blockW
    : (size.w - blockW) / 2;
  const baseY =
    vert === 'top' ? margin
    : vert === 'bottom' ? size.h - margin - blockH
    : (size.h - blockH) / 2;
  const nx = Number(caption.nudge?.x) || 0;
  const ny = Number(caption.nudge?.y) || 0;
  // Held inside the canvas, not inside the margin: the margin is where the
  // anchors put things, and a caption somebody dragged has left that behind on
  // purpose. Off the edge entirely is the one place it must not go, because
  // there is no gesture that brings back something you cannot see.
  return {
    x: Math.max(0, Math.min(Math.max(0, size.w - blockW), baseX + nx * size.w)),
    y: Math.max(0, Math.min(Math.max(0, size.h - blockH), baseY + ny * size.h)),
  };
}

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
  { key: 'streak', label: 'Days recorded in a row', value: (n) => (n.streakDays ? asDays(n.streakDays) : null) },
  { key: 'cells', label: 'Places', value: (n) => (n.cells ? asCount(n.cells) : null) },
  { key: 'world', label: 'Share of the world', value: (n) => (n.worldPct ? formatPct(n.worldPct) : null) },
];

/** The defaults a fresh dialog opens on. */
export const DEFAULT_SPEC = {
  shape: 'vertical',
  preset: '4x5',
  scale: 1,
  // A size typed rather than picked. Bypasses the multiplier — if you named the
  // pixels, there is nothing left for a quality setting to say.
  custom: false,
  customW: 1080,
  customH: 1350,
  scope: { kind: 'world', ids: [] },
  // Set once the preview has been dragged or zoomed: { cx, cy, zoom }. Not
  // remembered between sessions, because it is a framing of one selection.
  view: null,
  // Regions, one colour, on paper. Regions rather than blobs is where this still
  // parts company with the *map*, and deliberately so: the map opens on blobs
  // because it is a thing you read and edit at every zoom, while blobs at poster
  // scale are a soft wash that says "somewhere around here" where regions have
  // edges you can name. Paper rather than night for the same kind of reason —
  // the commonest thing done with the result is to put it on a wall.
  //
  // The wash used to default to *Most visited*, on the argument that a flat one
  // throws away how often you went. It does, and a poster is the wrong place to
  // spend that: a heat ramp is seven colours the paper had no say in, and it
  // overrules the one colour the look was built around. The ramps are one press
  // away and the legend explains them; the picture you get without pressing
  // anything is now a shape in a colour chosen against the paper it is on.
  //
  // These apply only to a dialog with nothing remembered — `export-ui.js` reads
  // the saved spec over the top, so anyone who has ever changed one of these
  // keeps their own answer.
  detail: 'region',
  // A grid level, or 'auto' for the finest the picture can carry.
  cellSize: 'auto',
  colorBy: 'flat',
  // Blank means "whatever the look says", which is the answer for anyone who has
  // not picked one — see `accentOf`.
  accent: '',
  strength: 1,
  palette: 'paper',
  colors: {}, // overrides on top of the palette
  // How strongly the land around the subject is drawn, 0 = not at all…
  surroundings: 0,
  // …and how strongly the borders across it are. Separate, because "which one
  // is Germany" and "is there anything there at all" are separate questions.
  borders: 0,
  // The lines the picture is made of, as one strength and a choice of which
  // borders it buys: `regions` the admin-1 ones, `countries` the national ones,
  // `both` both. The silhouette around the subject comes with all three and is
  // not a choice — it is the edge of the picture rather than a border in it.
  // These were two controls, a switch and a slider, which is the same question
  // ("how much line do you want") asked twice and answerable inconsistently: an
  // outline you could not soften beside seams you could.
  //
  // National borders are the default because they are the fewest lines that
  // still make a shape into a map, and the shape of the place is the picture.
  lines: 1,
  lineScope: 'countries',
  caption: {
    on: true,
    anchor: 'bottom-left',
    // Nothing until it is dragged, which is what makes the nine anchors still
    // the whole story for anyone who never touches the picture.
    nudge: { x: 0, y: 0 },
    align: 'left',
    fields: ['title', 'covered', 'regions', 'first'],
    title: '',
    font: 'system',
    size: 1,
    color: '',
    shadow: true,
    // Blank means "the opposite lightness to the text", which is right nearly
    // always and is the only answer that survives changing the palette.
    shadowColor: '',
    shadowStrength: 0.45,
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

// --- Boundaries good enough to print -------------------------------------------
//
// The map ships Natural Earth simplified to about a kilometre, which is right
// for a level that normally lives at z4–5 and is not right for a poster. At
// 1080 px across one country that is four pixels per vertex: coastlines come out
// as visible straight runs, and — worse — every admin-1 unit is simplified
// against *itself* rather than against its neighbours, so adjacent cantons
// overlap by slivers all along their shared borders.
//
// The app already has the answer for the map's own sharpest zoom: geoBoundaries,
// fetched per country through our own server (`loadFineRegions`, and see
// **How sharp a region is** in ARCHITECTURE.md). An export fetches the same
// thing for the countries in its picture — a handful, once, and then it is in
// memory for the map too.
//
// The country silhouette is then the *union of its own fine regions* rather than
// the coarse outline. It has to be: a sharp canton drawn inside a blunt national
// border shows the disagreement between the two datasets as a rim of land the
// cantons do not reach, and the outline stroke traces the wrong shape.

/** The ISO3 code the region dataset files a country under, or null. */
export const isoOf = countryIso;

/**
 * Whether this render draws from the detailed boundaries — set once per render
 * by `renderExport`.
 *
 * It used to mean *is every country in the frame already sharp*, and that is a
 * question nothing can answer yes to. Hungary can never be sharp (its detailed
 * set pairs 11 of our 43 regions and the rest would seam, so `loadFineRegions`
 * correctly keeps the overview one), and a frame around Bern contains Hungary.
 * One such country anywhere in the picture held the whole picture back, so the
 * subject was drawn from the overview set — the one that opens a bay along every
 * border two of its regions share. Waiting for perfect uniformity bought a
 * guaranteed defect.
 *
 * What it means now is *has the fetch taken responsibility for this frame*: the
 * scale is one where the detail shows, and the frame is small enough that
 * `ensureSharpBoundaries` asked for all of it. Both are decided from the camera,
 * so this and the fetch cannot drift apart. Everything then draws at the best
 * resolution it has, and a country that will never have one — Hungary, and a
 * handful of others — carries the seam at its own border instead of exporting it
 * to the rest of the map.
 *
 * A module-level flag because `renderExport` is synchronous start to finish, so
 * nothing can interleave with it, and threading a boolean through nine drawing
 * functions would say less than this comment does.
 */
let frameSharp = true;

/**
 * A country's outline at the best resolution in memory — its detailed regions
 * dissolved and trimmed back to the country proper, or the shipped outline.
 *
 * The trim is not optional: the region dataset keeps overseas territories on
 * purpose and `countries.json` does not, so an untrimmed dissolve puts French
 * Guiana back into the shape of France. See `fineCountryOutline`.
 */
const sharpCountryGeometry = (name) => fineCountryOutline(countryIso(name));

/** …and the same, held back when this frame is not one the fetch covered. */
const fineCountryGeometry = (name) => (frameSharp ? sharpCountryGeometry(name) : null);

/**
 * The bounding boxes of a country's *pieces*, cached by name.
 *
 * One box around the whole country is the wrong question to ask of a frame.
 * Russia's spans every longitude there is, so a picture of the ground around
 * Bern contained Russia; France's reaches Guyane and the Pacific. Both then
 * counted against `FINE_COUNTRY_LIMIT` for a frame neither is in.
 */
const pieceBoxes = new Map();
function boxesOf(c) {
  let boxes = pieceBoxes.get(c.id);
  if (boxes) return boxes;
  boxes = [];
  const g = c.geometry;
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.coordinates ?? [];
  for (const rings of polys) {
    const outer = rings?.[0];
    if (!outer?.length) continue;
    let w = 180; let s = 90; let e = -180; let n = -90;
    for (const [x, y] of outer) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    boxes.push([w, s, e, n]);
  }
  pieceBoxes.set(c.id, boxes);
  return boxes;
}

/** Does any piece of this country fall inside `[w, s, e, n]`? */
function inFrame(c, [w, s, e, n]) {
  const [cw, cs, ce, cn] = c.bbox;
  if (ce < w || cw > e || cn < s || cs > n) return false;
  return boxesOf(c).some((b) => !(b[2] < w || b[0] > e || b[3] < s || b[1] > n));
}

/**
 * The lon/lat rectangle a camera shows, or null if it straddles the antimeridian
 * — which is a frame spanning most of the world, and not a scale at which any of
 * this is visible.
 */
function frameBox(cam) {
  const [w, s] = lngLatAt(cam, 0, cam.h);
  const [e, n] = lngLatAt(cam, cam.w, 0);
  return w < e ? [w, s, e, n] : null;
}

/**
 * Is this frame one the detailed boundaries were fetched for?
 *
 * The same list `ensureSharpBoundaries` works from, against the same limit, so
 * the render cannot refuse to draw what the fetch collected.
 *
 * The file answers yes at any scale the detail shows at, because it fetches
 * every country in its frame before it draws (`all: true`). Only the preview is
 * bounded, which is the trade the limit was always making — a picture being
 * framed can be blunt; a picture being written is the thing itself.
 */
function frameIsSharp(spec, data, cam) {
  if (!regionsLoaded() || !detailShows(cam)) return false;
  if (!cam.preview) return true;
  return boundaryIsos(spec, data, cam).size <= FINE_COUNTRY_LIMIT;
}

/**
 * One selected area's outline, at the best resolution in memory — and never held
 * back by `frameSharp`. This is the *subject*: `ensureSharpBoundaries` always
 * asks for the scope's own countries before anything else, so it is the one
 * shape that is reliably sharp, and blunting it because a neighbour drawn at 30%
 * behind it has not arrived would be the tail wagging the dog. It is also read
 * by `frameOf`, which runs before there is a frame to judge.
 */
export function scopeGeometry(kind, id) {
  if (kind === 'continent') return continentGeometry(id);
  if (kind === 'country') return sharpCountryGeometry(id) ?? countryGeometry(id);
  // The region level stands a country in for itself where the admin-1 dataset
  // does not subdivide it (see WHOLE_COUNTRY in src/stats.js), and those ids
  // reach this far.
  if (String(id).startsWith(WHOLE_COUNTRY)) {
    const country = String(id).slice(WHOLE_COUNTRY.length);
    return sharpCountryGeometry(country) ?? countryGeometry(country);
  }
  return regionGeometry(id, true);
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

/** The country a region belongs to, for the list — nothing else has one. */
export const scopeCountryOf = (kind, id) =>
  (kind === 'region' ? regionById(id)?.country ?? null : null);

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
      country: scopeCountryOf(kind, id),
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
      const [L, col, row] = parseCellId(id);
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

/**
 * The largest box of a given aspect ratio that fits inside `availW`×`availH`.
 *
 * Two lines, and here rather than in CSS because `aspect-ratio` will not do it:
 * with a definite height and `max-width: 100%` a ratio wider than its container
 * has its width clamped and its height left alone, which is how a 21:9 export
 * came out squashed into the height of a 4:5 one. Shared by the dialog's two
 * layouts — beside the controls both bounds are measurements, stacked above them
 * the height is a cap (see fitFrame in src/export-ui.js).
 */
export function fitBox(ratio, availW, availH) {
  const w = availW;
  const h = w / ratio;
  return h > availH ? { w: availH * ratio, h: availH } : { w, h };
}

/**
 * The camera the picture is actually drawn with: the fitted one, unless the
 * preview has been dragged or zoomed.
 *
 * The override is stored as a Mercator centre and a *multiple* of the fitted
 * scale rather than as an absolute one, so the framing you chose survives
 * switching from a 4:5 post to a 16:9 slide — and survives the preview being
 * drawn at a third of the size of the file, which is the same problem in
 * miniature.
 */
export function cameraFor(spec, frame, size) {
  const fitted = fitCamera(frame, size);
  const v = spec?.view;
  if (!v || !Number.isFinite(v.cx) || !Number.isFinite(v.cy) || !(v.zoom > 0)) return fitted;
  const k = fitted.k * v.zoom;
  return { k, x0: v.cx - size.w / 2 / k, y0: v.cy + size.h / 2 / k, w: size.w, h: size.h };
}

/**
 * The frame a spec would be fitted to, before any dragging. The dialog needs it
 * to work out what a drag means and to put the view back.
 */
export function frameOf(spec, data) {
  const scope = settleScope(spec.scope);
  const geoms = scope.kind === 'world'
    ? []
    : scope.ids.map((id) => scopeGeometry(scope.kind, id)).filter(Boolean);
  return frameFor(geoms, data.cells());
}

/**
 * Which land the picture is a picture of.
 *
 * At the sharp outline wherever it has been fetched, like every other country
 * shape in this file. This was the one that took `c.geometry` flat, and it is
 * the shape "Draw the outline" strokes — so on a picture of everywhere, the
 * silhouette of the world came out at the overview set's ~1 km simplification
 * while the borders drawn *on top of it* were the national survey's. A coastline
 * in visible straight runs, under a border that followed every inlet.
 *
 * `scopeGeometry` already does this for a picture of somewhere in particular,
 * which is why the two disagreed depending on what was selected.
 */
const landGeoms = (scope, geoms) =>
  (scope.kind === 'world'
    ? allCountries().map((c) => fineCountryGeometry(c.id) ?? c.geometry)
    : geoms);

/** Where a point on the canvas is, in the world. */
export function lngLatAt(cam, px, py) {
  const x = cam.x0 + px / cam.k;
  const y = cam.y0 - py / cam.k;
  return [((lngOf(x) + 180) % 360 + 360) % 360 - 180, latOf(Math.max(-MAX_MERC_Y, Math.min(MAX_MERC_Y, y)))];
}

/**
 * The area of `kind` under a point — what a click on the preview picks.
 *
 * Straight through to the same lookup the coverage sweep uses, rather than a
 * second set of point-in-polygon rules: clicking a canton and having a cell in
 * that canton must resolve to the same canton, or the picture and its caption
 * are talking about different places.
 */
export const pickAt = (kind, lng, lat) => areaAtPoint(kind, lng, lat);

/** The Mercator rectangle a camera actually shows. */
const cameraRect = (cam) => ({
  xMin: cam.x0,
  xMax: cam.x0 + cam.w / cam.k,
  yMin: cam.y0 - cam.h / cam.k,
  yMax: cam.y0,
});

/**
 * Which grid level the blobs are drawn at.
 *
 * `pinned` is a level, not an adjustment. It used to be an offset from whatever
 * the frame could carry — which meant the *base* moved as you zoomed, so a cell
 * size you had chosen quietly changed size under you. A setting called "cell
 * size" has to name a size.
 *
 * A level pinned finer than the picture can really draw is still drawn: the
 * sheet floors a cell at MIN_CELL_PX rather than letting the level-set cut erase
 * it, which is the same bargain the map makes for a pinned Detail level. Auto
 * takes the finest level whose cells are honestly that size.
 */
export function blobLevelFor(k, pinned = null) {
  if (Number.isFinite(pinned)) return Math.max(0, Math.min(MAX_LEVEL, Math.round(pinned)));
  let L = 0;
  while (L < MAX_LEVEL && radiusOf(L) * k < MIN_BLOB_PX) L++;
  return L;
}

/**
 * The cell sizes on offer, named by the ground they cover rather than by an
 * adjective: "8 km" is a fact about the grid and "Medium" is a fact about the
 * list it appears in. Flat-to-flat at the equator, which is how the grid is
 * described everywhere else (a Mercator cell shrinks with latitude).
 */
export const CELL_SIZES = [
  { key: 'auto', label: 'Auto — fits the picture' },
  ...Array.from({ length: MAX_LEVEL + 1 }, (_, L) => {
    const km = (SQRT3 * radiusOf(L)) / 1000;
    return { key: L, label: km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km` };
  }),
];

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
    // Sized before it is unwrapped, not after: the test below throws most
    // shapes away, and `unwrapRing` would have copied every point of each one
    // first. At world scale most of a country dataset is islets of a fraction
    // of a pixel.
    //
    // And sized in degrees, projecting four numbers at the end rather than
    // every point in order to compare it. `mercX` is a multiply, but `mercY` is
    // a sine and an arctanh, and this pass runs over every point of every shape
    // in the frame before a single one is drawn.
    let lng0 = Infinity;
    let lng1 = -Infinity;
    let lat0 = Infinity;
    let lat1 = -Infinity;
    // Whether this ring is one of the few that wrap past ±180°, which is the
    // only reason `unwrapRing` exists. Answered in the pass that is happening
    // anyway, because the answer decides whether to copy the ring at all.
    let crosses = false;
    const outer = poly[0];
    for (let i = 0; i < outer.length; i++) {
      const lng = outer[i][0];
      const lat = outer[i][1];
      if (i > 0 && Math.abs(lng - outer[i - 1][0]) > 180) crosses = true;
      if (lng < lng0) lng0 = lng;
      if (lng > lng1) lng1 = lng;
      if (lat < lat0) lat0 = lat;
      if (lat > lat1) lat1 = lat;
    }
    if (!Number.isFinite(lng0)) continue;
    // Both projections are monotonic in their argument, so the extremes of the
    // ring are the extremes of its bounds.
    let x0 = mercX(lng0);
    let x1 = mercX(lng1);
    const y0 = toMercY(lat0);
    const y1 = toMercY(lat1);
    // Too small to be a shape on this canvas. At world scale most of a country
    // dataset is islets of a fraction of a pixel, and each is still a path.
    // Skipped for a wrapping ring, whose raw bounds span the world and so say
    // nothing about its size.
    if (!crosses && (x1 - x0) * cam.k < MIN_RING_PX && (y1 - y0) * cam.k < MIN_RING_PX) continue;
    // Unwrapping shifts longitude only, so this test is sound either way.
    if (y1 < view.yMin || y0 > view.yMax) continue;

    // The copy, and only where the seam makes it necessary.
    //
    // `unwrapRing` allocates a fresh pair for every point it is handed, so at
    // world scale with the borders on it was two allocations per point across a
    // couple of hundred thousand of them, on every frame of a drag — which the
    // collector then had to take back. Almost no ring on Earth crosses the
    // antimeridian, and the ones that do are known by the time we get here, so
    // everything else is read straight out of the dataset.
    let rings = poly;
    if (crosses) {
      rings = poly.map(unwrapRing);
      x0 = Infinity;
      x1 = -Infinity;
      for (const [lng] of rings[0]) {
        const x = mercX(lng);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }

    // **One copy, and only one.** The world repeats every WORLD metres, and a
    // map draws every repeat that reaches the screen — which is right for a map
    // you pan, and wrong for a picture. Zoom out far enough to fit the globe
    // vertically and a 16:9 frame is 1.8 worlds wide, so the Americas appeared
    // twice with New Zealand tucked in beside Alaska. A picture of the Earth has
    // one Earth in it; past that the frame is empty, which is the honest answer.
    //
    // Which copy: the one that lands nearest the middle of the view. For any
    // frame narrower than the world this is the same copy the old loop found,
    // seam-straddling frames included — there was only ever one candidate.
    const dx = Math.round(((view.xMin + view.xMax) / 2 - (x0 + x1) / 2) / WORLD) * WORLD;
    if (x1 + dx < view.xMin || x0 + dx > view.xMax) continue;
    // How many points this shape can possibly show, and therefore how many are
    // worth projecting. MIN_STEP_PX below already refuses to *draw* a step
    // shorter than a third of a pixel, but it has to project a point to find
    // that out — and the projection is the expensive half. A shape 80 px across
    // cannot use the 6,000 points a national survey recorded for it however the
    // line is drawn, so most of them are skipped before `mercY` ever sees them.
    //
    // **The preview only.** A stride is a guess — it drops points without
    // looking at where they were, so it can flatten a headland that MIN_STEP_PX
    // would have kept. That is a fair trade for something being dragged and no
    // trade at all for a file somebody is going to print, so the picture itself
    // is drawn from every point it has. See `cam.preview`.
    const spanPx = ((x1 - x0) + (y1 - y0)) * cam.k;
    const budget = Math.max(64, spanPx * 2);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const stride = cam.preview ? Math.max(1, Math.floor(ring.length / budget)) : 1;
      let lastX = px(mercX(ring[0][0]) + dx);
      let lastY = py(toMercY(ring[0][1]));
      path.moveTo(lastX, lastY);
      // The closing point is always taken, whatever the stride lands on, so a
      // thinned ring still ends where it began.
      for (let i = stride; i < ring.length; i += stride) {
        const at = Math.min(i, ring.length - 1);
        const x = px(mercX(ring[at][0]) + dx);
        const y = py(toMercY(ring[at][1]));
        // Sub-pixel step: the line already goes here. See MIN_STEP_PX.
        if (Math.abs(x - lastX) < MIN_STEP_PX && Math.abs(y - lastY) < MIN_STEP_PX) continue;
        path.lineTo(x, y);
        lastX = x;
        lastY = y;
      }
      path.closePath();
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
  if (!lines.length) {
    captionRects.delete(ctx.canvas);
    return;
  }
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

  const place = captionPlace(caption, size, blockW, blockH, m.margin);
  const blockX = place.x;
  let y = place.y;
  // Recorded before the text is painted, so what the dialog hit-tests is the
  // block that was actually drawn — after the fit-shrink above, which is the
  // step that makes a measured guess wrong.
  captionRects.set(ctx.canvas, { x: blockX, y: place.y, w: blockW, h: blockH });

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (caption.shadow) {
    // A caption sits over whatever the map put underneath it, which on a
    // transparent export is nothing at all and on a busy one is a heat map.
    //
    // It follows the text rather than always being black: dark type on a pale
    // palette with a black shadow under it does not separate from anything, it
    // just looks smudged. Light type wants a dark halo and dark type wants a
    // pale one, which is the same rule either way — a shadow the opposite
    // lightness to the thing it is holding up.
    const strength = Math.max(0, Math.min(1, caption.shadowStrength ?? 0.45));
    const picked = caption.shadowColor || (isLight(color) ? '#000000' : '#ffffff');
    ctx.shadowColor = withAlpha(picked, strength);
    ctx.shadowBlur = Math.round(m.body * 0.55);
    ctx.shadowOffsetY = Math.round(m.body * 0.06);
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

/** Is this colour nearer white than black? Rec. 601 luma, which is plenty. */
export function isLightColor(color) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(color).trim());
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}
const isLight = isLightColor;

/**
 * How strongly each kind of line is drawn — 0 for not at all.
 *
 * The silhouette is always at the slider's own strength. It is the edge of the
 * picture rather than a border in it: what the mask cut the subject out along,
 * and the one line whose absence reads as unfinished rather than as a choice.
 * The selector chooses which *borders* go inside it — the region ones, the
 * national ones, or both.
 *
 * A blob has no borders to draw, so at that detail the selector goes and the
 * slider means the only line there is.
 */
export function lineAlphas(spec) {
  const a = Math.max(0, Math.min(1, spec?.lines ?? 0));
  const which = spec?.detail === 'blob' ? 'none' : (spec?.lineScope ?? 'countries');
  return {
    outline: a,
    regions: which === 'regions' || which === 'both' ? a : 0,
    countries: which === 'countries' || which === 'both' ? a : 0,
  };
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

/**
 * The colour the visited wash is painted in: the one that was picked, or the one
 * the look came with.
 *
 * Blank rather than absent is the whole point — it is the same arrangement the
 * caption's shadow uses. An empty `accent` means "whatever the look says", so
 * every look changes the wash as it is chosen, and a colour picked by hand
 * survives changing everything else about the picture until a look is chosen
 * again. A spec cannot hold both answers at once, so it holds the override and
 * resolves the default here.
 */
export function accentOf(spec) {
  return spec?.accent || paletteOf(spec ?? {}).accent || PALETTES.night.accent;
}

/** The pixel size a spec asks for. */
/** The preset a spec names, or the first of its family. */
export function presetOf(spec) {
  const shape = SHAPES[spec?.shape] ?? SHAPES.vertical;
  return shape.presets.find((p) => p.key === spec?.preset) ?? shape.presets[0];
}

/**
 * The pixel size a spec asks for, clamped to what a canvas will actually hand
 * back. `clamped` says whether it had to be — the dialog shows the number it
 * will really produce, because a size control that lies is worse than one that
 * offers less.
 *
 * A custom size is taken literally: if you typed the pixels you wanted, the
 * quality multiplier has nothing left to say.
 */
export function sizeOf(spec) {
  let w;
  let h;
  if (spec?.custom) {
    w = Math.round(Number(spec.customW) || 0);
    h = Math.round(Number(spec.customH) || 0);
    if (!(w > 0) || !(h > 0)) ({ w, h } = presetOf(spec));
  } else {
    const preset = presetOf(spec);
    const scale = SCALES.includes(spec?.scale) ? spec.scale : 1;
    w = preset.w * scale;
    h = preset.h * scale;
  }
  w = Math.max(120, Math.min(MAX_SIDE_PX, w));
  h = Math.max(120, Math.min(MAX_SIDE_PX, h));
  const over = (w * h) / MAX_PIXELS;
  if (over <= 1) return { w, h, clamped: false };
  // Shrink both sides by the same factor, so a clamp changes the file's size
  // and never its proportions.
  const k = Math.sqrt(1 / over);
  return { w: Math.max(120, Math.round(w * k)), h: Math.max(120, Math.round(h * k)), clamped: true };
}

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
 *   `{ cells(), meta(), rollUp(mode), areaFC(kind, mode, fine), areaOf(kind, cellId) }`
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
  const cam = cameraFor(spec, frame, size);
  // Whether this canvas is the picture or a stand-in for it. The dialog draws
  // the preview at `previewSize()` and the file at the spec's own size, so a
  // canvas narrower than the spec asks for is the one being dragged around.
  //
  // Only the preview is allowed to thin anything (see the stride in
  // addGeometry). Deciding that from the camera scale instead was wrong in a way
  // that took a rendered poster to see: a 1080-pixel picture of a few regions
  // gives each of them several hundred pixels, and several hundred pixels looks
  // like plenty of budget right up until you compare it with the four thousand
  // points a national survey recorded for one canton. The exported file came out
  // visibly polygonal.
  //
  // Read before frameSharp, which asks it: only the preview is bounded.
  cam.preview = size.w < sizeOf(spec).w;
  // Before anything is drawn from a boundary. See frameSharp.
  frameSharp = frameIsSharp(spec, data, cam);

  // The rest of the world, if it was asked for: everything the frame reaches,
  // dimmer than the subject. It is off by default because the point of the cut
  // is the cut — but a canton floating in a void is hard to place, and one grey
  // outline of the country around it is the difference between a shape and a
  // map.
  //
  // How much dimmer is a control rather than a constant, because the right
  // answer depends entirely on how much of the frame the subject occupies. A
  // continent leaves a thin rim of neighbours and wants them faint; one canton
  // leaves the whole frame, and at the same setting reads as a shape floating
  // in nothing.
  // Two settings, because they are two things. The *land* around the subject
  // places it on a continent; the *borders* say which country each piece of that
  // land is. Wanting one without the other is not an edge case — borders alone
  // over the background is a good-looking map, and so is undifferentiated land
  // with no lines on it — and tying them to one slider meant you could have
  // neither.
  const restAlpha = Math.max(0, Math.min(1, spec.surroundings ?? 0));
  const borderAlpha = Math.max(0, Math.min(1, spec.borders ?? 0));
  if (restAlpha > 0.001 || borderAlpha > 0.001) {
    // One path per country rather than one for all of them, so each can carry
    // its own border — and at the sharp outline wherever that has been fetched,
    // or a blunt national border cuts visibly across the detailed region fills
    // on the other side of it.
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.6, size.h * 0.0011);
    ctx.fillStyle = withAlpha(palette.land, restAlpha);
    ctx.strokeStyle = withAlpha(palette.edge, borderAlpha);
    for (const c of allCountries()) {
      const path = new Path2D();
      addGeometry(path, fineCountryGeometry(c.id) ?? c.geometry, cam);
      if (restAlpha > 0.001) ctx.fill(path, 'evenodd');
      if (borderAlpha > 0.001) ctx.stroke(path);
    }
  }

  // The subject: the selection's own silhouette, or every country when the
  // subject is everywhere.
  const land = pathOf(landGeoms(scope, geoms), cam);
  ctx.fillStyle = palette.land;
  ctx.fill(land, 'evenodd');

  // Everything you have been is painted inside that silhouette and nowhere
  // else. `clip` is the whole feature: the boundaries the app already has are
  // what cut the picture out.
  ctx.save();
  ctx.clip(land, 'evenodd');
  drawVisited(ctx, spec, data, cam, size);
  // …and the lines between the pieces the subject is made of, over the top of
  // it. Inside the same clip, because these are the subject's own divisions and
  // not a second map drawn around it.
  drawDivisions(ctx, spec, cam, size, palette);
  ctx.restore();

  // The silhouette, last, over everything it encloses. At full strength this is
  // the flat edge colour — the same line it always was — and below it fades,
  // which is the half of this control that used to be a switch.
  const outlineAlpha = lineAlphas(spec).outline;
  if (outlineAlpha > 0.001) {
    ctx.strokeStyle = withAlpha(palette.edge, outlineAlpha);
    ctx.lineWidth = Math.max(1, size.h * 0.0016);
    ctx.lineJoin = 'round';
    ctx.stroke(land);
  }

  drawCaption(ctx, captionLines(caption, numbers), caption, size, caption.color || palette.text);
  return canvas;
}

// The layer the area fills are composed on before they reach the picture. See
// drawVisited.
let overlay = null;

/**
 * The visited ground, at whichever generalisation was asked for.
 *
 * **Drawn opaque onto a layer of its own and composited once.** Setting
 * `globalAlpha` and then filling region after region looks identical right up
 * until two of them overlap — and the boundary datasets overlap constantly,
 * because each unit is simplified against itself rather than against its
 * neighbours. Every sliver where two cantons disagree got painted twice and
 * came out darker, which reads as a drop shadow along one edge of every region
 * on the map. It is not a shadow; it is the same colour applied twice. One
 * composite at the end makes an overlap indistinguishable from the ground it
 * overlaps, which is what it is.
 */
function drawVisited(ctx, spec, data, cam, size) {
  const strength = Math.max(0, Math.min(1, spec.strength ?? 1));
  if (strength <= 0) return;

  if (spec.detail === 'blob') {
    // The blob sheet is already one image — its own pipeline resolved every
    // overlap before it got here — so it can go straight on.
    ctx.globalAlpha = strength;
    drawBlobs(ctx, spec, data, cam, size);
    ctx.globalAlpha = 1;
    return;
  }

  if (strength >= 0.999) {
    drawAreas(ctx, spec, data, cam);
    return;
  }
  if (!overlay) overlay = document.createElement('canvas');
  overlay.width = size.w;
  overlay.height = size.h;
  drawAreas(overlay.getContext('2d'), spec, data, cam);
  ctx.globalAlpha = strength;
  ctx.drawImage(overlay, 0, 0);
  ctx.globalAlpha = 1;
}

// One set of scratch canvases for the whole module. There is only ever one
// export being drawn, and the preview redraws on every drag of the strength
// slider — allocating three multi-megapixel canvases per frame is how a smooth
// control becomes a stuttering one.
let blobBuffers = null;

function drawBlobs(ctx, spec, data, cam, size) {
  const level = blobLevelFor(cam.k, Number.isFinite(spec.cellSize) ? spec.cellSize : null);
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
    colorOf: cellColorOf(spec.colorBy, accentOf(spec), litRange[level] ?? {}),
    heat: isHeatMode(spec.colorBy),
    // The map's own rim settings are deliberately not used — see BLOB_RIM.
    edge: BLOB_RIM,
    featherPx: BLOB_RIM_FEATHER_PX,
    pxPerMerc: cam.k,
    // The canvas is the cap. Nothing is gained by rendering the sheet larger
    // than the picture, and the map's own cap is set for a viewport rather than
    // for a poster.
    maxSide: Math.max(size.w, size.h),
    // The map bounds the sheet's *area* as well, because on a browser with no
    // canvas `filter` it repaints on every level change and pays six CPU passes
    // per pixel. A picture is painted once and then looked at for a long time,
    // so it buys the pixels and `maxSide` above is the only cap it wants.
    maxPixels: Infinity,
    featherScale: size.h / FEATHER_REF_PX,
    maxFeatherCells: MAX_FEATHER_CELLS,
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
  const fc = data.areaFC(spec.detail, spec.colorBy, frameSharp);
  const colorOf = areaColorOf(spec.colorBy, accentOf(spec));
  const flat = !isHeatMode(spec.colorBy);
  // Two neighbouring fills that share an edge do not meet on it: each is
  // antialiased against nothing, so half a pixel of background survives between
  // them and every border comes out as a pale hairline. Stroking each shape in
  // its own colour closes the shape over its own edge. Half a pixel wide,
  // because the point is to cover the seam and not to grow the region.
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.7;
  for (const f of fc.features ?? []) {
    // k=1 is a fill; k=2 is the outline ring set and k=3 a continent's label,
    // and neither is what a poster wants under its own outline.
    if (f.properties?.k !== 1 || !f.geometry) continue;
    const color = flat ? hexOpaque(accentOf(spec)) : colorOf(Number(f.properties.v ?? 0));
    const path = pathOf([f.geometry], cam);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.fill(path, 'evenodd');
    ctx.stroke(path);
  }
}

// --- The lines inside the picture ----------------------------------------------
//
// **A solid fill is one shape, and one shape says one thing.** Colour a poster
// by regions and every canton you have been to dissolves into its neighbours —
// which is exactly right, it is what `mergeAreas` is for and it is how you read
// "this whole corner of the country" at a glance. It is also the whole of what
// the picture says. Twenty-six cantons and one flat wash over eleven of them
// carry the same ink and the same amount of information.
//
// So the divisions are a strength of their own, the way *the rest of the world*
// and *their borders* are: the seams the infill is made of, drawn back over it.
// A third slider rather than a second colour, because how loud they should be
// depends entirely on the picture — a hairline that structures a country-sized
// fill turns a poster of one canton into a diagram of it.
//
// **Every unit the frame reaches, not only the lit ones.** The empty half of the
// subject is part of the composition too, and a picture where the lines stop
// where the colour stops draws attention to the boundary of your own travel
// twice over. The clip does the cutting, as it does for everything else here.
//
// **Which units is asked, not inherited.** These followed *Detail* on the
// grounds that they were the fill's own seams — which is one good picture and
// only one. A poster coloured by region wants the national borders in it as
// often as it wants the cantonal ones, and a poster coloured by country
// sometimes wants the regions showing through faintly underneath; neither was
// reachable while the lines were whatever the fill happened to be made of. So
// the selector says regions, countries, or both, and it means those words.
// Blobs are the exception: there is nothing between two blobs, so the row is
// hidden there rather than drawing something that answers a question nobody
// asked.

/**
 * The geometries whose edges are the divisions, bounded to what the frame can
 * reach. Bbox tests before geometry: at world scale this would otherwise be a
 * path per admin-1 unit on Earth, on every drag of the slider.
 *
 * Exported for the test, which is the only way to ask "does a frame around
 * Switzerland fetch twenty-six cantons or four and a half thousand" — from a
 * canvas the answer is a picture that looks the same either way.
 */
export function divisionGeoms(detail, cam) {
  if (detail === 'continent') return allContinents().map((n) => continentGeometry(n)).filter(Boolean);
  // Nothing at all until the admin-1 set is in memory, which is a fetch away
  // when the detail has only just been switched. Falling through would give
  // every country no regions and therefore its own outline — a picture of
  // national borders under a note that says "between regions", which is worse
  // than a picture that has not finished arriving. `ensureGeography` is already
  // fetching; the next frame has them.
  if (detail === 'region' && !regionsLoaded()) return [];

  // The frame in degrees. A frame wider than half the world, or one that has
  // been slid past the seam, is asked for everything rather than being made to
  // reason about which copy a bbox is in — at that scale the cull is not what
  // is expensive and the lines are a fraction of a pixel apart anyway.
  const box = cameraRect(cam);
  let reaches = () => true;
  if (box.xMax - box.xMin < WORLD / 2) {
    const [w, s] = lngLatAt(cam, 0, cam.h);
    const [e, n] = lngLatAt(cam, cam.w, 0);
    if (w < e) reaches = (bb) => bb && bb[2] >= w && bb[0] <= e && bb[3] >= s && bb[1] <= n;
  }

  // How big a thing is on this canvas, from its bbox alone — no geometry
  // touched. A bbox that straddles the seam is taken as "big", which it is.
  const sizePx = (bb) => {
    if (!bb) return Infinity;
    const w = Math.abs(mercX(bb[2]) - mercX(bb[0]));
    const h = Math.abs(toMercY(bb[3]) - toMercY(bb[1]));
    return Math.max(w, h) * cam.k;
  };
  // A *region* smaller than this is not a shape on this canvas, and its borders
  // are not lines — they are a smear the size of the thing they enclose.
  // Skipping it here rather than inside addGeometry is the point: that test runs
  // after `unwrapRing` has already copied every point of every ring. At world
  // scale nearly all 4,553 admin-1 units are this small, which is what made
  // zooming the preview out with the borders on stop responding altogether.
  //
  // Only regions. A country under two pixels is Luxembourg, and a world map
  // without Luxembourg's border is a world map with a mistake in it — the
  // country level is the picture at that scale, where the admin-1 level is
  // noise. There are 250 countries and 4,553 regions, so it is also not where
  // the time goes.
  const MIN_REGION_PX = 6;
  // The lines and the fills have to come from the same resolution or the border
  // between two regions is ruled twice, so this is the render's own answer and
  // not a second judgement — DETAIL_KM_PX is inside it.
  const wantFine = frameSharp;

  const countries = allCountries().filter((c) => reaches(c.bbox));
  if (detail === 'country') {
    return countries.map((c) => (wantFine && fineCountryGeometry(c.id)) || c.geometry);
  }

  const out = [];
  for (const c of countries) {
    // A country the admin-1 set does not subdivide stands in for itself, which
    // is the same rule WHOLE_COUNTRY encodes for the level that colours these.
    // Without it, Luxembourg would be the one shape in the frame with no line
    // around it — which reads as a gap in the data rather than as a country
    // that is one region.
    const regions = c.iso ? regionsOf(c.iso) : [];
    if (!regions.length) out.push((wantFine && fineCountryGeometry(c.id)) || c.geometry);
    else {
      for (const r of regions) {
        if (!reaches(r.bbox) || sizePx(r.bbox) < MIN_REGION_PX) continue;
        out.push(regionGeometry(r.id, wantFine) ?? r.geometry);
      }
    }
  }
  return out;
}

function drawDivisions(ctx, spec, cam, size, palette) {
  const { regions, countries } = lineAlphas(spec);
  const alpha = Math.max(regions, countries);
  if (alpha <= 0.001) return;

  // One path for all of them rather than one per unit. Nothing here is filled
  // and every line is the same colour, so there is nothing to tell them apart
  // with — and a single stroke is one rasterizer pass instead of four thousand.
  // Shared edges are therefore drawn twice, which at a flat alpha is invisible;
  // it is `fill` that would show the overlap, and there is no fill. Which is
  // also why *both* is one stroke and not two: a country the region set does not
  // subdivide stands in for itself at that level, so its outline is in both
  // lists, and at a flat alpha nobody can tell.
  const geoms = [];
  if (regions > 0.001) geoms.push(...divisionGeoms('region', cam));
  if (countries > 0.001) geoms.push(...divisionGeoms('country', cam));
  const lines = pathOf(geoms, cam);
  ctx.strokeStyle = withAlpha(palette.edge, alpha);
  // Finer than the outline around the whole subject, which has to stay the
  // strongest line in the picture: these divide it, they do not bound it.
  ctx.lineWidth = Math.max(0.5, size.h * 0.0009);
  ctx.lineJoin = 'round';
  ctx.stroke(lines);
}

/** A filename that says what the picture is of. */
export function exportFilename(spec, numbers) {
  const base = (numbers?.names?.length ? numbers.names.join('-') : 'sporra')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base || 'sporra'}-${spec.shape}.png`;
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

/**
 * Every country whose own detailed boundaries this picture would draw from.
 *
 * One list, read by both the fetch and the render, because they are the same
 * question asked at two moments and they must not answer it differently. They
 * used to: the fetch counted the scope plus the frame, the render asked whether
 * every country in the frame was sharp, and a spec that drew no neighbours had
 * the render vetoing detail the fetch had already collected.
 *
 * Three things put another country's geometry in the picture. The area levels
 * draw every lit region in the world and let the mask do the cutting, so a
 * picture of one canton still has its neighbours' regions painted underneath the
 * clip. The surroundings draw every country the frame reaches, and so does the
 * outline when the subject is everywhere. The divisions are the same set again —
 * a blunt canton border beside a sharp one is more obvious as a line than it
 * ever was as a fill.
 */
function boundaryIsos(spec, data, cam) {
  const settled = settleScope(spec?.scope);
  const isos = new Set();

  // Whatever was picked.
  if (settled.kind !== 'world' && settled.kind !== 'continent') {
    for (const id of settled.ids) {
      const iso = settled.kind === 'country'
        ? isoOf(id)
        : regionById(id)?.iso ?? isoOf(String(id).replace(WHOLE_COUNTRY, ''));
      if (iso) isos.add(iso);
    }
  }

  const alphas = lineAlphas(spec);
  const linesInside = alphas.regions > 0.001 || alphas.countries > 0.001;
  // The outline draws a country's edge too, but only for a picture of
  // *everywhere*: that is the one case where it is traced around
  // `allCountries()`, and for any other scope it strokes the selection's own
  // shapes, which the block above has already asked for.
  const outlinesTheWorld = alphas.outline > 0.001 && settled.kind === 'world';
  const drawsEdges = linesInside || outlinesTheWorld
    || (spec?.surroundings ?? 0) > 0.001 || (spec?.borders ?? 0) > 0.001;

  // Below DETAIL_KM_PX the two resolutions are the same picture, and a frame
  // straddling the antimeridian spans most of the world. Neither is worth
  // several megabytes of national survey.
  const box = cam && detailShows(cam) ? frameBox(cam) : null;
  if (!box || !data) return isos;

  if (spec?.detail === 'region') {
    const lit = new Set();
    for (const id of data.cells()) {
      const region = data.areaOf('region', id);
      if (region) lit.add(region);
    }
    for (const { iso } of countriesInView(lit, box)) isos.add(iso);
  }
  if (drawsEdges) {
    for (const c of allCountries()) if (c.iso && inFrame(c, box)) isos.add(c.iso);
  }
  return isos;
}

/**
 * Fetch the detailed boundaries for the countries this picture is of.
 *
 * Bounded on purpose. One country, or a handful of cantons in two, is a couple
 * of requests and the thing that makes the picture worth printing. A continent
 * is fifty-odd countries of national-survey geometry, which is several megabytes
 * to fetch and a polygon union per country to dissolve — and at continent scale
 * none of it is visible anyway, because the extra vertices are a fraction of a
 * pixel apart. So detail is fetched only where it can be seen.
 *
 * Never rejects: a country nobody has boundaries for keeps the overview
 * geometry, which is what the map has always drawn.
 *
 * `all` lifts the country limit, and only the file asks for that. The limit is
 * there because the preview is redrawn while somebody drags a slider, and
 * waiting on fifty countries of national-survey geometry to answer a drag is
 * not a trade worth making — a picture being framed can be blunt. A picture
 * being *written* is the thing itself, and it is worth a few seconds and a few
 * megabytes once. Past the limit nothing is fetched, and nothing is drawn sharp
 * either (`frameIsSharp` counts the same list): a picture from one resolution
 * is the point, and half a fetch would buy the seams without the sharpness.
 *
 * @returns {Promise<boolean>} whether anything new arrived, so the caller knows
 *   to redraw
 */
export async function ensureSharpBoundaries(scope, { spec, data, size, all = false } = {}) {
  const asked = { ...(spec ?? {}), scope };
  const frame = data && size ? frameOf(asked, data) : null;
  const cam = frame ? cameraFor(asked, frame, size) : null;
  const isos = boundaryIsos(asked, data, cam);

  if (!isos.size || (!all && isos.size > FINE_COUNTRY_LIMIT)) return false;
  await loadRegions();
  const added = await Promise.all([...isos].map((iso) => loadFineRegions(iso)));
  return added.some(Boolean);
}
