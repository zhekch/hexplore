// Mapbox Standard: the token it needs, and the two knobs it has.
//
// This is the fifth basemap — 3D buildings, modelled landmarks, trees you can
// see the shape of, and a sun that can be put in four places. It is drawn by
// Mapbox GL JS rather than by MapLibre; `src/gl-engine.js` is where that
// decision lives and why.
//
// **What this file used to be.** The first version of the 3D basemap ran on
// MapLibre, because keeping one engine was worth a lot: it fetched
// `mapbox/streets-v12` — a classic, flat, spec-v8 style MapLibre renders fine —
// rewrote every `mapbox://` URL in it to https, extruded the `building` layer
// itself with a `fill-extrusion`, bolted on a `raster-dem` for terrain and a sky
// above it, and put the token on each request through a `transformRequest`. It
// worked, and Mapbox even documents that path. It is gone because it could only
// ever be an imitation: the trees, the landmark models and the light presets are
// not layers in a style you can borrow, they are Standard, and Standard is a
// style *import*, which is a Mapbox GL JS feature. Rebuilding it by hand meant
// maintaining a worse copy of a thing that already exists. Anything that needs
// it is in git before this commit.
//
// What survived is the part that was never about rendering: whose token this is,
// and how to tell somebody it does not work.
//
// **The token is the viewer's own.** Mapbox serves nothing without an account,
// this app has never had one, and it is not going to bill somebody else's tiles
// to it. A public token (`pk.`) is designed to sit in a web page, so localStorage
// is exactly the right place for it — and it never goes near our server, which
// is a promise the dialog makes out loud.

const API = 'https://api.mapbox.com';

/** The style itself. Its config is what the presets below set. */
export const STANDARD_STYLE = 'mapbox://styles/mapbox/standard';

// Standard's own name for the import, and the only one it has. Every
// `setConfigProperty` call has to name it.
export const BASEMAP_IMPORT = 'basemap';

// --- Terrain ------------------------------------------------------------------
// Standard brings buildings and trees; the ground under them is flat until it is
// asked for. Exaggeration 1 — the real shape and no more of it. This is a map
// about where somebody has been, and a doubled Alps would put the visited wash
// on a slope nobody walked up. Set to 0 to switch terrain off and keep
// everything else.
export const TERRAIN_EXAGGERATION = 1;
export const DEM_SOURCE = 'mapbox-dem';
export const DEM_TILESET = 'mapbox://mapbox.mapbox-terrain-dem-v1';
export const DEM_MAX_ZOOM = 14;

// --- Where the sun is ---------------------------------------------------------
// Standard's four light presets, which are the control the published screenshots
// put in the corner. They are not decoration: each one relights the whole scene,
// and two of them turn the map dark — so the app's own chrome, the contrast
// rules for the visited wash and the colour of a route all follow from this.
// Hence `theme` on each, read by main.js exactly as a basemap's own theme is.
export const LIGHT_PRESETS = [
  { key: 'dawn', label: 'Dawn', theme: 'light' },
  { key: 'day', label: 'Day', theme: 'light' },
  { key: 'dusk', label: 'Dusk', theme: 'dark' },
  { key: 'night', label: 'Night', theme: 'dark' },
];
const DEFAULT_PRESET = 'day';

const TOKEN_KEY = 'visited-map:mapbox-token:v1';
const PRESET_KEY = 'visited-map:mapbox-light:v1';

/** The viewer's Mapbox token, or '' if they have not given one. */
export function mapboxToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Store it, or forget it when given nothing. Returns what is now stored. */
export function setMapboxToken(token) {
  const clean = String(token ?? '').trim();
  try {
    if (clean) localStorage.setItem(TOKEN_KEY, clean);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* a browser refusing localStorage still gets a map, just not this one */
  }
  return clean;
}

/** Is there a token to try at all? */
export const hasMapboxToken = () => !!mapboxToken();

/** Which light preset is chosen, falling back to the default for anything odd. */
export function lightPreset() {
  let held;
  try {
    held = localStorage.getItem(PRESET_KEY);
  } catch {
    held = null;
  }
  return LIGHT_PRESETS.some((p) => p.key === held) ? held : DEFAULT_PRESET;
}

/** Choose one. Returns what is now stored. */
export function setLightPreset(key) {
  const clean = LIGHT_PRESETS.some((p) => p.key === key) ? key : DEFAULT_PRESET;
  try {
    localStorage.setItem(PRESET_KEY, clean);
  } catch {
    /* fine — it falls back to Day next time */
  }
  return clean;
}

/**
 * Light or dark, for the preset in force.
 *
 * This is the answer main.js needs *before* the map has drawn anything — the
 * chrome is coloured from it while the style is still being fetched — so it is
 * a lookup rather than something read off the rendered map.
 *
 * @param {string} [key] defaults to the stored preset
 */
export function presetTheme(key = lightPreset()) {
  return LIGHT_PRESETS.find((p) => p.key === key)?.theme ?? 'light';
}

/**
 * Why this string cannot be used, or null if it can.
 *
 * Only two answers, and the second one matters: a **secret** token (`sk.`)
 * carries account-management scopes and is not redistributable, and pasting one
 * into a web page publishes it to everything that page loads. Mapbox GL JS
 * refuses these itself, deep inside a URL builder, as an exception thrown
 * mid-render; catching it here means the dialog can say what is wrong while
 * somebody is still looking at the box they typed it into.
 *
 * @param {string} token
 * @returns {string|null}
 */
export function tokenComplaint(token) {
  const clean = String(token ?? '').trim();
  if (!clean) return 'Paste your public token to switch the 3D basemap on.';
  if (clean.startsWith('sk.')) {
    return 'That is a secret token. Anything in a web page is public — use the public one, which starts pk.';
  }
  if (!clean.startsWith('pk.')) return 'A Mapbox public token starts with pk.';
  return null;
}

/**
 * Does this token work? Used by the dialog to say so before anyone has to
 * switch basemap — and reload the page — to find out.
 *
 * Asks for **Standard itself** rather than for `/tokens/v2`, so what is checked
 * is the thing that will actually be fetched: a token restricted to the wrong
 * URLs, or scoped without `styles:read`, passes the token endpoint and then
 * serves nobody a map.
 *
 * @param {string} token
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function checkMapboxToken(token) {
  const complaint = tokenComplaint(token);
  if (complaint) return { ok: false, why: complaint };
  try {
    const res = await fetch(
      `${API}/styles/v1/mapbox/standard?access_token=${encodeURIComponent(token.trim())}`,
      { credentials: 'omit' },
    );
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, why: 'Mapbox rejected that token.' };
    if (res.status === 403) {
      return { ok: false, why: 'That token is not allowed to read styles, or is restricted to other URLs.' };
    }
    return { ok: false, why: `Mapbox answered ${res.status}.` };
  } catch {
    return { ok: false, why: 'Could not reach Mapbox — check the connection.' };
  }
}

/**
 * Everything that has to be said to a Standard map once its style has parsed.
 *
 * Kept here rather than in main.js's `installGrid` because all of it is about
 * Mapbox in particular, and `installGrid` is the one function that has to stay
 * readable as *what this app draws* rather than as which library is drawing it.
 *
 * Idempotent, like the overlays' installers: a style swap lands here again with
 * a fresh style and no sources.
 *
 * @param {object} map a Mapbox GL JS map whose style has loaded
 */
export function configureStandard(map) {
  try {
    map.setConfigProperty(BASEMAP_IMPORT, 'lightPreset', lightPreset());
  } catch {
    // A style that is not Standard has no such import. Not worth failing over:
    // the map is already drawn and this only decides where the sun is.
  }
  if (!TERRAIN_EXAGGERATION) return;
  try {
    if (!map.getSource(DEM_SOURCE)) {
      map.addSource(DEM_SOURCE, {
        type: 'raster-dem',
        url: DEM_TILESET,
        tileSize: 512,
        maxzoom: DEM_MAX_ZOOM,
      });
    }
    map.setTerrain({ source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  } catch (e) {
    // Terrain is the one part of this that costs a second tile pyramid, and the
    // one part the map is perfectly good without.
    console.warn('Mapbox terrain could not be set up.', e);
  }
}
