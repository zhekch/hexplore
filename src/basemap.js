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
  // Dark enough to survive being seen *through* the visited wash — see the
  // reorder in terrainStyle(). At the published near-black it read as a hole;
  // at the land colour it vanished under a coloured cell.
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

  // Buildings belong *under* the visited wash, because a building is ground —
  // not something drawn over the map the way a street or a label is.
  //
  // The app inserts the wash immediately before the style's first symbol layer
  // (see installGrid), and OpenFreeMap publishes `water_name` at index 8 with
  // `building` right after it. So every building landed on top of the coloured
  // cells as an opaque dark polygon, punching a swarm of holes through a town.
  // Moving it in with the other ground fills makes a built-up area read as
  // texture in the cell's own colour. Roads and rails deliberately stay above:
  // they are how you recognise where you are, and a 2 px line doesn't blot out
  // the colour underneath the way a rooftop does.
  const buildingAt = style.layers.findIndex((l) => l.id === 'building');
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  if (buildingAt > firstSymbol && firstSymbol > -1) {
    style.layers.splice(firstSymbol, 0, ...style.layers.splice(buildingAt, 1));
  }

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

  // Labels that belong on a photograph are the ones naming *places*. Street
  // names and motorway shields do not: they are unreadable at the zooms this
  // map is usually at, they clutter the imagery, and OpenFreeMap gives them no
  // minzoom at all — so "A1" and every lane name were still being drawn from
  // halfway across the country. One-way arrows go for the same reason.
  const DROP_LABELS = new Set([
    'highway_name_other',
    'highway_name_motorway',
    'road_oneway',
    'road_oneway_opposite',
  ]);

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
    } else if (layer.type === 'line' && /^(highway|boundary)/.test(layer.id)) {
      // Roads and borders only, and quietly: enough to orient by, not enough to
      // draw over what the imagery is showing. White at any real strength turns
      // an aerial photo into a road map with a photo behind it.
      patchLayer(layer, {
        paint: {
          'line-color': /^boundary/.test(layer.id)
            ? 'rgba(255, 255, 255, 0.34)'
            : 'rgba(230, 236, 240, 0.2)',
          'line-opacity': 1,
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
