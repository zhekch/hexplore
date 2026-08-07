// Mapbox's maps, in three dimensions, rendered by MapLibre.
//
// Everything here exists because of one incompatibility, so it is worth stating
// before any of the code: **this is not Mapbox Standard.** The style in the
// screenshots — the one with the 3D trees, the modelled landmarks and the
// dawn/day/dusk/night presets — is delivered as a style *import*:
//
//   { "imports": [ { "id": "basemap", "url": "mapbox://styles/mapbox/standard" } ] }
//
// Style imports are a Mapbox GL JS v3 feature. MapLibre 5.24 has no
// implementation of them and no plan published for one, so handing that
// document to `map.setStyle()` yields a style with zero layers and a blank
// screen. Rendering Standard means running mapbox-gl-js as the map engine, and
// this app's engine is not a small thing to swap: every overlay it draws — the
// blob sheet, the railways, the airports, the photographs, the routes — is
// installed against the live style, and the licence mapbox-gl-js ships under
// since v2 would then govern the four basemaps that have nothing to do with
// Mapbox. See ARCHITECTURE.md, "The 3D basemap", for the whole of that
// argument.
//
// So this takes the other road: Mapbox's **classic** styles are ordinary
// MapLibre-renderable style documents (spec v8, one flat layer list), and
// everything that actually makes a map read as three-dimensional can be built
// on top of one —
//
//   Buildings   `fill-extrusion` over the `building` layer of
//               mapbox-streets-v8, which carries `height`, `min_height` and
//               `extrude` for exactly this. This is the thing you see.
//   Ground      `raster-dem` from mapbox-terrain-dem-v1, declared as the
//               style's `terrain`, so hills have shape and the camera's
//               existing 60° lean has something to lean over.
//   Sky         a horizon to put above the terrain, because a basemap that has
//               not been given one paints its background colour up there.
//
// The camera needed nothing: MAX_PITCH has been 60° since the map learned to
// turn, and src/view.js works the visible ground out in closed form from the
// camera rather than by unprojecting screen corners — which is why terrain,
// which changes what unproject answers, changes nothing downstream here.
//
// --- Where the visited colour lands -------------------------------------------
//
// Asked for: over the ground, under the buildings. It falls out of the anchor
// rule the other basemaps already use (`washAnchorIn` in src/basemap.js) with
// nothing added, because Mapbox orders its stack the same way everyone does:
// background, landcover, landuse, water, aeroway, then `building`, then the
// tunnels and roads and bridges, then the labels. `building` is the first id
// the anchor matches, so the wash is inserted above every fill that is ground
// and below every rooftop — flat ones and, since the extrusion layer is added
// higher still, extruded ones.
//
// The three overlays that draw over all of it — railways, airports,
// photographs — anchor on `labelStart()` instead, the bottom of the topmost run
// of symbol layers. That is why `addExtrusions` inserts the 3D buildings at the
// bottom of that same run rather than at the end of the list: put them last and
// they would be under nothing, and a photograph pin would be buried inside a
// tower block instead of standing on it.
//
// --- The token ----------------------------------------------------------------
//
// Mapbox will not serve any of this without one, and it is the viewer's own:
// this app has never had a Mapbox account and is not going to bill anyone's
// tiles to one. It lives in localStorage and is never sent to our server — a
// public token (`pk.`) is designed to sit in a web page, which is exactly what
// this is. See mapbox-ui.js for the dialog, and `tokenComplaint` below for the
// one case worth refusing outright.

import { washAnchorIn } from './basemap.js';

const API = 'https://api.mapbox.com';

// The classic style everything below is built from.
//
// streets-v12 rather than light-v11: it is the closest published thing to the
// Standard screenshots — warm grey-beige buildings, green parks, blue water,
// pink POI icons — and it is the only one of the classic set whose `composite`
// source carries both mapbox-streets-v8 (for the building heights) and
// mapbox-terrain-v2 (for the hillshade under them).
const STYLE_ID = 'mapbox/streets-v12';

// --- 3D buildings -------------------------------------------------------------
// Colour read off the reference screenshot: warm, desaturated, and lighter than
// the ground it stands on so a block of them reads as mass rather than as a
// stain. The roof is left to the vertical gradient — MapLibre darkens the walls
// on its own, which is most of what makes an extrusion look solid.
const BUILDING_COLOR = '#d8d0c4';
// Below this there are no building footprints in the tiles worth extruding, and
// above it every city has them. It is also where Mapbox's own 2D `building`
// fill hands over.
const BUILDING_MIN_ZOOM = 14;
// ...and buildings grow into place across this much zoom rather than appearing
// at full height on one notch of the wheel. The same reasoning as the road fade
// in src/basemap.js: an overlay that arrives all at once reads as a glitch.
const BUILDING_GROW_ZOOM = 15.5;
const BUILDING_OPACITY = 0.92;

// --- Terrain ------------------------------------------------------------------
// 1.0 — the ground's real shape and no more of it. Exaggeration is a
// presentation trick for a map *about* relief, and this is a map about where
// somebody has been: a doubled Alps would put the visited wash on a slope it
// was never walked up. Set to 0 to switch the terrain off entirely and keep the
// extruded buildings, which is the arrangement to fall back to if a device
// cannot afford the DEM tiles.
const TERRAIN_EXAGGERATION = 1;
// Mapbox's DEM is served at 512 and stops here; asking past it wastes requests
// on tiles that will 404.
const DEM_MAX_ZOOM = 14;

// A horizon for the leaning camera. Warm at the bottom where the sun would be,
// cooler above — enough to read as sky at a 60° lean without being the loudest
// thing on a screen that is mostly ground.
const SKY = {
  'sky-color': '#8fb8dd',
  'sky-horizon-blend': 0.6,
  'horizon-color': '#e6ecef',
  'horizon-fog-blend': 0.8,
  'fog-color': '#e9e4da',
  'fog-ground-blend': 0.7,
};

// Root keys Mapbox publishes that MapLibre either has never heard of or
// understands differently, and which are safe to drop because this file
// supplies its own answer to each.
//
// `projection` is the one that has to go rather than merely being noise:
// Mapbox writes `{"name": "globe"}` and MapLibre reads `{"type": "globe"}`, so
// left alone it is neither obeyed nor ignored — it is a validation error on
// every style load, and this map has its own opinion about the projection
// anyway. `imports`, `schema` and `models` are the Standard machinery that
// classic styles do not carry but may grow. `slot` is stripped per-layer for
// the same reason.
const DROP_ROOT = ['imports', 'schema', 'models', 'iconsets', 'featuresets', 'projection', 'fog', 'terrain', 'lights', 'camera', 'created', 'modified', 'owner', 'draft', 'visibility', 'protected', 'id'];

const TOKEN_KEY = 'visited-map:mapbox-token:v1';

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

/**
 * Why this string cannot be used, or null if it can.
 *
 * Only two answers, and the second one matters: a **secret** token (`sk.`)
 * carries account-management scopes and is not redistributable, and pasting one
 * into a web page publishes it to everything that page loads. Mapbox will
 * happily serve tiles with it, which is what makes this worth catching here
 * rather than letting it work.
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

/** Is there a token to try at all? */
export const hasMapboxToken = () => !!mapboxToken();

/**
 * Turn a `mapbox://` URL into one an ordinary fetch can reach.
 *
 * MapLibre has never heard of the scheme — it is Mapbox's own indirection for
 * "whatever host is serving this today" — so every one of them in a fetched
 * style has to be rewritten before the style is handed over. The token is
 * deliberately *not* added here: it is appended by `mapboxAuth` at request
 * time, because MapLibre builds the real sprite URL by concatenating `.json`
 * and `@2x.png` onto whatever string it is given, and a query string put on
 * early ends up in the middle of the filename.
 *
 * Exported for scripts/test/mapbox.mjs.
 *
 * @param {string} url
 * @returns {string}
 */
export function resolveMapboxUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('mapbox://')) return url;
  const rest = url.slice('mapbox://'.length);
  if (rest.startsWith('styles/')) return `${API}/styles/v1/${rest.slice('styles/'.length)}`;
  // `/sprite` goes on the end, and MapLibre adds `.json` or `@2x.png` after it.
  if (rest.startsWith('sprites/')) return `${API}/styles/v1/${rest.slice('sprites/'.length)}/sprite`;
  if (rest.startsWith('fonts/')) return `${API}/fonts/v1/${rest.slice('fonts/'.length)}`;
  // Anything else is a tileset id, or a comma-separated list of them, and the
  // thing to fetch is its TileJSON. `secure` is what makes the tile URLs inside
  // come back as https.
  return `${API}/v4/${rest}.json?secure`;
}

/**
 * MapLibre's `transformRequest`, for Mapbox's API and nothing else.
 *
 * One hook rather than a token threaded through every URL: the style, its
 * sprite sheet, its glyph ranges, two TileJSON documents and every vector and
 * DEM tile all need the same query parameter, and several of those URLs are
 * built by MapLibre itself from strings this file never sees.
 *
 * Returns `undefined` for everything else, which is MapLibre's "leave it
 * alone" — so the other four basemaps are untouched by this being installed.
 *
 * @param {string} url
 * @returns {{url: string}|undefined}
 */
export function mapboxAuth(url) {
  if (typeof url !== 'string' || !url.startsWith(API)) return undefined;
  if (url.includes('access_token=')) return undefined;
  const token = mapboxToken();
  if (!token) return undefined;
  return { url: `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` };
}

/**
 * Rewrite every `mapbox://` in a fetched style, in place.
 *
 * Exported for the test, which is the only way to check this without a token:
 * the rewriting is pure string work and the shape of a Mapbox style is known,
 * so it can be held to a fixture rather than to the network.
 *
 * @param {object} style a Mapbox style document, modified in place
 * @returns {object} the same object
 */
export function localiseStyle(style) {
  for (const key of DROP_ROOT) delete style[key];
  if (style.sprite) style.sprite = resolveMapboxUrl(style.sprite);
  if (style.glyphs) style.glyphs = resolveMapboxUrl(style.glyphs);
  for (const source of Object.values(style.sources ?? {})) {
    if (source.url) source.url = resolveMapboxUrl(source.url);
    if (Array.isArray(source.tiles)) source.tiles = source.tiles.map(resolveMapboxUrl);
  }
  // `slot` is Standard's way of saying where a layer belongs relative to an
  // imported basemap. In a flat style it means nothing, and MapLibre validates
  // it as an unknown property on every layer that carries one.
  for (const layer of style.layers ?? []) delete layer.slot;
  return style;
}

/**
 * Where a layer drawn *over* the whole basemap but *under* its labels goes.
 *
 * The same question `labelStart()` in src/main.js asks of the live map, asked
 * of a style document instead — and it has to be asked here rather than left to
 * that function, because the extrusions are put in before the style is handed
 * to MapLibre at all.
 *
 * @param {Array<{type: string}>} layers
 * @returns {number} the index to splice at
 */
export function labelStartIn(layers) {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].type !== 'symbol') return i + 1;
  }
  return 0;
}

/**
 * Add the extruded buildings, replacing whatever flat or extruded ones the
 * style already had.
 *
 * Mapbox has moved this around between style versions — v11 published a 2D
 * `building` fill and left 3D to the reader, v12 ships a `building-extrusion`
 * gated at high zoom — so rather than depend on which, every fill-extrusion
 * already in the style is dropped and one of ours goes in at a known place. The
 * flat `building` fill *stays*: it is what draws rooftops between z12 and z14,
 * below where extruding is worth the geometry, and it is also the layer the
 * visited wash anchors under.
 *
 * @param {object} style modified in place
 */
export function addExtrusions(style) {
  const layers = style.layers.filter((l) => l.type !== 'fill-extrusion');
  // The source the building footprints are actually in. Named `composite` in
  // every published Mapbox style, but looked up rather than assumed — a style
  // that renamed it would otherwise give an extrusion layer pointing at
  // nothing, which draws no buildings and reports no error.
  const source = Object.entries(style.sources ?? {})
    .find(([, s]) => s.type === 'vector')?.[0];
  if (!source) return;

  layers.splice(labelStartIn(layers), 0, {
    id: 'building-3d',
    type: 'fill-extrusion',
    source,
    'source-layer': 'building',
    minzoom: BUILDING_MIN_ZOOM,
    // `extrude` is published as the *string* 'true', not a boolean — a `==`
    // against `true` matches nothing and the map comes out flat with no
    // complaint from anywhere.
    filter: ['all',
      ['==', ['get', 'extrude'], 'true'],
      ['==', ['geometry-type'], 'Polygon'],
      ['>', ['coalesce', ['get', 'height'], 0], 0],
    ],
    paint: {
      'fill-extrusion-color': BUILDING_COLOR,
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
        BUILDING_MIN_ZOOM, 0, BUILDING_GROW_ZOOM, ['get', 'height']],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'],
        BUILDING_MIN_ZOOM, 0, BUILDING_GROW_ZOOM, ['coalesce', ['get', 'min_height'], 0]],
      'fill-extrusion-opacity': BUILDING_OPACITY,
      // Walls darker than roofs, which is the whole of why an extrusion reads
      // as a solid rather than as a coloured shadow.
      'fill-extrusion-vertical-gradient': true,
    },
  });
  style.layers = layers;
}

/**
 * Give the style real ground, and a sky to put above it.
 *
 * Declared *in the style document* rather than through `map.setTerrain()`,
 * which matters for a reason that has bitten this app before: a style swap
 * replaces everything MapLibre holds, so terrain set imperatively has to be
 * torn down by hand on the way out, and terrain declared here is simply gone
 * the moment another basemap is chosen. There is no fifth code path in
 * setStyleKey() as a result.
 *
 * @param {object} style modified in place
 */
export function addTerrain(style) {
  if (!TERRAIN_EXAGGERATION) return;
  style.sources['hexplore-dem'] = {
    type: 'raster-dem',
    url: resolveMapboxUrl('mapbox://mapbox.mapbox-terrain-dem-v1'),
    tileSize: 512,
    maxzoom: DEM_MAX_ZOOM,
    // TileJSON does not carry the encoding, and Mapbox's DEM is not Terrarium.
    // Left to the default, every hill comes out at the wrong height and the
    // sea has mountains in it.
    encoding: 'mapbox',
  };
  style.terrain = { source: 'hexplore-dem', exaggeration: TERRAIN_EXAGGERATION };
  style.sky = SKY;
}

/**
 * Fetch a Mapbox style and turn it into one this map can render.
 *
 * @param {string} [styleId] owner/style, defaulting to the one above
 * @returns {Promise<object>} a MapLibre style object
 */
export async function mapbox3dStyle(styleId = STYLE_ID) {
  const token = mapboxToken();
  if (!token) throw new Error('No Mapbox token');
  const url = `${API}/styles/v1/${styleId}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Mapbox rejected that token' : `Mapbox answered ${res.status}`);
  }
  const style = await res.json();
  if (!style || !Array.isArray(style.layers)) throw new Error('Mapbox did not return a style');

  localiseStyle(style);
  addExtrusions(style);
  addTerrain(style);
  return style;
}

/**
 * Does this token work? Used by the dialog to say so before anyone has to
 * switch basemap to find out.
 *
 * Deliberately asks for the style rather than for `/tokens/v2`, so what is
 * checked is the thing that will actually be fetched: a token restricted to the
 * wrong URLs, or scoped without `styles:read`, passes the token endpoint and
 * then serves nobody a map.
 *
 * @param {string} token
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function checkMapboxToken(token) {
  const complaint = tokenComplaint(token);
  if (complaint) return { ok: false, why: complaint };
  try {
    const res = await fetch(
      `${API}/styles/v1/${STYLE_ID}?access_token=${encodeURIComponent(token.trim())}`,
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
 * Where the visited wash goes on a Mapbox style.
 *
 * Re-exported rather than reimplemented, and that is the point: the rule that
 * put the colour under CARTO's rooftops and OpenFreeMap's is the rule that puts
 * it under Mapbox's, because all three order a style the same way. The test
 * holds it to a Mapbox layer list so a future change to the anchor cannot break
 * this basemap silently.
 */
export { washAnchorIn };
