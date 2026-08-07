// Snow, which is the one thing on this map that is not information.
//
// Everything else the app draws answers a question — where you have been, how
// often, what that ground is called. This answers none, and that is the point of
// it being filed under Easter eggs rather than under Layers: it is weather on a
// map that has no weather in it, and the only honest place for a control like
// that is one that admits what it is.
//
// **It is Mapbox's, and so it is the 3D basemap's alone.** `setSnow` is a Mapbox
// GL JS feature that renders inside the same 3D scene as the terrain and the
// buildings; MapLibre has no equivalent and cannot be given one from out here —
// precipitation is a renderer pass, not a layer you can add. The other four
// basemaps therefore never snow, whatever this is set to, and the dialog says so
// rather than leaving somebody to work out why the switch appears to be broken.
// That is also why `applySnow` takes the map rather than reading a global: the
// caller is the one place that knows which engine is underneath.
//
// **Whose winter, and why it is the map's rather than yours.** The obvious
// reading of "only during winter" is the viewer's own season, from their clock
// and their home. The better one is the *subject's*: if you are looking at
// Patagonia in July it is winter there, and snowing on it is the version of this
// that knows something. It also degrades more gracefully — a map centred on the
// equator has no winter to be in, and no answer about the viewer would have told
// you that.
//
// The months are meteorological (Dec–Feb north, Jun–Aug south) rather than
// astronomical, because a solstice-to-equinox winter would start snowing three
// weeks into December and stop in the third week of March, and nobody thinks of
// the year that way. Whole months are the version a person can predict.

import { t } from './i18n.js';

// --- Tuning -------------------------------------------------------------------

// How much snow, and it is deliberately much less than Mapbox's own example.
// Their published values (density 0.85, intensity 1) are a demo of the feature —
// a blizzard, shown against a city nobody needs to read. Here the snow falls in
// front of the thing the map is *for*, so it has to be legible through: enough
// to notice on a still frame, never enough to hide a blob under.
const DENSITY = 0.35;
const INTENSITY = 0.55;
const OPACITY = 0.85;
const FLAKE_SIZE = 0.61;

// A vignette is snow *near the camera* — out-of-focus flakes at the edges of the
// frame. Low, because the same argument applies twice over at the corners, and
// because a strong one reads as a dirty lens rather than as weather.
const VIGNETTE = 0.18;
const VIGNETTE_COLOR = '#ffffff';

// Thinning of the flakes at the centre of the screen, so the middle of the map —
// which is what you are looking at — stays clearest.
const CENTER_THINNING = 0.4;

// Which way it blows, as Mapbox's [azimuth°, elevation°]. Straight down would be
// a screensaver; a slant is what makes it read as falling.
const DIRECTION = [-40, 55];

// Below this zoom there is no snow at all, and it fades in over the next few.
//
// Not a performance decision — a truthfulness one. At z3 the frame is a third of
// a hemisphere, and snow drawn across it is snow claimed for four climate zones
// at once. Weather is a local fact, so it appears at roughly the zoom where the
// map is showing somewhere rather than everywhere.
const SNOW_MIN_ZOOM = 4.5;
const SNOW_FULL_ZOOM = 8;

// --- The setting --------------------------------------------------------------

/**
 * The three answers. `winter` is the interesting one; the other two are escapes.
 *
 * `label` is read at import time and so is in whatever language was loaded
 * before this module was — which `src/boot.js` guarantees is the right one. See
 * the note at the head of src/i18n.js for why that ordering exists and why
 * changing language reloads.
 */
export const SNOW_MODES = [
  { key: 'off', label: t('snow.never') },
  { key: 'winter', label: t('snow.winter') },
  { key: 'always', label: t('snow.always') },
];

const DEFAULT_MODE = 'off';
const SNOW_KEY = 'visited-map:snow:v1';

/** Is this a mode we know? Used by the prefs adopter, which is fed by the network. */
export const isSnowMode = (key) => SNOW_MODES.some((m) => m.key === key);

/** Which mode is chosen, falling back to off for anything odd or absent. */
export function snowMode() {
  let held;
  try {
    held = localStorage.getItem(SNOW_KEY);
  } catch {
    held = null;
  }
  return isSnowMode(held) ? held : DEFAULT_MODE;
}

/**
 * Choose one. Returns what is now stored, so a caller can mirror it without
 * reading back.
 */
export function setSnowMode(key) {
  const clean = isSnowMode(key) ? key : DEFAULT_MODE;
  try {
    localStorage.setItem(SNOW_KEY, clean);
  } catch {
    /* private mode — it falls back to off next load, which is the safe way round */
  }
  return clean;
}

// --- Whether it is snowing ------------------------------------------------------

/**
 * Is it winter at this latitude, on this date?
 *
 * Split out and exported because it is the whole of the interesting logic and
 * the only part that can be wrong in a way nobody would notice for six months.
 *
 * @param {number} lat   degrees north, so negative is the southern hemisphere
 * @param {Date}   [when]
 */
export function isWinterAt(lat, when = new Date()) {
  if (!Number.isFinite(lat)) return false;
  const month = when.getMonth(); // 0 = January
  // Dec, Jan, Feb north of the equator; Jun, Jul, Aug south of it. The equator
  // itself is given the northern answer rather than a third case: it is one line
  // of latitude, nobody's map is centred on it by accident, and a `lat === 0`
  // branch would be a special case for a place with no winter either way.
  return lat >= 0
    ? month === 11 || month <= 1
    : month >= 5 && month <= 7;
}

/**
 * Should there be snow, given the mode, where the map is looking and when it is?
 *
 * @param {string} mode  one of SNOW_MODES
 * @param {number} lat   the centre of the map
 * @param {Date}   [when]
 */
export function snowWanted(mode, lat, when = new Date()) {
  if (mode === 'always') return true;
  if (mode === 'winter') return isWinterAt(lat, when);
  return false;
}

// --- Putting it on the map ------------------------------------------------------

/**
 * The specification handed to Mapbox. A function rather than a constant because
 * the zoom ramp is built from the two constants above, and a reader chasing why
 * there is no snow at z3 should find the answer in one place.
 */
export function snowSpec() {
  return {
    density: [
      'interpolate', ['linear'], ['zoom'],
      SNOW_MIN_ZOOM, 0,
      SNOW_FULL_ZOOM, DENSITY,
    ],
    intensity: INTENSITY,
    opacity: OPACITY,
    color: '#ffffff',
    'flake-size': FLAKE_SIZE,
    'center-thinning': CENTER_THINNING,
    direction: DIRECTION,
    vignette: VIGNETTE,
    'vignette-color': VIGNETTE_COLOR,
  };
}

/**
 * Set the snow, or take it off. Safe to call on any map and at any time.
 *
 * Three guards, and each is a real case rather than defensive habit: a MapLibre
 * map has no `setSnow` at all, a style that has not parsed yet throws from
 * inside it, and the whole feature is marked experimental in the type
 * definitions — which is Mapbox reserving the right to change these property
 * names in a minor version. None of those should cost anybody their map, so the
 * failure mode here is *no snow*, silently, and never a broken basemap.
 *
 * @param {object} map    a map from either engine
 * @param {string} [mode] defaults to the stored setting
 * @param {Date}   [when]
 * @returns {boolean} whether snow is now on
 */
export function applySnow(map, mode = snowMode(), when = new Date()) {
  if (!map || typeof map.setSnow !== 'function') return false;
  let on = false;
  try {
    on = snowWanted(mode, map.getCenter?.()?.lat ?? NaN, when);
    map.setSnow(on ? snowSpec() : null);
  } catch {
    return false;
  }
  return on;
}
