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
// So the engine is **decided at boot, from the chosen basemap**, and switching
// across the two families reloads the page. That is a real wart and it is the
// cheap half of a trade: `main.js` builds its map at module scope and wires
// twenty handlers around it inline, so swapping the engine in place means
// tearing all of that down and standing it back up — the most expensive part of
// the app to get wrong, for a transition that happens when somebody presses one
// button. The page already restores its camera from localStorage on every load
// (`savedView()`), so what you actually see is a flash and the same view back.
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
    mirrorControlClasses();
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
// down. `src/style.css` restyles those controls fairly heavily — the geolocate
// button is redrawn from scratch — and it does so through `:is()` pairs that
// name both prefixes, which is why almost none of this file is needed.
//
// Almost. `:is()` handles every selector the app wrote; what it cannot handle is
// the handful of places `main.js` reaches for a control **by class name** to
// read its state — the geolocate button's three-state toggle is inspected with
// `classList.contains('maplibregl-ctrl-geolocate-active')`, because MapLibre
// publishes that state nowhere else. Rewriting those call sites to test both
// prefixes would mean threading the engine through five functions that have no
// other reason to know about it.
//
// So on Mapbox the control container is watched and every `mapboxgl-` class is
// mirrored to its `maplibregl-` twin. The app then goes on asking the question
// it has always asked, and this is the only file that knows there are two names
// for everything.
//
// It is a no-op on MapLibre, where it is never called.
const PREFIX = /\bmapboxgl-/;

function mirrorOn(el) {
  if (!(el instanceof Element)) return;
  for (const name of [...el.classList]) {
    if (!PREFIX.test(name)) continue;
    const twin = name.replace('mapboxgl-', 'maplibregl-');
    // Checked before adding: `classList.add` of a class already present writes
    // nothing and so raises no mutation record, but the check is what makes
    // that guarantee ours rather than the DOM's.
    if (!el.classList.contains(twin)) el.classList.add(twin);
  }
}

function mirrorTree(root) {
  mirrorOn(root);
  if (root instanceof Element) root.querySelectorAll('[class*="mapboxgl-"]').forEach(mirrorOn);
}

function mirrorControlClasses() {
  const start = () => {
    const container = document.getElementById('map');
    if (!container) return;
    mirrorTree(container);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') mirrorOn(record.target);
        else record.addedNodes.forEach(mirrorTree);
      }
    }).observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      // Only the attribute that carries the names. Without this filter the
      // observer wakes on every `style` write MapLibre makes to the canvas
      // during a gesture, which is a callback per frame for nothing.
      attributeFilter: ['class'],
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

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
    const slot = SLOT_OF[before];
    return slot ? add({ ...spec, slot }, undefined) : add(spec, before);
  };
}
