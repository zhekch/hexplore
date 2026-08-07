// The two basemaps that aren't just a URL.
//
// MapLibre takes a style *object* anywhere it takes a style URL, which is what
// makes both of these possible without hosting anything: fetch somebody else's
// style JSON, change the parts that are wrong, hand the result to the map.
//
//   Terrain   OpenFreeMap's dark style, recoloured. As published it is a
//             near-black monochrome — background rgb(12,12,12), forest
//             rgb(32,32,32), water rgb(27,27,29) with the blue channel two
//             points above the others. That is the look this exists to get
//             away from, so every colour below is overwritten: land becomes a
//             desaturated grey-green, forest becomes green and starts drawing
//             at z4 instead of z10, water becomes properly blue, roads become
//             legible warm grey, and Natural Earth's shaded relief — which the
//             style already declares as a source and then never uses — is
//             switched on underneath at low zoom.
//
//   Satellite Esri's World Imagery, with VersaTiles' satellite style supplying
//             the labels. Imagery on its own is unreadable for this app: you
//             cannot tell which valley you covered without place names on top.
//
// Both fall back to a plain style if the network doesn't cooperate — a basemap
// that fails to fetch must not take the whole map down with it.

const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark';
const VT_SATELLITE = 'https://tiles.versatiles.org/assets/styles/satellite/style.json';

// Esri's own tile cache, no key. Note the order: {z}/{y}/{x}, not the usual
// {z}/{x}/{y} — Esri serves row before column and a swap yields blank tiles.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIB =
  'Powered by <a href="https://www.esri.com/">Esri</a> — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const OSM_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// --- The dark palette ---------------------------------------------------------
// Read against the reference: land a desaturated grey-green, forest clearly
// greener than bare ground, water clearly bluer than both, labels near-white.
// Nothing here is pure black.
//
// Roads are deliberately darker than the reference. This basemap is background
// for the visited cells, not the subject: at the reference's brightness the
// road network read louder than the wash on top of it, which is backwards.
const LAND = '#333f33';
const LAND_SOFT = '#3a4a3c';
const FOREST = '#3f5133';
const PARK = '#42522f';
const WATER = '#1b2a3a';
const WATERWAY = '#22344a';
const ROAD_MINOR = '#4f5850';
const ROAD_MAJOR = '#646d61';
const ROAD_TRUNK = '#7c8274';
const ROAD_CASING = 'rgba(24, 32, 26, 0.85)';
const LABEL = '#eef2ea';
const LABEL_HALO = 'rgba(0, 0, 0, 0.78)';
const WATER_LABEL = '#9fb6c8';

// layer id → what to overwrite. Ids that aren't in the style are skipped, so an
// upstream rename degrades to "that layer keeps its old colour" rather than an
// exception.
const DARK_PATCH = {
  background: { paint: { 'background-color': LAND } },
  landuse_residential: { paint: { 'fill-color': LAND_SOFT } },
  landuse_park: { paint: { 'fill-color': PARK } },
  landcover_wood: {
    // Published gated at z10 with a fading opacity ramp, so at the zooms this
    // map spends its life at there is no forest at all. It is the single
    // biggest reason the style reads as flat grey.
    minzoom: 4,
    paint: { 'fill-color': FOREST, 'fill-opacity': 0.55, 'fill-pattern': undefined },
  },
  landcover_grass: { minzoom: 4, paint: { 'fill-color': '#3c4d33', 'fill-opacity': 0.45 } },
  landcover_glacier: { paint: { 'fill-color': '#4a544e' } },
  landcover_ice_shelf: { paint: { 'fill-color': '#4a544e' } },
  water: { paint: { 'fill-color': WATER } },
  waterway: { paint: { 'line-color': WATERWAY } },
  // Drawn over the visited wash, so this is a rooftop on top of the colour
  // rather than something seen through it. Published near-black it read as a
  // hole punched in the cell; lifted to here it reads as texture, and the
  // outline is what keeps a dense block from filling in as one dark mass.
  building: { paint: { 'fill-color': '#27342b', 'fill-outline-color': '#3d4d3f' } },

  highway_path: { paint: { 'line-color': '#464e42' } },
  highway_minor: { paint: { 'line-color': ROAD_MINOR } },
  highway_major_casing: { paint: { 'line-color': ROAD_CASING } },
  highway_major_inner: { paint: { 'line-color': ROAD_MAJOR } },
  highway_major_subtle: { paint: { 'line-color': '#495046' } },
  highway_motorway_casing: { paint: { 'line-color': ROAD_CASING } },
  highway_motorway_inner: { paint: { 'line-color': ROAD_TRUNK } },
  highway_motorway_subtle: { paint: { 'line-color': ROAD_MINOR } },
  highway_motorway_bridge_casing: { paint: { 'line-color': ROAD_CASING } },
  highway_motorway_bridge_inner: { paint: { 'line-color': ROAD_TRUNK } },
  'aeroway-runway': { paint: { 'line-color': ROAD_MINOR } },
  'aeroway-taxiway': { paint: { 'line-color': '#5a6155' } },
  'aeroway-area': { paint: { 'fill-color': '#39473a' } },
  railway_transit: { paint: { 'line-color': '#4b544a' } },
  railway_transit_dashline: { paint: { 'line-color': LAND } },
  railway_service: { paint: { 'line-color': '#4b544a' } },
  railway_service_dashline: { paint: { 'line-color': LAND } },
  railway: { paint: { 'line-color': '#4b544a' } },
  railway_dashline: { paint: { 'line-color': LAND } },
  railway_minor: { paint: { 'line-color': '#4b544a' } },
  // A dashline draws the *gaps* over the rail, so it has to be the land colour
  // exactly — left black it stripes the track with the old background.
  railway_minor_dashline: { paint: { 'line-color': LAND } },
  road_area_pier: { paint: { 'fill-color': LAND } },
  road_pier: { paint: { 'line-color': LAND } },

  boundary_3: { paint: { 'line-color': '#5f6b57' } },
  boundary_2: { paint: { 'line-color': '#6f7c65' } },
  boundary_2_z0: { paint: { 'line-color': '#6f7c65' } },
  boundary_2_z2: { paint: { 'line-color': '#6f7c65' } },

  water_name_line: { paint: { 'text-color': WATER_LABEL, 'text-halo-color': LABEL_HALO } },
  water_name_point: { paint: { 'text-color': WATER_LABEL, 'text-halo-color': LABEL_HALO } },
  highway_name_other: {
    paint: { 'text-color': '#cfd5c8', 'text-halo-color': LABEL_HALO },
    layout: { 'text-transform': 'none' },
  },
  highway_name_motorway: { paint: { 'text-color': '#e2e5dc', 'text-halo-color': LABEL_HALO } },
};

// Anything whose id starts with one of these is a place label: one rule rather
// than twelve near-identical entries, and it keeps working if a new tier
// (place_city_small, say) appears upstream.
const LABEL_PREFIXES = ['place_', 'country_', 'continent'];

async function fetchStyle(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const style = await res.json();
  if (!style || !Array.isArray(style.layers)) throw new Error(`${url} is not a MapLibre style`);
  return style;
}

/** Apply `overrides` to a layer in place, deleting keys set to undefined. */
function patchLayer(layer, overrides) {
  if (overrides.minzoom !== undefined) layer.minzoom = overrides.minzoom;
  for (const bucket of ['paint', 'layout']) {
    if (!overrides[bucket]) continue;
    layer[bucket] = layer[bucket] ?? {};
    for (const [key, value] of Object.entries(overrides[bucket])) {
      if (value === undefined) delete layer[bucket][key];
      else layer[bucket][key] = value;
    }
  }
}


// --- The zoom diet ------------------------------------------------------------
// Terrain and Satellite are both built from OpenFreeMap's style, which labels
// everything it has and gates almost none of it: every one of its place tiers —
// hamlet, suburb, village, town, city — has no `minzoom` at all, so village
// names are drawn at world zoom, and `highway_minor` starts at z8, which puts
// every lane in a canton on screen while you are looking at a country.
//
// Light (CARTO Voyager) is the one that reads cleanly, and it is disciplined
// about exactly this: hamlets at z12, villages at z10, towns at z8, cities from
// z4 by rank, road names from z13, minor roads from z13. These are those gates,
// applied to the layers OpenFreeMap gives the same job to. Nothing is
// recoloured here and nothing is added — labels and roads simply stop arriving
// before they can be read.
const LABEL_GATES = {
  place_other: 13, //     hamlets and localities
  place_suburb: 12,
  place_village: 11,
  place_town: 7,
  place_city: 6,
  place_city_large: 4,
  place_state: 5,
  place_country_other: 4,
  place_country_minor: 3,
  place_country_major: 2,
  water_name: 5,
  // Street names, on Light's own schedule. OpenFreeMap gives these no minzoom
  // at all, so "A1" was drawn from halfway across the country — which is why
  // they used to be dropped outright, and dropping them meant Terrain and
  // Satellite had no street names at any zoom, including the zoom where you are
  // looking at one street. Voyager names its major roads from z13 and works down
  // to minor at z16; OpenFreeMap splits the same job two ways, so the motorway
  // shields take the early gate and everything else waits until the map is
  // showing a neighbourhood rather than a city.
  highway_name_motorway: 13,
  highway_name_other: 15,
};

// Roads. The motorway tier already carries a sensible gate upstream (z6); it is
// the ones below it that arrive far too early.
const ROAD_GATES = {
  highway_path: 15,
  highway_minor: 13,
  road_pier: 14,
  railway: 11,
};

// The real offender is `highway_major_subtle`, which OpenFreeMap draws from z6
// with primary, secondary, tertiary AND trunk all in the one layer: 225 road
// features on screen at z9 where Light draws 71. Light gets that number by
// splitting the classes and gating each one — trunk early, primary at z8,
// secondary at z11, tertiary later still — so these are those gates, applied
// class by class inside the filter the layer already has.
//
// Zoom in a filter is only evaluated at integer zooms, which for a road
// appearing is exactly the right granularity.
const ROAD_CLASS_GATES = [
  ['trunk', 0],
  ['primary', 8],
  ['secondary', 11],
  ['tertiary', 13],
];

// The layers whose filter is `class in (primary, secondary, tertiary, trunk)`.
// Everything the upstream styles draw as road-like: the tiers themselves, plus
// the railways and piers that clutter at the same zooms.
const ROAD_LAYER = /^(highway|railway|road_)/;

// --- Where the visited wash goes ----------------------------------------------
// Anything a basemap draws *over* the ground rather than as ground: the streets,
// the tunnels and bridges carrying them, the railways, the rooftops.
//
// Deliberately not the aeroways. CARTO puts `aeroway-runway` among the water
// fills, below its first label, and a runway there is ground the way a car park
// is — pulling the anchor above it would drag the wash under the water.
const OVERLAY_LAYER = /^(tunnel|bridge|road|highway|rail|building)/;

/**
 * The layer the visited wash is inserted before: over everything that is ground,
 * under everything drawn on top of it.
 *
 * The first symbol layer used to decide this alone, and it is right about Light
 * only by luck. CARTO publishes Voyager and Dark Matter as the same 93 layers in
 * the same order with one difference that matters — Voyager puts
 * `waterway_label` at index 13, just before the tunnels, and Dark Matter puts it
 * at 66, after every road, rail and building in the style. So one rule landed
 * the wash under the streets on Light and over them on Dark, where a town came
 * out a flat patch of colour with nothing drawn in it.
 *
 * OpenFreeMap has the same problem from the other side: `water_name` at 8 and
 * `building` at 9, so its rooftops cleared the wash by a single layer, and
 * terrainStyle() used to answer that by moving the buildings down instead.
 *
 * Hence: whichever comes first, the style's first label or the first thing it
 * draws over the ground. On Voyager that is still index 13, so Light — the one
 * that already looked right — does not move.
 *
 * @param {Array<{id: string, type: string}>} layers a style's layers, in order
 * @returns {string|undefined} the layer id to pass as MapLibre's `beforeId`
 */
export function washAnchorIn(layers) {
  const at = (layers ?? []).findIndex((l) => l.type === 'symbol' || OVERLAY_LAYER.test(l.id));
  return at > -1 ? layers[at].id : undefined;
}

const MAJOR_ROAD_LAYERS = new Set([
  'highway_major_subtle',
  'highway_major_casing',
  'highway_major_inner',
]);

// Below this zoom Terrain and Satellite draw no roads at all — not faint ones,
// none. A motorway network seen from a country away is texture, not
// information: you cannot follow it, you cannot name it, and on a photograph it
// is a grey scribble over the thing you came to look at. Fading them was the
// first answer and it was the wrong one; at z3 a whisper across the whole of
// Europe is still a whisper across the whole of Europe.
//
// It is a floor applied with MAX, never assignment — `highway_minor` is already
// held to z13 and `highway_path` to z15, and this must not undo that.
const ROAD_MIN_ZOOM = 8;
// And by here they are drawn properly. Between the two they arrive gradually,
// so the first road does not appear at full strength on one notch of the wheel.
const ROAD_FULL_ZOOM = 11;

// Light keeps its roads on the map when you zoom out, but barely visible — the
// network is there to orient by, not to be read, and that restraint is most of
// why it feels calm at world zoom. OpenFreeMap draws the same lines at full
// strength from z0, so on a zoomed-out terrain or satellite map the roads were
// the loudest thing on screen while Light's had faded to a whisper. This map
// now goes one step further than Light and draws none below ROAD_MIN_ZOOM.
const ROAD_FADE = [
  'interpolate', ['linear'], ['zoom'],
  ROAD_MIN_ZOOM, 0,
  ROAD_MIN_ZOOM + 1, 0.45,
  ROAD_FULL_ZOOM, 1,
];

function gateRoadClasses(layer) {
  layer.filter = [
    'all',
    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    [
      'any',
      ...ROAD_CLASS_GATES.map(([cls, z]) =>
        (z ? ['all', ['==', ['get', 'class'], cls], ['>=', ['zoom'], z]] : ['==', ['get', 'class'], cls])),
    ],
  ];
}

// Markings that a map of where you have been never needed. One-way arrows are
// for driving down a street, not for recognising one you walked along.
//
// Street names were here too, and should not have been: unreadable *at the zooms
// this map is mostly used at* is an argument for a minzoom, not for deleting the
// layer. See LABEL_GATES.
const LABEL_DROP = new Set(['road_oneway', 'road_oneway_opposite']);

/**
 * Put a built style on the same zoom diet Light keeps. Returns the layers that
 * survive, in order, so the caller can decide what else to do with them.
 *
 * @param {object} style a MapLibre style object, modified in place
 */
function applyZoomDiet(style) {
  const kept = [];
  for (const layer of style.layers) {
    if (LABEL_DROP.has(layer.id)) continue;
    const gate = LABEL_GATES[layer.id] ?? ROAD_GATES[layer.id];
    // Never *lower* an upstream gate — this is a diet, not a redesign.
    if (gate !== undefined && (layer.minzoom ?? 0) < gate) layer.minzoom = gate;
    if (MAJOR_ROAD_LAYERS.has(layer.id)) gateRoadClasses(layer);
    // Every road tier fades in as the map zooms in, and does not exist below
    // ROAD_MIN_ZOOM. Railways and piers ride along: they are the same kind of
    // clutter at the same zooms.
    if (ROAD_LAYER.test(layer.id)) {
      // MAX, so a tier already held further in keeps its own floor.
      if ((layer.minzoom ?? 0) < ROAD_MIN_ZOOM) layer.minzoom = ROAD_MIN_ZOOM;
      // A layer that upstream stops drawing before roads are allowed back is
      // simply dropped: keeping it would leave minzoom past maxzoom, which is a
      // layer that can never draw and only costs a parse.
      if (layer.maxzoom !== undefined && layer.maxzoom <= ROAD_MIN_ZOOM) continue;
      if (layer.type === 'line') patchLayer(layer, { paint: { 'line-opacity': ROAD_FADE } });
    }
    kept.push(layer);
  }
  style.layers = kept;
  return kept;
}

/**
 * OpenFreeMap's dark style, recoloured into something that isn't black.
 * @returns {Promise<object>} a MapLibre style object
 */
export async function terrainStyle() {
  const style = await fetchStyle(OFM_DARK);

  for (const layer of style.layers) {
    const patch = DARK_PATCH[layer.id];
    if (patch) patchLayer(layer, patch);
    else if (layer.type === 'symbol' && LABEL_PREFIXES.some((p) => layer.id.startsWith(p))) {
      patchLayer(layer, {
        paint: { 'text-color': LABEL, 'text-halo-color': LABEL_HALO, 'text-halo-width': 1.3 },
        // Every place tier is published `text-transform: uppercase`, which
        // shouts BURGDORF at you from a town of nine thousand. Sentence case is
        // both quieter and what the map it is imitating does.
        layout: { 'text-transform': 'none' },
      });
    }
  }

  // `building` is published at index 9, right after `water_name` at 8, and used
  // to be moved below it so the rooftops sat under the visited wash. That was
  // solving the wrong half of the problem: it made Terrain's buildings agree
  // with Dark, where the wash covered everything, and disagree with Light, where
  // a town keeps its shape in the cell's own colour. Light is the one that looks
  // right, so the wash anchor moved instead — see washAnchor() in src/main.js —
  // and the layer is left where OpenFreeMap puts it.

  // Labels and minor roads on the same zoom diet Light keeps — see
  // applyZoomDiet(). Done after the recolouring, which is keyed by layer id and
  // must see every layer.
  applyZoomDiet(style);

  // Shaded relief. The source is already declared and unused; putting it just
  // above the background gives the land some shape at the zooms where this map
  // is usually looked at, and fades out before it can fight with the blobs.
  if (style.sources?.ne2_shaded && !style.layers.some((l) => l.id === 'natural_earth')) {
    style.layers.splice(1, 0, {
      id: 'natural_earth',
      type: 'raster',
      source: 'ne2_shaded',
      maxzoom: 7,
      layout: { visibility: 'visible' },
      paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.22, 6, 0.06],
        'raster-saturation': -0.45,
        'raster-contrast': 0.1,
      },
    });
  }

  for (const source of Object.values(style.sources ?? {})) {
    if (!source.attribution) source.attribution = OSM_ATTRIB;
  }
  return style;
}

/**
 * Esri World Imagery, with OpenFreeMap's labels and roads over the top.
 *
 * Built from the *same* style as Terrain rather than a second provider's, which
 * was the first attempt: VersaTiles publishes a ready-made satellite style, but
 * it is 208 layers designed around its own imagery — which the research found
 * only covers Germany and parts of Europe (NYC, London and Tokyo all 404 above
 * z12) — and swapping the source under it left the map black and the style
 * permanently "not loaded". Starting from a style this app already renders
 * correctly, and keeping only what belongs over a photograph, is both smaller
 * and something we control.
 *
 * Kept: the labels, because imagery without place names is unreadable — you
 * cannot tell which valley you covered. And the roads, faintly, because they
 * are how you recognise where you are.
 * Dropped: every fill. A photograph is the ground truth; painting landcover
 * over it would be drawing on the evidence.
 * @returns {Promise<object>}
 */
export async function satelliteStyle() {
  let style;
  try {
    style = await fetchStyle(OFM_DARK);
  } catch {
    // No labels, but a working satellite map beats no satellite map.
    return bareSatellite();
  }

  // One-way arrows are markings rather than labels, and mean nothing over a
  // photograph. Belt and braces with LABEL_DROP in the diet, whatever that is
  // tuned to next.
  //
  // Street names are *not* dropped here any more. They were, on the grounds that
  // they clutter the imagery — true from a country away and false at the zoom
  // where you are trying to work out which street you walked down, which is the
  // zoom a photograph is most worth having. The diet holds them back until then
  // (see LABEL_GATES), which is the same answer the place names get.
  const DROP_LABELS = new Set(['road_oneway', 'road_oneway_opposite']);

  // Over a photograph the road network has to be thinner still: the imagery is
  // the subject, and every lane drawn on top of it turns an aerial photo into a
  // road map with a photo behind it. So the diet's gates apply, and then only
  // the tiers you actually orient by survive at all.
  applyZoomDiet(style);
  const SAT_ROADS = /^(highway_motorway|highway_major|boundary)/;

  const keep = [];
  for (const layer of style.layers) {
    if (DROP_LABELS.has(layer.id)) continue;
    if (layer.type === 'symbol') {
      // Labels, in white with a hard halo — over aerial photography the halo is
      // doing most of the work.
      patchLayer(layer, {
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0, 0, 0, 0.85)',
          'text-halo-width': 1.6,
        },
        layout: { 'text-transform': 'none' },
      });
      keep.push(layer);
    } else if (layer.type === 'line' && SAT_ROADS.test(layer.id)) {
      // Roads and borders only, and quietly: enough to orient by, not enough to
      // draw over what the imagery is showing. White at any real strength turns
      // an aerial photo into a road map with a photo behind it.
      patchLayer(layer, {
        paint: {
          'line-color': /^boundary/.test(layer.id)
            ? 'rgba(255, 255, 255, 0.34)'
            : 'rgba(230, 236, 240, 0.2)',
          // Boundaries hold their strength — at world zoom they are the only
          // thing telling you which country you are looking at. Roads take the
          // diet's fade, so zooming out quietens them the way Light does.
          'line-opacity': /^boundary/.test(layer.id) ? 1 : ROAD_FADE,
        },
      });
      keep.push(layer);
    }
  }

  style.sources.imagery = {
    type: 'raster',
    tiles: [ESRI_IMAGERY],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIB,
  };
  // The photograph goes underneath everything that survived.
  style.layers = [{ id: 'imagery', type: 'raster', source: 'imagery' }, ...keep];
  return style;
}

/** Imagery with no labels — the fallback when the label style can't be had. */
function bareSatellite() {
  return {
    version: 8,
    sources: {
      imagery: {
        type: 'raster',
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution: ESRI_ATTRIB,
      },
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }],
  };
}
