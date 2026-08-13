// The waymarked trails overlay — the hiking, cycling and winter routes that
// somebody has actually signed and painted onto a post, drawn over whatever
// basemap is underneath.
//
// **This one is pixels, and the railways are not.** That is the interesting
// difference between the two reference overlays, and it is a decision rather
// than an accident. OpenRailwayMap publishes vector tiles, so src/rail.js gets
// 288 layers it can restyle, filter, hit-test and recolour for a dark map.
// Waymarked Trails publishes PNGs and nothing else — there is no vector service
// to point at — so what arrives is ink, already coloured, already labelled by
// their cartographer, and unchangeable from here beyond an opacity.
//
// Three consequences, all of them visible from the outside:
//
//   **A tap cannot say what you hit.** `queryRenderedFeatures` over a raster
//   layer returns nothing, because there is nothing there to return: the tile is
//   a picture of a route, not the route. So the card a tap opens asks their API
//   *which routes run near this point* and says exactly that. It is a list of
//   candidates rather than an identification, and the wording is written to be
//   honest about it. Reading the tile's own alpha to narrow it down was tried on
//   paper and abandoned: ink under the finger proves a route is there, never
//   which of the four overlapping ones it belongs to, so it would buy a more
//   confident card and not a more correct one.
//
//   **It is drawn for a light background.** Their palette assumes a pale map
//   under it, which is true of one of this app's five basemaps. The overlay is
//   left alone rather than recoloured — `raster-hue-rotate` on somebody's
//   waymark colours would be inventing signage — and what changes per basemap is
//   the opacity, which is the one knob that cannot lie about what a route is.
//
//   **There are no retina tiles.** `@2x` is a 404 on their server, so on a
//   2× display this is the one soft thing on the map. Asking for tiles a zoom
//   deeper and letting the renderer shrink them would fix it and would cost
//   their servers four times the traffic for a cosmetic gain, which is the exact
//   trade server/trail-tiles.js exists to refuse.
//
// The tiles come through this app's own server. See the head of
// server/trail-tiles.js for why, and for what that obliges it to do.

import { t } from './i18n.js';

// --- Tuning -------------------------------------------------------------------

// How strongly the ink lands, until somebody says otherwise.
//
// **Three quarters, on both sides, and it used to be two numbers.** The split
// was 0.95 over a light map — where their palette is already tuned and near
// full strength is right — against 0.72 over a dark one, where the white casing
// around every route reads as glare and the routes stop being lines on a map and
// become a lit sign in front of it. The reasoning holds and the numbers were the
// wrong conclusion from it: near-full over Light is ink laid *on* the map rather
// than in it, and the difference between the two sides was never worth a basemap
// switch moving the slider under you. 0.75 is a route you can follow and a map
// you can still read underneath, either way round.
//
// It is still stored per basemap — see OPACITY_KEY — because a strength somebody
// *chooses* while looking at one map is still a statement about that map. What
// changed is what they are given before they choose anything.
//
// The floor is what it is for the same reason as ever: below about 0.6 a local
// footpath in pale yellow stops being visible at all, which is the half of the
// data that is hardest to get anywhere else.
const DEFAULT_OPACITY = { light: 0.75, dark: 0.75 };

// What the slider will go to. Below the floor the overlay is a rumour, and
// somebody who wants it gone has a switch for that; the ceiling is opacity 1,
// which is the most a raster layer has.
export const OPACITY_MIN = 0.2;
export const OPACITY_MAX = 1;

// Smooth the ink when the renderer is scaling a tile — which, with no `@2x` and
// a `maxzoom` of 18, is most of the time on most screens. `nearest` keeps the
// palette exact and turns every diagonal path into a staircase; a route drawn
// 2 px wide has nothing left after that.
const RESAMPLING = 'linear';

// What a tile's fade ends at, once this module has had a word with it. Any
// number already in the past will do; the point is that there is one at all.
// See `keepFadesEnded`, which is where the reason lives.
const FADE_ALREADY_OVER = 0;

// How far from the finger counts as "near here" when a tap asks what runs past.
// Pixels rather than metres, because it is a question about a fingertip and not
// about the ground: the same 22 px is a couple of streets at z14 and a couple of
// paces at z18, which is what somebody pointing at a line on a screen means both
// times.
const TAP_RADIUS_PX = 22;

// Deliberately no zoom floor, which the snow and the basemap diet both have.
// Their renderer already thins by network level as you zoom out — at z6 what is
// left is the continental routes and nothing else — so a floor here would hide
// data that is both true and drawn on purpose. The one number that is ours is
// `maxzoom` below, and that is not taste: z19 is a 404.

// The deepest zoom they render. Past it the renderer overzooms the z18 tile,
// which is a correct rescaling because it knows the tile is a parent — where
// asking for z19 is a request that can only fail.
const MAX_ZOOM = 18;

const NS = 'hexplore-trails';
const SOURCE = `${NS}-src`;
const LAYER = `${NS}-ink`;

/** Our layer ids, for anyone reordering the stack or taking it off. */
export const trailLayerIds = () => [LAYER];

// --- Which map of trails ---------------------------------------------------------

/**
 * The renderings this map offers.
 *
 * `key` is the path segment on their tile server *and* the subdomain their API
 * lives on — theirs, not ours, and the reason server/trail-tiles.js keeps the
 * same list. `label` is read at import time and so is in whatever language was
 * loaded before this module was, which src/boot.js guarantees is the right one.
 */
// Their fifth, `riding`, is deliberately absent. It is horse riding — not a
// second word for cycling, which is what everybody reads it as, and the reason
// it is gone rather than relabelled: this is a map for the ways its owner
// actually travels, and a row nobody will ever press costs a quarter of the
// menu's width and one moment of "what is that?" for every person who meets it.
// Nothing but this list stands between it and coming back.
export const TRAIL_THEMES = [
  { key: 'hiking', label: t('trails.hiking') },
  { key: 'cycling', label: t('trails.cycling') },
  { key: 'mtb', label: t('trails.mtb') },
  { key: 'slopes', label: t('trails.slopes') },
];

const DEFAULT_THEME = 'hiking';
const THEME_KEY = 'visited-map:trail-theme:v1';

/**
 * Is this a theme we know?
 *
 * Every way in goes through this, because every one of them can carry a value
 * this build has never heard of: a `localStorage` key written by a newer version
 * and read by an older one, or simply edited. An unknown theme is a path their
 * server 404s, which would be an overlay that is switched on, says it is
 * showing something, and draws nothing at all.
 *
 * Exported for the test that pins this list to the proxy's allowlist.
 */
export const isTrailTheme = (key) => TRAIL_THEMES.some((th) => th.key === key);

/** Which rendering is chosen, falling back to hiking for anything odd or absent. */
export function trailTheme() {
  let held;
  try {
    held = localStorage.getItem(THEME_KEY);
  } catch {
    held = null;
  }
  return isTrailTheme(held) ? held : DEFAULT_THEME;
}

/** Choose one. Returns what is now stored, so a caller can mirror it without reading back. */
export function setTrailTheme(key) {
  const clean = isTrailTheme(key) ? key : DEFAULT_THEME;
  try {
    localStorage.setItem(THEME_KEY, clean);
  } catch {
    /* private mode — it falls back to hiking next load, which is the safe way round */
  }
  return clean;
}

/** What to call a theme, for a sentence rather than a button. */
export const trailThemeLabel = (key) =>
  TRAIL_THEMES.find((th) => th.key === key)?.label ?? key;

// --- How loud ---------------------------------------------------------------------
//
// **Two stored values, one per basemap theme, which is the same shape the
// visited colour keeps and for the same reason.** A single number was the
// obvious version and it is wrong in the case that actually happens: the split
// above is not two preferences, it is a correction for what is underneath, so a
// strength chosen while looking at Light becomes glare the moment you switch to
// Dark. Storing one per side means switching basemap moves the slider — which is
// why the row says which map it is talking about, exactly as `Visited color ·
// light map` does a few rows up.
//
// Absent means the tuned default above, so anybody who never touches this keeps
// the version that was measured rather than a number somebody dragged once.
const OPACITY_KEY = 'visited-map:trail-opacity:v1';

/** Light or dark, and never anything else — an unknown basemap reads as dark. */
const sideOf = (basemap) => (basemap === 'light' ? 'light' : 'dark');

const clamp = (v) => Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v));

function storedOpacities() {
  try {
    const held = JSON.parse(localStorage.getItem(OPACITY_KEY));
    return held && typeof held === 'object' ? held : {};
  } catch {
    // Absent, unparseable, or a private-mode throw. All three mean "no opinion",
    // which is the answer that leaves the measured defaults in place.
    return {};
  }
}

/**
 * How strong the ink should be over this basemap: what was chosen, or the
 * measured default.
 *
 * The stored value is validated rather than trusted — it is a number in
 * `localStorage`, which a newer build, an older one, or a person with the
 * devtools open can all have written. A `raster-opacity` of `"loud"` is a layer
 * that does not render at all.
 */
export function trailOpacity(basemap) {
  const held = storedOpacities()[sideOf(basemap)];
  return Number.isFinite(held) ? clamp(held) : DEFAULT_OPACITY[sideOf(basemap)];
}

/**
 * Set it for one side. Returns what is now in force, so a caller can mirror it
 * without reading back.
 */
export function setTrailOpacity(basemap, value) {
  const side = sideOf(basemap);
  if (!Number.isFinite(value)) return trailOpacity(basemap);
  const clean = clamp(value);
  try {
    localStorage.setItem(OPACITY_KEY, JSON.stringify({ ...storedOpacities(), [side]: clean }));
  } catch {
    /* private mode — it falls back to the measured default next load */
  }
  return clean;
}

// --- Putting it on the map --------------------------------------------------------

/**
 * The source as MapLibre and Mapbox both want it.
 *
 * Exported so a test can hold it to the two things that are not taste: the URL
 * must go through this app's own proxy, and `maxzoom` must be the zoom past
 * which their server 404s.
 *
 * `tileSize: 256` is a statement about their tiles rather than a preference.
 * Both renderers work in 512 internally and derive which zoom to ask for from
 * this number, so getting it wrong does not scale the image — it asks for the
 * wrong tile.
 */
export function trailSourceSpec(theme) {
  return {
    type: 'raster',
    tiles: [`/api/trails/tile/${theme}/{z}/{x}/{y}.png`],
    tileSize: 256,
    maxzoom: MAX_ZOOM,
    // On the source rather than on the map's own AttributionControl, the same
    // mechanism the airports and the region boundaries use: a source's credit
    // shows only while the source is present, so this arrives with the overlay
    // and leaves with it. OSM's own line is already on screen from the basemap;
    // this is the credit for the rendering, which is the part that is theirs.
    attribution: '<a href="https://waymarkedtrails.org/" target="_blank" rel="noopener noreferrer">Waymarked Trails</a>',
  };
}

/** The one layer, given which way round the basemap is. */
export function trailLayerSpec(basemap) {
  return {
    id: LAYER,
    type: 'raster',
    source: SOURCE,
    paint: {
      'raster-opacity': trailOpacity(basemap),
      'raster-resampling': RESAMPLING,
      // No cross-fade between zoom levels. The default half-second dissolve is
      // right for aerial photography, where the two zooms are the same picture
      // at different sharpness, and wrong here: their renderer draws a different
      // *set* of routes at each zoom, so the fade shows two maps at once and
      // reads as the overlay glitching.
      //
      // It stays zero on every basemap. Over terrain a zero here has a second,
      // invisible meaning that had to be answered separately — see
      // `keepFadesEnded`, which answers it without touching this number.
      'raster-fade-duration': 0,
    },
  };
}

/**
 * Draw it, or move it to a different theme.
 *
 * Switching theme replaces the source outright rather than setting new tiles on
 * the one that is there: a live source's tile template is not settable in either
 * renderer, which is the same reason the railway overlay rebuilds when its
 * detail ceiling moves.
 *
 * @param {object} map
 * @param {object} opts
 * @param {string} opts.theme one of TRAIL_THEMES
 * @param {'light'|'dark'} opts.basemap which way round the map underneath is
 * @param {string|undefined} opts.before the layer to insert beneath
 */
export function installTrails(map, { theme, basemap, draped = false, before }) {
  const want = isTrailTheme(theme) ? theme : DEFAULT_THEME;
  const held = map.getSource(SOURCE);
  if (held && held._hexploreTheme !== want) removeTrails(map);
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, trailSourceSpec(want));
    // Which theme these tiles are of. Read back above rather than tracked in a
    // module variable, because the source outlives this module's idea of the
    // world: a basemap switch rebuilds the map and every layer on it, and a
    // variable here would go on claiming a source that no longer exists.
    const made = map.getSource(SOURCE);
    if (made) made._hexploreTheme = want;
  }
  // Over terrain the overlay needs one thing more than a layer. See keepFadesEnded.
  if (draped) keepFadesEnded(map); else stopKeepingFades(map);
  if (!map.getLayer(LAYER)) {
    map.addLayer(trailLayerSpec(basemap), before);
  } else {
    map.setPaintProperty(LAYER, 'raster-opacity', trailLayerSpec(basemap).paint['raster-opacity']);
  }

  // **Put it back under the routes, every time, rather than only when it is
  // first added.** `addLayer(layer, before)` is the only chance a layer gets to
  // choose where it sits, and that chance comes at install — which is a moment
  // this module does not control and cannot see. If the anchor did not exist
  // yet, or resolved differently under a basemap whose layers arrive inside a
  // style import, the overlay lands wherever it landed and stays there for the
  // life of the style: a sheet of pixels over the routes, which is the one
  // place it must never be. This is a picture, so whatever it covers is simply
  // gone — and what it was covering was the tracks somebody actually walked.
  //
  // `moveLayer` is cheap and idempotent, and every caller already passes the
  // anchor it wants, so re-asserting it on each sync costs a no-op in the case
  // that was already right and fixes the case that was not.
  if (before && map.getLayer(LAYER) && map.getLayer(before)) {
    try {
      map.moveLayer(LAYER, before);
    } catch {
      // A `before` that exists but sits inside somebody else's import is not
      // always a legal target. Leaving the layer where it is beats throwing on
      // a basemap switch.
    }
  }
}

// --- Letting go of the tiles you are no longer looking at ---------------------------
//
// **This is why the routes thinned to hairlines on the 3D basemap and on no
// other.** Two of Mapbox's behaviours meet, and each is sensible alone.
//
// *A fading tile holds its children.* `SourceCache.update` keeps a tile's deeper
// children alive while that tile is still fading in, so a half-loaded zoom can
// go on showing the sharper picture it already has. Whether a tile is still
// fading is read off `Tile.fadeEndTime`, and that field has exactly one writer:
//
//     registerFadeDuration(duration) {
//       const fadeEndTime = duration + this.timeAdded;
//       if (fadeEndTime < now()) return;        // ← leaves it undefined
//       …
//     }
//
// With `raster-fade-duration: 0` — which this overlay wants, for the reason on
// `trailLayerSpec` — that test is true on every tile, every time, so
// **`fadeEndTime` is never written on anything**. A tile whose fade has no end
// never stops fading, so its children are never let go. Every z18 tile fetched
// while you were zoomed in is still in the source cache when you come back out,
// and the cache grows rather than turning over.
//
// *Draping prefers the deepest tile.* With terrain on, the layer is drawn into
// an offscreen texture per terrain tile, and `_setupProxiedCoordsForOrtho`
// collects every source tile overlapping that terrain tile, sorts them
// `b.overscaledZ - a.overscaledZ` — deepest first — and stencils them so the
// first one wins.
//
// Together: come back out to z13 and the stale z18 tile is drawn in place of the
// correct z15 one, squeezed to a quarter of its width. The ink goes to a
// hairline and the numbered shields shrink to dots, and it never recovers,
// because nothing ever releases those tiles. On the flat four the ideal tile is
// simply the one drawn, which is the whole of why this was a 3D-only bug.
//
// So: give every tile an end to its fade, one that has already passed. Nothing
// is ever "still fading", nothing holds its children, and the cache turns over
// as it does everywhere else. Measured over the same view before and after a
// zoom to maximum and back, the source cache goes from 156 tiles across four
// zooms to 40 across one, and the ink comes back to the pixel.
//
// **It writes a field that is Mapbox's, which wants justifying.** The honest
// alternative is a real `raster-fade-duration` over this basemap, and it was
// measured too: it restores the ink but leaves 130-odd stale tiles in the cache,
// so it treats the symptom and stays at the mercy of which tile happens to win.
// This removes the cause. `fadeEndTime` is read in two places and written in
// one, all of them shown above; if a future Mapbox renames it the `try` below
// means the overlay draws as it did before this fix rather than throwing on
// every frame — the bug comes back, and nothing else does.
//
// On `render` because that is the frame boundary the next `update` reads across,
// and only over terrain, because on the flat four there is nothing to fix.

const FADE_KEEPER = '_hexploreTrailsFadeKeeper';

function keepFadesEnded(map) {
  if (map[FADE_KEEPER]) return;
  const stamp = () => {
    try {
      const cache = map.style?.getSourceCache?.(SOURCE);
      const tiles = cache?._tiles;
      if (!tiles) return;
      for (const key in tiles) {
        if (tiles[key].fadeEndTime === undefined) tiles[key].fadeEndTime = FADE_ALREADY_OVER;
      }
    } catch {
      // A renderer that does not keep its tiles here, or a style mid-swap. The
      // overlay draws either way; this is the only thing that stops working.
    }
  };
  map[FADE_KEEPER] = stamp;
  map.on('render', stamp);
}

function stopKeepingFades(map) {
  const held = map[FADE_KEEPER];
  if (!held) return;
  map[FADE_KEEPER] = null;
  try {
    map.off('render', held);
  } catch {
    /* a map being torn down has nothing to unsubscribe from */
  }
}

/** Take it off again — the layer first, then the source it reads. */
export function removeTrails(map) {
  stopKeepingFades(map);
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

// --- What runs near here ----------------------------------------------------------

/**
 * The extent of some screen-corner points, as the `w,s,e,n` the server wants.
 *
 * Four corners rather than two, because the map turns: the box a finger covers
 * is square on the screen and a rotated quadrilateral on the ground, and its
 * extent is not the extent of two opposite corners. Nothing here knows about
 * pixels — the caller unprojects, because the caller is the one holding a map.
 *
 * @param {{lng: number, lat: number}[]} points
 */
export function bboxAround(points) {
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]
    .map((v) => v.toFixed(6))
    .join(',');
}

/** The screen points to unproject for a tap, given where it landed. */
export const tapCorners = ({ x, y }, r = TAP_RADIUS_PX) => [
  { x: x - r, y: y - r }, { x: x + r, y: y - r },
  { x: x + r, y: y + r }, { x: x - r, y: y + r },
];

/**
 * Ask what runs near a box. Never throws: a card that cannot be filled in is a
 * card that says so, and an overlay is not worth an unhandled rejection.
 *
 * @returns {Promise<object[]>} their routes, or nothing at all
 */
export async function trailsNear(theme, bbox) {
  try {
    const res = await fetch(`/api/trails/near?theme=${encodeURIComponent(theme)}&bbox=${encodeURIComponent(bbox)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.routes) ? body.routes : [];
  } catch {
    return [];
  }
}

/**
 * How far one route runs, and how much of it is up and down.
 *
 * A second request, made when somebody opens a row rather than when the card
 * opens. What is behind it upstream is the whole geometry of the route — a
 * quarter of a megabyte for a regional loop — which the server reduces to these
 * three numbers before it answers. See `oneDetail` in server/trail-tiles.js for
 * why that reduction happens there and not here.
 *
 * @returns {Promise<{length: number|null, ascent: number|null, descent: number|null}|null>}
 */
export async function trailDetails(theme, id) {
  try {
    const res = await fetch(`/api/trails/route/${encodeURIComponent(theme)}/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** Where the drawing of one waymark lives — this app's own proxy, as ever. */
export const trailSymbolUrl = (theme, id) =>
  `/api/trails/symbol/${encodeURIComponent(theme)}/${encodeURIComponent(id)}.svg`;

/**
 * How far, how much up, how much down — as the one line a row shows.
 *
 * Metres in, because that is what OSM tags and their renderer both count in; a
 * distance in kilometres and a climb in metres out, because that is how anybody
 * planning a walk says it. Arrows rather than the words "ascent" and "descent":
 * three labelled pairs do not fit the width of this card, and ↑ 1,240 m under a
 * route name is not ambiguous.
 *
 * Returns null when the route says none of the three, which is normal — most
 * local paths carry no `distance` tag at all.
 */
export function trailStatsLine({ length, ascent, descent } = {}) {
  const parts = [];
  if (Number.isFinite(length) && length > 0) {
    const km = length / 1000;
    parts.push(t('trails.km', { v: km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1) }));
  }
  if (Number.isFinite(ascent) && ascent > 0) parts.push(t('trails.ascent', { v: Math.round(ascent).toLocaleString() }));
  if (Number.isFinite(descent) && descent > 0) parts.push(t('trails.descent', { v: Math.round(descent).toLocaleString() }));
  return parts.length ? parts.join(' · ') : null;
}

// --- Which routes are the ones you have heard of ----------------------------------
//
// **The listing does not say which routes are made of other routes**, and that
// is the thing somebody actually wants filtered out. A tap in the Alps comes
// back with the Via Alpina and then twenty legs of the local network — "Ried –
// Gempelen", "Reinisch – Rohrbach" — each a real relation, each signed, and none
// of them the answer to "what is this path".
//
// The honest word for a route made of other routes is `type=superroute`, and it
// exists only in their *detail* record, which is a quarter of a megabyte per
// route. Reading twenty of those to decide what to put in a list would cost a
// hundred times what the list itself costs, to sort it.
//
// So this reads reach instead, which the listing gives for free and which is the
// same distinction from the other side: INT, NAT and REG are the routes with a
// name, a number and an operator behind them — the ones on the guidebook's
// contents page — and AL1…AL4, LOC and NDS are the network they are stitched
// out of. It is not the same test and it does not pretend to be; it is the one
// that can be made without asking their servers for a megabyte per tap.
//
// `slopes` has no such hierarchy at all — its group is *what you would be doing*
// rather than how far the route reaches — so everything there is a main route
// and the switch that would filter them is not shown.
const MAIN_GROUPS = new Set(['INT', 'NAT', 'REG']);

/** Is this one of the routes with a name of its own, rather than a leg? */
export const isMainTrail = (route, theme) =>
  theme === 'slopes' || MAIN_GROUPS.has(String(route?.group ?? ''));

/**
 * The list a card shows: the routes with names of their own first, then the
 * legs of the local network they are stitched out of.
 *
 * **Ordered, and no longer filtered.** There used to be a *Main routes only*
 * switch that dropped the second half, on by default. It went because it
 * answered a question nobody was asking twice: the ordering already puts the
 * named routes at the top, so the legs it hid cost a line each at the bottom of
 * a card somebody had already decided to open — and getting them back meant
 * finding the switch. A card is a short list read once, not a directory to be
 * pruned.
 *
 * A stable partition: their own order survives inside each half, and theirs is
 * by reach already.
 */
export function orderTrails(routes, theme) {
  return [
    ...routes.filter((r) => isMainTrail(r, theme)),
    ...routes.filter((r) => !isMainTrail(r, theme)),
  ];
}

// --- What a route says about itself -----------------------------------------------

// How far a route runs, in their vocabulary. Three of the four themes speak this
// one; `slopes` speaks the other one below.
//
// **Their own site buckets everything else as "other", and this omits it
// instead.** Hiking hands back `AL1`…`AL4` for the levels of a local hierarchy
// and `LOC` for a route with no network tag at all, and there is no sentence
// about reach that is true of all of them. A row that said "Other route" would
// be a row that means "we did not recognise this", dressed as a fact.
const GROUPS = {
  INT: () => t('trails.international'),
  NAT: () => t('trails.national'),
  REG: () => t('trails.regional'),
  LOC: () => t('trails.local'),
  NDS: () => t('trails.node-network'),
};

// Winter routes are not graded by reach but by *what you would be doing on
// them*, and their API says so with a number. Not a difficulty scale, which is
// the obvious misreading: 1 is a downhill piste of any colour and 5 is a
// cleared footpath.
const SLOPE_GROUPS = {
  1: () => t('trails.downhill'),
  2: () => t('trails.nordic'),
  3: () => t('trails.ski-tour'),
  4: () => t('trails.sled'),
  5: () => t('trails.winter-hiking'),
  6: () => t('trails.sleigh'),
};

/**
 * One route as a row: the sign, what it is called, and where it runs.
 *
 * **Three things and no labels.** This used to compose clauses — the kind, the
 * number, the itinerary, and the waymark as a sentence beginning "Waymark:" —
 * and a list of twenty routes made a wall of them, in which the one word you
 * were scanning for (the name) was the shortest thing on every line. Two of the
 * four are now redundant rather than dropped: the number is *painted on the
 * symbol*, which is the whole point of the symbol being a picture, and the kind
 * is what the main-routes switch above has already sorted on.
 *
 * Every string in here is an OSM tag value, which is to say something anyone on
 * the internet can edit — so the caller sets them with `textContent` and this
 * returns text rather than markup.
 */
export function describeTrail(route, theme) {
  if (!route) return null;
  const kind = theme === 'slopes' ? SLOPE_GROUPS[route.group] : GROUPS[route.group];
  // Their `itinerary` is an ordered list of places, so an arrow is the honest
  // join: these are stops in sequence, not a set.
  const between = route.itinerary?.length ? route.itinerary.join(' → ') : null;

  // What to head the row with, in the order of how much it tells you. A route
  // with a reference and no name is not anonymous — a numbered node-network leg
  // or a piste is *called* its number — and a route with neither is still
  // "Interlaken → Grindelwald", which says more than "Unnamed route" ever did.
  // The last two are for the case that is left: a piste with no name, no number
  // and no ends, where "Downhill piste" is the whole of what is known.
  const title = route.name || route.ref || between || (kind ? kind() : null)
    || t('trails.unnamed-route');

  return {
    id: route.id,
    title,
    // Where it runs, unless that is what the row is already called.
    between: between === title ? null : between,
    // Which half of the list this belongs in, and whether it is set in the
    // weight that says "you have heard of this one".
    main: isMainTrail(route, theme),
    // The sign itself. Their sentence about it becomes the `alt`, which is what
    // it is for: a description of a picture, in the language of whoever tagged
    // the route, read out where the picture cannot be seen.
    symbol: route.symbolId
      ? { url: trailSymbolUrl(theme, route.symbolId), alt: route.symbol ?? '' }
      : null,
    // The way back to the original. Their own site is the better page to land on
    // — it has the elevation profile and the map — but it is a single-page app
    // whose deep links are its own business and not something to hard-code from
    // out here. The relation on OpenStreetMap is the durable address, and it is
    // the same link the railway card offers for the same reason.
    osm: `https://www.openstreetmap.org/relation/${route.id}`,
  };
}
