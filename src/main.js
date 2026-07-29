import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  MAX_LEVEL,
  MAX_MERC_Y,
  SQRT3,
  mercX,
  mercY,
  project,
  radiusOf,
  colsOf,
  normCol,
  cellCenter,
  pointToCell,
  parentOf,
} from './hexgrid.js';
import {
  loadCountries,
  countriesLoaded,
  countryIdAt,
  mergeCountries,
  countryGeometry,
} from './countries.js';
import { auth, connection, mountAuth } from './auth.js';
import { mountCellInfo } from './cell-info.js';
import { mountRouteInfo } from './route-info.js';
import { mountImport } from './import.js';
import { mountStats } from './stats-ui.js';
import { mountHomeAssistant } from './home-assistant-ui.js';
import { sourceLabel } from './locations.js';
import { mountColorPicker } from './color-picker.js';
import { terrainStyle, satelliteStyle } from './basemap.js';
import { mountKomoot } from './komoot-ui.js';
import { mountStrava } from './strava-ui.js';
import { mountSync } from './sync-ui.js';
import { mountSettings } from './settings-ui.js';
import { mountSearch } from './search-ui.js';
import { activeDays } from './trips.js';
import { mountBackup } from './backup-ui.js';
import { createHistory, plural } from './history.js';
import { showToast } from './toast.js';
import { routesToFC, totalLength, formatDistance, canonicalSport } from './routes.js';
import { reconcilePrefs } from './prefs.js';
import { loadPlaces, describeRoute } from './places.js';
import { createBlobLayer, blobsSupported, BLOB_ALPHA, BLOB_HEAT_ALPHA } from './blob-canvas.js';

// Past the finest hex levels (0..MAX_LEVEL), one more zoom-out step swaps the
// hex regions for whole-country fills.
const COUNTRY_LEVEL = MAX_LEVEL + 1;

// --- View tuning ---------------------------------------------------------------
// Grid geometry (cell size, levels, mercator math) lives in src/hexgrid.js —
// shared with the import scripts so both always agree on cell ids.
//
// Each level is 3× wider than the previous, and every big-cell center lands
// exactly on a small-cell center, so crossfades look concentric.
const LEVEL_STEP = Math.log2(3); // ≈ 1.585 zoom levels per grid level
// Zoom at which the finest level takes over. Every coarser level switches
// LEVEL_STEP zooms below this, so lowering it makes the grid stay on smaller
// cells longer — you have to zoom out further before cells enlarge.
const LEVEL0_ZOOM = 10;

const VIEW_PAD = 0.35; // extra region coverage around the viewport, per side
const TILE_INSET = 0.92; // unvisited tiles shrink to leave a glass gap
// Vector region smoothing — used for the selection ring, and for regions only
// on browsers that can't run the blob canvas (src/blob-canvas.js does the real
// thing). Repeated corner-cutting (Chaikin) converges on a smooth quadratic
// B-spline; each round doubles the point count.
const SMOOTH_ROUNDS = 4;
// How far each cut moves in from the corner (0.25 = classic Chaikin).
const SMOOTH_CUT = 0.28;
// false renders visited regions as fill only; true restores the outline + glow.
const SHOW_REGION_BORDERS = false;

// Edit-mode tile spotlight: tiles render only near the cursor and fade out
// toward the rim, so zoomed-out views never build a viewport full of cells.
const SPOT_PX = 300; // spotlight radius in screen px
const SPOT_FADE_START = 0.5; // fraction of the radius where the fade begins
const SPOT_MAX_CELLS = 2200; // shrink the spotlight when cells get tiny

// Level changes cross-dissolve rather than cut. Long enough to read as one
// shape relaxing into another, short enough not to lag behind a zoom gesture.
const LEVEL_FADE_MS = 620;

// Saved routes are drawn over the regions in their own color rather than the
// accent: they have to stay legible whatever the visited areas underneath them
// are painted, in every heat mode and on both basemaps. A soft wide glow under
// a crisp core keeps the same glass look as everything else.
const ROUTE_COLOR = '#ff9147';
// Zoom → width of the crisp core line, in screen px. The glow is a multiple of
// it, and the route you have open is drawn thicker still.
const ROUTE_WIDTH_STOPS = [
  [3, 0.9],
  [10, 2],
  [16, 3.4],
];
const ROUTE_GLOW_SCALE = 3.4;
const ROUTE_SELECTED_SCALE = 1.7;

const EMPTY = { type: 'FeatureCollection', features: [] };

// --- Startup view --------------------------------------------------------------
// Priority: last saved view (if REMEMBER_VIEW) → IP-based location (city
// level) → world view.
const REMEMBER_VIEW = false; // true → resume the last camera position on load
const VIEW_KEY = 'visited-map:view:v1';
const IP_ZOOM = 10.5; // zoom used when landing on the IP-based location

function savedView() {
  if (!REMEMBER_VIEW) return null;
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    if (v && Number.isFinite(v.lng) && Number.isFinite(v.lat) && Number.isFinite(v.zoom)) {
      return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const initialView = savedView();

// --- Basemap styles & overlays -----------------------------------------------
// The basemaps on offer. `theme` picks a legible tile colour for edit mode and
// decides how routes and the visited wash are lifted for contrast.
//
// Two kinds of entry: a `url`, which MapLibre fetches itself, or a `build()`
// that returns a style object — used where the published style needs changing
// before it is usable (see src/basemap.js). To add a basemap, add a line here.
const STYLES = {
  dark: {
    label: 'Dark',
    url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    theme: 'dark',
    cellAlpha: 1,
    heatAlpha: 1,
  },
  terrain: {
    label: 'Terrain',
    build: terrainStyle,
    theme: 'dark',
    // Tune the visited wash for this basemap here — see regionOpacity().
    cellAlpha: 1,
    heatAlpha: 1,
    // Only if OpenFreeMap is unreachable — the plain dark basemap beats a blank
    // screen.
    fallback: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  voyager: {
    label: 'Light',
    url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    theme: 'light',
    cellAlpha: 1,
    heatAlpha: 1,
  },
  satellite: {
    label: 'Satellite',
    build: satelliteStyle,
    // Imagery is dark enough that the dark-theme contrast rules are the right
    // ones — a light wash over aerial photography disappears.
    theme: 'dark',
    // Tune the visited wash over imagery here — see regionOpacity().
    cellAlpha: 1.3,
    heatAlpha: 1.3,
    fallback: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
};

// Something valid to open on while a built style is being fetched. Just a
// background, in the tone the finished style will have, so the swap doesn't
// flash.
const placeholderStyle = (theme) => ({
  version: 8,
  sources: {},
  layers: [
    {
      id: 'placeholder',
      type: 'background',
      paint: { 'background-color': theme === 'light' ? '#eae7e1' : '#333f33' },
    },
  ],
});

/**
 * What to hand MapLibre for a basemap: a URL straight through, or the built
 * style object. A build that fails falls back rather than leaving no map.
 */
async function resolveStyle(key) {
  const entry = STYLES[key];
  if (!entry?.build) return entry?.url;
  try {
    return await entry.build();
  } catch (e) {
    console.warn(`Basemap "${key}" could not be built; falling back.`, e);
    return entry.fallback;
  }
}
const STYLE_KEY = 'visited-map:style:v1';

// OpenRailwayMap raster overlay (train tracks). Attribution is required.
const RAIL_SOURCE = {
  type: 'raster',
  tiles: ['https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
  attribution: '© <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
};

let styleKey = localStorage.getItem(STYLE_KEY) ?? 'dark';
if (!STYLES[styleKey]) styleKey = 'dark';
// Apply the matching chrome colors before the map initializes to avoid a
// white-on-light flash when the saved basemap is Voyager.
document.documentElement.dataset.theme = STYLES[styleKey].theme;
// Train tracks are deliberately session-only and always start disabled after
// a page reload. Their state still survives basemap switches within the page.
let railOn = false;

// Edit-mode glass tiles need a light fill on dark maps and a dark fill on light
// maps to stay visible.
const tileColors = () =>
  STYLES[styleKey].theme === 'light'
    ? { fill: 'rgb(30, 41, 59)', line: 'rgb(51, 65, 85)' }
    : { fill: 'rgb(240, 246, 255)', line: 'rgb(235, 243, 255)' };

// --- Map -----------------------------------------------------------------------
const map = new maplibregl.Map({
  container: 'map',
  // A built style can't be awaited here. Rather than load a *different* basemap
  // and throw it away — a wasted fetch and a visible flash of the wrong map —
  // the map comes up on a bare background in roughly the right colour, and the
  // real style is set once it has been fetched and rewritten (see below).
  style: STYLES[styleKey].url ?? placeholderStyle(STYLES[styleKey].theme),
  center: initialView ? [initialView.lng, initialView.lat] : [15, 30],
  zoom: initialView?.zoom ?? 2.2,
  minZoom: 1.8,
  maxZoom: 17.5,
  // Added by hand below so it can sit top-right, out of the geolocate button's
  // corner.
  attributionControl: false,
});

// The place names that title imported routes come from GeoNames, which is
// CC BY 4.0 — the credit is required whether or not any route is on screen.
// (Natural Earth, used for the country level and the lake names, is public
// domain and asks for nothing.)
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://www.geonames.org/">GeoNames</a>',
  }),
  'top-right',
);
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
window.map = map; // handy in devtools

// Any user-initiated movement (or a geolocate flight) cancels the pending
// IP fly-in.
let userInteracted = false;
map.on('movestart', (e) => {
  if (e.originalEvent) userInteracted = true;
});

// "My location" button — browser geolocation (works on localhost; production
// needs HTTPS). Clicking it pans to the viewer and shows the blue dot.
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  fitBoundsOptions: { maxZoom: 14 },
  trackUserLocation: true,
});
// Where the browser last put you, so a second press can return there.
let lastFix = null;
geolocate.on('geolocate', (e) => {
  userInteracted = true;
  if (Number.isFinite(e?.coords?.longitude)) lastFix = [e.coords.longitude, e.coords.latitude];
});

// MapLibre's tracking control is a three-state toggle: off → locked → (pan
// away) → background → off. That means pressing it twice without moving turns
// tracking *off* and takes the blue dot with it, which is never what "show me
// where I am" is asking for — the button appears to delete your own location.
//
// Only the locked→off step is intercepted. Background→locked is MapLibre's
// re-centre and is exactly right, so it is left alone.
function keepGeolocateOn() {
  const btn = document.querySelector('.maplibregl-ctrl-geolocate');
  if (!btn || btn.dataset.stayPut) return;
  btn.dataset.stayPut = '1';
  btn.addEventListener(
    'click',
    (e) => {
      const locked = btn.classList.contains('maplibregl-ctrl-geolocate-active')
        && !btn.classList.contains('maplibregl-ctrl-geolocate-background');
      if (!locked) return; // first press, or re-centring from background
      e.stopPropagation();
      e.preventDefault();
      if (lastFix) map.easeTo({ center: lastFix, duration: 500 });
    },
    true, // capture: the control's own handler is on the button itself
  );
}
// Its own corner, so the attribution can have the top-right one to itself.
map.addControl(geolocate, 'bottom-right');
keepGeolocateOn();

// On a phone that corner is where the layers button lives too, and two glass
// pills stacked a gap apart read as clutter. Below the same breakpoint the
// bottom sheet uses (560px), move the geolocate button into the layers cluster
// so the two share one container; above it, put it back in the map's corner.
// The control doesn't care where its element sits — it talks to the map, not
// to its parent.
const geoGroup = document.querySelector('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group');
const geoCorner = geoGroup?.parentElement ?? null;
const layersCluster = document.getElementById('layers-cluster');
const phoneMq = window.matchMedia('(max-width: 560px)');

function placeGeolocate() {
  if (!geoGroup || !geoCorner) return;
  const host = phoneMq.matches ? layersCluster : geoCorner;
  if (geoGroup.parentElement !== host) host.append(geoGroup);
}
phoneMq.addEventListener('change', placeGeolocate);
placeGeolocate();

// Persist the camera so the next visit can resume where you left off
// (only used when REMEMBER_VIEW is on).
map.on('moveend', () => {
  if (!REMEMBER_VIEW) return;
  try {
    const c = map.getCenter();
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        lng: +c.lng.toFixed(5),
        lat: +c.lat.toFixed(5),
        zoom: +map.getZoom().toFixed(2),
      }),
    );
  } catch {
    /* storage unavailable */
  }
});

// Tracks whether the basemap has become visible yet — before that, the
// IP landing can be instant (no animation on a blank screen).
let mapShown = false;
map.once('load', () => {
  mapShown = true;
});

// First visit: aim the camera at the viewer's approximate location. The
// lookup runs in the browser (the API sees the viewer's public IP), so it
// works when the site is served from localhost too. VPNs resolve to the
// VPN's city; failures just leave the world view.
async function flyToIpLocation() {
  const providers = [
    ['https://get.geojs.io/v1/ip/geo.json', (d) => [+d.longitude, +d.latitude]],
    ['https://ipwho.is/', (d) => (d.success === false ? null : [+d.longitude, +d.latitude])],
  ];
  for (const [url, pick] of providers) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const center = pick(await res.json());
      if (!center || !center.every(Number.isFinite)) continue;
      if (!userInteracted && !savedView()) {
        if (mapShown) {
          // The map is already on screen: snap the center under the target
          // while still at world zoom (imperceptible), then zoom straight
          // down into it — no sideways pan at high zoom.
          map.jumpTo({ center });
          map.easeTo({ zoom: IP_ZOOM, duration: 1600 });
        } else {
          // Nothing rendered yet — just open the map at the target.
          map.jumpTo({ center, zoom: IP_ZOOM });
        }
      }
      return;
    } catch {
      /* try the next provider */
    }
  }
}
if (!initialView) flyToIpLocation();

// Keep the canvas in sync with the container even when the window itself
// doesn't fire a resize (embedded panes, dev tools, split views).
new ResizeObserver(() => map.resize()).observe(map.getContainer());

// ============================================================================
// >>> EDIT TOGGLE <<<  Flip this to true to bring editing back on.
// ----------------------------------------------------------------------------
// false → view-only map: the pencil button is hidden and clicks can never
//         modify cells (visited cells come from your imported history).
// true  → the pencil button appears; entering edit mode lets you click/paint
//         cells to mark them visited.
// The "Visited color" picker lives in the base-map menu regardless of this.
// ============================================================================
const EDIT_ENABLED = true;

// --- Mode & accent color -----------------------------------------------------
// 'view' (default): a normal map with only the colored regions visible.
// 'edit': a tile spotlight follows the cursor and clicks toggle cells.
const MODE_KEY = 'visited-map:mode:v1';
const COLOR_KEY = 'visited-map:color:v1';
const DEFAULT_ACCENT = '#60acff';

let mode = EDIT_ENABLED && localStorage.getItem(MODE_KEY) === 'edit' ? 'edit' : 'view';
let tileVis = mode === 'edit' ? 1 : 0; // 0..1, tweened on mode change

let accent = localStorage.getItem(COLOR_KEY) ?? DEFAULT_ACCENT;
if (!/^#[0-9a-f]{6}$/i.test(accent)) accent = DEFAULT_ACCENT;

// --- Coloring modes -----------------------------------------------------------
// 'flat' paints every visited region in the accent color and merges them into
// blobs. The heat maps instead give each cell its own color from its rolled-up
// stats, so the regions break back into a hex mosaic — the shape stops being
// the message and the numbers take over.
//
// Ramps run cool → hot / old → new and are sampled with an `interpolate`
// expression on the per-feature value `v` (0..1).
const HEAT_MODES = {
  flat: { label: 'Single color' },
  visits: {
    label: 'Most visited',
    legend: ['Rare', 'Often'],
    ramp: ['#2b3a6b', '#2f6fa8', '#39a0a0', '#8fc55f', '#f2d049', '#f08b3a', '#e4562f'],
    // Visit counts are heavily skewed (home dwarfs everything), so compress.
    value: (s, r) => Math.log(s.hits) / Math.log(Math.max(2, r.maxHits)),
  },
  // Not a ramp: a color per source. "Where did this part of the map come from"
  // is a question about categories, so cool→hot would be meaningless here — the
  // colors only have to be told apart, not ordered.
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
const UNDATED = -1;
const UNDATED_COLOR = '#5b6377';

// Colors for the Type mode. Picked to stay apart from each other rather than to
// run in any order, and assigned by first appearance in SOURCE_ORDER so a given
// source keeps its color as the map grows.
const TYPE_COLORS = [
  '#60acff', '#ff7ab8', '#5fd0a8', '#ffcf5c', '#b98cff',
  '#ff8f5c', '#4fd4e0', '#c3e05a', '#e0607a', '#8fa0d8',
];
// Anything not on the map yet, and anything past the palette, shares this.
const TYPE_OTHER_COLOR = '#7d8698';
const TYPE_MAX = TYPE_COLORS.length;

const HEAT_KEY = 'visited-map:heat:v1';
let heatMode = localStorage.getItem(HEAT_KEY) ?? 'flat';
if (!HEAT_MODES[heatMode]) heatMode = 'flat';

// The value function for the active mode, or null when regions are flat.
// A categorical mode puts a palette index in `v` instead of a 0..1 position,
// so it skips the clamping the ramps need.
function heatMetric() {
  const m = HEAT_MODES[heatMode];
  if (m?.categorical) return (stat) => (stat.src ?? TYPE_MAX);
  if (!m?.value) return null;
  return (stat, range) => {
    const v = m.value(stat, range ?? {});
    if (v === UNDATED) return UNDATED;
    return Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 1000) / 1000;
  };
}

// --- Blob canvas --------------------------------------------------------------
// Hex levels are painted into a canvas and blurred (src/blob-canvas.js) so the
// lattice dissolves and neighbouring colors bleed together. The country level
// keeps the vector path — those are real borders, not cells — and so does any
// browser without canvas filters.
const BLOBS = blobsSupported();
const blobCur = createBlobLayer(map, 'blob');
// Which side of a transition the blob canvas is on. Hex→hex level changes
// dissolve inside the canvas itself, so the layer just sits at full opacity
// ('none'); only a crossing to or from the vector country level makes the
// whole layer fade.
let blobRole = 'none'; // 'none' | 'in' | 'out'

// Which side of a crossfade the vector `hex` layers are on. Normally they hold
// whatever is coming in ('in'). Going country → blob they hold what is going
// *out*, and the incoming side is the canvas — which needs no vector source at
// all, so the countries can stay put and fade where they already are instead of
// being copied onto `hex-prev`. That copy re-parsed and re-tiled the same
// geometry the map had already drawn, at the exact moment it was supposed to be
// fading out smoothly.
let hexRole = 'in'; // 'in' | 'out' | 'warm'

// What the `hex` source actually holds, so a repeat of the same data can be
// skipped (see setHexData). Declared up here because the fade helpers below
// reach for it before updateGrid's state block is evaluated.
let hexData = EMPTY;

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Sample a ramp at t (0..1) with a straight sRGB mix — the ramps are dense
// enough that a fancier interpolation buys nothing here.
function sampleRamp(ramp, t) {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(
    a[2] + (b[2] - a[2]) * f,
  )})`;
}

// Per-cell color for the canvas painter, quantized so a whole region shares a
// handful of fill styles.
function blobColorOf(level) {
  const heat = HEAT_MODES[heatMode];
  if (heat.categorical) return (stat) => TYPE_COLORS[stat.src] ?? TYPE_OTHER_COLOR;
  if (!heat.ramp) return () => accent;
  const metric = heatMetric();
  const range = litRange[level] ?? {};
  const steps = 48;
  const cache = new Map();
  return (stat) => {
    const v = metric(stat, range);
    const bucket = v < 0 ? -1 : Math.round(v * steps);
    let color = cache.get(bucket);
    if (!color) {
      color = bucket < 0 ? UNDATED_COLOR : sampleRamp(heat.ramp, bucket / steps);
      cache.set(bucket, color);
    }
    return color;
  };
}

// MapLibre expression that turns `v` into a color for the active ramp.
function heatColorExpr() {
  const heat = HEAT_MODES[heatMode];
  // Categorical: `v` is a palette slot, so pick, don't interpolate.
  if (heat?.categorical) {
    return [
      'match',
      ['number', ['get', 'v'], TYPE_MAX],
      ...TYPE_COLORS.flatMap((c, i) => [i, c]),
      TYPE_OTHER_COLOR,
    ];
  }
  const ramp = heat?.ramp;
  if (!ramp) return accent;
  const stops = ramp.flatMap((c, i) => [i / (ramp.length - 1), c]);
  return [
    'case',
    ['<', ['number', ['get', 'v'], 0], 0], UNDATED_COLOR,
    ['interpolate', ['linear'], ['number', ['get', 'v'], 0], ...stops],
  ];
}

function mixWithWhite(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function mixWithBlack(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * (1 - t));
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

// A route line lightened toward white reads beautifully on the dark basemap and
// vanishes on the pale one, so the core takes the opposite treatment per theme
// and the glow, which is haze either way, pulls back a little on light.
// The core line is the activity's colour lifted toward the basemap's own
// contrast; the glow underneath is that colour untouched.
const routeLineColor = () =>
  routeColorExpr((hex) =>
    (STYLES[styleKey].theme === 'light' ? mixWithBlack(hex, 0.3) : mixWithWhite(hex, 0.35)));
const routeGlowColor = () => routeColorExpr((hex) => hex);
const routeGlowOpacity = () => {
  const strong = STYLES[styleKey].theme === 'light' ? 0.5 : 0.6;
  const soft = STYLES[styleKey].theme === 'light' ? 0.26 : 0.35;
  return ['case', ROUTE_SELECTED, strong, soft];
};

// --- Paint expressions -----------------------------------------------------
// Region features: k=1 fill polygons, k=2 outline. Tile features carry a
// per-cell spotlight fade in property `f` (0..1).
const HOVER = ['number', ['feature-state', 'hoverT'], 0];
const F = ['number', ['get', 'f'], 1];

const tileLineWidth = ['interpolate', ['linear'], ['zoom'], 2, 0.8, 17, 1.3];
const boundLineWidth = ['interpolate', ['linear'], ['zoom'], 2, 1.5, 17, 2.2];
const boundGlowWidth = ['interpolate', ['linear'], ['zoom'], 2, 5, 17, 10];

const tileFillOpacity = () => ['*', tileVis, F, ['+', 0.05, ['*', 0.1, HOVER]]];
const tileLineOpacity = () => ['*', tileVis, F, ['+', 0.22, ['*', 0.32, HOVER]]];

// Route widths. MapLibre only accepts ["zoom"] as the input of a TOP-LEVEL
// step/interpolate, so both the glow's scale and the selected-route bump have
// to be baked into the stop values — wrapping an interpolate in ['*', …] is
// rejected outright when the layer is added.
const ROUTE_SELECTED = ['boolean', ['feature-state', 'sel'], false];
const routeWidth = (scale) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...ROUTE_WIDTH_STOPS.flatMap(([zoom, w]) => [
    zoom,
    ['case', ROUTE_SELECTED, w * scale * ROUTE_SELECTED_SCALE, w * scale],
  ]),
];

function applyTileVis() {
  map.setPaintProperty('tile-fill', 'fill-opacity', tileFillOpacity());
  map.setPaintProperty('tile-line', 'line-opacity', tileLineOpacity());
}

// f = uniform fade factor (0..1) used for crossfading regions between levels.
// The vector layers and the blob canvas fade as one: only one of them holds
// the current level at any moment, so driving both keeps the crossfade working
// across the hex → country boundary too.
function setVectorFade(suffix, f) {
  map.setPaintProperty(`hex-fill${suffix}`, 'fill-opacity', regionOpacity() * f);
  map.setPaintProperty(`hex-bound-glow${suffix}`, 'line-opacity', SHOW_REGION_BORDERS ? 0.35 * f : 0);
  map.setPaintProperty(`hex-bound-line${suffix}`, 'line-opacity', SHOW_REGION_BORDERS ? 0.9 * f : 0);
}

// The incoming ramp: whichever layers hold the level being faded in.
function applyFade(f) {
  if (hexRole === 'in') setVectorFade('', f);
  // 'warm' means `hex` is holding country geometry purely so the map has it
  // tiled before the crossing — it must stay invisible until it is the
  // incoming side, and every path through here has to keep pinning it down.
  else if (hexRole === 'warm') setVectorFade('', 0);
  if (blobRole !== 'out') blobCur.setOpacity(regionOpacity() * f);
}
// The outgoing ramp.
function applyPrevFade(f) {
  setVectorFade('-prev', f);
  if (hexRole === 'out') setVectorFade('', f);
  if (blobRole === 'out') blobCur.setOpacity(regionOpacity() * f);
}

// applyColors() only moves paint properties, but in single-color mode the
// accent is *baked into the blob canvas* — so changing it also needs a
// re-raster, or the wash keeps its old color until the map next moves. Heat
// modes don't care: their cell colors don't come from the accent at all.
// Coalesced to one repaint per frame so dragging the picker stays smooth.
let accentRepaint = 0;
function repaintAccent() {
  if (accentRepaint || isHeatMode()) return;
  accentRepaint = requestAnimationFrame(() => {
    accentRepaint = 0;
    updateGrid(true);
  });
}

function applyColors() {
  if (!map.getLayer('hex-fill')) return;
  const lineColor = mixWithWhite(accent, 0.45);
  const fill = heatColorExpr();
  for (const s of ['', '-prev']) {
    map.setPaintProperty(`hex-fill${s}`, 'fill-color', fill);
    map.setPaintProperty(`hex-bound-glow${s}`, 'line-color', accent);
    map.setPaintProperty(`hex-bound-line${s}`, 'line-color', lineColor);
  }
  if (map.getLayer('sel-line')) {
    map.setPaintProperty('sel-line', 'line-color', mixWithWhite(accent, 0.75));
  }
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-color', routeLineColor());
    map.setPaintProperty('route-glow', 'line-color', routeGlowColor());
    map.setPaintProperty('route-glow', 'line-opacity', routeGlowOpacity());
  }
}

// Whether the active coloring mode is a heat map (per-cell colors from a ramp)
// rather than the single-color wash. The two are tuned separately — opacity
// here, edge softness in src/blob-canvas.js.
const isHeatMode = () => {
  const m = HEAT_MODES[heatMode];
  return !!(m?.ramp || m?.categorical);
};

// Heat-map cells are opaque enough to read as data; flat regions stay a
// translucent wash over the basemap. Both live in src/blob-canvas.js.
// How strong the visited wash is, per basemap. The same alpha does not read the
// same over a near-black basemap, a green one and a photograph — over imagery a
// light wash vanishes, over Terrain the default drowns the landcover. Each
// STYLES entry can carry `cellAlpha` (single-colour) and `heatAlpha` (the heat
// maps) as multipliers of the defaults in src/blob-canvas.js; 1 = unchanged.
const regionOpacity = () => {
  const style = STYLES[styleKey] ?? {};
  const base = isHeatMode() ? BLOB_HEAT_ALPHA : BLOB_ALPHA;
  const scale = (isHeatMode() ? style.heatAlpha : style.cellAlpha) ?? 1;
  return Math.max(0, Math.min(1, base * scale));
};

function setHeatMode(next) {
  if (!HEAT_MODES[next] || next === heatMode) return;
  const wasType = !!HEAT_MODES[heatMode]?.categorical;
  heatMode = next;
  try {
    localStorage.setItem(HEAT_KEY, heatMode);
  } catch {
    /* fine */
  }
  // The per-source tally is only built while Type is on, so switching into or
  // out of it is the one mode change that has to redo the roll-up.
  if (wasType !== !!HEAT_MODES[heatMode]?.categorical) recomputeLit();
  countryDirty = true; // countries render dissolved or per-country by mode
  applyColors();
  applyFade(fade.cur);
  applyPrevFade(fade.prev);
  updateLayersUi();
  updateGrid(true);
}

// --- Visited cells & upward propagation -------------------------------------
// Cells are stored per user on the server (see server/index.js and src/auth.js),
// not in localStorage. `visited` starts empty and is hydrated once the user's
// session resolves (hydrateVisited, below). The baked-in import history from
// `npm run import` is merged into each account server-side, once per import run.
const visited = new Set(); // ids "L/col/row" at the level they were clicked
// Provenance, one entry per source that vouches for a cell:
//   id → [{ source, addedAt, firstAt, lastAt, hits, fixes }, …] (epoch s, 0 = unknown)
// A cell you walked through with Timeline on *and* painted by hand has two.
const cellMeta = new Map();
let authed = false; // true once a session is active; gates server saves

const nowSec = () => Math.floor(Date.now() / 1000);

// litSets[L] = "col/row" → rolled-up stats for every cell lit at level L: each
// stored cell plus all of its ancestors, so coloring a small hexagon colors the
// big ones around it. The stats are what the heat maps read:
//   hits — separate visits to the cell (see VISIT_GAP_SEC in locations.js;
//          a thousand fixes from one run through it count as one)
//   time — most recent evidence (falls back to when it was added)
//   age  — earliest evidence
//   ids  — the stored cell ids rolled up into this one, so clearing a cell can
//          find what to delete with a lookup instead of a sweep of `visited`
let litSets = [];
// Cells painted since the last roll-up, waiting to be folded in incrementally
// (see rollUpPainted). Declared here because recomputeLit() below runs at module
// load, before anything further down has been initialized.
const paintQueue = [];
// Per-level ranges, so a heat map's colors mean the same thing while you pan.
let litRange = [];
// Sources present on the map, most cells first — the order the Type mode hands
// out its palette in, so the biggest source gets the most distinct color and a
// source keeps its color as long as its standing doesn't change.
let sourceOrder = [];

// Tally one source's visits onto a rolled-up cell. Nearly every cell only ever
// sees a single source, so the Map is only allocated once a second turns up.
function addSource(e, src, hits) {
  if (e.srcMap) {
    e.srcMap.set(src, (e.srcMap.get(src) ?? 0) + hits);
  } else if (e.src1 === undefined) {
    e.src1 = src;
    e.n1 = hits;
  } else if (e.src1 === src) {
    e.n1 += hits;
  } else {
    e.srcMap = new Map([[e.src1, e.n1], [src, hits]]);
  }
}

// Which source speaks for this cell: the one that saw you there most often.
// Ties go to the alphabetically first, so the map doesn't shuffle between loads.
function dominantSource(e) {
  if (!e.srcMap) return e.src1;
  let best;
  let bestN = -1;
  for (const [src, n] of e.srcMap) {
    if (n > bestN || (n === bestN && src < best)) {
      best = src;
      bestN = n;
    }
  }
  return best;
}

function recomputeLit() {
  // A full rebuild already accounts for anything sitting in the queue.
  paintQueue.length = 0;
  // The per-source tally is only worth building when something is going to read
  // it — it's an extra pass and an extra field on every rolled-up cell.
  const byType = HEAT_MODES[heatMode]?.categorical;
  litSets = Array.from({ length: MAX_LEVEL + 1 }, () => new Map());
  const sourceCells = new Map();

  for (const id of visited) {
    let [L, col, row] = id.split('/').map(Number);
    if (L > MAX_LEVEL) continue; // stored at a level that no longer exists

    // Fold this cell's provenance into the numbers the heat maps use. Cells
    // marked by hand have no fix count worth showing, so they weigh 1.
    let hits = 0;
    let time = 0;
    let age = 0;
    let own = null; // this cell's own dominant source
    let ownN = -1;
    for (const m of cellMeta.get(id) ?? []) {
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
    if (byType && own) sourceCells.set(own, (sourceCells.get(own) ?? 0) + 1);
    // No fix count (hand-marked, or carried over from before provenance) still
    // counts as one visit. Dates are left at 0 on purpose: "we don't know when"
    // is its own answer, and the date heat maps grey those cells out rather
    // than pretending they happened when they were added.
    if (!hits) hits = 1;
    if (!age) age = time;

    for (let l = L; l <= MAX_LEVEL; l++) {
      if (l > L) [col, row] = parentOf(l - 1, col, row);
      const key = `${col}/${row}`;
      let e = litSets[l].get(key);
      if (e) {
        e.hits += hits;
        e.cells++;
        e.ids.push(id);
        if (time > e.time) e.time = time;
        if (age && (!e.age || age < e.age)) e.age = age;
      } else {
        litSets[l].set(key, (e = { hits, time, age, cells: 1, ids: [id] }));
      }
      if (byType && own) addSource(e, own, ownN);
    }
  }

  if (byType) {
    // Hand out palette slots by how much of the map each source accounts for.
    sourceOrder = [...sourceCells.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([src]) => src);
    const slot = new Map(sourceOrder.map((src, i) => [src, i]));
    for (const lit of litSets) {
      for (const e of lit.values()) {
        e.src = slot.get(dominantSource(e)) ?? TYPE_MAX;
        // The tally has done its job; drop it so the entries stay small.
        delete e.srcMap;
        delete e.src1;
        delete e.n1;
      }
    }
  } else {
    sourceOrder = [];
  }

  litRange = litSets.map((lit) => {
    const r = { maxHits: 1, minTime: 0, maxTime: 0, minAge: 0, maxAge: 0 };
    for (const e of lit.values()) {
      if (e.hits > r.maxHits) r.maxHits = e.hits;
      if (e.time) {
        if (!r.minTime || e.time < r.minTime) r.minTime = e.time;
        if (e.time > r.maxTime) r.maxTime = e.time;
      }
      if (e.age) {
        if (!r.minAge || e.age < r.minAge) r.minAge = e.age;
        if (e.age > r.maxAge) r.maxAge = e.age;
      }
    }
    return r;
  });

  countryDirty = true; // the set of lit countries may have changed
}

// Fold ONE newly stored cell into litSets/litRange without rebuilding them.
// Returns false — having changed nothing — when only a full rebuild would be
// exact, so the caller can fall back.
//
// The catch is litRange: `minTime` is a minimum over entry times and `maxAge` a
// maximum over entry ages, and adding a cell can *raise* an entry's time or
// *lower* its age. Neither composes incrementally. Cells painted by hand carry
// no dates at all (markCell stores firstAt/lastAt as 0), so those two fields
// stay untouched and the shortcut is exact — which is the only case this is
// used for. Anything dated takes the slow path.
function rollUpPainted(id) {
  let [L, col, row] = id.split('/').map(Number);
  if (L > MAX_LEVEL) return true; // same skip as recomputeLit()

  let hits = 0;
  let time = 0;
  let age = 0;
  for (const m of cellMeta.get(id) ?? []) {
    if (m.source !== 'manual' && m.source !== 'unknown') hits += m.hits || 0;
    if (m.lastAt > time) time = m.lastAt;
    if (m.firstAt && (!age || m.firstAt < age)) age = m.firstAt;
  }
  if (!hits) hits = 1;
  if (!age) age = time;
  if (time || age) return false; // dated — litRange would need the full pass

  for (let l = L; l <= MAX_LEVEL; l++) {
    if (l > L) [col, row] = parentOf(l - 1, col, row);
    const key = `${col}/${row}`;
    let e = litSets[l].get(key);
    if (e) {
      e.hits += hits;
      e.cells++;
      e.ids.push(id);
    } else {
      litSets[l].set(key, (e = { hits, time: 0, age: 0, cells: 1, ids: [id] }));
    }
    if (e.hits > litRange[l].maxHits) litRange[l].maxHits = e.hits;
  }
  countryDirty = true;
  return true;
}

// --- Country level: which countries are lit, merged into one shape ----------
// The merge (a polygon union) is only recomputed when the lit set changes AND
// the country level is actually on screen, so painting hexes never pays for it.
let countryFC = EMPTY;
let countryDirty = true;
const cellCountryMemo = new Map(); // coarse "col/row" -> country id (centers never move)

// Longitudes come back from cellCenter() in [0,360) because cell columns are
// stored normalized; fold them into [-180,180] before the country lookup, or
// western-hemisphere cells (Portugal, Spain, the Americas) land near +350°.
const wrapLng = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;

function buildCountryFC() {
  // Resolve countries from the coarsest lit cells (~50 km) rather than every
  // fine cell: a couple hundred point-in-country tests instead of tens of
  // thousands, which is what was freezing the page.
  const litIds = new Set();
  const perCountry = new Map(); // id → rolled-up stats, for the heat maps
  for (const [key, stat] of litSets[MAX_LEVEL]) {
    let cid = cellCountryMemo.get(key);
    if (cid === undefined) {
      const sep = key.indexOf('/');
      const col = +key.slice(0, sep);
      const row = +key.slice(sep + 1);
      const [lng, lat] = project(cellCenter(MAX_LEVEL, col, row));
      cid = countryIdAt(wrapLng(lng), lat);
      cellCountryMemo.set(key, cid);
    }
    if (!cid) continue;
    litIds.add(cid);
    let e = perCountry.get(cid);
    if (e) {
      e.hits += stat.hits;
      e.cells += stat.cells;
      if (stat.time > e.time) e.time = stat.time;
      if (stat.age && (!e.age || stat.age < e.age)) e.age = stat.age;
    } else {
      perCountry.set(cid, (e = { ...stat }));
      e.srcN = new Map();
    }
    // A whole country is colored by whichever app covers the most of it — by
    // ground, not by visits, which is the question the country level answers.
    if (stat.src !== undefined) e.srcN.set(stat.src, (e.srcN.get(stat.src) ?? 0) + stat.cells);
  }
  for (const e of perCountry.values()) {
    let best = TYPE_MAX;
    let bestN = -1;
    for (const [src, n] of e.srcN ?? []) {
      if (n > bestN || (n === bestN && src < best)) {
        best = src;
        bestN = n;
      }
    }
    e.src = best;
  }

  // In a heat mode each country is its own feature so it can carry its own
  // color; otherwise they dissolve into one borderless shape.
  const heat = heatMetric();
  if (heat) {
    const range = { maxHits: 1, minTime: 0, maxTime: 0, minAge: 0, maxAge: 0 };
    for (const e of perCountry.values()) {
      if (e.hits > range.maxHits) range.maxHits = e.hits;
      if (e.time) {
        if (!range.minTime || e.time < range.minTime) range.minTime = e.time;
        if (e.time > range.maxTime) range.maxTime = e.time;
      }
      if (e.age) {
        if (!range.minAge || e.age < range.minAge) range.minAge = e.age;
        if (e.age > range.maxAge) range.maxAge = e.age;
      }
    }
    const features = [];
    for (const [id, stat] of perCountry) {
      const geometry = countryGeometry(id);
      if (geometry) {
        features.push({ type: 'Feature', properties: { k: 1, v: heat(stat, range) }, geometry });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const { fill, rings } = mergeCountries(litIds);
  const features = [];
  if (fill.length) {
    features.push({ type: 'Feature', properties: { k: 1 }, geometry: { type: 'MultiPolygon', coordinates: fill } });
  }
  if (rings.length) {
    features.push({ type: 'Feature', properties: { k: 2 }, geometry: { type: 'MultiLineString', coordinates: rings } });
  }
  return { type: 'FeatureCollection', features };
}

// Cached country FeatureCollection. If the data hasn't loaded yet, kick off the
// (one-time) fetch and refresh once it arrives; show nothing until then.
function ensureCountryFC() {
  if (!countriesLoaded()) {
    loadCountries().then(() => {
      cellCountryMemo.clear();
      countryDirty = true;
      updateGrid(true);
    });
    return EMPTY;
  }
  if (countryDirty) {
    countryFC = buildCountryFC();
    countryDirty = false;
  }
  return countryFC;
}

// Initial (empty) light-up so litSets/countryDirty exist before the map draws;
// hydrateVisited() re-runs this once the user's cells arrive from the server.
recomputeLit();

// --- Saving ------------------------------------------------------------------
// Edits go to the server as incremental add/remove batches, debounced so a
// Ctrl-paint sweep sends one request instead of one per cell. No-ops when
// signed out.
const pendingAdd = new Set();
const pendingRemove = new Set();
let saveTimer = null;

let saving = false;

function queueSave() {
  if (!authed) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPending, 500);
}

// Send what's queued, and only clear it once the server has actually taken it.
// It used to be emptied before the request went out, so a save that failed —
// server down, tunnel dropped — threw the edits away without telling anyone.
// Holding them means the Retry button has something to send.
async function flushPending() {
  if (!authed || saving) return;
  const add = [...pendingAdd];
  const remove = [...pendingRemove];
  if (!add.length && !remove.length) return;
  saving = true;
  try {
    await auth.mutateCells(add, remove);
    // Delete by id rather than clearing: a cell re-marked while this request
    // was in flight has already moved to the other set, and that newer intent
    // must survive.
    for (const id of add) pendingAdd.delete(id);
    for (const id of remove) pendingRemove.delete(id);
  } catch (e) {
    console.warn('Saving cells failed, keeping the edits queued:', e);
  } finally {
    saving = false;
  }
}

// Mark a cell by hand. Cells that arrived from an import keep their existing
// provenance — the server does the same, so a manual tap over imported history
// never overwrites where it came from.
function markCell(id) {
  visited.add(id);
  if (!cellMeta.has(id)) {
    cellMeta.set(id, [{ source: 'manual', addedAt: nowSec(), firstAt: 0, lastAt: 0, hits: 1, fixes: 0 }]);
  }
  pendingRemove.delete(id);
  pendingAdd.add(id);
  queueSave();
}

// Clearing a cell means "I was never here" — it drops every source's claim.
function unmarkCell(id) {
  visited.delete(id);
  cellMeta.delete(id);
  pendingAdd.delete(id);
  pendingRemove.add(id);
  queueSave();
}

// --- Undo / redo ---------------------------------------------------------------
// Every edit below records how to take itself back. The stack lives in
// src/history.js; what it needs from here is the two halves of an edit and a
// phrase for the toast.
const history = createHistory();

// Undo doesn't go through the debounced queue — it sends the inverse itself —
// so anything already queued has to land first. Otherwise a clear that hasn't
// been sent yet flushes *after* the restore that undid it, and the cells go
// again half a second later.
async function settleSaves() {
  clearTimeout(saveTimer);
  for (let i = 0; i < 40; i++) {
    if (!pendingAdd.size && !pendingRemove.size) return;
    if (saving) await new Promise((r) => setTimeout(r, 40));
    else await flushPending();
  }
  // Still holding edits means the server isn't taking them. Undoing on top of
  // that would show a change on screen that nothing has recorded.
  throw new Error("the server isn't answering");
}

// What a cell knows, deep-copied so a later edit to the live map can't reach
// into an entry sitting in the undo stack.
function snapshotCells(ids) {
  return ids.map((id) => [id, (cellMeta.get(id) ?? []).map((e) => ({ ...e }))]);
}

// Put snapshots back — on the map and on the server, with their provenance.
// This is why POST /api/cells/restore exists: re-adding the ids would bring
// them back as bare manual marks, having quietly thrown away the dates, the
// visit counts and which app they came from.
async function restoreCells(snapshot) {
  await settleSaves();
  const rows = [];
  const at = nowSec();
  for (const [id, entries] of snapshot) {
    const list = entries.length ? entries : [{ source: 'manual', addedAt: at, firstAt: 0, lastAt: 0, hits: 1, fixes: 0 }];
    visited.add(id);
    cellMeta.set(id, list.map((e) => ({ ...e })));
    // It's going back on the map, so a queued "remove it" is no longer true.
    pendingRemove.delete(id);
    for (const e of list) rows.push([id, e.source, e.addedAt, e.firstAt, e.lastAt, e.hits, e.fixes]);
  }
  await auth.restoreCells(rows);
  recomputeLit();
  updateGrid(true);
  updateTiles();
}

// The other direction: clear these again.
async function clearCells(ids) {
  for (const id of ids) unmarkCell(id);
  recomputeLit();
  updateGrid(true);
  updateTiles();
  await settleSaves();
}

// Mark these again, as they were. Same call as restoring a clear, because a
// mark *is* a row — the manual one.
async function remarkCells(snapshot) {
  await restoreCells(snapshot);
}

// Pull the signed-in user's cells (and their provenance) and light them up.
// Runs after login, after the initial session check and after an import; safe
// to call before or after the map style loads (updateGrid no-ops until the
// sources exist, then installGrid renders).
async function hydrateVisited() {
  visited.clear();
  cellMeta.clear();
  try {
    const { sources = [], rows = [] } = (await auth.getCells()) ?? {};
    for (const [id, srcIdx, addedAt, firstAt, lastAt, hits, fixes = 0] of rows) {
      visited.add(id);
      const entry = { source: sources[srcIdx] ?? 'unknown', addedAt, firstAt, lastAt, hits, fixes };
      const list = cellMeta.get(id);
      if (list) list.push(entry);
      else cellMeta.set(id, [entry]);
    }
  } catch (e) {
    console.warn('Loading cells failed:', e);
    visited.clear();
    cellMeta.clear();
  }
  closeCellInfo();
  closeRouteInfo();
  recomputeLit();
  updateGrid(true);
  updateTiles();
  updateHud(currentLevel);
}

// Ancestor of a stored cell at a coarser level (identity at the same level).
function ancestorAt(L, col, row, targetL) {
  while (L < targetL) {
    [col, row] = parentOf(L, col, row);
    L++;
  }
  return [col, row];
}

// Every stored cell that sits inside (or is) the cell (L, col, row).
// recomputeLit() already walks each stored cell up to every ancestor, so it
// records the ids on the way past — this is that index, read back. It used to
// re-split and re-walk all ~20k stored ids on every tap.
function storedUnder(L, col, row) {
  return litSets[L]?.get(`${col}/${row}`)?.ids ?? [];
}

function toggleCell(id) {
  const [L, col, row] = id.split('/').map(Number);
  if (litSets[L].has(`${col}/${row}`)) {
    // Clear everything stored beneath (or at) this cell. Iterate a copy: the
    // array belongs to litSets now, and unmarkCell is removing its contents.
    const ids = [...storedUnder(L, col, row)];
    // Taken *before* the clear — this is everything those cells knew, and in a
    // moment it will only exist here.
    const snapshot = snapshotCells(ids);
    for (const vid of ids) unmarkCell(vid);
    // Zoomed out, one tap can clear a country's worth of cells, which is
    // exactly the edit you most want back.
    history.push(
      `clearing ${plural(ids.length, 'cell')}`,
      () => restoreCells(snapshot),
      () => clearCells(ids),
    );
  } else {
    markCell(id);
    const snapshot = snapshotCells([id]);
    history.push('marking a cell', () => clearCells([id]), () => remarkCells(snapshot));
  }
  recomputeLit();
  updateGrid(true);
  updateTiles();
}
// Debug hooks — handy in devtools for poking at cells and their provenance.
window.visitedMap = {
  toggle: toggleCell,
  visited,
  cellMeta,
  idAt: (lng, lat) => cellIdAt({ lng, lat }),
  info: (lng, lat) => showCellInfoAt({ lng, lat }),
};

// Clicks/hovers resolve to a cell mathematically — no hit-testing, so gaps
// between tiles, boundary lines and merged fills all behave the same.
function cellIdAt(lngLat) {
  const [c, r] = pointToCell(currentLevel, mercX(lngLat.lng), mercY(lngLat.lat));
  return `${currentLevel}/${normCol(c, colsOf(currentLevel))}/${r}`;
}

// --- View-mode cell info ------------------------------------------------------
// Tapping a colored area in view mode answers "when was I here, and how does
// the map know?". The clicked cell is whatever the current zoom is showing, so
// zoomed out you get the aggregate of everything inside it.
let cellInfo = null; // set by mountCellInfo() once the DOM is wired
let selection = null; // { L, col, row } of the highlighted cell
let lastInfoLngLat = null; // where you tapped, so zooming can re-resolve it

// Ground size of a cell at the current latitude (Mercator cells shrink as you
// go north). Shared by the HUD readout and the info card.
function cellSizeKm(level) {
  const cosLat = Math.cos((map.getCenter().lat * Math.PI) / 180);
  const km = (SQRT3 * radiusOf(level) * cosLat) / 1000; // flat-to-flat, ground
  if (km >= 10) return `≈ ${Math.round(km)} km`;
  if (km >= 1) return `≈ ${km.toFixed(1)} km`;
  return `≈ ${Math.round(km * 1000)} m`;
}
const cellSizeLabel = (level) =>
  level == null || level === COUNTRY_LEVEL ? 'country' : `${cellSizeKm(level)} cell`;

// Roll the provenance of every stored cell inside (L, col, row) into one
// summary plus a per-source breakdown.
function gatherInfo(L, col, row) {
  const ids = storedUnder(L, col, row);
  if (!ids.length) return null;
  const bySource = new Map();
  let addedAt = 0;
  let firstAt = 0;
  let lastAt = 0;
  let hits = 0;
  let fixes = 0;
  const earlier = (a, b) => (b && (!a || b < a) ? b : a); // 0 means "unknown"
  for (const id of ids) {
    for (const m of cellMeta.get(id) ?? []) {
      let s = bySource.get(m.source);
      if (!s) {
        bySource.set(m.source, (s = { key: m.source, cells: 0, hits: 0, fixes: 0, addedAt: 0, firstAt: 0, lastAt: 0 }));
      }
      s.cells++;
      s.hits += m.hits || 0;
      s.fixes += m.fixes || 0;
      s.addedAt = earlier(s.addedAt, m.addedAt);
      s.firstAt = earlier(s.firstAt, m.firstAt);
      s.lastAt = Math.max(s.lastAt, m.lastAt || 0);
      // Only imported data has a meaningful count — a hand-marked cell carries
      // a placeholder 1 that would be nonsense to show.
      if (m.source !== 'manual' && m.source !== 'unknown') {
        hits += m.hits || 0;
        fixes += m.fixes || 0;
      }
      addedAt = earlier(addedAt, m.addedAt);
      firstAt = earlier(firstAt, m.firstAt);
      lastAt = Math.max(lastAt, m.lastAt || 0);
    }
  }
  const [lng, lat] = project(cellCenter(L, col, row));
  return {
    lat,
    lng: wrapLng(lng),
    sizeLabel: cellSizeLabel(L),
    cellCount: ids.length,
    hits,
    fixes,
    addedAt,
    firstAt,
    lastAt,
    sources: [...bySource.values()].sort((a, b) => b.cells - a.cells),
  };
}

// The highlight ring around the inspected cell — same rounded outline the
// regions use, so it reads as part of the same language.
function selectionFC() {
  if (!selection || !map.getSource('sel')) return EMPTY;
  const { L, col, row } = selection;
  const [cx, cy] = cellCenter(L, col, row);
  const ring = fullHexOffsets(radiusOf(L)).map(([dx, dy]) => [cx + dx, cy + dy]);
  ring.push([...ring[0]]);
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: smoothLoop(ring).map(project) } },
    ],
  };
}

function updateSelection() {
  map.getSource('sel')?.setData(selectionFC());
}

function closeCellInfo() {
  selection = null;
  updateSelection();
  cellInfo?.hide();
}

function showCellInfoAt(lngLat) {
  if (currentLevel == null) return;
  closeRouteInfo(); // the two cards share the same spot on screen
  lastInfoLngLat = lngLat; // remembered so a zoom can re-resolve the same spot
  // At the country level there are no hexes to inspect — fall back to the
  // coarsest hex level, which is what the country fill is derived from.
  const L = Math.min(currentLevel, MAX_LEVEL);
  const [c, r] = pointToCell(L, mercX(lngLat.lng), mercY(lngLat.lat));
  const col = normCol(c, colsOf(L));
  if (!litSets[L]?.has(`${col}/${r}`)) {
    closeCellInfo();
    return;
  }
  const info = gatherInfo(L, col, r);
  if (!info) {
    closeCellInfo();
    return;
  }
  selection = { L, col, row: r };
  updateSelection();
  cellInfo?.show(info);
}

// --- Saved routes -------------------------------------------------------------
// An imported track can keep its actual line as well as the cells it lit up
// (src/routes.js). Routes are a layer of their own over the regions and a table
// of their own on the server: clearing a cell never touches them, and they
// never feed the heat maps — they're a record of one journey, not of coverage.
const ROUTES_KEY = 'visited-map:routes:v1';
const ROUTE_LAYERS = ['route-glow', 'route-line'];

let routesOn = localStorage.getItem(ROUTES_KEY) === 'on';
let routeList = []; // newest first; carries `geom` only once routeGeom is true
let routeGeom = false; // whether the lines themselves have been fetched
let routeInfo = null; // set by mountRouteInfo() once the DOM is wired
let homeAssistant = null; // set by mountHomeAssistant()
let colorPicker = null; // set by mountColorPicker()
let stravaUi = null; // set by mountStrava()
let backupUi = null; // set by mountBackup()
let selectedRoute = null;

function saveRoutesPref() {
  try {
    localStorage.setItem(ROUTES_KEY, routesOn ? 'on' : 'off');
  } catch {
    /* fine */
  }
}

// --- Routes by activity ------------------------------------------------------
// With the activity worked out for nearly every route, "show me only the rides"
// and "make the ski days white" become answerable. Both are per-activity and
// both live in the browser: they're a way of looking at the map, not a fact
// about it, so nothing here is sent to the server.
//
// The key is the activity string exactly as stored ('' for one that was never
// worked out); ROUTE_NO_SPORT stands in for the blank so it can be a real entry
// in a map and a real row in the menu.
const ROUTE_VIEW_KEY = 'visited-map:route-view:v1';
const ROUTE_NO_SPORT = '\u0000none';

let hiddenSports = new Set(); // activities switched off
let sportColors = new Map(); // activity → hex, only where it differs

// Both halves are keyed by activity name, and those names have been tidied at
// least once (Road ride → Cycling, Hike → Hiking). A stored key that predates a
// rename would silently match nothing — the colour would just stop applying —
// so everything read back goes through the same canonicaliser the routes did.
// ROUTE_NO_SPORT is the sentinel for "activity not set" and is left alone.
const canonKey = (key) => (key === ROUTE_NO_SPORT ? key : canonicalSport(key));

function adoptRouteView(raw) {
  const hidden = Array.isArray(raw?.hidden) ? raw.hidden : [];
  hiddenSports = new Set(hidden.filter((k) => typeof k === 'string').map(canonKey));
  sportColors = new Map(
    Object.entries(raw?.colors ?? {})
      .filter(([, v]) => /^#[0-9a-f]{6}$/i.test(String(v)))
      .map(([k, v]) => [canonKey(k), v]),
  );
}

function loadRouteView() {
  try {
    adoptRouteView(JSON.parse(localStorage.getItem(ROUTE_VIEW_KEY) || '{}'));
  } catch {
    /* defaults are fine */
  }
}
loadRouteView();

const routeViewJson = () => ({ hidden: [...hiddenSports], colors: Object.fromEntries(sportColors) });

// --- Preferences that follow the account -------------------------------------
// Every colour you choose — the visited wash and one per activity — plus which
// activities are switched off. Written to localStorage on every change (instant,
// and it still works with no server) and pushed to the account debounced, so the
// phone and the laptop agree.
//
// Reconciled by timestamp, and that is the part that used to be wrong. The old
// rule was "on load, the server wins", which quietly undid any change whose push
// had not landed — a tab closed inside the 600 ms debounce, a flaky connection,
// a failed request that nothing retried. The colour looked right until the next
// reload and then vanished, with nothing anywhere saying a save had failed.
// Now each copy carries when it was last touched and the newer one wins; if it
// is the local one, it is pushed back rather than thrown away.
//
// Both stamps come from client clocks, so two devices editing while offline are
// resolved by whichever *thinks* it is later. For one person's colour choices
// that is a fair trade against the machinery real conflict resolution needs.
const PREFS_STAMP_KEY = 'visited-map:prefs-stamp:v1';

let prefsStamp = Number(localStorage.getItem(PREFS_STAMP_KEY)) || 0;
let prefsDirty = false; // a local change the server has not acknowledged
let pushViewTimer = null;

const prefsPayload = () => ({ v: 1, updatedAt: prefsStamp, accent, routeView: routeViewJson() });

/** Note a local change: stamp it, mirror it locally, and schedule the push. */
function touchPrefs() {
  prefsStamp = Date.now();
  prefsDirty = true;
  try {
    localStorage.setItem(PREFS_STAMP_KEY, String(prefsStamp));
    localStorage.setItem(ROUTE_VIEW_KEY, JSON.stringify(routeViewJson()));
    localStorage.setItem(COLOR_KEY, accent);
  } catch {
    /* private mode, quota — the server copy is still attempted */
  }
  clearTimeout(pushViewTimer);
  // Debounced because dragging a colour fires on every frame.
  pushViewTimer = setTimeout(pushPrefs, 600);
}

const saveRouteView = touchPrefs;

async function pushPrefs() {
  clearTimeout(pushViewTimer);
  if (!prefsDirty || !authed) return;
  const sending = prefsStamp;
  try {
    await auth.setPrefs(prefsPayload());
    // Only clear the flag if nothing changed while the request was in flight.
    if (prefsStamp === sending) prefsDirty = false;
  } catch {
    // Not worth interrupting anyone over — but it must not be forgotten either,
    // which is what made a lost colour look like the app's own doing. Retry, and
    // leave the flag set so the unload flush and the next load both catch it.
    clearTimeout(pushViewTimer);
    pushViewTimer = setTimeout(pushPrefs, 5000);
  }
}

// The page going away is the likeliest moment for an unsaved change to exist,
// so it gets a send that survives it. `pagehide` covers closing and navigating;
// `visibilitychange` covers a phone being locked or the app switched away from,
// which on iOS is often the last event a page ever sees.
function flushPrefsOnExit() {
  if (!prefsDirty || !authed) return;
  clearTimeout(pushViewTimer);
  auth.sendPrefs(prefsPayload());
  // Assumed sent. Nothing here can learn otherwise — the page may not be alive
  // to hear the answer — and leaving the flag up would re-send the same blob on
  // every tab switch. If it really did fail, the stamp in localStorage is still
  // ahead of the account's and the next load pushes it again; that comparison,
  // not this flag, is what actually guarantees the change is not lost.
  prefsDirty = false;
}
window.addEventListener('pagehide', flushPrefsOnExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPrefsOnExit();
});

/** Adopt a set of preferences wholesale — from the server, or from a reset. */
function adoptPrefs(prefs) {
  if (prefs.routeView && typeof prefs.routeView === 'object') adoptRouteView(prefs.routeView);
  if (/^#[0-9a-f]{6}$/i.test(String(prefs.accent ?? ''))) {
    accent = String(prefs.accent).toLowerCase();
    colorPicker?.set(accent); // the swatch, and the panel behind it
    applyColors();
    repaintAccent();
  }
  try {
    localStorage.setItem(ROUTE_VIEW_KEY, JSON.stringify(routeViewJson()));
    localStorage.setItem(COLOR_KEY, accent);
  } catch {
    /* fine */
  }
  renderedSports = ''; // the per-activity rows must be rebuilt against the new state
  repaintRouteColors();
  syncRoutes();
}

/**
 * Reconcile this browser's preferences with the account's. Runs on every load,
 * after the routes are known — the rows it rebuilds are built from what the
 * account actually has.
 */
async function syncPrefs() {
  let remote;
  try {
    remote = await auth.getPrefs();
  } catch {
    return; // offline: the local copy stands, and stays flagged if it is dirty
  }
  const verdict = reconcilePrefs({ localStamp: prefsStamp, dirty: prefsDirty, remote });

  if (verdict === 'adopt') {
    prefsStamp = Number(remote?.updatedAt) || 0;
    prefsDirty = false;
    try {
      localStorage.setItem(PREFS_STAMP_KEY, String(prefsStamp));
    } catch {
      /* fine */
    }
    // The visited colour only started being synced after the activity colours
    // were, so an account can hold the second and not the first. Rather than
    // reset it to the default, the one this browser has been using is adopted
    // into the account — which is the answer the person picking it meant.
    const migrate = !/^#[0-9a-f]{6}$/i.test(String(remote.accent ?? '')) && accent !== DEFAULT_ACCENT;
    adoptPrefs(remote);
    if (migrate) touchPrefs();
  } else if (verdict === 'push') {
    prefsDirty = true;
    pushPrefs();
  }
}

const sportKey = (route) => route.sport || ROUTE_NO_SPORT;
const sportLabel = (key) => (key === ROUTE_NO_SPORT ? 'Not set' : key);
const sportColor = (key) => sportColors.get(key) ?? ROUTE_COLOR;

/** Every activity present in the list, most-used first. */
function sportsPresent() {
  const counts = new Map();
  for (const r of routeList) counts.set(sportKey(r), (counts.get(sportKey(r)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] === ROUTE_NO_SPORT) - (b[0] === ROUTE_NO_SPORT) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, n }));
}

// Isolating a route: while set, only this one is drawn. It deliberately beats
// the per-activity filter rather than intersecting with it — you asked to see
// *this* route, and having it stay invisible because its activity happens to be
// switched off would be obtuse.
let soloRoute = null;

const visibleRoutes = () => {
  if (soloRoute != null) return routeList.filter((r) => r.id === soloRoute);
  return routeList.filter((r) => !hiddenSports.has(sportKey(r)));
};

/** Draw only this route, or (with null) go back to everything. */
function setSoloRoute(id) {
  soloRoute = id ?? null;
  updateSoloChip();
  syncRoutes();
}

// The chip is the only way out of isolation that doesn't mean opening a menu,
// so it lives on the map rather than in one.
function updateSoloChip() {
  const chip = document.getElementById('route-solo');
  if (!chip) return;
  const route = soloRoute == null ? null : routeList.find((r) => r.id === soloRoute);
  // The isolated route can vanish under us — deleted, or the list reloaded
  // after a sync. Left set, `visibleRoutes()` would return nothing and the chip
  // that undoes it would be hidden: a map with no routes and no way back.
  if (soloRoute != null && !route) soloRoute = null;
  chip.hidden = !route;
  if (!route) return;
  document.getElementById('route-solo-text').textContent =
    `Showing only ${route.name || 'one route'}`;
}

// One `match` over the feature's own `sport`, so a thousand routes are still one
// paint property rather than a layer each. Only activities actually recoloured
// get a branch; everything else falls through to the default.
function routeColorExpr(mix) {
  const entries = [...sportColors].filter(([, hex]) => hex && hex.toLowerCase() !== ROUTE_COLOR.toLowerCase());
  if (!entries.length) return mix(ROUTE_COLOR);
  const expr = ['match', ['coalesce', ['get', 'sport'], '']];
  for (const [key, hex] of entries) {
    // The blank activity is stored under a sentinel; on the feature it is ''.
    expr.push(key === ROUTE_NO_SPORT ? '' : key, mix(hex));
  }
  expr.push(mix(ROUTE_COLOR));
  return expr;
}

// Pull the route list. Metadata only by default — the lines are a much bigger
// payload, and there's no point fetching them until they're on screen.
async function loadRoutes(withGeom = routesOn) {
  if (!authed) {
    routeList = [];
    routeGeom = false;
    syncRoutes();
    return;
  }
  try {
    routeList = await auth.getRoutes(withGeom);
    routeGeom = withGeom;
  } catch (e) {
    console.warn('Loading routes failed:', e);
    routeList = [];
    routeGeom = false;
  }
  syncRoutes();
  if (routeGeom) namePlaces();
}

// Routes saved before place naming existed have no place. Working one out needs
// the geometry and the (lazy, ~2 MB) place dataset, so it happens here rather
// than at load: whenever the lines are in memory anyway, anything still blank
// gets named and sent back once.
let namingPlaces = false;
async function namePlaces() {
  const blank = routeList.filter((r) => !r.place && r.geom?.length);
  if (!blank.length || namingPlaces) return;
  namingPlaces = true;
  try {
    await loadPlaces();
    const named = [];
    for (const route of blank) {
      const place = describeRoute(route);
      if (!place) continue;
      route.place = place;
      named.push([route.id, place]);
    }
    if (named.length) await auth.setRoutePlaces(named);
  } catch (e) {
    console.warn('Naming routes failed:', e);
  } finally {
    namingPlaces = false;
  }
}

// Push the current list at the map and keep the menu's count honest.
function syncRoutes() {
  updateSoloChip();
  updateRoutesUi();
  const src = map.getSource('routes');
  if (!src) return;
  src.setData(routesOn && routeGeom ? routesToFC(visibleRoutes()) : EMPTY);
  for (const id of ROUTE_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', routesOn ? 'visible' : 'none');
  }
  // Feature state doesn't survive setData, and a basemap switch rebuilds the
  // source from scratch — so the highlight is re-applied here, not once.
  if (selectedRoute != null && routeGeom) {
    map.setFeatureState({ source: 'routes', id: selectedRoute }, { sel: true });
  }
}

function setRoutesOn(on) {
  if (on === routesOn) return;
  routesOn = on;
  saveRoutesPref();
  if (!on) {
    closeRouteInfo();
    soloRoute = null;
    updateSoloChip();
  }
  // First time they're switched on, the geometry still has to be fetched.
  if (on && !routeGeom) loadRoutes(true);
  else syncRoutes();
}

function setSelectedRoute(id) {
  if (selectedRoute === id) return;
  const src = map.getSource('routes');
  if (selectedRoute != null && src) map.removeFeatureState({ source: 'routes', id: selectedRoute }, 'sel');
  selectedRoute = id;
  if (id != null && src) map.setFeatureState({ source: 'routes', id }, { sel: true });
}

function closeRouteInfo() {
  setSelectedRoute(null);
  routeInfo?.hide();
}

// Which saved route is under the pointer, if any. A line a couple of pixels
// wide is hard to hit, so the query gets some slack around the point — and the
// glow layer, being wider, does most of the catching.
function routeAt(point) {
  if (!routesOn || !routeGeom || !map.getLayer('route-line')) return null;
  const pad = 8;
  const hit = map.queryRenderedFeatures(
    [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ],
    { layers: ROUTE_LAYERS },
  )[0];
  if (!hit) return null;
  return routeList.find((r) => r.id === hit.properties?.id) ?? null;
}

// A tap on a route wins over the cell underneath it: you aimed at the line.
function showRouteInfo(route) {
  closeCellInfo();
  setSelectedRoute(route.id);
  routeInfo?.show(route);
}

// Frame a [w, s, e, n] box with the same padding a route gets. Trips and
// searched-for lakes are both "here is an area, look at it" — the only thing
// zoomToRoute does that this doesn't is read the box off a route.
function fitBboxOnMap(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return;
  // A single-cell trip has no extent at all; give it something to fit.
  const pad = Math.max(0.02, (b[2] - b[0]) * 0.08, (b[3] - b[1]) * 0.08);
  map.fitBounds(
    [
      [b[0] - pad, b[1] - pad],
      [b[2] + pad, b[3] + pad],
    ],
    { padding: 60, maxZoom: 13, duration: 800 },
  );
}

function zoomToRoute(route) {
  const b = route.bounds ?? [];
  if (b.length !== 4 || !b.every(Number.isFinite)) return;
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding: 70, maxZoom: 15.5, duration: 700 },
  );
}

// Returns whether it actually went: the routes dialog closes the route it was
// showing on the strength of this, and closing it after a failed delete would
// be telling the user something that isn't so.
async function removeRoute(route) {
  let removed = null;
  try {
    // The answer carries the whole row away with it, geometry included. That
    // copy is the only one there is — the map may never have loaded this line
    // — and it's what Undo puts back.
    ({ route: removed } = await auth.deleteRoute(route.id));
  } catch (e) {
    console.warn('Removing the route failed:', e);
    return false;
  }
  dropRouteLocally(route.id);
  if (removed) {
    // Restoring gives it a new row id, so redo can't close over the old one.
    const at = { id: route.id };
    history.push(
      `deleting ${route.name ? `“${route.name}”` : 'a route'}`,
      async () => {
        const before = new Set(routeList.map((r) => r.id));
        await auth.saveRoutes([removed]);
        await loadRoutes(routesOn);
        const again = routeList.find((r) => !before.has(r.id));
        if (again) at.id = again.id;
        updateRoutesUi();
      },
      async () => {
        await auth.deleteRoute(at.id);
        dropRouteLocally(at.id);
      },
    );
  }
  return true;
}

// Forget a route here, without telling the server — the caller has already
// done that, or is about to.
function dropRouteLocally(id) {
  if (selectedRoute === id) setSelectedRoute(null);
  if (soloRoute === id) soloRoute = null; // nothing left to isolate
  routeList = routeList.filter((r) => r.id !== id);
  updateSoloChip();
  syncRoutes();
}

function updateRoutesUi() {
  const box = document.getElementById('routes-toggle');
  const note = document.getElementById('routes-note');
  if (!box || !note) return;
  box.checked = routesOn;
  // Nothing to show is not a failure — it's an invitation.
  box.disabled = !routeList.length;
  const shown = visibleRoutes();
  // When some activities are switched off, the count has to say so — otherwise
  // "12 routes" next to four lines on the map reads as a bug.
  note.textContent = routeList.length
    ? (shown.length === routeList.length
        ? `${routeList.length === 1 ? '1 route' : `${routeList.length} routes`} · ${formatDistance(totalLength(routeList))}`
        : `${shown.length} of ${routeList.length} shown · ${formatDistance(totalLength(shown))}`)
    : 'Import a GPX or KML track to save one';
  renderRouteOptions();
}

// Static markup, no interpolation — an eye, or an eye with a line through it.
const EYE_ON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4"/><path d="M6.5 7.9A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5a9.9 9.9 0 0 0 4-.8"/></svg>';

// A touch device is where the menu is a full-width sheet on top of the map.
const coarsePointer = window.matchMedia('(pointer: coarse)');
// Set when a tap's only job was to dismiss the menu; cleared by the map's click
// handler on the very next event.
let dismissedMenuOnTap = false;

// --- The per-activity panel --------------------------------------------------
// Behind a chevron, because it is one row per activity and there can be a dozen
// of them; always-open it would push everything below it off the menu.
let routeOptionsOpen = false;
// One picker (and one panel) per activity row. Both are torn down before a
// re-render — see destroy() in src/color-picker.js.
let routePickers = [];
// Which activities the rows currently show, so a state change can be told from
// a list change.
let renderedSports = '';

// Eye state and dimming, without touching the rest of the row.
function refreshRouteOptionStates() {
  const box = document.getElementById('routes-options');
  if (!box) return;
  for (const row of box.querySelectorAll('.route-option')) {
    const shown = !hiddenSports.has(row.dataset.sport);
    const eye = row.querySelector('.route-option-eye');
    eye.classList.toggle('off', !shown);
    eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
    eye.title = shown ? 'Hide these on the map' : 'Show these on the map';
    eye.innerHTML = shown ? EYE_ON_SVG : EYE_OFF_SVG;
  }
  const reset = box.querySelector('.route-option-reset');
  if (reset) reset.hidden = !sportColors.size && !hiddenSports.size;
}

function dropRoutePickers() {
  for (const { picker, panel } of routePickers) {
    picker.destroy();
    panel.remove();
  }
  routePickers = [];
}

function renderRouteOptions() {
  const toggle = document.getElementById('routes-options-toggle');
  const box = document.getElementById('routes-options');
  if (!toggle || !box) return;

  const sports = sportsPresent();
  // Nothing to sort by until there are at least two kinds of thing.
  const worthShowing = routeList.length > 0 && sports.length > 1;
  toggle.hidden = !worthShowing;
  if (!worthShowing) {
    dropRoutePickers();
    renderedSports = '';
    box.replaceChildren();
    box.hidden = true;
    routeOptionsOpen = false;
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  toggle.setAttribute('aria-expanded', routeOptionsOpen ? 'true' : 'false');
  toggle.classList.toggle('open', routeOptionsOpen);
  box.hidden = !routeOptionsOpen;
  if (!routeOptionsOpen) {
    dropRoutePickers();
    renderedSports = '';
    box.replaceChildren();
    return;
  }

  // Toggling an activity changes one row's state, not which rows exist — and
  // rebuilding the list would throw away the colour pickers (and the element
  // under the cursor) for nothing. Only rebuild when the set of activities
  // actually differs.
  const signature = sports.map((x) => `${x.key}:${x.n}`).join('|');
  if (signature === renderedSports && box.childElementCount) {
    refreshRouteOptionStates();
    return;
  }
  renderedSports = signature;
  dropRoutePickers();
  box.replaceChildren();
  for (const { key, n } of sports) {
    const row = document.createElement('div');
    row.className = 'route-option';
    row.dataset.sport = key;

    const shown = !hiddenSports.has(key);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = `route-option-eye${shown ? '' : ' off'}`;
    eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
    eye.title = shown ? 'Hide these on the map' : 'Show these on the map';
    eye.innerHTML = shown ? EYE_ON_SVG : EYE_OFF_SVG;
    eye.addEventListener('click', () => {
      if (hiddenSports.has(key)) hiddenSports.delete(key);
      else hiddenSports.add(key);
      saveRouteView();
      syncRoutes();
    });

    const name = document.createElement('span');
    name.className = 'route-option-name';
    name.textContent = sportLabel(key);
    const count = document.createElement('i');
    count.textContent = String(n);

    // The app's own picker, not the browser's — same panel, same presets and
    // same live-repaint-while-dragging as the visited colour above it.
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch route-option-color';
    swatch.style.setProperty('--swatch', sportColor(key));
    swatch.setAttribute('aria-label', `Color for ${sportLabel(key)}`);
    swatch.title = `Color for ${sportLabel(key)}`;

    const panel = document.createElement('div');
    panel.className = 'menu-popover color-panel';
    panel.hidden = true;
    document.body.append(panel);

    const picker = mountColorPicker({
      button: swatch,
      panel,
      value: sportColor(key),
      place: () => placeBesideMenu(swatch, panel),
      onInput: (hex) => {
        swatch.style.setProperty('--swatch', hex);
        sportColors.set(key, hex);
        saveRouteView();
        repaintRouteColors();
      },
    });
    routePickers.push({ picker, panel });

    row.append(eye, name, count, swatch);
    box.append(row);
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'route-option-reset';
  reset.textContent = 'Reset colors and show all';
  reset.hidden = !sportColors.size && !hiddenSports.size;
  reset.addEventListener('click', () => {
    sportColors.clear();
    hiddenSports.clear();
    saveRouteView();
    for (const row of box.querySelectorAll('.route-option')) {
      row.querySelector('.route-option-color')?.style.setProperty('--swatch', ROUTE_COLOR);
    }
    repaintRouteColors();
    syncRoutes();
  });
  box.append(reset);
}

// Beside the menu where there's room, above it when there isn't (phones, where
// the menu is a full-width sheet) — the same rule the ⓘ note uses. Shared by the
// visited-colour picker and every per-activity one.
function placeBesideMenu(button, panel) {
  const menuBox = document.getElementById('layers-menu').getBoundingClientRect();
  const btnBox = button.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const left = menuBox.right + 10;
  if (left + panelBox.width <= window.innerWidth - 10) {
    // Never off the top or bottom: a row near the end of a long menu would
    // otherwise open its panel past the edge of the window.
    const top = Math.max(10, Math.min(btnBox.top - 12, window.innerHeight - panelBox.height - 10));
    return { left, top };
  }
  return {
    left: menuBox.left + (menuBox.width - panelBox.width) / 2,
    top: menuBox.top - panelBox.height - 10,
  };
}

function repaintRouteColors() {
  if (!map?.getLayer('route-line')) return;
  map.setPaintProperty('route-line', 'line-color', routeLineColor());
  map.setPaintProperty('route-glow', 'line-color', routeGlowColor());
}

// --- Ctrl-paint: hold Ctrl and sweep the cursor to mark cells ----------------
// Purely additive (never erases), so sweeping back over a cell is a no-op —
// use single-click to clear. Panning is suspended while Ctrl is held so a
// drag paints instead of moving the map. Cells are added immediately but the
// (heavier) relight + re-render is batched to one per frame.
let ctrlPaint = false;
let paintDirty = false;

// Sweeping with Ctrl held paints a cell per frame, and re-deriving all five
// levels from all ~20k stored cells each time was more work than a frame has.
// Fold the new cells in instead, and only fall back to the full pass when the
// shortcut can't be exact (see rollUpPainted).
function flushPaint() {
  paintDirty = false;
  const ids = paintQueue.splice(0);
  // Type mode re-ranks the sources and reassigns palette slots on every add, so
  // it always takes the full pass.
  let incremental = !HEAT_MODES[heatMode]?.categorical;
  if (incremental) {
    for (const id of ids) {
      if (!rollUpPainted(id)) {
        incremental = false;
        break;
      }
    }
  }
  if (!incremental) recomputeLit(); // discards the partial roll-up and redoes it
  updateGrid(true);
  updateTiles();
}

// Every cell a single Ctrl-sweep lit. One drag is one thing you did, so it's
// one entry in the history — undoing a sweep across half a canton should not
// mean four hundred presses of Ctrl-Z.
let sweptCells = [];

function paintAt(lngLat) {
  if (currentLevel == null) return;
  const id = cellIdAt(lngLat);
  if (visited.has(id)) return; // already lit — nothing to do
  markCell(id);
  sweptCells.push(id);
  paintQueue.push(id);
  if (!paintDirty) {
    paintDirty = true;
    requestAnimationFrame(flushPaint);
  }
}

function startPaint() {
  if (ctrlPaint || mode !== 'edit') return;
  ctrlPaint = true;
  sweptCells = [];
  setHover(null);
  // Disabling dragPan drops the handler but not MapLibre's inertia buffer: a
  // pan that was already under way still gets its fling, so the map carries on
  // coasting underneath the sweep and paints a smear of cells the cursor never
  // passed over. Only reachable when the button went down before the modifier.
  const wasMoving = map.isMoving() || map.isEasing();
  map.dragPan.disable();
  if (wasMoving) {
    map.stop();
    // map.stop() suppresses the moveend it would otherwise have fired, so the
    // work that handler does has to happen here instead or the grid and the
    // tiles are left showing the camera we just cancelled.
    updateGrid();
    updateTiles();
  }
  if (lastLngLat) paintAt(lastLngLat); // catch the cell already under the cursor
}

function stopPaint() {
  if (!ctrlPaint) return;
  ctrlPaint = false;
  map.dragPan.enable();
  // The gesture is over, so now it's one edit with a size. A sweep that lit
  // nothing new (dragging back over cells already on the map) isn't an edit at
  // all and doesn't go on the stack.
  if (sweptCells.length) {
    const ids = sweptCells;
    const snapshot = snapshotCells(ids);
    sweptCells = [];
    history.push(
      `painting ${plural(ids.length, 'cell')}`,
      () => clearCells(ids),
      () => remarkCells(snapshot),
    );
  }
}

let lastLngLat = null;

// --- Level / coverage logic ----------------------------------------------------
// Level L owns every zoom below LEVEL0_ZOOM - L·LEVEL_STEP, so that expression
// is the boundary between L and L+1.
const levelBoundary = (L) => LEVEL0_ZOOM - L * LEVEL_STEP;

// Once a level is on screen it keeps the map until the zoom is this far past
// the boundary. Without the margin, the wobble at the end of a scroll- or
// pinch-zoom (it overshoots and settles back) crosses the threshold two or
// three times, and every crossing repaints and crossfades the regions — which
// is the flicker you get on the way in or out of a level.
const LEVEL_HYSTERESIS = 0.28;

// --- Pinned detail -------------------------------------------------------------
// By default the level follows the zoom (levelForZoom, below). The Detail
// control in the menu pins it instead: the map then keeps drawing that cell
// size however far you zoom. `null` = auto, which is the default.
//
// Only the two ends are offered. The in-between levels were five buttons that
// all did the same kind of thing, and the honest answer to "which one" was
// "let the zoom decide" — so the choice is now Tiniest (the grid as stored),
// Auto, or Country. Pinning the finest one at world zoom costs no more than it
// does zoomed in: regions are built by iterating the marked cells, not the
// viewport, so the only thing it asks for is what you have already marked.
const DETAIL_KEY = 'visited-map:detail:v1';
const DETAIL_CHOICES = [0, null, COUNTRY_LEVEL];

function savedDetail() {
  const raw = localStorage.getItem(DETAIL_KEY);
  if (!raw || raw === 'auto') return null;
  const L = raw === 'country' ? COUNTRY_LEVEL : Number(raw);
  // A level pinned before the middle of the range was retired has no button to
  // un-pin it any more, so it would sit there unreachable. Auto is what those
  // levels were approximating anyway.
  return DETAIL_CHOICES.includes(L) ? L : null;
}

let detailLevel = savedDetail();
// Set when the pin is released. The level being left behind is one the zoom
// never chose, so the hysteresis below has nothing real to hold on to — asking
// it to decide would keep the pinned size until the map was nudged. One
// pass without it lands straight on the zoom's own level.
let skipHysteresis = false;

// The menu speaks in tokens ('auto', '1'…'4', 'country'); everything else in
// levels, with null for auto.
const detailToken = (L) =>
  L == null ? 'auto' : L === COUNTRY_LEVEL ? 'country' : String(L);
const detailFromToken = (t) =>
  t === 'auto' ? null : t === 'country' ? COUNTRY_LEVEL : Number(t);

function setDetailLevel(next) {
  if (next === detailLevel) return;
  skipHysteresis = next == null;
  detailLevel = next;
  try {
    localStorage.setItem(DETAIL_KEY, detailToken(next));
  } catch {
    /* fine */
  }
  updateLayersUi();
  // A pinned level ignores the zoom, so nothing else would ever ask for the
  // rebuild — force it.
  updateGrid(true);
}

function levelForZoom(zoom, current = null) {
  const raw = Math.min(COUNTRY_LEVEL, Math.max(0, Math.ceil((LEVEL0_ZOOM - zoom) / LEVEL_STEP - 1e-9)));
  // A jump of more than one level means a deliberate leap, not wobble.
  if (current === null || Math.abs(raw - current) !== 1) return raw;
  // Coarsening (zooming out) crosses the current level's own boundary;
  // refining (zooming in) crosses the one below it.
  const boundary = levelBoundary(raw > current ? current : current - 1);
  const held = raw > current ? zoom > boundary - LEVEL_HYSTERESIS : zoom < boundary + LEVEL_HYSTERESIS;
  return held ? current : raw;
}

function paddedMerc() {
  const b = map.getBounds();
  const xMin = mercX(b.getWest());
  const xMax = mercX(b.getEast());
  const yMin = mercY(b.getSouth());
  const yMax = mercY(b.getNorth());
  const px = (xMax - xMin) * VIEW_PAD;
  const py = (yMax - yMin) * VIEW_PAD;
  return {
    xMin: xMin - px,
    xMax: xMax + px,
    yMin: Math.max(-MAX_MERC_Y, yMin - py),
    yMax: Math.min(MAX_MERC_Y, yMax + py),
  };
}

// --- Geometry builders -------------------------------------------------------
// Unvisited tiles: plain inset hexagons (sharp corners) — precomputed once
// per level as offsets from the cell center.
function tileOffsets(R) {
  const hh = (SQRT3 / 2) * R;
  const pts = [
    [R, 0], [R / 2, hh], [-R / 2, hh], [-R, 0], [-R / 2, -hh], [R / 2, -hh],
  ].map(([x, y]) => [x * TILE_INSET, y * TILE_INSET]);
  pts.push([...pts[0]]);
  return pts;
}

// Exact (full-size) hex corner offsets — used for the region boundary edges
// so adjacent visited cells merge seamlessly.
function fullHexOffsets(R) {
  const hh = (SQRT3 / 2) * R;
  return [
    [R, 0], [R / 2, hh], [-R / 2, hh], [-R, 0], [-R / 2, -hh], [R / 2, -hh],
  ];
}

// The six neighbors of (col,row) with the CCW-directed edge shared with each:
// dc = column delta, dr(parity) = row delta, a/b index fullHexOffsets.
const EDGES = [
  { dc: 0, dr: () => 1, a: 1, b: 2 }, // top
  { dc: 1, dr: (p) => p, a: 0, b: 1 }, // NE
  { dc: 1, dr: (p) => p - 1, a: 5, b: 0 }, // SE
  { dc: 0, dr: () => -1, a: 4, b: 5 }, // bottom
  { dc: -1, dr: (p) => p - 1, a: 3, b: 4 }, // SW
  { dc: -1, dr: (p) => p, a: 2, b: 3 }, // NW
];

// Chain directed boundary segments into closed loops. Lit cells emit their
// edges CCW, so outer boundaries come out CCW and holes CW.
function chainSegments(segs) {
  const key = (x, y) => `${Math.round(x)}|${Math.round(y)}`;
  const byStart = new Map();
  segs.forEach((s, i) => {
    const k = key(s[0][0], s[0][1]);
    const arr = byStart.get(k);
    if (arr) arr.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Array(segs.length).fill(false);
  const chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const pts = [segs[i][0], segs[i][1]];
    for (;;) {
      const last = pts[pts.length - 1];
      const candidates = byStart.get(key(last[0], last[1]));
      let next = -1;
      if (candidates) {
        for (const j of candidates) {
          if (!used[j]) {
            next = j;
            break;
          }
        }
      }
      if (next === -1) break;
      used[next] = true;
      pts.push(segs[next][1]);
    }
    chains.push(pts);
  }
  return chains;
}

// Relax a closed loop into a blob. One Chaikin round replaces every corner
// with two points cut in from it; repeating converges on a smooth curve that
// bulges through the middle of each edge and never overshoots the hull, so
// neighbouring regions still flow together exactly where their cells touch.
function smoothLoop(loop, rounds = SMOOTH_ROUNDS) {
  let pts = loop.slice(0, -1); // drop the closing point; the ring is implicit
  if (pts.length < 3) return loop;
  for (let r = 0; r < rounds; r++) {
    const out = new Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      out[i * 2] = [ax + (bx - ax) * SMOOTH_CUT, ay + (by - ay) * SMOOTH_CUT];
      out[i * 2 + 1] = [ax + (bx - ax) * (1 - SMOOTH_CUT), ay + (by - ay) * (1 - SMOOTH_CUT)];
    }
    pts = out;
  }
  pts.push([...pts[0]]);
  return pts;
}

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2; // >0 = CCW in mercator (y up)
};

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Turn the emitted boundary edges into rounded fill polygons (with holes)
// plus one outline feature. buildGrid counts everything outside the built
// window as unlit, so every loop is closed by construction — regions that
// extend past coverage close along the padded, off-screen rim.
function regionFeatures(boundary) {
  const closed = (pts) =>
    pts.length > 3 &&
    Math.round(pts[0][0]) === Math.round(pts[pts.length - 1][0]) &&
    Math.round(pts[0][1]) === Math.round(pts[pts.length - 1][1]);
  const loops = chainSegments(boundary).filter(closed).map((l) => smoothLoop(l));
  const outers = [];
  const holes = [];
  for (const lp of loops) (ringArea(lp) > 0 ? outers : holes).push(lp);

  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      const a = ringArea(outers[i]);
      if (a < bestArea && pointInRing(h[0], outers[i])) {
        best = i;
        bestArea = a;
      }
    }
    if (best >= 0) polys[best].push(h);
  }

  const features = polys.map((rings) => ({
    type: 'Feature',
    properties: { k: 1 },
    geometry: { type: 'Polygon', coordinates: rings.map((r) => r.map(project)) },
  }));
  if (loops.length) {
    features.push({
      type: 'Feature',
      properties: { k: 2 },
      geometry: {
        type: 'MultiLineString',
        coordinates: loops.map((r) => r.map(project)),
      },
    });
  }
  return features;
}

// Region geometry for the padded viewport. Iterates only the LIT cells (not
// the whole window), so cost stays proportional to the number of marked
// cells no matter how far out the map is zoomed.
function buildGrid(bb, L) {
  if (L === COUNTRY_LEVEL) return ensureCountryFC();
  const R = radiusOf(L);
  const colSp = 1.5 * R;
  const rowSp = SQRT3 * R;
  const N = colsOf(L);
  const lit = litSets[L];
  const hexOffs = fullHexOffsets(R);

  let colMin = Math.floor((bb.xMin - R) / colSp);
  let colMax = Math.ceil((bb.xMax + R) / colSp);
  let wholeWorld = false;
  if (colMax - colMin + 1 > N) {
    colMin = 0;
    colMax = N - 1;
    wholeWorld = true;
  }
  const rowMin = Math.floor(bb.yMin / rowSp) - 2;
  const rowMax = Math.ceil(bb.yMax / rowSp) + 2;

  // Lit cells outside the built window count as unlit, so region outlines
  // close along the (padded, off-screen) coverage rim instead of fragmenting
  // when a region extends past coverage.
  const litInWindow = (col, row) =>
    row >= rowMin &&
    row <= rowMax &&
    (wholeWorld || (col >= colMin && col <= colMax)) &&
    lit.has(`${normCol(col, N)}/${row}`);

  // Heat maps need one shape per cell to carry its own value, so the blob
  // merge is off in those modes and cells tile as flat hexagons instead —
  // which is what makes the mosaic readable as data rather than a shape.
  const heat = heatMetric();
  const features = [];
  const boundary = [];

  for (const [key, stat] of lit) {
    const sep = key.indexOf('/');
    const nc = +key.slice(0, sep);
    const row = +key.slice(sep + 1);
    if (row < rowMin || row > rowMax) continue;
    // Every world-copy instance of this canonical column inside the window.
    // N is even, so parity (and the odd-column offset) survives the wrap.
    const kMin = Math.ceil((colMin - nc) / N);
    const kMax = Math.floor((colMax - nc) / N);
    for (let k = kMin; k <= kMax; k++) {
      const col = nc + k * N;
      const p = col & 1;
      const cx = col * colSp;
      const cy = (row + (p ? 0.5 : 0)) * rowSp;
      if (heat) {
        features.push({
          type: 'Feature',
          properties: { k: 1, v: heat(stat, litRange[L]) },
          geometry: {
            type: 'Polygon',
            coordinates: [[...hexOffs, hexOffs[0]].map(([dx, dy]) => project([cx + dx, cy + dy]))],
          },
        });
        continue;
      }
      // Emit boundary edges facing unlit neighbors; shared edges between
      // two lit cells cancel, merging them into one region.
      for (const e of EDGES) {
        if (!litInWindow(col + e.dc, row + e.dr(p))) {
          const [ax, ay] = hexOffs[e.a];
          const [bx, by] = hexOffs[e.b];
          boundary.push([[cx + ax, cy + ay], [cx + bx, cy + by]]);
        }
      }
    }
  }
  if (heat) return { type: 'FeatureCollection', features };
  return { type: 'FeatureCollection', features: regionFeatures(boundary) };
}

// --- Edit-mode tile spotlight ------------------------------------------------
let cursorPx = null; // last pointer position in screen px

function buildTiles() {
  if (currentLevel == null || !cursorPx) return EMPTY;
  const L = currentLevel;
  const R = radiusOf(L);
  const colSp = 1.5 * R;
  const rowSp = SQRT3 * R;
  const N = colsOf(L);
  const lit = litSets[L];
  const offs = tileOffsets(R);

  const c = map.unproject(cursorPx);
  const cxm = mercX(c.lng);
  const cym = mercY(c.lat);
  // Spotlight radius: SPOT_PX on screen, capped so tiny cells can't flood it.
  const rim = map.unproject([cursorPx[0] + SPOT_PX, cursorPx[1]]);
  const hexArea = ((3 * SQRT3) / 2) * R * R;
  const radius = Math.min(
    Math.abs(mercX(rim.lng) - cxm),
    Math.sqrt((SPOT_MAX_CELLS * hexArea) / Math.PI),
  );

  const features = [];
  const colMin = Math.floor((cxm - radius - R) / colSp);
  const colMax = Math.ceil((cxm + radius + R) / colSp);
  for (let col = colMin; col <= colMax; col++) {
    const cx = col * colSp;
    const p = col & 1;
    const off = p ? 0.5 : 0;
    const nc = normCol(col, N);
    const rowLo = Math.floor((cym - radius) / rowSp - off) - 1;
    const rowHi = Math.ceil((cym + radius) / rowSp - off) + 1;
    for (let row = rowLo; row <= rowHi; row++) {
      const cy = (row + off) * rowSp;
      const dist = Math.hypot(cx - cxm, cy - cym);
      if (dist > radius) continue;
      if (lit.has(`${nc}/${row}`)) continue;
      const t = dist / radius;
      let fade = 1;
      if (t > SPOT_FADE_START) {
        const u = (t - SPOT_FADE_START) / (1 - SPOT_FADE_START);
        fade = 1 - u * u * (3 - 2 * u); // smoothstep falloff
      }
      if (fade < 0.03) continue;
      features.push({
        type: 'Feature',
        properties: { id: `${L}/${nc}/${row}`, k: 0, f: Math.round(fade * 100) / 100 },
        geometry: {
          type: 'Polygon',
          coordinates: [offs.map(([dx, dy]) => project([cx + dx, cy + dy]))],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function updateTiles() {
  // Keep the last tile set while fading out of edit mode; it's cleared when
  // the mode tween lands.
  if (mode !== 'edit' && tileVis === 0) return;
  map.getSource('tiles')?.setData(mode === 'edit' ? buildTiles() : EMPTY);
}

// --- Crossfade -------------------------------------------------------------
const fade = { cur: 1, prev: 0, raf: null, timeout: null };

// Outgoing opacity for a true cross-dissolve. Ramping both layers linearly
// looks wrong: the incoming one is composited *over* the outgoing one, so the
// visible density is `cur + prev·(1 − cur)`, which sags in the middle of the
// transition — at heat-map opacity that dip is the "flash" you see when the
// level changes. Deriving prev from cur holds the composite at exactly the
// mode's alpha the whole way across.
function crossPrev(f) {
  const A = regionOpacity();
  return Math.max(0, Math.min(1, (1 - f) / (1 - A * f)));
}

// Hex → hex level change: dissolve the two levels together inside the blob
// canvas. The layer's opacity is untouched, so the visible density is constant
// by construction and there is only ever one texture to keep in sync.
const blobFade = { raf: null, timeout: null };

// Land any canvas dissolve still in flight on its end state. A fast zoom can
// reach the country boundary while a hex → hex dissolve is only halfway: left
// running, the blob would keep morphing between two old levels *while* the
// layer fades out, which reads as a second change inside the same gesture.
function stopBlobFade() {
  if (blobFade.raf) cancelAnimationFrame(blobFade.raf);
  if (blobFade.timeout) clearTimeout(blobFade.timeout);
  blobFade.raf = null;
  blobFade.timeout = null;
  if (blobCur.inTransition()) blobCur.setFade(1);
}

function dissolveBlob(duration = 320) {
  stopVectorFade();
  if (blobFade.raf) cancelAnimationFrame(blobFade.raf);
  if (blobFade.timeout) clearTimeout(blobFade.timeout);
  const t0 = performance.now();
  const finish = () => {
    blobFade.raf = null;
    blobCur.setFade(1);
  };
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / duration));
    blobCur.setFade(1 - Math.pow(1 - t, 3)); // easeOutCubic
    if (t < 1) blobFade.raf = requestAnimationFrame(tick);
    else finish();
  };
  blobFade.raf = requestAnimationFrame(tick);
  // rAF is throttled in a hidden tab; make sure the dissolve always lands.
  blobFade.timeout = setTimeout(() => {
    if (blobFade.raf) {
      cancelAnimationFrame(blobFade.raf);
      finish();
    }
  }, duration + 120);
}

// Drop any layer crossfade still in flight and settle the layers where a
// steady state expects them.
function stopVectorFade() {
  if (fade.raf) cancelAnimationFrame(fade.raf);
  if (fade.timeout) clearTimeout(fade.timeout);
  fade.raf = null;
  fade.timeout = null;
  fade.cur = 1;
  fade.prev = 0;
  // Abandoning a country → blob crossfade leaves the countries sitting on
  // `hex` at a partial opacity that applyFade() would no longer touch. Hand the
  // layer back to the incoming role and put it back at full strength, or the
  // next level that lands there starts out invisible.
  if (hexRole === 'out') {
    hexRole = 'warm';
    applyFade(1);
    applyPrevFade(0);
  }
}

function animateFade(curFrom, curTo, prevFrom, prevTo, duration = 480, cross = false) {
  if (fade.raf) cancelAnimationFrame(fade.raf);
  if (fade.timeout) clearTimeout(fade.timeout);
  const t0 = performance.now();
  const finish = () => {
    fade.raf = null;
    fade.cur = curTo;
    fade.prev = prevTo;
    applyFade(curTo);
    applyPrevFade(prevTo);
    if (prevTo === 0) {
      map.getSource('hex-prev').setData(EMPTY);
      // A blob that was fading out has handed over to the vector level.
      if (blobRole === 'out') blobCur.clear();
      blobRole = 'none';
      if (hexRole === 'out') {
        // The countries have finished fading out where they stood. Keep them
        // tiled and pinned invisible rather than dropping them: the map is now
        // sitting one level from crossing straight back, and re-parsing them at
        // that moment is exactly the stall this avoids. warmCountries() lets
        // them go once the zoom is clear of the boundary.
        hexRole = 'warm';
        applyFade(curTo); // pins hex-fill at 0 for the warm role
      }
    }
  };
  const tick = (now) => {
    // rAF timestamps can precede the performance.now() taken at schedule
    // time — clamp from below or the eased value goes negative.
    const t = Math.min(1, Math.max(0, (now - t0) / duration));
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    fade.cur = curFrom + (curTo - curFrom) * e;
    fade.prev = cross ? crossPrev(fade.cur) : prevFrom + (prevTo - prevFrom) * e;
    applyFade(fade.cur);
    applyPrevFade(fade.prev);
    if (t < 1) fade.raf = requestAnimationFrame(tick);
    else finish();
  };
  fade.raf = requestAnimationFrame(tick);
  // rAF can be throttled in hidden/embedded tabs; make sure the fade lands.
  fade.timeout = setTimeout(() => {
    if (fade.raf) {
      cancelAnimationFrame(fade.raf);
      finish();
    }
  }, duration + 120);
}

// --- Grid updates ----------------------------------------------------------
let currentLevel = null;
let currentAsBlob = false; // whether the live level is on the canvas or vector
let paintedZoom = 0; // zoom the blob canvas was last rasterized at
let coverage = null;

const WORLD_COVERAGE = { xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity };

// Re-feeding a GeoJSON source data it already holds is not free: MapLibre ships
// it to a worker and re-tiles every tile in the cache. The country level used to
// do that on *every move frame* of a zoom-out — country geometry is detailed and
// viewport-independent, so it was both heavy and pure waste, landing right on top
// of the crossfade it was competing with. ensureCountryFC() hands back a stable
// object while nothing has changed, so identity tells "same data" from "rebuilt".
function setHexData(fc) {
  if (fc === hexData) return;
  hexData = fc;
  map.getSource('hex').setData(fc);
}

// Crossing into the country level has to ramp opacity on geometry the map has
// already tiled. Handing `hex` ~800 KB of boundaries at the moment the fade
// starts costs ~60 ms of worker time before a single country can be drawn, and
// by then crossPrev has already pulled the blob down — so the countries arrive
// late and one gesture reads as level → nothing → country. Feeding the same
// data in a zoom level early, pinned invisible, makes the crossing pure ramp.
// The other direction never had this problem: there the countries are already
// on `hex` and simply fade out where they stand, which is why zoom-in looked
// right while zoom-out did not.
const COUNTRY_WARM_ZOOM = levelBoundary(MAX_LEVEL) + 1.2;
// Releasing the tiles again needs its own, much higher threshold. Anything
// close to the warm one churns: zooming around a boundary would drop and
// re-parse 800 KB every time it was crossed. Keep it clear of the L3 ↔ L4
// boundary too, so ordinary zooming between those levels never touches it.
const COUNTRY_COOL_ZOOM = levelBoundary(MAX_LEVEL - 1) + 1;

function warmCountries(level, asBlob) {
  const zoom = map.getZoom();
  // Only safe while the live level lives on the canvas. Without blob support
  // `hex` carries the actual regions and must not be borrowed for anything.
  // Pinned to a hex level, the country crossing can never happen — there is
  // nothing to prepare for, so don't parse the boundaries at all.
  if (asBlob && detailLevel == null && zoom < COUNTRY_WARM_ZOOM) {
    // Only ever borrow `hex` when it is idle — mid-crossfade it is holding a
    // level that is still on screen.
    // 'in' (idle blob level) and 'warm' (already borrowed, possibly cooled back
    // to empty) are both fine to load into. Only 'out' is off limits — there the
    // countries are still on screen, fading.
    if (hexRole === 'out' || !countriesLoaded()) return;
    const fc = ensureCountryFC();
    if (fc === hexData) return;
    // Pin the layer down *before* handing it the geometry, never after.
    hexRole = 'warm';
    setVectorFade('', 0);
    setHexData(fc);
  } else if (hexRole === 'warm' && zoom > COUNTRY_COOL_ZOOM) {
    // Far enough away to give the tiles back — but only the data goes. The role
    // stays 'warm', because `hex` is not the live surface at a blob level
    // either way and raising its opacity here is a flash waiting to happen:
    // setHexData() returns as soon as the worker has been *told* about the
    // empty data, while the tiles on screen are still the countries for another
    // frame or two. hex-fill only becomes visible again when it is genuinely
    // the incoming side, at the country level.
    setHexData(EMPTY);
  }
}

function coverageContainsView() {
  if (!coverage) return false;
  const b = map.getBounds();
  return (
    mercX(b.getWest()) >= coverage.xMin &&
    mercX(b.getEast()) <= coverage.xMax &&
    mercY(b.getSouth()) >= coverage.yMin &&
    mercY(b.getNorth()) <= coverage.yMax
  );
}

// Set while the country boundaries are being fetched, so a zoom gesture doesn't
// queue one callback per frame.
let countryLoadPending = false;

// Load with ?debuglevels to have every committed level change logged with the
// zoom it happened at. A single zoom gesture should produce exactly one line;
// two or three means the level decision itself is oscillating (LEVEL_HYSTERESIS
// too tight) rather than the crossfade misbehaving.
const DEBUG_LEVELS = new URLSearchParams(location.search).has('debuglevels');
const levelName = (L) => (L === COUNTRY_LEVEL ? 'country' : `L${L}`);

function updateGrid(force = false) {
  // The hex sources briefly don't exist while a new basemap style loads.
  if (!map.getSource('hex')) return;
  const bb = paddedMerc();
  // Edit mode always works on the smallest cells: display, spotlight and
  // painting all lock to level 0 so what you see is what gets marked. Outside
  // it, a pinned Detail level wins over the zoom.
  let level;
  if (mode === 'edit') level = 0;
  else if (detailLevel != null) level = detailLevel;
  else {
    level = levelForZoom(map.getZoom(), skipHysteresis ? null : currentLevel);
    skipHysteresis = false;
  }

  // The country level draws from a lazily-fetched 1.4 MB boundary file. Handing
  // over before it lands would dissolve the hexes into an empty map and then
  // pop the countries in a beat later — two visible changes for one zoom. Hold
  // the coarsest hex level until the data is there; the fetch re-runs this.
  if (level === COUNTRY_LEVEL && !countriesLoaded()) {
    if (!countryLoadPending) {
      countryLoadPending = true;
      loadCountries().then(() => {
        countryLoadPending = false;
        updateGrid(true);
      });
    }
    level = currentLevel != null && currentLevel <= MAX_LEVEL ? currentLevel : MAX_LEVEL;
  }

  updateHud(level);
  // Hex levels go through the blob canvas; the country level stays vector.
  const asBlob = BLOBS && level !== COUNTRY_LEVEL && blobCur.isInstalled();
  // Before the early-outs: the whole point is to have this done well ahead of
  // the crossing, and a zoom that never leaves its level still approaches one.
  warmCountries(level, asBlob);
  const levelChanged = level !== currentLevel;
  // The blob canvas is a raster: zooming inside one level stretches it, so
  // repaint once the zoom has drifted enough for that to show — but never in
  // the middle of a gesture. Rasterizing costs tens of milliseconds, and doing
  // it repeatedly while the user is still zooming is both a stutter and a
  // visible pop; the existing image scales with the map perfectly well until
  // they let go.
  const zoomDrift = currentAsBlob && Math.abs(map.getZoom() - paintedZoom) > 0.3;
  if (!force && !levelChanged && !zoomDrift && coverageContainsView()) return;
  if (!force && !levelChanged && zoomDrift && coverageContainsView() && map.isMoving()) return;

  const fc = asBlob ? EMPTY : buildGrid(bb, level);

  const paintBlob = () =>
    blobCur.paint({
      bb,
      level,
      cells: litSets[level],
      colorOf: blobColorOf(level),
      heat: isHeatMode(),
    });

  if (DEBUG_LEVELS && levelChanged && currentLevel !== null) {
    const how = asBlob && currentAsBlob ? 'canvas dissolve' : 'layer crossfade';
    console.log(
      `[levels] ${levelName(currentLevel)} → ${levelName(level)} (${how})` +
        ` at zoom ${map.getZoom().toFixed(3)}, t=${Math.round(performance.now())}ms`,
    );
  }

  if (levelChanged && currentLevel !== null && asBlob && currentAsBlob) {
    // Hex → hex, the common case. The dissolve happens inside the canvas: the
    // outgoing level is frozen, the new one is painted over it, and the layer
    // opacity never moves. Nothing here depends on a texture arriving at the
    // right moment, which is what used to make a single zoom look like two
    // level changes in a row.
    blobCur.beginTransition();
    if (hexRole === 'in') setHexData(fc); // 'warm' is holding the countries ready
    paintBlob(); // composes at t = 0 — still showing the outgoing level
    blobRole = 'none';
    applyFade(1);
    applyPrevFade(0);
    dissolveBlob(LEVEL_FADE_MS);
  } else if (levelChanged && currentLevel !== null) {
    // Crossing the hex ↔ country boundary: the two sides live on different
    // layers, so this one really is a layer crossfade. Whichever side is
    // outgoing already holds a valid texture — nothing is copied, so there is
    // no frame where the old level is missing.
    stopBlobFade();
    blobRole = currentAsBlob ? 'out' : 'in';
    // Blob → country: the countries are new data and have to be loaded onto
    // `hex` as the incoming side. Country → blob: the incoming side is the
    // canvas, so `hex` keeps the countries it has already tiled and fades them
    // out in place — nothing is re-parsed, so nothing blinks.
    hexRole = currentAsBlob ? 'in' : 'out';
    applyFade(0);
    applyPrevFade(1);
    if (hexRole === 'in') setHexData(fc);
    if (asBlob) paintBlob();
    animateFade(0, 1, 1, 0, LEVEL_FADE_MS, true);
  } else {
    // While hexRole is 'out' the vector layers are showing the outgoing
    // countries; feeding them the new level's (empty) data would erase them
    // mid-fade. animateFade's finish() takes care of it.
    if (hexRole === 'in') setHexData(fc);
    if (asBlob) paintBlob();
    // A blob that is mid-fade-out is still on screen: clearing its canvas here
    // would erase it instantly and turn the hand-over to the country level into
    // a pop. The fade's own finish() clears it once it has actually gone.
    else if (blobRole !== 'out') blobCur.clear();
  }

  currentAsBlob = asBlob;
  paintedZoom = map.getZoom();
  currentLevel = level;
  // Country geometry is global — it doesn't depend on where the viewport is,
  // so nothing about a pan or zoom can invalidate it. Claiming the whole world
  // as covered keeps the move handler from re-running this at all.
  coverage = level === COUNTRY_LEVEL ? WORLD_COVERAGE : bb;

  // The info card describes a cell at a particular level, so a zoom that
  // changes the level re-resolves it against the bigger (or smaller) hex.
  if (levelChanged && selection && lastInfoLngLat) showCellInfoAt(lastInfoLngLat);
}

// --- Hover (tweened via feature-state for a soft glass highlight) ----------
const hoverAnim = new Map(); // cellId -> { v, target }
let hoveredId = null;
let hoverRaf = null;

function hoverLoop() {
  let active = false;
  for (const [id, s] of hoverAnim) {
    s.v += (s.target - s.v) * 0.18;
    if (Math.abs(s.target - s.v) < 0.01) {
      s.v = s.target;
      if (s.v === 0) hoverAnim.delete(id);
    } else {
      active = true;
    }
    map.setFeatureState({ source: 'tiles', id }, { hoverT: s.v });
  }
  hoverRaf = active ? requestAnimationFrame(hoverLoop) : null;
}

function setHover(id) {
  if (id === hoveredId) return;
  if (hoveredId) {
    const s = hoverAnim.get(hoveredId) ?? { v: 1 };
    hoverAnim.set(hoveredId, { ...s, target: 0 });
  }
  hoveredId = id;
  if (id) {
    const s = hoverAnim.get(id) ?? { v: 0 };
    hoverAnim.set(id, { ...s, target: 1 });
  }
  if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverLoop);
}

// --- Mode switching ----------------------------------------------------------
let modeRaf = null;

function setMode(next) {
  if (!EDIT_ENABLED) next = 'view';
  if (next === mode) return;
  mode = next;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* fine */
  }
  if (mode !== 'edit') stopPaint();
  setHover(null);
  closeCellInfo(); // the cards belong to view mode; clicks now paint
  closeRouteInfo();
  updateModeUi();
  // Re-lock the region level: edit mode pins to level 0 (smallest cells),
  // view mode returns to the zoom-appropriate level. Crossfades either way.
  updateGrid(true);
  if (mode === 'edit') updateTiles();

  // Tween the tile spotlight in/out.
  if (modeRaf) cancelAnimationFrame(modeRaf);
  const from = tileVis;
  const to = mode === 'edit' ? 1 : 0;
  const t0 = performance.now();
  const D = 280;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / D));
    const e = 1 - Math.pow(1 - t, 3);
    tileVis = from + (to - from) * e;
    applyTileVis();
    if (t < 1) {
      modeRaf = requestAnimationFrame(tick);
    } else {
      modeRaf = null;
      if (to === 0) map.getSource('tiles')?.setData(EMPTY);
    }
  };
  modeRaf = requestAnimationFrame(tick);
}

// --- HUD ---------------------------------------------------------------------
const hud = document.getElementById('hud');
const hudPanel = document.getElementById('hud-panel');
const hudSize = document.getElementById('hud-size');
const hudRes = document.getElementById('hud-res');
const hudVisited = document.getElementById('hud-visited');
const colorInput = document.getElementById('hud-color');
const hudPencil = document.getElementById('hud-pencil');
const hudDone = document.getElementById('hud-done');

// Editing is opt-in: the pencil only exists once you switch it on in the menu,
// so the default map is a clean view-only surface you can't scribble on.
const EDIT_UI_KEY = 'visited-map:editui:v1';
let editUi = EDIT_ENABLED && localStorage.getItem(EDIT_UI_KEY) === 'on';

function setEditUi(on) {
  editUi = EDIT_ENABLED && on;
  try {
    localStorage.setItem(EDIT_UI_KEY, editUi ? 'on' : 'off');
  } catch {
    /* fine */
  }
  if (!editUi && mode === 'edit') setMode('view'); // also calls updateModeUi
  else updateModeUi();
}

function updateModeUi() {
  hud.hidden = !EDIT_ENABLED || !editUi;
  const editing = mode === 'edit';
  hudPencil.hidden = editing;
  hudPanel.hidden = !editing;
  document.body.classList.toggle('editing', editing);
  const box = document.getElementById('edit-toggle');
  if (box) box.checked = editUi;
  // One cursor for the whole of edit mode. It used to swap to a crosshair while
  // a paint sweep was armed, and macOS draws the pointing hand from its
  // fingertip but the crosshair from its centre — so arming and disarming
  // shifted the visible pointer by several pixels and back, without anything
  // having actually moved.
  map.getCanvas().style.cursor = editing ? 'crosshair' : '';
}

function updateHud(level) {
  if (level == null) return;
  if (level === COUNTRY_LEVEL) {
    hudSize.textContent = 'Countries';
    hudRes.textContent = '—';
  } else {
    hudSize.textContent = cellSizeKm(level);
    hudRes.textContent = String(level);
  }
  hudVisited.textContent = String(visited.size);
  updateDetailNow(level);
}

// The Detail buttons are bare numbers, and a cell's ground size depends on the
// latitude you're looking at — so the section says what is actually on screen.
// Outside edit mode this is the only place that shows it.
const detailNow = document.getElementById('detail-now');

function updateDetailNow(level = currentLevel) {
  if (level == null) return;
  detailNow.textContent =
    level === COUNTRY_LEVEL ? 'Showing whole countries' : `Showing ${cellSizeKm(level)} cells`;
}

// --- Basemap / overlay controls ----------------------------------------------
const layersBtn = document.getElementById('layers-btn');
const layersMenu = document.getElementById('layers-menu');
const railToggle = document.getElementById('rail-toggle');
// `setStyle()` rebuilds MapLibre's entire style asynchronously. Keep the
// checkbox as the source of truth while that happens, then reconcile the
// actual layer once our custom sources/layers are ready again.
let styleReady = false;

function setStyleKey(key) {
  if (!STYLES[key] || key === styleKey) return;
  styleKey = key;
  try {
    localStorage.setItem(STYLE_KEY, key);
  } catch {
    /* fine */
  }
  // setStyle() drops our layers; the 'style.load' handler (installGrid)
  // rebuilds them, re-adds the rail overlay if on, and restores opacities.
  styleReady = false;
  updateLayersUi();
  // Built styles are fetched and rewritten before they can be handed over, so
  // this is async — but the key and the UI have already moved, and a slow fetch
  // must not be able to apply over a basemap the user has since switched away
  // from.
  Promise.all([
    resolveStyle(key),
    map.isStyleLoaded() ? Promise.resolve() : new Promise((r) => map.once('style.load', r)),
  ]).then(([style]) => {
    if (style && styleKey === key) map.setStyle(style);
  });
}

function setRail(on) {
  railOn = on;
  updateLayersUi();
  syncRailLayer();
}

function syncRailLayer() {
  // A click during initial load or a basemap switch is intentionally deferred;
  // installGrid() calls this again for the newly loaded style.
  if (!styleReady) return;
  if (railOn) {
    addRailLayer();
  } else {
    if (map.getLayer('rail')) map.removeLayer('rail');
    if (map.getSource('rail')) map.removeSource('rail');
  }
}

const dateShort = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const legendEndLabel = (sec) => (sec ? dateShort.format(new Date(sec * 1000)) : '');

function updateLayersUi() {
  for (const btn of layersMenu.querySelectorAll('[data-style]')) {
    btn.classList.toggle('active', btn.dataset.style === styleKey);
  }
  for (const btn of layersMenu.querySelectorAll('[data-heat]')) {
    btn.classList.toggle('active', btn.dataset.heat === heatMode);
  }
  const token = detailToken(detailLevel);
  for (const btn of layersMenu.querySelectorAll('[data-detail]')) {
    btn.classList.toggle('active', btn.dataset.detail === token);
  }
  updateDetailNow();
  railToggle.checked = railOn;
  updateRoutesUi();

  // The picker only means anything in single-color mode.
  const heat = HEAT_MODES[heatMode];
  document.getElementById('color-row').hidden = isHeatMode();

  // Type has categories rather than a range: one swatch per source, ordered
  // the way the palette was handed out, so the list matches the map.
  const typeLegend = document.getElementById('type-legend');
  typeLegend.hidden = !heat.categorical;
  if (heat.categorical) {
    typeLegend.replaceChildren();
    if (!sourceOrder.length) {
      const empty = document.createElement('span');
      empty.className = 'legend-empty';
      empty.textContent = 'Nothing on the map yet';
      typeLegend.append(empty);
    }
    const labels = sourceOrder.map(sourceLabel);
    // Two columns unless a name would be clipped to nothing in one; then give
    // every entry the full width rather than truncating half of them.
    typeLegend.classList.toggle('wide', labels.some((l) => l.length > 16));
    for (const [i, label] of labels.entries()) {
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.title = label;
      const dot = document.createElement('i');
      dot.style.background = TYPE_COLORS[i] ?? TYPE_OTHER_COLOR;
      const name = document.createElement('span');
      name.textContent = label;
      key.append(dot, name);
      typeLegend.append(key);
    }
  }

  // Legend: the ramp itself, plus what its ends stand for right now.
  const legend = document.getElementById('heat-legend');
  legend.hidden = !heat.ramp;
  if (heat.ramp) {
    // background-image, not the `background` shorthand: the shorthand resets
    // background-repeat to `repeat`, and a tiled gradient wraps its ends around
    // into the bar's edges.
    document.getElementById('legend-bar').style.backgroundImage =
      `linear-gradient(90deg, ${heat.ramp.join(', ')})`;
    const r = litRange[Math.min(currentLevel ?? 0, MAX_LEVEL)] ?? {};
    let [lo, hi] = heat.legend;
    if (heatMode === 'visits') hi = `${(r.maxHits ?? 1).toLocaleString()} visits`;
    if (heatMode === 'oldest' && r.maxAge) {
      lo = legendEndLabel(r.minAge);
      hi = legendEndLabel(r.maxAge);
    }
    document.getElementById('legend-min').textContent = lo;
    document.getElementById('legend-max').textContent = hi;
  }
  // Let the CSS restyle the glass panels for light basemaps (dark text/glass)
  // so they don't become white-on-white.
  document.documentElement.dataset.theme = STYLES[styleKey].theme;
}

// Things that must be dismissed when the menu closes (the colour picker).
const menuClosers = [];

function setMenuOpen(open) {
  layersMenu.hidden = !open;
  if (!open) for (const close of menuClosers) close();
  // On phones the menu becomes a bottom sheet and the buttons underneath it
  // get out of the way.
  document.body.classList.toggle('menu-open', open);
  if (open) updateLayersUi();
}

function wireLayersControl() {
  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(layersMenu.hidden);
  });
  // Click-away closes the menu — but "away" has to be decided when the press
  // lands, not when the click resolves. A control inside the menu that redraws
  // its own row (the per-activity eye) detaches the very element that was
  // clicked, so by the time this handler runs `e.target` is an orphan and
  // `contains()` says false: the menu closed itself every time you toggled an
  // activity. Recording it on pointerdown, while the element is still in the
  // tree, is what makes that impossible.
  let pressedInsideMenu = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      pressedInsideMenu = layersMenu.contains(e.target) || layersBtn.contains(e.target);
    },
    true,
  );
  document.addEventListener('click', (e) => {
    if (layersMenu.hidden || pressedInsideMenu) return;
    if (layersMenu.contains(e.target) || layersBtn.contains(e.target)) return;
    // Remember that this tap was spent closing the menu, so the map's own click
    // handler can let it go by. Only where the menu covers the map.
    if (coarsePointer.matches && map.getCanvasContainer().contains(e.target)) {
      dismissedMenuOnTap = true;
    }
    setMenuOpen(false);
  });
  for (const btn of layersMenu.querySelectorAll('[data-style]')) {
    btn.addEventListener('click', () => setStyleKey(btn.dataset.style));
  }
  for (const btn of layersMenu.querySelectorAll('[data-heat]')) {
    btn.addEventListener('click', () => setHeatMode(btn.dataset.heat));
  }
  for (const btn of layersMenu.querySelectorAll('[data-detail]')) {
    btn.addEventListener('click', () => setDetailLevel(detailFromToken(btn.dataset.detail)));
  }
  railToggle.addEventListener('change', () => setRail(railToggle.checked));
  document.getElementById('route-solo-clear').addEventListener('click', () => {
    setSoloRoute(null);
    routeInfo?.setSolo(false);
  });
  document.getElementById('routes-toggle').addEventListener('change', (e) => setRoutesOn(e.target.checked));
  document.getElementById('routes-options-toggle').addEventListener('click', () => {
    routeOptionsOpen = !routeOptionsOpen;
    renderRouteOptions();
  });
  document.getElementById('edit-toggle').addEventListener('change', (e) => setEditUi(e.target.checked));

  // The menu used to carry an "i" beside almost every row, each opening a
  // paragraph in a floating popover. Eleven of them made a short panel look
  // like documentation, and the one that was actually worth reading — what
  // importing does to your files — is now in the import dialog itself, where
  // the question comes up. The rest were explaining controls that say what
  // they do.
  //
  // The colour picker still floats, and it is still anchored to a row inside
  // the scroll area, so a scroll would leave it pointing at nothing.
  layersMenu.querySelector('.menu-scroll')?.addEventListener('scroll', () => colorPicker?.close());
  menuClosers.push(() => colorPicker?.close());

  updateLayersUi();
}

// --- Layer setup (re-runs on every style load) -------------------------------
// setStyle() replaces the whole style, dropping our sources/layers, so this
// runs again after each basemap switch to rebuild them and restore state.
const RAIL_BEFORE = () => (map.getLayer('tile-fill') ? 'tile-fill' : undefined);
let firstInstall = true;

function addRailLayer() {
  if (map.getSource('rail')) return;
  map.addSource('rail', RAIL_SOURCE);
  // Sit above the basemap but beneath our tiles/regions.
  map.addLayer(
    { id: 'rail', type: 'raster', source: 'rail', paint: { 'raster-opacity': 0.85 } },
    RAIL_BEFORE(),
  );
}

// Where the basemap's labels begin — the layer to sit *under* if you want to be
// above every road, water and boundary but still let the place names win.
//
// `firstSymbol` is not that place: CARTO's styles put a few label layers (the
// first is `waterway_label`) *before* all the road layers, so inserting there
// lands below every street. That is exactly right for the visited wash, which
// should read as tinted ground with the streets drawn on top of it — and
// exactly wrong for a route, which came out chopped into dashes wherever a road
// casing crossed it.
function labelStart() {
  const layers = map.getStyle().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].type !== 'symbol') return layers[i + 1]?.id;
  }
  return undefined;
}

function installGrid() {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
  const isRegion = ['==', ['get', 'k'], 1];
  const isBoundary = ['==', ['get', 'k'], 2];
  const boundLineColor = mixWithWhite(accent, 0.45);
  const tc = tileColors();

  // Tile spotlight (below the region layers).
  map.addSource('tiles', { type: 'geojson', data: EMPTY, promoteId: 'id', tolerance: 0 });
  map.addLayer({
    id: 'tile-fill', type: 'fill', source: 'tiles',
    paint: { 'fill-color': tc.fill, 'fill-opacity': tileFillOpacity(), 'fill-antialias': true },
  }, firstSymbol);
  map.addLayer({
    id: 'tile-line', type: 'line', source: 'tiles', layout: lineLayout,
    paint: { 'line-color': tc.line, 'line-opacity': tileLineOpacity(), 'line-width': tileLineWidth, 'line-blur': 0.4 },
  }, firstSymbol);

  // Blob canvases sit between the tiles and the vector region layers; only one
  // of the two paths carries the current level at a time.
  if (BLOBS) {
    blobCur.install(firstSymbol, 0);
  }

  for (const suffix of ['-prev', '']) {
    const src = `hex${suffix}`;
    // A style swap recreates the sources empty, so forget what the old ones
    // held — including any pre-warmed country geometry, which is gone with them.
    if (suffix === '') {
      hexData = EMPTY;
      hexRole = 'in';
    }
    map.addSource(src, { type: 'geojson', data: EMPTY, tolerance: 0 });
    map.addLayer({
      // Fill layers render LineStrings too (implicitly closed) — filter to
      // the k=1 polygons or the k=2 outline gets double-filled per tile.
      id: `hex-fill${suffix}`, type: 'fill', source: src, filter: isRegion,
      paint: { 'fill-color': heatColorExpr(), 'fill-opacity': 0, 'fill-antialias': true },
    }, firstSymbol);
    map.addLayer({
      id: `hex-bound-glow${suffix}`, type: 'line', source: src, filter: isBoundary, layout: lineLayout,
      paint: { 'line-color': accent, 'line-opacity': 0, 'line-width': boundGlowWidth, 'line-blur': 5 },
    }, firstSymbol);
    map.addLayer({
      id: `hex-bound-line${suffix}`, type: 'line', source: src, filter: isBoundary, layout: lineLayout,
      paint: { 'line-color': boundLineColor, 'line-opacity': 0, 'line-width': boundLineWidth, 'line-blur': 0.4 },
    }, firstSymbol);
  }

  // Saved routes go above the regions *and* above the basemap's own lines: a
  // line you actually walked reading as if it ran under the streets looks like
  // a bug. `promoteId` makes the route's own id the feature id, so the selected
  // one can be widened through feature-state instead of a second layer.
  const beforeLabels = labelStart();
  map.addSource('routes', { type: 'geojson', data: EMPTY, promoteId: 'id' });
  map.addLayer({
    id: 'route-glow', type: 'line', source: 'routes',
    layout: { ...lineLayout, visibility: routesOn ? 'visible' : 'none' },
    paint: {
      'line-color': routeGlowColor(),
      'line-opacity': routeGlowOpacity(),
      'line-width': routeWidth(ROUTE_GLOW_SCALE),
      'line-blur': 4,
    },
  }, beforeLabels);
  map.addLayer({
    id: 'route-line', type: 'line', source: 'routes',
    layout: { ...lineLayout, visibility: routesOn ? 'visible' : 'none' },
    paint: {
      'line-color': routeLineColor(),
      'line-opacity': 0.95,
      'line-width': routeWidth(1),
    },
  }, beforeLabels);

  // Highlight ring for the cell being inspected in view mode — added last so
  // it sits above the region fills.
  map.addSource('sel', { type: 'geojson', data: EMPTY, tolerance: 0 });
  map.addLayer({
    id: 'sel-line', type: 'line', source: 'sel', layout: lineLayout,
    paint: {
      'line-color': mixWithWhite(accent, 0.75),
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.6, 17, 2.6],
      'line-opacity': 0.95,
    },
  }, firstSymbol);

  styleReady = true;
  syncRailLayer();

  // Repopulate geometry for the new style and restore the current opacities.
  applyColors();
  applyTileVis();
  updateGrid(true);
  updateTiles();
  updateSelection();
  syncRoutes();
  if (firstInstall) {
    firstInstall = false;
    animateFade(0, 1, 0, 0, 800); // gentle first reveal
  } else {
    applyFade(fade.cur);
    applyPrevFade(fade.prev);
  }
}

// 'style.load' fires as soon as the style JSON is ready — before every tile —
// and again after each setStyle().
map.on('style.load', installGrid);

// The saved basemap may be one that has to be built (fetched and recoloured),
// which the constructor above could not wait for.
//
// Both waits matter. The build has to finish, obviously — but so does the
// placeholder's own load: calling setStyle() while a style is still loading
// makes MapLibre log "Unable to perform style diff … Rebuilding the style from
// scratch" and land in a state where the new sources are registered but nothing
// draws. The map came up as a single flat colour with no tiles and no routes.
if (STYLES[styleKey].build) {
  const wanted = styleKey;
  Promise.all([
    resolveStyle(wanted),
    map.isStyleLoaded() ? Promise.resolve() : new Promise((r) => map.once('style.load', r)),
  ]).then(([style]) => {
    if (style && styleKey === wanted) {
      styleReady = false;
      map.setStyle(style);
    }
  });
}

// --- Interaction wiring (bound once; map + DOM persist across setStyle) -------
const isCtrl = (e) => e.ctrlKey || e.metaKey;

{
  map.on('click', (e) => {
    // On a phone the menu is a sheet over the map, so the tap that dismisses it
    // is aimed at the sheet, not at the ground behind it — marking a cell or
    // opening an info card there is never what was meant. The menu is closed by
    // the click-away handler; this only makes sure the map ignores the same tap.
    // Desktop is left alone: there the menu sits beside the map, so a click on
    // the map really is a click on the map.
    if (dismissedMenuOnTap) {
      dismissedMenuOnTap = false;
      return;
    }
    if (currentLevel == null) return;
    if (mode !== 'edit') {
      // A tap that landed on a saved route is about the route, not the ground
      // under it; otherwise view mode inspects the cell.
      const route = routeAt(e.point);
      if (route) showRouteInfo(route);
      else showCellInfoAt(e.lngLat);
      return;
    }
    if (isCtrl(e.originalEvent)) return; // Ctrl gesture is handled as painting
    toggleCell(cellIdAt(e.lngLat));
  });

  let hoverPending = false;
  map.on('mousemove', (e) => {
    cursorPx = [e.point.x, e.point.y];
    lastLngLat = e.lngLat;
    // View mode: show that the line under the cursor is tappable. Skipped
    // mid-gesture, where a hit test would be both wasted and misleading.
    if (mode !== 'edit' && routesOn && routeGeom && !map.isMoving()) {
      map.getCanvas().style.cursor = routeAt(e.point) ? 'pointer' : '';
    }
    if (mode !== 'edit' || currentLevel == null) return;
    // Keep the paint gesture in sync with the live modifier state (covers the
    // case where Ctrl is pressed/released without a separate key event, e.g.
    // after an OS shortcut stole focus).
    if (isCtrl(e.originalEvent)) startPaint();
    else stopPaint();
    if (ctrlPaint) {
      paintAt(e.lngLat); // painting schedules its own re-render
      return;
    }
    // While the map is panning/zooming, leave the spotlight where it is: it's
    // anchored to the map, so it rides along and stays under the cursor (the
    // grabbed point follows the cursor during a drag). Rebuilding here would
    // use a mid-drag camera and make it swim. moveend re-anchors it.
    if (map.isMoving()) return;
    setHover(cellIdAt(e.lngLat));
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      updateTiles();
    });
  });
  map.getCanvas().addEventListener('mouseleave', () => setHover(null));

  // The modifier state carried on the button-press itself, checked before
  // MapLibre sees it.
  //
  // Everything else here learns about Ctrl/Cmd from a keydown or from a later
  // mousemove, and both can miss: the page only gets a keydown if it had focus
  // when the key went down — Cmd-Tabbing back into the window and dragging
  // straight away never produces one — and once MapLibre has started a pan it
  // stops emitting `mousemove`, so the check in that handler never runs again.
  // The gesture then panned the map instead of painting, which read as the map
  // jerking sideways before a single cell finally got colored on release.
  //
  // Capture phase, because MapLibre's own mousedown listener is on this element
  // and starting the pan is exactly what has to be pre-empted.
  map.getCanvasContainer().addEventListener(
    'mousedown',
    (e) => {
      if (mode !== 'edit' || !isCtrl(e)) return;
      // Paint from where the button actually went down rather than wherever the
      // pointer was last seen moving, which may be stale or somewhere else.
      const box = map.getCanvasContainer().getBoundingClientRect();
      lastLngLat = map.unproject([e.clientX - box.left, e.clientY - box.top]);
      startPaint();
    },
    true,
  );

  // Ctrl held while stationary should still start/stop the paint gesture.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') startPaint();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') stopPaint();
  });
  window.addEventListener('blur', stopPaint);

  hudPencil.addEventListener('click', () => setMode('edit'));
  hudDone.addEventListener('click', () => setMode('view'));
  // The accent picker. Repainting on every drag frame is the point — you pick
  // the color against the map itself, not against a swatch.
  colorPicker = mountColorPicker({
    button: colorInput,
    panel: document.getElementById('color-panel'),
    value: accent,
    place: () => placeBesideMenu(colorInput, document.getElementById('color-panel')),
    onInput: (hex) => {
      accent = hex;
      // Stored the same way as the activity colours, and for the same reason:
      // the visited colour is a choice about the account, not about this
      // laptop. It used to be localStorage only, so picking it here left the
      // phone on the old one for good.
      touchPrefs();
      applyColors();
      repaintAccent();
    },
  });

  wireLayersControl();

  cellInfo = mountCellInfo({ onClose: () => closeCellInfo() });
  routeInfo = mountRouteInfo({
    onClose: () => closeRouteInfo(),
    onZoom: zoomToRoute,
    // Everything that changes a route lives in one place now; the card hands
    // over to it rather than being a second editor.
    onMore: (route) => {
      closeRouteInfo();
      stats.openRoute(routeList.find((r) => r.id === route.id) ?? route);
    },
    // Toggle: a second press on an already-isolated route puts the rest back.
    onOnly: (route) => {
      setSoloRoute(soloRoute === route.id ? null : route.id);
      routeInfo?.setSolo(soloRoute === route.id);
    },
    isSolo: (route) => soloRoute === route.id,
  });

  // The file importer, first entry behind "Import & sync": parses the file in
  // the browser, previews what it found, then merges the cells server-side.
  const importer = mountImport({
    onKomoot: () => komootUi.open(),
    onClose: () => sync?.open(),
    knownCells: () => visited,
    knownSources: () => [...new Set([...cellMeta.values()].flat().map((m) => m.source))],
    onImported: async ({ routes = false } = {}) => {
      await hydrateVisited();
      // Saving a track and not seeing it would just be confusing, so the first
      // import that carries one switches the layer on.
      if (routes && !routesOn) {
        routesOn = true;
        saveRoutesPref();
      }
      await loadRoutes(routesOn);
      updateLayersUi();
    },
  });
  // Two doors, split by which way the data is going: everything that brings it
  // in behind one, everything that takes it back out behind the other. Each
  // entry hands off to its own dialog and comes back to its hub on Back.
  let sync = null;
  let settings = null;
  homeAssistant = mountHomeAssistant({
    onSynced: () => hydrateVisited(),
    onClose: () => sync?.open(),
    onLink: (link) => {
      let text;
      if (!link) text = 'Not connected';
      else if (!link.enabled) text = 'Connected · paused';
      else if (link.lastError) text = 'Connected · last sync failed';
      else {
        const every = link.intervalMin >= 60 ? `${link.intervalMin / 60} h` : `${link.intervalMin} min`;
        text = `Syncing every ${every}`;
      }
      sync?.setHaStatus(text);
    },
  });
  // Komoot is a one-off import, not a connected account that polls on a timer,
  // so it lives behind "Import locations" with the files rather than in Sync
  // alongside Home Assistant and Strava. Back therefore returns to the importer.
  const komootUi = mountKomoot({
    knownCells: () => visited,
    onClose: () => importer?.open(),
    onImported: async ({ routes = false } = {}) => {
      await hydrateVisited();
      if (routes && !routesOn) {
        routesOn = true;
        saveRoutesPref();
      }
      await loadRoutes(routesOn);
      updateLayersUi();
    },
  });
  const afterActivities = async () => {
    await hydrateVisited();
    if (!routesOn) {
      routesOn = true;
      saveRoutesPref();
    }
    await loadRoutes(routesOn);
    updateLayersUi();
  };
  stravaUi = mountStrava({
    onSynced: afterActivities,
    onClose: () => sync?.open(),
    onLink: (l) => {
      let text;
      if (!l) text = 'Not connected';
      else if (!l.connected) text = 'Set up · not signed in';
      else if (!l.enabled) text = 'Connected · paused';
      else if (l.lastError) text = 'Connected · last sync failed';
      else {
        const every = l.intervalMin >= 60 ? `${l.intervalMin / 60} h` : `${l.intervalMin} min`;
        text = `Syncing every ${every}`;
      }
      sync?.setStravaStatus(text);
    },
  });
  // Backups are the one entry in Sync that goes the other way: everything else
  // pulls data in, this writes the whole database out on a schedule.
  backupUi = mountBackup({
    onClose: () => settings?.open(),
    onStatus: () => settings?.setBackupStatus(backupUi.summary()),
  });
  sync = mountSync({ homeAssistant, strava: stravaUi, files: importer });
  settings = mountSettings({ backup: backupUi });
  document.getElementById('sync-open').addEventListener('click', () => {
    setMenuOpen(false);
    sync.open();
  });
  document.getElementById('settings-open').addEventListener('click', () => {
    setMenuOpen(false);
    settings.open();
  });

  // Search: one field over the map for the three things it holds — a place to
  // go and look at, a route you remember the name of, and a day you remember
  // the date of.
  // Cmd/Ctrl-K is handled inside the palette (it has to be, to toggle itself
  // closed); this is the same job for every other way in.
  const search = mountSearch({
    trips: () => stats.trips() ?? [],
    routes: () => routeList,
    days: () => activeDays(cellMeta, routeList),
    meta: () => cellMeta,
    onPlace: (lngLat, { bounds } = {}) => {
      if (bounds?.length === 4) fitBboxOnMap(bounds);
      else map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: 11, duration: 900 });
    },
    onTrip: (trip) => {
      fitBboxOnMap(trip.bbox);
      showToast(`${trip.name} · ${trip.cells.length.toLocaleString()} cells`);
    },
    onRoute: async (route) => {
      if (!routesOn) setRoutesOn(true);
      if (!routeGeom) await loadRoutes(true);
      setSoloRoute(route.id);
      zoomToRoute(route);
      showRouteInfo(routeList.find((r) => r.id === route.id) ?? route);
    },
    // However it was opened — the button or Cmd-K — the trips fill in behind
    // the field rather than in front of it. Deriving them is a sweep of the map
    // and a 2 MB dataset, and making you wait to type is the wrong way round.
    onOpen: () => {
      stats.ensureTrips().then(() => search.refresh()).catch(() => {});
    },
  });
  document.getElementById('search-btn').addEventListener('click', () => {
    setMenuOpen(false);
    search.open();
  });

  const stats = mountStats({
    cells: () => visited,
    meta: () => cellMeta,
    routes: () => routeList,
    // Picking a route in the list opens it in the dialog; "Show on map" is the
    // one that closes the panel, switches the layer on and flies there.
    onShowRoute: async (route) => {
      stats.close();
      if (!routesOn) setRoutesOn(true);
      if (!routeGeom) await loadRoutes(true);
      // Isolated by default: coming from the list you picked one route out of
      // eighty-two, and dropping it into all eighty-two is not showing it to
      // you. The chip on the map puts the others back.
      setSoloRoute(route.id);
      zoomToRoute(route);
      showRouteInfo(routeList.find((r) => r.id === route.id) ?? route);
    },
    // A trip is ground, not a line: there is nothing to select, so showing one
    // means framing it. The toast names it because the map itself can't —
    // twelve scattered blobs don't say "Iceland, last August".
    onShowTrip: (trip) => {
      fitBboxOnMap(trip.bbox);
      showToast(`${trip.name} · ${trip.cells.length.toLocaleString()} cells`);
    },
    // The dialog edits the same objects routeList holds, so only the drawn
    // labels need refreshing — same as the card on the map.
    onRouteEdited: (route, before) => {
      updateRoutesUi();
      if (!before) return;
      const after = { name: route.name, sport: route.sport, source: route.source, sportGuessed: route.sportGuessed };
      // Applying a set of values *is* the same operation in both directions, so
      // undo and redo are one function pointed at two snapshots.
      const apply = async (vals) => {
        await auth.updateRoute(route.id, { name: vals.name, sport: vals.sport, source: vals.source });
        Object.assign(route, vals);
        updateRoutesUi();
      };
      // Say which edit it was: "renaming" is wrong for a route you only refiled
      // under a different app, and a toast that describes the wrong change is
      // worse than one that says nothing.
      const title = before.name ? `“${before.name}”` : 'a route';
      const what = before.name !== after.name
        ? `renaming ${title}`
        : before.sport !== after.sport
          ? `changing the activity of ${title}`
          : before.source !== after.source
            ? `refiling ${title}`
            : `editing ${title}`;
      history.push(what, () => apply(before), () => apply(after));
    },
    onRouteDeleted: async (route) => {
      if (!(await removeRoute(route))) throw new Error('Could not remove that route.');
    },
    knownSources: () => [...new Set(routeList.map((r) => r.source))],
  });
  document.getElementById('stats-open').addEventListener('click', () => {
    setMenuOpen(false);
    stats.open();
  });

  let pending = false;
  map.on('move', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      updateGrid();
      // Don't rebuild the spotlight mid-move — it rides with the map so it
      // stays under the cursor while dragging; moveend re-anchors it.
    });
  });
  map.on('moveend', () => {
    updateGrid();
    updateTiles();
  });
  map.on('resize', () => {
    updateGrid();
    updateTiles();
  });

  // Until the pointer moves, anchor the spotlight to the viewport center.
  const el = map.getContainer();
  cursorPx = [el.clientWidth / 2, el.clientHeight / 2];

  // A saved 'edit' mode only survives if editing is still switched on.
  if (mode === 'edit' && !editUi) {
    mode = 'view';
    tileVis = 0;
  }
  updateModeUi();
  // Geometry, colors and the first reveal are set up in installGrid() when the
  // style finishes loading (and again after every basemap switch).
}

// --- Undo / redo, from the keyboard -------------------------------------------
// Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z (Ctrl-Y too, which is what Windows hands
// tell their fingers). Every one of them says out loud what it just did — on a
// map the change is often off screen, or a cell too small to see move, and a
// silent undo is indistinguishable from one that did nothing.
function isTypingIn(el) {
  if (!el) return false;
  const tag = el.tagName;
  // Renaming a route keeps its own undo. Taking Ctrl-Z away from a text field
  // to undo something on the map behind it would be the wrong answer twice.
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

window.addEventListener('keydown', async (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  if (isTypingIn(e.target)) return;
  e.preventDefault();
  const forward = key === 'y' || e.shiftKey;
  if (!authed) {
    showToast('Sign in to change the map', { tone: 'quiet' });
    return;
  }
  try {
    const label = forward ? await history.redo() : await history.undo();
    if (label) showToast(`${forward ? 'Redid' : 'Undid'} ${label}`);
    // Nothing on the stack is an answer, not a failure — said quietly.
    else showToast(forward ? 'Nothing to redo' : 'Nothing to undo', { tone: 'quiet' });
  } catch (err) {
    // The entry stays on the stack (see src/history.js), so this is worth
    // trying again once the server is back.
    showToast(`Couldn't ${forward ? 'redo' : 'undo'} that — ${err.message ?? err}`);
  }
});

// --- "the server has gone" banner ---------------------------------------------
// Every API call reports whether it got an answer (src/auth.js), so this only
// has to react. It matters because the map goes on working perfectly when the
// server is unreachable — cells still light up under the cursor, routes still
// draw — and without a word said, that looks exactly like a map that is saving.
function mountOfflineBanner() {
  const bar = document.getElementById('offline-bar');
  const detail = document.getElementById('offline-detail');
  const retry = document.getElementById('offline-retry');
  let checking = false;

  const show = (reason) => {
    detail.textContent =
      reason === 'error'
        ? 'The server answered with an error. Recent changes may not have been saved.'
        : "Anything you change now won't be saved.";
    bar.hidden = false;
  };

  connection.watch((ok, reason) => {
    if (ok) bar.hidden = true;
    else show(reason);
  });

  retry.addEventListener('click', async () => {
    if (checking) return;
    checking = true;
    retry.disabled = true;
    retry.textContent = 'Checking…';
    const ok = await connection.check();
    // Back up: push whatever the map has been holding on to, then reload the
    // authoritative copy so the two agree again.
    if (ok) {
      flushPending();
      await hydrateVisited();
      await loadRoutes(routesOn);
    }
    checking = false;
    retry.disabled = false;
    retry.textContent = 'Retry';
  });

  // The browser knows before we do when the machine drops off the network.
  window.addEventListener('offline', () => show('offline'));
  window.addEventListener('online', () => connection.check());
}
mountOfflineBanner();

// --- Auth gate ---------------------------------------------------------------
// Resolve the session on load: if signed in, pull the user's cells; otherwise
// show the login/register overlay. Logging out clears the map and re-shows it.
mountAuth({
  onAuthed: async () => {
    authed = true;
    await hydrateVisited();
    await loadRoutes(routesOn);
    // After the routes, because it re-renders the per-activity rows and those
    // are built from what the account actually has.
    await syncPrefs();
    // Only for the menu's status line — the sync itself runs on the server
    // whether or not this page is open.
    homeAssistant?.refresh();
    // Coming back from Strava's OAuth redirect reopens the dialog on the result.
    if (!(await stravaUi?.handleReturn())) stravaUi?.refresh();
    // …and the backup schedule, for the row in Sync. Only the account that made
    // the map may read it; anyone else's row says so.
    backupUi?.refresh();
    // Whatever was on the stack was somebody else's map, or this one before it
    // was re-read from the server. Either way there is nothing here to take
    // back any more.
    history.clear();
  },
  onLoggedOut: () => {
    authed = false;
    // Undo history belongs to the account that just left too, and every entry
    // in it is an instruction to change *their* map.
    history.clear();
    // These belong to the account that just left, not to this browser.
    hiddenSports = new Set();
    sportColors = new Map();
    renderedSports = '';
    // Preferences belong to the account too, so the next person to sign in on
    // this browser gets their own colours rather than inheriting these — and
    // the stamp has to go with them, or their (older) copy would look stale and
    // be overwritten by the ghost of this one.
    prefsStamp = 0;
    prefsDirty = false;
    clearTimeout(pushViewTimer);
    accent = DEFAULT_ACCENT;
    colorPicker?.set(accent);
    applyColors();
    try {
      localStorage.removeItem(ROUTE_VIEW_KEY);
      localStorage.removeItem(PREFS_STAMP_KEY);
      localStorage.removeItem(COLOR_KEY);
    } catch {
      /* fine */
    }
    homeAssistant?.clear();
    stravaUi?.clear();
    visited.clear();
    cellMeta.clear();
    pendingAdd.clear();
    pendingRemove.clear();
    closeCellInfo();
    closeRouteInfo();
    routeList = [];
    routeGeom = false;
    syncRoutes();
    recomputeLit();
    updateGrid(true);
    updateTiles();
    updateHud(currentLevel);
  },
});
