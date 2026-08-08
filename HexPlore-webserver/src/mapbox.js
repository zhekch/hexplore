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
// **The token is the viewer's own, and it follows their account.** Mapbox serves
// nothing without an account, this app has never had one, and it is not going to
// bill somebody else's tiles to it.
//
// It lived in localStorage and nowhere else for as long as the 3D basemap has
// existed, on the argument that a credential belonging to somebody else's
// account should never touch our server. That turned out to be the wrong trade
// for the only person it affects: it meant pasting the same token again on the
// phone, again on the laptop, and again after every cache clear, to switch on a
// basemap they had already signed up for. So it is a preference like any other
// now — put into the account's blob by main.js and adopted from it by every
// device that signs in. `src/prefs.js` holds the one rule that is not obvious.
//
// What that costs is worth stating plainly, because the dialog used to promise
// the opposite: the token sits in the `user_prefs` row in plain text and rides
// along in every backup file the server takes. For a **public** token (`pk.`)
// that is a fair price — it is designed to sit in a web page, it is already in
// the query string of every tile this browser fetches, and anyone who can read
// that database can read the map it draws. A **secret** token (`sk.`) is a
// different object entirely, which is why `tokenComplaint` still refuses one by
// name and why it matters more now than it did.
//
// localStorage stays, as the device's copy rather than the only one. Two things
// need it: the map is built before the session is resolved — `boot.js` picks a
// map library from `hasMapboxToken()` synchronously, long before `/api/prefs`
// has answered anything — and the basemap has to keep working offline.

const API = 'https://api.mapbox.com';

/** The style itself. Its config is what the presets below set. */
export const STANDARD_STYLE = 'mapbox://styles/mapbox/standard';

// Standard's own name for the import, and the only one it has. Every
// `setConfigProperty` call has to name it.
export const BASEMAP_IMPORT = 'basemap';

// --- Terrain ------------------------------------------------------------------
//
// On, at exaggeration 1 — the ground's real shape and no more of it. A doubled
// Alps would put the visited wash on a slope nobody walked up.
//
// **Standard sets its own, and its own is not enough.** What it publishes is
//
//     ["interpolate", ["linear"], ["zoom"], 6, 0, 7, 1, 12, 1, 13.7, 0]
//
// — relief through the zooms where you are looking at a region, and **faded back
// to flat by z13.7**, which is every zoom at which you are looking at a city. In
// Bern that is the difference between a town on the side of a gorge and a town
// printed on a sheet of paper: the Aare drops forty metres below the Bundesplatz
// and none of it was there. This file briefly deferred to that ramp and the map
// lost the thing that made it worth looking at.
//
// **What it costs is bridges, and there is no way to have both.** Terrain drapes
// line layers onto the DEM, so the Kornhausbrücke — which Standard otherwise
// models as a deck forty metres above the water — sinks to river level and
// crosses the Aare as a painted stripe. That is what draping *is* for a line
// layer; all 45 of Standard's config options were read looking for an exemption
// and there is none. Checked both ways over that bridge, twice.
//
// So it is a trade, and this is the side of it worth being on: the relief is
// everywhere and all the time, and the flattened bridge is a handful of spans in
// a city. Set this to 0 for the other side — bridges with decks, and a flat
// Bern.
export const TERRAIN_EXAGGERATION = 1;
export const DEM_SOURCE = 'mapbox-dem';
export const DEM_TILESET = 'mapbox://mapbox.mapbox-terrain-dem-v1';
// Mapbox's DEM stops here and is upsampled above it, which is why the relief
// stays smooth at street zoom rather than turning into steps.
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

// --- What Standard draws of its own -------------------------------------------
// Config on the imported basemap, set once its style has parsed. Each of these
// is a published option with published values; `standardConfig` collects them
// and `configureStandard` sets each inside its own try, because a style that is
// not Standard has no such import.
//
// `none` rather than the published default `circle`: the coloured discs behind
// every POI icon are the loudest thing on a map whose subject is the ground
// underneath them. Without them the icons keep their colour and their meaning
// and stop reading as a scatter of buttons.
const POI_BACKGROUND = 'none';

// Off. Standard labels every tram stop and bus stop it has, and in a city with a
// dense network that is the same three or four names repeated across the screen
// — "Zytglogge" five times over one junction in Bern. The stop icons stay; it is
// the words that were the noise.
const SHOW_TRANSIT_LABELS = false;

// --- The 3D work, and the thing that was never wrong with it --------------------
//
// **None of this is what made a landmark look like a shed.** That was the
// server's `script-src`, which had no wasm source and so blocked the WebAssembly
// Mapbox GL JS decodes the batched landmark meshes with — see the CSP note in
// server/index.js. Every property below was read carefully, twice, while the
// actual bug sat one directive away in another file and could not be seen from
// here at all, because Vite's dev server sends no CSP and so the map on
// localhost:5173 was perfect the entire time.
//
// The lesson worth keeping is about *where to look*, not about config: a feature
// that draws nothing has a renderer between it and the screen, and the renderer
// is running inside somebody's policy. Ask what the deployed page is allowed to
// do before re-reading what the style was asked to draw.
//
// **Facades** are the intricate buildings — modelled windows, walls, roofs,
// entrance lights — and Mapbox's own words for switching them on are "must be
// toggled on in Studio or enabled directly in the code using the
// `show3dFacades` property". They exist in a *list of cities* rather than
// everywhere: Munich, Berlin, Stuttgart, San Francisco, New York, Las Vegas,
// Helsinki and Tokyo at the time of writing, more through 2026. So this changes
// nothing at all in Bern, and it is still right — the map is not a map of Bern,
// and the alternative is finding out in Tokyo that the setting existed all along.
const SHOW_FACADES = true;

// **Landmark icons are off**, which is Standard's own default and was the right
// answer before this file ever had an opinion about it.
//
// They were switched on as a guess at the missing models and are exactly the
// wrong thing: an icon *in place of* a landmark is a worse map than the plain
// extrusion it sits on, because it covers the building with a claim that there
// is something here worth seeing and then declines to show it. With the CSP
// fixed the model itself draws, and a marker for a thing already on the screen
// is one more sticker over the ground this map is about — the same call as the
// POI discs above, and made for the same reason.
//
// The icons also cost requests that answer 404: `mapbox-landmark-pois-v1` is not
// served to this account's token, so every tile of it was a round trip to a
// refusal for a layer nobody asked for.
const SHOW_LANDMARK_ICONS = false;

// **The models themselves, from the zoom the rest of the city arrives at.**
//
// Standard publishes `building-models` at **minzoom 14** and every other
// building layer at **15**: `3d-building`, `2d-building`, `procedural-buildings`
// and `building-underground` all start together, one zoom later. So there is a
// band between them where the modelled landmarks stand on a city that has no
// buildings in it — a parliament and a cathedral floating over a bare street
// plan, which reads as something half-loaded rather than as detail. Zooming in
// then makes the rest of the city appear *around* models that were already
// there, which is backwards: the landmark is what you should arrive at last.
//
// **The layer's own minzoom cannot be moved from out here.** `setLayerZoomRange`
// resolves against the style's own layers and returns without a word for one
// that arrived inside an import — the same silence `setConfigProperty` has for a
// name it does not know. Neither the plain id nor any scoped spelling reaches
// it.
//
// So the zoom is answered by *setting the config property again*, from a `zoom`
// handler, which is the plain thing and the only one that works.
//
// **What does not work, tried and measured: putting an expression in the config
// value.** `["step", ["zoom"], false, 15, true]` is accepted by
// `setConfigProperty`, reads back intact from `getConfigProperty`, and is wrong
// — Standard gates the layer through `layout.visibility`, which is resolved when
// the style is evaluated and *not* re-resolved as the camera moves. So the value
// is read once, at whatever zoom the page happened to load at, and frozen: open
// the map at z10 and the landmarks never appear at any zoom, because the answer
// was computed while they were legitimately hidden. It looks exactly like the
// CSP bug it was written on top of — a plain extrusion, no error — which is how
// it survived being "verified" by flipping it at one zoom and looking.
const BUILDINGS_MINZOOM = 15;

/** Are the landmark models Standard's to draw at this zoom? */
export const landmarksVisibleAt = (zoom) => zoom >= BUILDINGS_MINZOOM;

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

/**
 * Every config property this app has an opinion about, and what it wants.
 *
 * A list rather than a run of calls because the failure mode here is silence.
 * `Style.setConfigProperty` looks the name up in the style's own schema and
 * **returns without a word** if it is not there — so a property Mapbox has
 * renamed, or one misspelled here, does exactly nothing and reports exactly
 * nothing. Every name below is spelled the way the Standard reference spells
 * it, and `scripts/test/mapbox.mjs` checks that each one is actually sent.
 *
 * Read at call time, because the light preset is a setting and the rest are not.
 *
 * @param {number} [zoom] the zoom to answer `show3dLandmarks` for. Defaulting to
 *   Infinity rather than to a number means a caller that does not care gets the
 *   models — "on" is what this app wants of them, and the zoom only ever takes
 *   them away.
 */
export const standardConfig = (zoom = Infinity) => ({
  lightPreset: lightPreset(),
  backgroundPointOfInterestLabels: POI_BACKGROUND,
  showTransitLabels: SHOW_TRANSIT_LABELS,
  show3dLandmarks: landmarksVisibleAt(zoom),
  show3dFacades: SHOW_FACADES,
  showLandmarkIcons: SHOW_LANDMARK_ICONS,
});

// One `zoom` handler per map, and the last value each was given. A style swap
// brings `configureStandard` back with the config reset to Standard's own
// defaults, so the property is always re-sent — it is only the handler that must
// not be added twice.
const gated = new WeakSet();
const gateApplied = new WeakMap();

/**
 * Keep `show3dLandmarks` answering for the zoom the map is actually at.
 *
 * Written the dull way on purpose: see the note above about the expression that
 * looked like it did this and did not.
 *
 * @param {object} map
 */
function gateLandmarks(map) {
  if (typeof map.getZoom !== 'function' || typeof map.on !== 'function') return;
  // `configureStandard` has just sent this for the zoom in force — including on
  // a style swap, which resets the config and so must send it again. Recording
  // it here rather than in `send` is what keeps the handler quiet until the
  // camera actually crosses.
  gateApplied.set(map, landmarksVisibleAt(map.getZoom()));
  if (gated.has(map)) return;
  gated.add(map);
  // Only on a crossing. `zoom` fires every frame of a pinch, and every call
  // re-evaluates the style.
  map.on('zoom', () => {
    const want = landmarksVisibleAt(map.getZoom());
    if (want === gateApplied.get(map)) return;
    gateApplied.set(map, want);
    try {
      map.setConfigProperty(BASEMAP_IMPORT, 'show3dLandmarks', want);
    } catch {
      // Not Standard, and so not its landmarks either.
    }
  });
}

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
 * switch basemap to find out.
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
  // The zoom decides one of these, and this runs on every style parse — so the
  // value sent is the one for where the camera is now, not for where it was.
  const zoom = typeof map.getZoom === 'function' ? map.getZoom() : Infinity;
  for (const [key, value] of Object.entries(standardConfig(zoom))) {
    try {
      map.setConfigProperty(BASEMAP_IMPORT, key, value);
    } catch {
      // A style that is not Standard has no such import. Not worth failing over:
      // the map is already drawn and none of this decides whether it draws.
      //
      // One `try` each rather than one around the lot, so that a property this
      // Standard has never heard of cannot take the light preset down with it —
      // the sun would move on some builds and not others, which is the kind of
      // bug that gets blamed on the sun.
    }
  }
  gateLandmarks(map);

  if (!TERRAIN_EXAGGERATION) return;
  try {
    // The DEM is Standard's own tileset, added again here under the same name
    // because the one inside the import cannot be addressed from out here — and
    // `setTerrain` needs a source it can see. Two declarations of the same
    // tiles; the tiles themselves are fetched once.
    if (!map.getSource(DEM_SOURCE)) {
      map.addSource(DEM_SOURCE, {
        type: 'raster-dem',
        url: DEM_TILESET,
        tileSize: 512,
        maxzoom: DEM_MAX_ZOOM,
      });
    }
    // A flat number, deliberately, replacing the zoom ramp Standard would
    // otherwise apply — see the note above. The ramp is why the city was flat.
    map.setTerrain({ source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  } catch (e) {
    // Terrain is the one part of this that costs a second tile pyramid, and the
    // one part the map is still a map without.
    console.warn('Mapbox terrain could not be set up.', e);
  }
}
