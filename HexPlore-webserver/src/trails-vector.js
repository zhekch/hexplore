// The waymarked trails overlay again — the same routes as src/trails.js, drawn
// from vector tiles instead of somebody else's pixels.
//
// **Both exist on purpose, and neither is the successor to the other.** The
// raster overlay is Waymarked Trails' own cartography: a renderer that has been
// tuned for years by somebody who cares about hiking maps, with waymark drawings
// and elevation profiles behind every route. What it cannot do is answer a
// question, because by the time it arrives it is ink. This one is the data, from
// MapTiler's Outdoor schema, and everything it does better follows from that one
// fact:
//
//   **"Only the routes you have heard of" is a filter here.** On the raster it
//   is not expressible at all — their renderer decides what to draw and the
//   answer arrives already drawn. Here it is `REACH` below, evaluated in the
//   renderer as the map moves, with no round trip and nothing to cache.
//
//   **A tap knows what it hit.** `queryRenderedFeatures` over a vector layer
//   returns the feature, so the card names *this* route rather than listing what
//   runs near the finger. The raster's card is a list of candidates and is
//   worded to admit it; see the head of src/trails.js.
//
//   **It can be drawn for a dark map.** The line colour is ours, so the waymark
//   colour is used where the route carries one and adjusted for the map
//   underneath — where recolouring the raster would be inventing signage.
//
// And what it does worse, which is why the other one stays:
//
//   **There is no OSM id on a feature.** Their `trail` layer carries class,
//   name, ref, operator, symbol, colour, network and scale, and nothing that
//   identifies the relation — measured against the live tiles, not assumed. So a
//   card here cannot link to OpenStreetMap, cannot fetch the waymark drawing,
//   and cannot ask anybody how long the route is. The raster provider's card can
//   do all three.
//
//   **`osmc:symbol` is a string, not a picture.** `symbol` arrives as
//   `yellow::yellow_diamond` — the tag, unrendered. Waymarked Trails draws it.
//
//   **It stops at z14.** Their tileset's deepest zoom, where the raster goes to
//   18. For lines that is a much smaller loss than it sounds — see
//   MAPTILER_MAX_ZOOM in server/maptiler-tiles.js — but it is a loss.
//
//   **It needs a key, and the free tier has a monthly ceiling.** The raster
//   needs nothing and belongs to a volunteer project.
//
// So the provider is a choice, kept in src/trails.js beside the theme, and this
// module is what the choice reaches when it lands on MapTiler.
//
// The tiles come through this app's own server, for the reason every other
// overlay does and one more: the key. See server/maptiler-tiles.js.

import { t } from './i18n.js';

// --- What the `trail` layer actually contains ---------------------------------
//
// **It is not only routes, and that is the thing worth knowing before reading
// any of the filters below.** Their `trail` layer carries route relations *and*
// bare OSM paths in the same bucket, distinguished only by what they are tagged
// with. Counted over live tiles across ten countries:
//
//   z5–z8   every feature has a `network`, and it is `iwn` or `icn` — they have
//           already thinned to the international routes for us.
//   z10     3190 features in one Alpine tile, 301 of them with a `network`. The
//           other 2889 are footpaths: no name, no ref, no network, a `sac_scale`
//           and nothing else.
//   z14     87 features, 6 with a network.
//
// So from z10 down the overlay is nine parts unsigned path to one part signed
// route unless something says otherwise. That is the whole reason REACH exists,
// and it is why its default is not "everything".

// The route networks that are somebody's guidebook rather than somebody's
// parish. OSM spells these `[level][activity]n` — `i`nternational, `n`ational,
// `r`egional, `l`ocal, over `w`alking, `c`ycling, `m`ountain bike and `h`orse —
// so this is the first three levels across all four activities.
//
// **Written out rather than matched on the first letter**, which would be four
// characters of expression and would also swallow every free-text network a
// region has invented: `network=Rundweg` is not a national route because it
// begins with an R. An unrecognised network still counts as *waymarked* below —
// it is a network, whatever it is called — and does not count as main, which is
// the conservative way round.
const MAIN_NETWORKS = [
  'iwn', 'nwn', 'rwn',
  'icn', 'ncn', 'rcn',
  'imn', 'nmn', 'rmn',
  'ihn', 'nhn', 'rhn',
];

// Read the field once. An absent property and an empty one both arrive here as
// `''` — their tiles carry `"name": ""` explicitly rather than omitting the key,
// which is worth pinning down because `["!=", ["get","name"], ""]` is *true* for
// a property that is missing and would quietly pass every feature.
const NETWORK = ['coalesce', ['get', 'network'], ''];
const NAME = ['coalesce', ['get', 'name'], ''];
const REF = ['coalesce', ['get', 'ref'], ''];

/**
 * How much of the network to draw — the reason this provider exists.
 *
 * A ladder rather than a switch, because "important" is not one question. The
 * four rungs are the four honest cuts the data supports, in the order of how
 * much they leave on the map.
 */
export const TRAIL_REACH = [
  // Everything the tiles carry, footpaths included. What a raw MapTiler Outdoor
  // style shows, and at z12+ over anywhere walkable it is a thicket.
  { key: 'all', label: () => t('trails.reach-all') },
  // Anything that is called something — a name, a number, or a network. Drops
  // the unnamed paths, which is most of the volume and none of the answers.
  { key: 'named', label: () => t('trails.reach-named') },
  // Anything in a signed network at all, local included. This is the closest
  // thing to what the raster provider draws, which is why it is the default.
  { key: 'waymarked', label: () => t('trails.reach-waymarked') },
  // International, national and regional only. The routes with a name, a number
  // and an operator behind them.
  { key: 'main', label: () => t('trails.reach-main') },
];

// **Waymarked, not main.** Two arguments, and they point the same way. It is
// what the other provider draws, so switching provider changes how the routes
// look and not which ones exist — a filter that also silently dropped four
// fifths of them would make the two impossible to compare. And the local
// network is the half of this data that is hardest to get anywhere else: a
// yellow diamond footpath is exactly what somebody checking "was there already a
// name for the way I went" is looking for. Both stricter and looser are one
// press away, and the choice is remembered.
const DEFAULT_REACH = 'waymarked';
const REACH_KEY = 'visited-map:trail-reach:v1';

/** Is this a rung we know? Every way in goes through it — see `trailReach`. */
export const isTrailReach = (key) => TRAIL_REACH.some((r) => r.key === key);

/**
 * How much of the network is drawn, falling back to the default for anything
 * odd or absent.
 *
 * Validated rather than trusted, for the same reason the theme is: this is a
 * string in `localStorage`, which a newer build, an older one, or a person with
 * the devtools open can all have written. An unknown rung would be a filter
 * expression that matches nothing — an overlay that is switched on, says it is
 * showing something, and draws an empty map.
 */
export function trailReach() {
  let held;
  try {
    held = localStorage.getItem(REACH_KEY);
  } catch {
    held = null;
  }
  return isTrailReach(held) ? held : DEFAULT_REACH;
}

/** Choose one. Returns what is now stored, so a caller can mirror it without reading back. */
export function setTrailReach(key) {
  const clean = isTrailReach(key) ? key : DEFAULT_REACH;
  try {
    localStorage.setItem(REACH_KEY, clean);
  } catch {
    /* private mode — it falls back to the default next load, which is the safe way round */
  }
  return clean;
}

/** What to call a rung, for a sentence rather than a button. */
export const trailReachLabel = (key) =>
  (TRAIL_REACH.find((r) => r.key === key)?.label ?? (() => key))();

/**
 * The rung as a filter expression, or null for "everything".
 *
 * Exported for the test, which is the only way to check an expression that is
 * otherwise evaluated inside somebody else's renderer.
 */
export function reachFilter(reach) {
  switch (isTrailReach(reach) ? reach : DEFAULT_REACH) {
    case 'all':
      return null;
    case 'named':
      return ['any', ['!=', NAME, ''], ['!=', REF, ''], ['!=', NETWORK, '']];
    case 'main':
      return ['in', NETWORK, ['literal', MAIN_NETWORKS]];
    case 'waymarked':
    default:
      return ['!=', NETWORK, ''];
  }
}

// --- Which map of trails ----------------------------------------------------------

/**
 * The renderings this provider offers.
 *
 * **Three, where the raster provider has four, and the missing one is mountain
 * bike.** Their `class` field is `foot | hiking | via_ferrata | bicycle | horse
 * | wheelchair`, with no MTB value in it — an MTB route and a cycle route are
 * both `bicycle`, and the only thing separating them is that individual MTB
 * *paths* carry an `mtb:scale` in `scale`. A theme built on that would show
 * unsigned singletrack and nothing else the moment the reach filter came off
 * "all", which is a row that lies about what it contains.
 *
 * The same decision as `riding` on the other provider, for the same reason: a
 * menu entry that cannot do what its label says costs more than its absence.
 * See src/trails.js.
 */
export const MAPTILER_THEMES = [
  { key: 'hiking', label: t('trails.hiking') },
  { key: 'cycling', label: t('trails.cycling') },
  { key: 'ski', label: t('trails.ski') },
];

const DEFAULT_THEME = 'hiking';

/** Is this a theme this provider can draw? */
export const isMaptilerTheme = (key) => MAPTILER_THEMES.some((th) => th.key === key);

/**
 * The nearest theme this provider can draw to the one that is chosen.
 *
 * The two providers do not offer the same list, so switching provider has to
 * land somewhere. `mtb` becomes `cycling`, which is the same tiles minus a
 * distinction MapTiler does not carry, and `slopes` becomes `ski`, which is the
 * same thing under another name. Anything else falls back to hiking.
 */
export const nearestMaptilerTheme = (key) => {
  if (isMaptilerTheme(key)) return key;
  if (key === 'mtb') return 'cycling';
  if (key === 'slopes') return 'ski';
  return DEFAULT_THEME;
};

// Which source layer a theme reads, and which features in it.
//
// `ski` is a layer of its own in their schema rather than a class — it carries
// pistes, lifts, pylons and avalanche fencing together — so the two are not
// interchangeable and the theme decides which is read.
const SOURCE_LAYER = { hiking: 'trail', cycling: 'trail', ski: 'ski' };

// The classes each theme draws.
//
// Hiking takes `foot` and `via_ferrata` along with `hiking`: a signed footpath
// through a town is the same kind of answer as a mountain route, and a via
// ferrata is emphatically something somebody walked. `horse` and `wheelchair`
// are left out of both — they are real and they are not what either row says.
//
// Ski takes the two kinds of piste and leaves the machinery: a chairlift, a
// pylon and a run of avalanche fencing are all in that layer, and none of them
// is a route anybody travels under their own power. `station` is the resort
// itself, which is a point and not a line.
const THEME_CLASSES = {
  hiking: ['hiking', 'foot', 'via_ferrata'],
  cycling: ['bicycle'],
  ski: ['downhill', 'nordic', 'skitour', 'sled', 'hike', 'connection', 'playground'],
};

/** Whether the reach filter means anything for this theme. */
// Pistes carry no `network` — they are graded by difficulty, which is a
// different question — so every rung of the ladder would draw the same map and
// the row is not shown. The same shape as `trailsHaveReach` on the other
// provider, and for the same reason.
export const maptilerHasReach = (theme) => theme !== 'ski';

// --- How it is drawn ---------------------------------------------------------------

const NS = 'hexplore-mtrails';
const SOURCE = `${NS}-src`;
const CASING = `${NS}-casing`;
const PATHS = `${NS}-paths`;
const ROUTES = `${NS}-routes`;
const LABELS = `${NS}-labels`;

/** Our layer ids, for anyone reordering the stack or taking it off. */
export const vectorTrailLayerIds = () => [CASING, PATHS, ROUTES, LABELS];

/** The layers a tap should ask about — the lines, never the labels. */
export const vectorTrailTapLayers = () => [ROUTES, PATHS];

// The deepest zoom their tileset has. Past it the renderer overzooms the z14
// tile, which for geometry is a correct rescaling rather than a blur.
const MAX_ZOOM = 14;

// **The waymark colour, twice, because a colour that reads on white does not
// read on near-black.** Their `color` is derived from `osmc:symbol` and is one
// of eight words. Only about one route in eight carries one at all, so this is a
// grace note rather than the scheme — but where a route *is* the yellow diamond,
// drawing it yellow is the single most useful thing this overlay can do that
// the raster cannot do for a dark map.
//
// `black` is the one that has to move rather than merely brighten: a black
// waymark on a dark basemap is an invisible route, and the honest substitute is
// the lightest neutral rather than a colour it is not.
const WAYMARK_COLORS = {
  light: {
    red: '#d92b2b', blue: '#1f5fd0', green: '#0f8a3c', yellow: '#a8860b',
    brown: '#8a5a2b', orange: '#e06c00', purple: '#8b3fb5', black: '#2a2a2a',
  },
  dark: {
    red: '#ff6b6b', blue: '#6aa9ff', green: '#4fc776', yellow: '#e8c44a',
    brown: '#c89b6e', orange: '#ff9a4d', purple: '#c98bec', black: '#c9c9c9',
  },
};

// What a route with no waymark colour is drawn in — which is most of them.
//
// Not a neutral grey, which was the first version and made the overlay look
// like a road layer that had lost its labels. A hiking route is red on almost
// every printed map in Europe and Waymarked Trails draws it red too, so this is
// the colour somebody already expects for the thing they switched on.
const THEME_COLORS = {
  light: { hiking: '#c2410c', cycling: '#1d4ed8', ski: '#0e7490' },
  dark: { hiking: '#fb923c', cycling: '#60a5fa', ski: '#22d3ee' },
};

/** Light or dark, and never anything else — an unknown basemap reads as dark. */
const sideOf = (basemap) => (basemap === 'light' ? 'light' : 'dark');

/**
 * What each layer draws, before any rung of the ladder is applied.
 *
 * Separate from the paint because the filters are the one part of a layer that
 * changes while somebody is looking at the map — `setVectorTrailReach` needs
 * them without needing a basemap, an opacity or a fontstack to get at them.
 *
 * Every layer starts from the same two clauses. **Only lines**, because their
 * `ski` layer carries points (resorts, pylons) and polygons (piste areas) in
 * with the runs, and a `line-*` layer handed a point draws nothing while still
 * costing the tile a pass. And **only this theme's classes**, because both
 * themes that read the `trail` layer read the same one.
 *
 * Exported for the test, which is the only way to check an expression that is
 * otherwise evaluated inside somebody else's renderer.
 */
export function themeFilters(theme) {
  const want = isMaptilerTheme(theme) ? theme : DEFAULT_THEME;
  const classes = THEME_CLASSES[want];
  const base = ['all',
    ['==', ['geometry-type'], 'LineString'],
    ['in', ['coalesce', ['get', 'class'], ''], ['literal', classes]],
  ];
  const signed = ['all', ...base.slice(1), ['!=', NETWORK, '']];
  return {
    base,
    casing: signed,
    paths: ['all', ...base.slice(1), ['==', NETWORK, '']],
    routes: signed,
    labels: ['all', ...base.slice(1), ['!=', NETWORK, ''], ['!=', NAME, '']],
  };
}

/**
 * The line colour: the waymark's where there is one, the theme's where there is
 * not.
 *
 * A `match` with a default rather than a chain of `case`s, because this is
 * evaluated per feature per frame and `match` is the one the renderers compile
 * to a lookup.
 */
function colorFor(theme, side) {
  const palette = WAYMARK_COLORS[side];
  const fallback = THEME_COLORS[side][theme] ?? THEME_COLORS[side].hiking;
  return [
    'match', ['coalesce', ['get', 'color'], ''],
    ...Object.entries(palette).flatMap(([name, hex]) => [name, hex]),
    fallback,
  ];
}

/**
 * How heavy a line is, by how far its network reaches.
 *
 * The weight *is* the hierarchy — it is what makes a map with everything on it
 * still readable, and it is the half of "show me the important ones" that does
 * not involve hiding anything. A national route is drawn twice the width of an
 * unsigned path at every zoom.
 */
const WEIGHT = [
  'case',
  ['in', NETWORK, ['literal', MAIN_NETWORKS]], 2.2,
  ['!=', NETWORK, ''], 1.5,
  1.0,
];

const widthAt = (scale) => [
  'interpolate', ['linear'], ['zoom'],
  8, ['*', 0.55 * scale, WEIGHT],
  12, ['*', 1.0 * scale, WEIGHT],
  16, ['*', 1.9 * scale, WEIGHT],
];

/**
 * The source as MapLibre and Mapbox both want it.
 *
 * Exported so a test can hold it to the two things that are not taste: the URL
 * must go through this app's own proxy — the key is on the other side of it, and
 * so is the promise that MapTiler is never told where somebody is looking — and
 * `maxzoom` must be the zoom past which their server answers 400.
 */
export function vectorTrailSourceSpec() {
  return {
    type: 'vector',
    tiles: ['/api/trails/mt/{z}/{x}/{y}.pbf'],
    maxzoom: MAX_ZOOM,
    // On the source rather than the map's AttributionControl, the same mechanism
    // every other overlay uses: a source's credit shows only while the source is
    // present, so this arrives with the overlay and leaves with it. Both halves
    // are required by their terms, and the OSM half is the same sentence the
    // basemap is already showing — the control de-duplicates it.
    attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>',
  };
}

/**
 * Every layer, in the order they are added.
 *
 * Four rather than one, and each of them earns it:
 *
 *   **casing** is a dark or light halo under the signed routes only. An overlay
 *   drawn over five different basemaps cannot assume contrast, and a 1 px red
 *   line over a red-roofed town centre is a line nobody can follow. It is under
 *   the routes and not the paths because a casing on every footpath at z14 is
 *   twice the geometry for a thicket nobody was trying to read.
 *
 *   **paths** and **routes** are one distinction drawn twice, and they are two
 *   layers for a reason that is entirely MapLibre's: `line-dasharray` is not
 *   data-driven, so "signed routes solid, bare paths dashed" cannot be one
 *   layer with an expression in it. The dash is worth the second layer — at the
 *   looser rungs it is what stops an unsigned shortcut reading like a waymarked
 *   route.
 *
 *   **labels** is the thing a raster overlay can never have. Their tiles carry
 *   the name, so the route says what it is without being tapped.
 *
 * @param {object} opts
 * @param {string} opts.theme one of MAPTILER_THEMES
 * @param {'light'|'dark'} opts.basemap which way round the map underneath is
 * @param {number} opts.opacity how strongly the ink lands
 * @param {string[]} opts.font the basemap's own fontstack — see styleFont() in
 *   src/main.js. A stack the basemap's glyph server has never heard of is a
 *   label that silently never draws, which is why this is passed in rather than
 *   guessed at.
 */
export function vectorTrailLayerSpecs({ theme, basemap, opacity, font }) {
  const want = isMaptilerTheme(theme) ? theme : DEFAULT_THEME;
  const side = sideOf(basemap);
  const sourceLayer = SOURCE_LAYER[want];
  const classes = THEME_CLASSES[want];
  const color = colorFor(want, side);

  const { base, casing: casingFilter, paths: pathsFilter, routes: routesFilter, labels: labelsFilter } = themeFilters(want);

  return {
    sourceLayer,
    base,
    casing: {
      id: CASING,
      type: 'line',
      source: SOURCE,
      'source-layer': sourceLayer,
      filter: casingFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': side === 'light' ? '#ffffff' : '#0b0b0d',
        'line-width': widthAt(2.6),
        'line-opacity': opacity * 0.55,
      },
    },
    paths: {
      id: PATHS,
      type: 'line',
      source: SOURCE,
      'source-layer': sourceLayer,
      filter: pathsFilter,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': widthAt(1),
        'line-opacity': opacity * 0.75,
        // Short dashes, in line-widths rather than pixels, so the pattern holds
        // its proportions as the line thickens with zoom.
        'line-dasharray': [2, 1.6],
      },
    },
    routes: {
      id: ROUTES,
      type: 'line',
      source: SOURCE,
      'source-layer': sourceLayer,
      filter: routesFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': widthAt(1),
        'line-opacity': opacity,
      },
    },
    labels: {
      id: LABELS,
      type: 'symbol',
      source: SOURCE,
      'source-layer': sourceLayer,
      // Labelled only where there is something to say and the route is signed.
      // A name on every footpath is how a map stops being readable.
      filter: labelsFilter,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name'], ['get', 'ref'], ''],
        'text-font': font,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
        // Along the line rather than beside it, and repeated, because a route
        // crosses the screen and one label in the middle of it is a label you
        // have to hunt for.
        'symbol-spacing': 260,
        'text-max-angle': 32,
        'text-padding': 4,
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': side === 'light' ? '#2c2c2c' : '#e8e8ea',
        'text-halo-color': side === 'light' ? '#ffffff' : '#0b0b0d',
        'text-halo-width': 1.4,
        'text-opacity': opacity,
      },
    },
  };
}

/**
 * Draw it, or move it to a different theme.
 *
 * Idempotent, like every other overlay's installer: a basemap switch rebuilds
 * the map and every layer on it and lands here again with a fresh style and no
 * sources. Switching theme replaces the layers rather than the source — unlike
 * the raster provider, where the theme is in the tile URL, here it is a filter
 * and a source layer, so the tiles already on the wire are the right ones.
 *
 * @param {object} map
 * @param {object} opts see vectorTrailLayerSpecs, plus:
 * @param {string} opts.reach which rung of TRAIL_REACH to draw
 * @param {string|undefined} opts.before the layer to insert beneath
 */
export function installVectorTrails(map, { theme, basemap, opacity, font, reach, before }) {
  const want = isMaptilerTheme(theme) ? theme : DEFAULT_THEME;
  const specs = vectorTrailLayerSpecs({ theme: want, basemap, opacity, font });

  // The source outlives this module's idea of the world, so which theme its
  // layers are drawn for is read back off the map rather than tracked in a
  // module variable — the same reason src/trails.js does it that way.
  const held = map.getLayer(ROUTES);
  if (held && map.__hexploreMtrailsTheme !== want) removeVectorTrails(map, { keepSource: true });

  if (!map.getSource(SOURCE)) map.addSource(SOURCE, vectorTrailSourceSpec());

  for (const spec of [specs.casing, specs.paths, specs.routes, specs.labels]) {
    if (!map.getLayer(spec.id)) {
      map.addLayer(spec, before);
    } else {
      for (const [k, v] of Object.entries(spec.paint)) map.setPaintProperty(spec.id, k, v);
    }
  }
  map.__hexploreMtrailsTheme = want;
  setVectorTrailReach(map, reach, want);
}

/**
 * Apply a rung of the ladder to the layers that are already there.
 *
 * Separate from the install because this is the one thing that changes while
 * somebody is looking at the map, and rebuilding four layers to change a filter
 * would drop every tile the renderer has parsed.
 *
 * The rung is combined with each layer's own filter rather than replacing it:
 * the paths layer is defined by having no network and the routes layer by having
 * one, and a reach filter that overwrote that would put dashes under everything.
 */
export function setVectorTrailReach(map, reach, theme) {
  const want = isMaptilerTheme(theme) ? theme : (map.__hexploreMtrailsTheme ?? DEFAULT_THEME);
  const own = themeFilters(want);
  // Pistes have no network, so no rung of the ladder can say anything about
  // them; applying one would draw an empty map. See maptilerHasReach.
  const extra = maptilerHasReach(want) ? reachFilter(reach) : null;
  const apply = (id, filter) => {
    if (!map.getLayer(id)) return;
    map.setFilter(id, extra ? ['all', filter, extra] : filter);
  };
  apply(CASING, own.casing);
  apply(PATHS, own.paths);
  apply(ROUTES, own.routes);
  apply(LABELS, own.labels);
}

/** How strongly the ink lands, without rebuilding anything. */
export function setVectorTrailOpacity(map, opacity) {
  if (map.getLayer(CASING)) map.setPaintProperty(CASING, 'line-opacity', opacity * 0.55);
  if (map.getLayer(PATHS)) map.setPaintProperty(PATHS, 'line-opacity', opacity * 0.75);
  if (map.getLayer(ROUTES)) map.setPaintProperty(ROUTES, 'line-opacity', opacity);
  if (map.getLayer(LABELS)) map.setPaintProperty(LABELS, 'text-opacity', opacity);
}

/** Take it off again — the layers first, then the source they read. */
export function removeVectorTrails(map, { keepSource = false } = {}) {
  for (const id of vectorTrailLayerIds()) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (!keepSource && map.getSource(SOURCE)) map.removeSource(SOURCE);
  if (!keepSource) map.__hexploreMtrailsTheme = undefined;
}

// --- What a tap actually hit --------------------------------------------------------

// How far from the finger counts. Pixels rather than metres, for the same reason
// the raster provider's radius is: it is a question about a fingertip, not about
// the ground. Smaller than that one's 22 px, because this returns what was
// *hit* rather than what runs nearby, and a generous box is how a tap on open
// ground comes back holding the path fifty metres away.
const TAP_RADIUS_PX = 8;

/** The screen box to ask about, given where the tap landed. */
export const tapBox = ({ x, y }, r = TAP_RADIUS_PX) => [
  [x - r, y - r], [x + r, y + r],
];

/**
 * One feature as a row, in the shape src/trails.js's card already renders.
 *
 * Deliberately the same keys as `describeTrail` there, so a card does not have
 * to know which provider it is showing — with two of them permanently null,
 * because their tiles do not carry the answers. See the head of this file.
 *
 * Every string here is an OSM tag value, which is to say something anyone on the
 * internet can edit, so this returns text and the caller sets it with
 * `textContent`.
 */
export function describeVectorTrail(feature) {
  const p = feature?.properties;
  if (!p) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const network = str(p.network);
  const name = str(p.name);
  const ref = str(p.ref);

  return {
    // No OSM relation id in their schema, so a row is identified by what it
    // says. Good enough for the one thing an id is used for here — telling two
    // rows of the same list apart — and honest about not being an id.
    id: `${network ?? ''}:${ref ?? ''}:${name ?? ''}`,
    title: name || ref || reachWord(network) || t('trails.unnamed-route'),
    // The card's muted tail, which on the other provider holds the itinerary —
    // the places a route runs between. This schema has no equivalent, and the
    // nearest useful thing it does carry is who signed the route: "Berner
    // Wanderwege" under a yellow diamond is exactly the fact that tells you
    // which network of paths you are standing in. Falls back to how far the
    // route reaches, so a row is never a bare name where the other provider
    // would have said something.
    between: str(p.operator) || (name ? reachWord(network) : null),
    main: !!network && MAIN_NETWORKS.includes(network),
    // Their `symbol` is the raw `osmc:symbol` tag — `yellow::yellow_diamond` —
    // not a drawing of it. Showing the tag would be showing somebody the source
    // code of a picture, so the card gets nothing here and the colour of the
    // line carries what it can instead.
    symbol: null,
    // Nothing to link to: without a relation id there is no OSM page for this.
    osm: null,
    // The parts the other provider has no equivalent of, which the card shows
    // in place of the waymark and the distance.
    network,
    ref,
    operator: str(p.operator),
    color: str(p.color),
    kind: str(p.class),
    scale: str(p.scale),
  };
}

/**
 * How far a network reaches, as a word — the heading for a route with no name.
 *
 * Spelled out as four literal keys rather than one built from the level letter,
 * which is what this wanted to be. A key assembled from a template literal is a
 * key no static check can find, and scripts/test/i18n.mjs refuses them for
 * exactly that reason: a missing translation would show up as the string
 * `trails.national` in a card, in one language, on somebody else's phone.
 */
const LEVEL_WORDS = {
  i: () => t('trails.international'),
  n: () => t('trails.national'),
  r: () => t('trails.regional'),
  l: () => t('trails.local'),
};

// The local half of the same `[level][activity]n` scheme as MAIN_NETWORKS. Only
// these four count as local: a free-text network beginning with an L is not a
// local route any more than `Rundweg` is a regional one.
const LOCAL_NETWORKS = ['lwn', 'lcn', 'lmn', 'lhn'];

export function reachWord(network) {
  if (!network) return null;
  if (MAIN_NETWORKS.includes(network)) return LEVEL_WORDS[network[0]]();
  if (LOCAL_NETWORKS.includes(network)) return LEVEL_WORDS.l();
  return null;
}

/**
 * What a tap hit, deduplicated.
 *
 * **A route is many features.** Their tiles cut a relation into one feature per
 * way and per tile, so a single tap on the Via Alpina comes back holding it four
 * times over. Two routes are the same route here when everything the schema says
 * about them agrees — which is the best this data supports, and is why `id`
 * above is built out of the same three fields.
 *
 * Ordered main-first, the same way the other provider's list is, and for the
 * same reason: what is this path, and then what else is here.
 */
export function trailsAtTap(map, point, { reach } = {}) {
  const layers = vectorTrailTapLayers().filter((id) => map.getLayer(id));
  if (!layers.length) return [];
  let hits;
  try {
    hits = map.queryRenderedFeatures(tapBox(point), { layers });
  } catch {
    // A style swap mid-tap leaves the layers named but not queryable. An empty
    // answer is the honest one and is what the card already knows how to say.
    return [];
  }
  const seen = new Map();
  for (const f of hits) {
    const row = describeVectorTrail(f);
    if (!row) continue;
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  const rows = [...seen.values()];
  // `reach` is passed only so the list cannot contradict the map: the renderer
  // has already filtered what is drawn, and a query only ever returns drawn
  // features, so this is belt and braces rather than the filter itself.
  const wanted = reach === 'main' ? rows.filter((r) => r.main) : rows;
  return [...wanted.filter((r) => r.main), ...wanted.filter((r) => !r.main)];
}
