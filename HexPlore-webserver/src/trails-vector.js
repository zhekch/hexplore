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
// **The mountain-bike and horse rows are kept and have never once matched.**
// Counted over 3370 features across twelve mountain-bike destinations — Finale
// Ligure, Whistler, Morzine, Davos, Livigno, Bikepark Wales, Sedona and the rest
// — `imn`/`nmn`/`rmn` appear exactly zero times, and the only MTB-ish network in
// the whole sample was one free-text `mtb`. They stay because they are correct
// OSM and cost nothing to carry; nothing should be built on the assumption that
// they will fire. What mountain biking actually looks like in this schema is
// MTB_SCALES below.
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
const SCALE = ['coalesce', ['get', 'scale'], ''];

// --- What mountain biking is here ---------------------------------------------
//
// **Not a class, and not a network — a grade.** Their `class` has no MTB value:
// a downhill trail and a Sunday cycle route are both `bicycle`. And the MTB
// network codes never appear (see MAIN_NETWORKS). What *is* there, and in
// quantity, is `mtb:scale` in the `scale` field: 1651 of the 3370 features
// counted across twelve bike destinations carry one, on named trails that are
// the actual reason people go — "Dolmen" and "Trail Ruote di Pietra" above
// Finale Ligure, and their equivalents at Whistler and Morzine.
//
// So an MTB trail here is a bicycle way with a grade on it, which is a theme of
// *trails* where hiking and cycling are themes of *routes*. That difference is
// why the reach ladder is hidden for it, exactly as it is for pistes.
//
// **Written out rather than matched on the leading digit**, for the same reason
// MAIN_NETWORKS is: `scale` also carries `sac_scale` for walkers ("hiking",
// "mountain_hiking") and whatever anybody has typed — the sample held `yes`,
// `bad` and `0+` — and "starts with a 0" is a test that a value like `0 metres`
// would pass. These twenty-one are every spelling mtb:scale actually has.
const MTB_SCALES = ['0', '1', '2', '3', '4', '5', '6']
  .flatMap((n) => [n, `${n}+`, `${n}-`]);

/** A bicycle way somebody has graded, and that nobody has signed as a route. */
const IS_MTB = ['all',
  ['in', SCALE, ['literal', MTB_SCALES]],
  // Signed cycle routes stay in Cycling even where one is also graded, so the
  // two themes partition `bicycle` between them and no feature falls down the
  // gap. In the measured sample the two never co-occur, but a route that is both
  // belongs under the sign it carries.
  ['==', NETWORK, ''],
];

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
 * Four, the same count as the raster provider, and two of them mean something
 * different here.
 *
 * **Mountain bike is a theme of trails, not of routes.** Their `class` is `foot
 * | hiking | via_ferrata | bicycle | horse | wheelchair` with no MTB value in
 * it, and the MTB network codes never appear — so this row was left out at
 * first, on the reasoning that there was nothing honest to put in it. That was
 * half right and the wrong conclusion: what MapTiler carries is `mtb:scale` on
 * individual ways, in quantity and on the named trails people actually ride. See
 * IS_MTB. It is a real row; it is just not made of route relations, which is why
 * the reach ladder is hidden for it.
 *
 * **`ski` is their separate layer**, and is the same shape of thing — graded by
 * difficulty rather than ranked by reach.
 *
 * `horse` and `wheelchair` are still absent from every theme. They are real and
 * they are not what any of these rows say, which is the same decision as
 * `riding` on the other provider. See src/trails.js.
 */
export const MAPTILER_THEMES = [
  { key: 'hiking', label: t('trails.hiking') },
  { key: 'cycling', label: t('trails.cycling') },
  { key: 'mtb', label: t('trails.mtb') },
  { key: 'ski', label: t('trails.ski') },
];

const DEFAULT_THEME = 'hiking';

/** Is this a theme this provider can draw? */
export const isMaptilerTheme = (key) => MAPTILER_THEMES.some((th) => th.key === key);

/**
 * The nearest theme this provider can draw to the one that is chosen.
 *
 * The two providers offer the same four rows under three shared names, so the
 * only one that has to move is the raster's `slopes`, which is this one's `ski`
 * — the same thing under another name. Anything unrecognised falls back to
 * hiking.
 */
export const nearestMaptilerTheme = (key) => {
  if (isMaptilerTheme(key)) return key;
  if (key === 'slopes') return 'ski';
  return DEFAULT_THEME;
};

// Which source layer a theme reads, and which features in it.
//
// `ski` is a layer of its own in their schema rather than a class — it carries
// pistes, lifts, pylons and avalanche fencing together — so the two are not
// interchangeable and the theme decides which is read.
const SOURCE_LAYER = { hiking: 'trail', cycling: 'trail', mtb: 'trail', ski: 'ski' };

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
  mtb: ['bicycle'],
  ski: ['downhill', 'nordic', 'skitour', 'sled', 'hike', 'connection', 'playground'],
};

// What a theme wants beyond its classes. Cycling and mountain bike read the same
// class and split it between them — see IS_MTB — so a feature belongs to exactly
// one of the two rows, and neither row silently contains the whole of the other.
const THEME_EXTRA = {
  mtb: IS_MTB,
  cycling: ['!', IS_MTB],
};

/**
 * Whether this theme is made of signed routes at all.
 *
 * The two that are not — pistes, graded by difficulty, and mountain bike trails,
 * graded by `mtb:scale` — carry no `network` between them, so every rung of the
 * ladder would draw the identical map and the row is not shown. The same shape
 * as `trailsHaveReach` on the other provider.
 *
 * **It decides more than the ladder.** A theme with no networks has no
 * signed-versus-unsigned distinction either, so the dashes and the casing follow
 * it too — see `themeFilters`. Drawing an entire theme dashed, which is what was
 * happening to `ski` before anybody looked at it, says "none of this is a real
 * route" about a map on which nothing could ever be one.
 */
export const maptilerHasReach = (theme) => theme !== 'ski' && theme !== 'mtb';

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
// Mountain bike deliberately shares cycling's colour rather than taking one of
// its own or being graded green-to-black by `mtb:scale`. Difficulty is a real
// axis and it is not this overlay's question — this is a map of where you have
// been, and a second palette competing with the waymark colours would be two
// legends on one map. The grade is in the tap card, where somebody asking about
// one trail can read it.
const THEME_COLORS = {
  light: { hiking: '#c2410c', cycling: '#1d4ed8', mtb: '#1d4ed8', ski: '#0e7490' },
  dark: { hiking: '#fb923c', cycling: '#60a5fa', mtb: '#60a5fa', ski: '#22d3ee' },
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
  const core = [
    ['==', ['geometry-type'], 'LineString'],
    ['in', ['coalesce', ['get', 'class'], ''], ['literal', classes]],
  ];
  const extra = THEME_EXTRA[want];
  if (extra) core.push(extra);

  // **A theme with no networks has no unsigned half.** Pistes and graded MTB
  // trails are all "unsigned" in the letter of the data, so splitting them the
  // way hiking is split puts every feature in the dashed layer and none in the
  // solid one — a whole map drawn as though it were a collection of shortcuts.
  // For those themes the routes layer takes everything and the paths layer takes
  // nothing.
  if (!maptilerHasReach(want)) {
    return {
      base: ['all', ...core],
      casing: ['all', ...core],
      // Deliberately unsatisfiable rather than absent: the layer still exists,
      // because the four are added and removed as a set, and a filter that
      // cannot match is the cheapest way to say "not on this theme".
      //
      // Written with `['literal', 1]` rather than a bare `1`, which is not
      // pedantry: `['==', 1, 0]` is read as the *legacy* filter syntax, where
      // the first argument is a property name and must be a string — so the
      // plain spelling does not evaluate to false, it fails to compile.
      paths: ['==', ['literal', 1], 0],
      routes: ['all', ...core],
      labels: ['all', ...core, ['!=', NAME, '']],
    };
  }

  const signed = ['all', ...core, ['!=', NETWORK, '']];
  return {
    base: ['all', ...core],
    casing: signed,
    paths: ['all', ...core, ['==', NETWORK, '']],
    routes: signed,
    labels: ['all', ...core, ['!=', NETWORK, ''], ['!=', NAME, '']],
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

// **Weighted to sit beside Waymarked Trails rather than under it.** The first
// version was about half of this, which was legible on its own and looked thin
// and provisional the moment somebody switched providers to compare — their
// cartography draws a route as a confident stroke, and a 2 px line beside it
// reads as a draft of one. Multiplied through WEIGHT above, a national route is
// about 4 px at z12 where a footpath is under 2, which is the same span their
// renderer uses.
const widthAt = (scale) => [
  'interpolate', ['linear'], ['zoom'],
  8, ['*', 0.7 * scale, WEIGHT],
  12, ['*', 1.9 * scale, WEIGHT],
  16, ['*', 3.2 * scale, WEIGHT],
];

/** Where the tiles come from, on this server. See `vectorTrailTileUrl`. */
export const TILE_PATH = '/api/trails/mt/{z}/{x}/{y}.pbf';

/**
 * The tile template, as a URL MapLibre will actually fetch.
 *
 * **Absolute, and that is not a style choice — a relative one does not work at
 * all.** Vector tiles are fetched inside a Web Worker, which has no document to
 * resolve a path against, so `/api/trails/mt/…` comes back as `Failed to
 * construct 'Request': Failed to parse URL` and the source sits there loaded and
 * empty. Nothing draws, nothing 404s, and the network panel shows no request to
 * explain it. A raster source has none of this trouble because its tiles are
 * fetched on the main thread, which is why the other trails provider gets away
 * with a bare path.
 *
 * **Concatenated, deliberately, rather than `new URL(path, origin)`.** `URL`
 * normalises, and normalising a tile template percent-encodes the placeholders
 * into `%7Bz%7D/%7Bx%7D/%7By%7D` — which MapLibre then cannot substitute, so
 * every tile is requested with the braces still in the path and every one of
 * them 404s. `railUrl` in src/rail.js says the same thing for the same reason;
 * this is the second module to need it and the second to be bitten by it.
 *
 * The origin is a parameter so that a test can call this at all: `location` is a
 * browser thing, and these run in node.
 */
export const vectorTrailTileUrl = (origin = location.origin) => origin + TILE_PATH;

/**
 * The source as MapLibre and Mapbox both want it.
 *
 * Exported so a test can hold it to the things that are not taste: the URL must
 * go through this app's own proxy — the key is on the other side of it, and so
 * is the promise that MapTiler is never told where somebody is looking — the
 * placeholders must survive whatever made it absolute, and `maxzoom` must be the
 * zoom past which their server answers 400.
 */
export function vectorTrailSourceSpec(origin) {
  return {
    type: 'vector',
    tiles: [vectorTrailTileUrl(origin)],
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
        // A hair over the line it sits under, not a multiple of it: now the
        // lines are heavier, a 2.6× casing is a 3 px halo each side and the
        // overlay reads as a road network. 1.55 keeps it to about a pixel.
        'line-width': widthAt(1.55),
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
    // A graded trail carries no operator and no network, so without this a
    // mountain bike row is a bare name — and the grade is the one fact somebody
    // looking at an unfamiliar trail actually wants.
    between: str(p.operator) || mtbGrade(p) || (name ? reachWord(network) : null),
    main: !!network && MAIN_NETWORKS.includes(network),
    // **The waymark, which this provider was not supposed to be able to show.**
    // Their `symbol` is the raw `osmc:symbol` tag — `yellow::yellow_diamond` —
    // and there is no id to look a drawing up by. What makes it work anyway is
    // that Waymarked Trails renders a symbol *from the tag*, needing nothing the
    // two services have to agree on beyond the OSM tag they both read. See
    // `validSymbolTag` in server/trail-tiles.js.
    //
    // The `alt` is the waymark's colour rather than the tag: `alt` describes a
    // picture for somebody who cannot see it, and `yellow::yellow_diamond` is
    // the source code of one.
    symbol: str(p.symbol)
      ? { url: vectorTrailSymbolUrl(str(p.symbol), network), alt: str(p.color) ?? '' }
      : null,
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

// **Always their hiking host, whatever the route is for.** Their symbol API is
// per activity and the obvious thing is to ask the one that matches — a cycle
// route from `cycling`, a walk from `hiking`. Measured, that is wrong: the
// cycling host answers 404 to `from_tags` for *every* tag, including ones the
// hiking host renders happily. It is not a gap in their data, it is what their
// cycling map is: cycle routes are drawn as numbered shields rather than painted
// waymarks, so there is no osmc renderer behind that host to call.
//
// Which is fine, because `osmc:symbol` is a waymarking convention rather than a
// walking one — a blue bar painted on a post is the same picture whoever it is
// for — and the hiking renderer draws all of them.
const SYMBOL_HOST = 'hiking';

/**
 * Where the drawing of one waymark lives — this app's own proxy, as ever.
 *
 * The network travels with the tag because it picks the frame the waymark is
 * drawn on: the same tag under `INT` and under `LOC` is different bytes. See
 * `symbolStyleFor` in server/trail-tiles.js.
 */
export const vectorTrailSymbolUrl = (tag, network) =>
  `/api/trails/symbol-tag.svg?theme=${SYMBOL_HOST}`
  + `&osmc=${encodeURIComponent(tag)}&network=${encodeURIComponent(network ?? '')}`;

/**
 * How hard a mountain bike trail is, as a phrase — or null if this is not one.
 *
 * `mtb:scale` runs 0 (a smooth track) to 6 (unrideable by nearly everybody), and
 * it is left as its number rather than translated into words. Six invented
 * adjectives would be this app asserting a difficulty scale it did not define
 * and cannot calibrate; the number is what the tag says and what every guide to
 * it is written in.
 */
export function mtbGrade(props) {
  const scale = typeof props?.scale === 'string' ? props.scale.trim() : '';
  if (props?.class !== 'bicycle' || !MTB_SCALES.includes(scale)) return null;
  return t('trails.mtb-grade', { v: scale });
}

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
