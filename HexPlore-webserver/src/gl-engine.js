// Which library draws the map, and why there are two of them.
//
// Four of the five basemaps are MapLibre's business and always will be: they are
// CARTO's, OpenFreeMap's and Esri's tiles, MapLibre is BSD, and nothing about
// them wants anything else. The fifth is Mapbox **Standard** — the 3D trees, the
// modelled landmarks, the dawn/day/dusk/night presets — and that style is
// delivered as a style `import`, which is a Mapbox GL JS v3 feature MapLibre
// 5.24 does not implement. Handing that document to MapLibre yields a style with
// zero layers and a blank screen. There is no version of this where one library
// draws all five.
//
// So the engine is **decided at boot, from the chosen basemap** — and changed
// afterwards by rebuilding the map rather than by reloading the page. The
// reload was the first answer and it was too slow to live with: it threw away
// the session's cells, routes and boundaries and fetched them all again to
// change which library was drawing. `switchEngine()` in main.js does it
// properly, on the back of the `onMapBuilt` registry there.
//
// **Why not simply run Mapbox GL JS for everything** and delete this file: it is
// proprietary since v2, and it is billed *per map load* rather than per tile —
// so every time the app opened to look at CARTO Dark it would spend one of
// Mapbox's 50,000 monthly loads on a map Mapbox had nothing to do with. Loading
// it only when it is the thing being looked at keeps both the licence and the
// meter where they belong.
//
// Both libraries are imported dynamically, so a viewer who never chooses 3D
// never downloads Mapbox GL JS, and one who does never downloads MapLibre.

import { hasMapboxToken, mapboxToken } from './mapbox.js';

export const MAPBOX = 'mapbox';
export const MAPLIBRE = 'maplibre';

// Which basemap key belongs to which library. One entry today, and a Set rather
// than an `=== 'mapbox'` because the next Mapbox style added — a satellite one,
// say — should be a word here and nothing else.
//
// Deliberately *not* a field on the STYLES entries in main.js, tempting as that
// is. This has to be answerable before main.js has been loaded at all: which
// library to fetch is the first decision of the page, and STYLES lives seven
// thousand lines inside the module that cannot be parsed until it is made.
const MAPBOX_BASEMAPS = new Set(['mapbox']);

export const STYLE_KEY = 'visited-map:style:v1';

/**
 * Which library has to draw a given basemap.
 *
 * A Mapbox basemap with no token is not Mapbox's problem to draw — there is
 * nothing it could fetch — so it reports MapLibre and main.js moves the basemap
 * somewhere MapLibre can go.
 */
export const engineForBasemap = (key) =>
  (MAPBOX_BASEMAPS.has(key) && hasMapboxToken() ? MAPBOX : MAPLIBRE);

/** The basemap the last visit left on, whatever it was. */
export function savedStyleKey() {
  try {
    return localStorage.getItem(STYLE_KEY) ?? '';
  } catch {
    return '';
  }
}

// What `loadEngine` last produced, so main.js can read it without awaiting.
//
// **Why this is not a top-level `await` in main.js**, which is what it wants to
// be: the build targets Safari 14, because that is the WebKit inside the iOS
// app, and top-level await did not arrive until Safari 15. Raising the floor to
// buy one `await` would drop the app off the phones it was written for. So
// `src/boot.js` awaits this and *then* imports main.js, which is free to read
// the answer synchronously — the ordering is guaranteed by the import itself
// rather than by anybody remembering to check.
let loaded = null;

/** The library in use, once boot.js has settled it. */
export const engineNow = () => loaded;

/**
 * Load a map library and its stylesheet.
 *
 * @param {string} which MAPBOX or MAPLIBRE
 * @returns {Promise<{gl: object, engine: string}>}
 */
export async function loadEngine(which) {
  if (which === MAPBOX) {
    const [mod] = await Promise.all([
      import('mapbox-gl'),
      import('mapbox-gl/dist/mapbox-gl.css'),
    ]);
    const gl = mod.default ?? mod;
    // Mapbox GL JS reads this global when it resolves a `mapbox://` URL, which
    // is every URL in Standard. Set before any Map is constructed; there is no
    // per-map option for it.
    gl.accessToken = mapboxToken();
    loaded = { gl, engine: MAPBOX };
    return loaded;
  }
  const [mod] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]);
  loaded = { gl: mod.default ?? mod, engine: MAPLIBRE };
  return loaded;
}

// --- The class-name prefix ----------------------------------------------------
//
// The two libraries build identical control DOM and name it differently:
// `.maplibregl-ctrl-geolocate` against `.mapboxgl-ctrl-geolocate`, all the way
// down. That is answered in two places, and it is worth saying which does what.
//
// **Styling** is `style.css`, where every one of those selectors now names both
// prefixes through an `:is()` pair. That costs nothing at runtime and cannot
// drift, because there is still exactly one copy of each rule.
//
// **Reading and writing** is this function. `main.js` reaches for the geolocate
// button by class in five places — MapLibre publishes its three-state toggle
// nowhere else, so the state has to be read off the element and, in one case,
// written back to it. Mirroring the names onto the element was tried first and
// is worse in two ways that both bite: a `querySelector` running in the same
// tick as `addControl` would not see a mirror delivered by a MutationObserver,
// and `dropLockOnZoom` *removes* a state class, which a mirror would put
// straight back because the library's own copy of it is still there.
//
// One library is live per page, so the prefix is simply a lookup — and what is
// read and written is the name the library itself uses.
export const ctrlClass = (suffix) =>
  `${loaded?.engine === MAPBOX ? 'mapboxgl' : 'maplibregl'}-${suffix}`;

// ...except for one moment, and it is the moment a basemap switch is made of.
//
// "One library is live per page" stopped being true the day the map could be
// rebuilt instead of the page: `switchEngine` loads the incoming library
// *first*, so that a failed download leaves the map on screen alone — and
// `loadEngine` sets `loaded` as it resolves. From there until the new map is
// built, `ctrlClass` names the library that is arriving while the DOM still
// belongs to the one that is leaving, and every selector built from it matches
// nothing.
//
// That window is exactly where the outgoing control's state has to be read, so
// reading is done under both names. Writing still goes through `ctrlClass`: a
// class written under the wrong prefix would be a class the library never looks
// at, which fails silently in the other direction.
const PREFIXES = ['maplibregl', 'mapboxgl'];

/** Both libraries' names for one control class. */
export const ctrlClasses = (suffix) => PREFIXES.map((p) => `${p}-${suffix}`);

/** A selector matching that class whichever library built the element. */
export const ctrlSelector = (suffix) => ctrlClasses(suffix).map((c) => `.${c}`).join(', ');

/** Is this element carrying that control class, under either library's name? */
export const hasCtrlClass = (el, suffix) =>
  ctrlClasses(suffix).some((c) => el?.classList?.contains(c));

// --- Where our layers go ------------------------------------------------------
//
// Everything this app draws is inserted relative to the basemap: the visited
// wash goes under the streets and rooftops, and the railways, airports and
// photographs go under the labels. On MapLibre that is a `beforeId` — the id of
// a real layer, worked out by reading `map.getStyle().layers`.
//
// **On Standard there are no layers to read.** The style is one `import`, and
// `getStyle().layers` comes back empty, so there is no id to insert before.
// Standard answers this with **slots**: named places in the imported stack that
// a layer asks for by declaring `slot`. It is the better mechanism — it is a
// promise about position that survives Mapbox reordering the style underneath
// it, where a `beforeId` is a guess that a layer id still means what it meant.
//
// So the two anchors become sentinels, and `installAddLayerSlots` below teaches
// one `map.addLayer` to translate them. That is deliberately a wrapper rather
// than a change at the fourteen call sites in `main.js` and the three overlay
// modules: those all say `map.addLayer(spec, before)` today and go on saying it.
export const WASH_SLOT_ID = '@hexplore-wash';
export const LABEL_SLOT_ID = '@hexplore-labels';

// `middle` is above the ground, the water and the roads, and below the 3D
// buildings and every label — which is exactly the description the visited wash
// has always been given. `top` is above the buildings and the POI icons, which
// is where a photograph pin belongs.
const SLOT_OF = {
  [WASH_SLOT_ID]: 'middle',
  [LABEL_SLOT_ID]: 'top',
};

/** Is this one of the sentinels rather than a real layer id? */
export const isSlot = (id) => typeof id === 'string' && id in SLOT_OF;

// --- Being lit, and refusing to be ---------------------------------------------
//
// Mapbox GL JS lights the whole scene from the style, and at dusk and night that
// light is dim and blue. Every layer type this app draws with is lit by default:
// `line`, `fill`, `circle` and `raster` all ship `*-emissive-strength: 0`, which
// means "take the scene's light". So a route, a railway and the visited wash were
// all being *dimmed by the sun going down* — correct for a road, which is a thing
// lying in the world, and wrong for an annotation drawn on top of it. The map's
// own labels never had the problem: `icon-` and `text-emissive-strength` default
// to 1, which is exactly the admission that some things are not lit by the scene.
//
// So ours say the same. Injected here rather than written into twenty layer
// definitions because it is a fact about the renderer, not about any of them —
// and because it has to reach the railway overlay's 288 layers too, which are
// somebody else's style and not ours to annotate.
//
// Only when the layer has not asked for its own, so a caller that wants to be
// lit — or half-lit — still can.
const EMISSIVE_OF = {
  line: 'line-emissive-strength',
  fill: 'fill-emissive-strength',
  circle: 'circle-emissive-strength',
  raster: 'raster-emissive-strength',
};
// 1 is "ignore the scene's light entirely", which is what a drawn-on annotation
// wants. Lower it to let night dim our layers along with the map again.
const EMISSIVE_STRENGTH = 1;

function selfLit(spec) {
  const prop = EMISSIVE_OF[spec.type];
  if (!prop || (spec.paint && prop in spec.paint)) return spec;
  return { ...spec, paint: { ...spec.paint, [prop]: EMISSIVE_STRENGTH } };
}

/**
 * Teach a Mapbox map to read the two sentinels as slots.
 *
 * Wraps `addLayer` in place. Anything that is not a sentinel is passed straight
 * through, so a `beforeId` naming one of our own layers — which is most of them,
 * once `installGrid` has run — keeps working exactly as it does on MapLibre.
 *
 * @param {object} map a Mapbox GL JS map
 */
export function installAddLayerSlots(map) {
  const add = map.addLayer.bind(map);
  map.addLayer = (spec, before) => {
    const lit = selfLit(spec);
    const slot = SLOT_OF[before];
    return slot ? add({ ...lit, slot }, undefined) : add(lit, before);
  };
}

// --- Sprites the style did not declare ---------------------------------------
//
// The train-tracks overlay draws from four sprite sheets that are fetched only
// if a switched-on group actually reads from one — 2.25 MB of atlas that must
// not arrive for a layer nobody asked for. MapLibre has an API for exactly that,
// `map.addSprite(id, url)`, and refers to the images as `spriteId:imageName`.
//
// **Mapbox GL JS has no such thing.** A style there has one sprite, declared up
// front, and `map.getSprite` is not a function — which is precisely how this
// failed: `installRail` threw on its first line and the overlay reported nothing
// worse than "could not be loaded".
//
// The shim below does by hand what the API does: fetch the atlas and its JSON,
// cut each icon out of it, and hand the pieces to `map.addImage` under the same
// `spriteId:imageName` keys the rail style already asks for. Nothing in
// src/rail.js knows the difference.
//
// One sheet at a time and only when asked, exactly as before — this is a shim
// for the API, not a change of policy about what gets downloaded.

/** `${url}@2x.png` on a retina screen, `${url}.png` elsewhere — MapLibre's rule. */
const spriteFormat = () => ((window.devicePixelRatio || 1) > 1 ? '@2x' : '');

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin, so no `crossOrigin` — and deliberately not `'anonymous'`,
    // which was the first version and fetched *without credentials*. The
    // atlases are behind this app's session cookie, so that got a 401 and the
    // icons silently never arrived. Set it only if the atlas ever moves off
    // this origin, where a tainted canvas could not be read back at all.
    if (new URL(url, location.href).origin !== location.origin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`sprite image ${url} could not be loaded`));
    img.src = url;
  });
}

async function addSpriteAsImages(map, id, url) {
  const format = spriteFormat();
  const [meta, atlas] = await Promise.all([
    // `same-origin` credentials, for the same reason as the image above.
    fetch(`${url}${format}.json`, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(`sprite ${url} answered ${r.status}`);
      return r.json();
    }),
    fetchImage(`${url}${format}.png`),
  ]);
  const cut = document.createElement('canvas');
  const ctx = cut.getContext('2d', { willReadFrequently: true });
  for (const [name, icon] of Object.entries(meta)) {
    if (!icon?.width || !icon?.height) continue;
    const key = `${id}:${name}`;
    if (map.hasImage(key)) continue;
    cut.width = icon.width;
    cut.height = icon.height;
    ctx.clearRect(0, 0, icon.width, icon.height);
    ctx.drawImage(atlas, icon.x, icon.y, icon.width, icon.height, 0, 0, icon.width, icon.height);
    map.addImage(key, ctx.getImageData(0, 0, icon.width, icon.height), {
      pixelRatio: icon.pixelRatio ?? 1,
      // An SDF icon is recoloured by `icon-color`, and the rail style leans on
      // that heavily. Getting this wrong draws the icons in flat black.
      sdf: !!icon.sdf,
    });
  }
}

/**
 * Give a Mapbox map MapLibre's multi-sprite API.
 *
 * @param {object} map a Mapbox GL JS map
 */
export function installSpriteShim(map) {
  if (typeof map.getSprite === 'function') return; // MapLibre already has it
  const added = new Set();
  map.getSprite = () => [...added].map((id) => ({ id }));
  map.addSprite = (id, url) => {
    if (added.has(id)) return;
    added.add(id);
    addSpriteAsImages(map, id, url).catch((e) => {
      // Forgotten again so a later attempt can retry, and warned about rather
      // than thrown: a sheet that will not load costs the icons that read from
      // it, not the overlay and certainly not the map.
      added.delete(id);
      console.warn(`Sprite "${id}" could not be added.`, e);
    });
  };
  map.removeSprite = (id) => added.delete(id);
  // A style swap throws every image away, and the rail overlay's installer is
  // idempotent precisely so it can put them back — but it asks `getSprite()`
  // first, and a shim still claiming to hold them would talk it out of it.
  map.on('style.load', () => added.clear());
}

// --- Style state the expressions read -----------------------------------------
//
// OpenRailwayMap's style is 288 layers that consult **global state** 1,529
// times: `["global-state", "theme"]`, `["global-state", "showAbandoned…"]` and
// so on, with a `state` block of defaults at the top. It is how one style draws
// a light railway and a dark one, and how a group is switched off without
// touching a layer. MapLibre has it; Mapbox GL JS has never heard of it, and a
// style full of an expression it cannot parse is 288 layers it will not add.
//
// The shim resolves those expressions to the values they would have had, at the
// moment each layer is added — and remembers the layer as it was written, so a
// state change can resolve it again. That is the whole difference in cost:
// MapLibre re-evaluates one state property, and here a change to `theme` walks
// every layer that mentions it and re-sets what moved. Rail groups are switched
// once in a while, so that is the right trade; it would be the wrong one for
// something that changed per frame.
const GLOBAL_STATE = 'global-state';

/** Does this fragment consult global state at all — optionally, a given key? */
function readsState(node, key) {
  if (Array.isArray(node)) {
    if (node[0] === GLOBAL_STATE) return key === undefined || node[1] === key;
    return node.some((n) => readsState(n, key));
  }
  if (node && typeof node === 'object') return Object.values(node).some((v) => readsState(v, key));
  return false;
}

/** The same fragment with every `["global-state", k]` replaced by its value. */
function resolveState(node, state) {
  if (Array.isArray(node)) {
    // `null` rather than undefined: an unset key is a value the expression can
    // still be typed against, where a hole in the array is a parse error.
    if (node[0] === GLOBAL_STATE) return state[node[1]] ?? null;
    return node.map((n) => resolveState(n, state));
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveState(v, state)]));
  }
  return node;
}

/**
 * Give a Mapbox map MapLibre's global style state.
 *
 * Wraps `addLayer`, so install it **after** `installAddLayerSlots` — this one
 * resolves the spec and hands it on, and the slot wrapper underneath still gets
 * to translate the anchor.
 *
 * @param {object} map a Mapbox GL JS map
 */
export function installGlobalStateShim(map) {
  if (typeof map.setGlobalStateProperty === 'function') return; // MapLibre has it
  const state = {};
  // Layers as they were written, for the ones that actually read state. Kept so
  // a later change to a key can be applied to a layer already on the map.
  const unresolved = new Map();
  const add = map.addLayer.bind(map);

  map.addLayer = (spec, before) => {
    if (!readsState(spec)) return add(spec, before);
    unresolved.set(spec.id, spec);
    return add(resolveState(spec, state), before);
  };

  map.setGlobalStateProperty = (key, value) => {
    if (state[key] === value) return;
    state[key] = value;
    for (const [id, spec] of unresolved) {
      if (!map.getLayer(id) || !readsState(spec, key)) continue;
      const now = resolveState(spec, state);
      if (now.filter !== undefined) map.setFilter(id, now.filter);
      for (const [k, v] of Object.entries(now.paint ?? {})) map.setPaintProperty(id, k, v);
      for (const [k, v] of Object.entries(now.layout ?? {})) map.setLayoutProperty(id, k, v);
    }
  };

  map.getGlobalState = () => ({ ...state });
  // A style swap drops every layer, so the specs describe nothing. The state
  // itself stays: it is what the overlay was last told to draw, and it is set
  // again on the way back in anyway.
  map.on('style.load', () => unresolved.clear());
}

// --- Which way a drag turns the map -------------------------------------------
//
// The two libraries disagree, and it is not a bug in either. Mapbox turns by the
// horizontal distance dragged and nothing else. MapLibre turns the map *around
// its centre*, like a wheel: grab above the centre-line and drag right and the
// map turns one way, grab below it and the same drag turns it the other. Both
// are defensible; having both in one app is not, because the gesture is muscle
// memory and it should not change when the basemap does.
//
// Mapbox's is the one this map keeps, so MapLibre's move function is replaced
// with Mapbox's — `(currentPoint.x - lastPoint.x) * 0.8`, which is that library's
// own line, copied.
//
// This reaches inside MapLibre, so it is read before it is written, the same way
// `dropLockOnZoom` reaches for `_watchState`: a MapLibre that has renamed any of
// this leaves the gesture alone rather than breaking the map.
const ROTATE_DEGREES_PER_PIXEL = 0.8;

export function matchMapboxRotation(map) {
  const handler = map.dragRotate?._mouseRotate;
  if (typeof handler?._moveFunction !== 'function') return;
  handler._moveFunction = (lastPoint, currentPoint) => ({
    bearingDelta: (currentPoint.x - lastPoint.x) * ROTATE_DEGREES_PER_PIXEL,
  });
}
