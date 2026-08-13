// The train-tracks overlay: OpenRailwayMap's own style, grafted onto whichever
// basemap is showing.
//
// The overlay used to be one raster layer — `standard/{z}/{x}/{y}.png` from
// openrailwaymap.org, drawn at 85% opacity and switched on or off as a single
// thing. That is all a raster overlay can be: by the time the level crossings,
// the kilometre posts and the switch numbers arrive they are pixels, and
// nothing on this side can filter them, recolour them or say what one of them
// is. This module is the same content as vector tiles, which makes all three
// possible and costs a style of our own to carry.
//
// **The style is built, not fetched.** `scripts/build-rail-style.mjs` takes
// their published style apart and emits `rail-style.json`; read the note at the
// top of that file for what has to be rewritten and why. What arrives here is
// 288 layers that are ready to add except for two things only the running map
// knows — the basemap's fontstack, and which theme it is.
//
// **It is a dynamic import**, like the gazetteer and the boundaries: 315 KB that
// a session which never switches the overlay on should not pay for. The tiles
// behind it come from `/api/rail/*`, which is a caching proxy — see
// server/rail-tiles.js, and read its policy note before making the map ask for
// more than it does.

// The `hexplore-orm-` namespace every id in the overlay carries is baked into
// rail-style.json by the build, not repeated here: one place decides it, and it
// is the place that writes the ids.

// --- What is drawn before anybody chooses --------------------------------------

/**
 * Which groups are on for someone who has never opened the list.
 *
 * Not "all of them", which is what an absent key used to mean. The overlay draws
 * six kinds of thing over a map that already has a map on it, and three of them
 * are for reading a railway rather than seeing where one is: the line-number
 * shields are the densest labels on the whole map, the kilometre posts are a
 * number every few hundred metres, and the signals are both dense and the only
 * reason the 1.5 MB full-colour sprite atlas is ever fetched. Someone who
 * switches the overlay on wants to see where the tracks are; the rest is there
 * for when they ask.
 */
export const RAIL_GROUP_DEFAULTS = {
  linenumbers: false,
  tracks: true,
  stations: true,
  symbols: false,
  platforms: true,
  milestones: false,
};

/** Whether a group is on, given what has been chosen and what defaults to. */
export const railGroupOn = (chosen, key) => chosen?.[key] ?? RAIL_GROUP_DEFAULTS[key] ?? true;

// --- Technical infrastructure --------------------------------------------------
//
// One switch over the parts of a railway that are not a railway you could travel
// on: the sidings and yard roads a train is only ever shunted along, the line
// that was lifted in 1974, and the "stations" that are a junction, a site or a
// point where two tracks cross. All of it is real and correctly mapped, and all
// of it doubles the amount of ink on the screen around any station of any size.
//
// **The switch is a filter, not a visibility.** These are properties of features
// rather than whole layers — a single track layer draws both the through line and
// the siding beside it — so a group toggle cannot express it.
//
// **And it is one global-state key rather than 253 setFilter calls.** MapLibre
// re-parses a source's tiles when a filter changes, so flipping this layer by
// layer would do that work 253 times over. The filters are written once at
// install in terms of a key of ours, exactly the way their own style is written
// in terms of theirs, and the switch sets the key.

/** Ours, and namespaced so an upstream `state` key can never collide with it. */
const TECHNICAL_STATE = 'hexploreTechnical';

/**
 * Their own four switches for infrastructure that is not running railway.
 *
 * Free configuration rather than filters of our own — the style consults these
 * itself. Their defaults disagree with each other (construction and proposed
 * are on out of the box, abandoned and razed are off), which is a fine answer
 * for a map *of* railways and the wrong one for an overlay on a map of
 * somewhere. All four follow the one switch instead.
 */
const ORM_STATE_SWITCHES = [
  'showConstructionInfrastructure',
  'showProposedInfrastructure',
  'showAbandonedInfrastructure',
  'showRazedInfrastructure',
];

/**
 * The states their switches do not cover. `disused` is track that is still there
 * and no longer used, which has no switch of theirs; the other four are listed
 * as well so that the filter reads as the whole rule rather than half of it.
 */
const TECHNICAL_LINE_STATES = ['disused', 'construction', 'proposed', 'abandoned', 'razed'];

/**
 * Station features that are operational furniture rather than somewhere to catch
 * a train. `halt` is in the list because it is: their `halt` is `railway=halt`,
 * an unstaffed stopping point, and it is the value that most often turns a
 * junction-dense area into a wall of labels. Move it out of here if the small
 * stops are what you are looking at.
 */
const TECHNICAL_STATION_FEATURES = [
  'service_station', 'yard', 'crossover', 'junction', 'spur_junction', 'site', 'halt',
];

// Which rule each source layer answers to. A track carries `service` and `state`;
// a station carries `feature`. Everything else — platforms, signals, kilometre
// posts — has its own group and is left alone.
const TRACK_SOURCE_LAYERS = new Set(['railway_line_high', 'standard_railway_line_low']);
const STATION_SOURCE_LAYERS = new Set([
  'standard_railway_text_stations',
  'standard_railway_text_stations_low',
  'standard_railway_text_stations_med',
  'standard_railway_grouped_stations',
  'standard_railway_grouped_station_areas',
]);

/**
 * The extra filter one source layer's features have to pass, or null.
 *
 * `coalesce` to the empty string rather than testing the property directly:
 * `match` on a missing property evaluates its input to null, and null is not one
 * of the labels *or* the fallback — it is a type error, which in a filter means
 * the layer draws nothing at all.
 */
export function technicalFilter(sourceLayer) {
  const ordinary = TRACK_SOURCE_LAYERS.has(sourceLayer)
    ? ['all',
      // Any `service` value at all — spur, yard, siding, crossover — is a track
      // a service moves over rather than one it runs on.
      ['==', ['coalesce', ['get', 'service'], ''], ''],
      ['match', ['coalesce', ['get', 'state'], ''], TECHNICAL_LINE_STATES, false, true]]
    : STATION_SOURCE_LAYERS.has(sourceLayer)
      ? ['match', ['coalesce', ['get', 'feature'], ''], TECHNICAL_STATION_FEATURES, false, true]
      : null;
  // `to-boolean` around the switch, and it is not decoration. `global-state`
  // evaluates to **null** for a key nobody has set, `any` wants booleans, and a
  // filter that throws does not fail loudly — it draws nothing. Every track and
  // every station in the overlay reads this expression, so one ordering mistake
  // that left the key unset would empty the map of railways with no error worth
  // the name. Coerced, an unset key reads as "off", which is the default anyway.
  return ordinary && ['any', ['to-boolean', ['global-state', TECHNICAL_STATE]], ordinary];
}

/**
 * Show the technical infrastructure, or take it back off.
 *
 * Five properties and therefore five source reloads, where a batch would be one:
 * MapLibre re-parses a source whose filters read a key that changed, and only
 * `Style.setGlobalState` applies several at once — which is not on `Map`. Not
 * worth reaching past `Map` for. This is a switch somebody flips when they sit
 * down to read a station, not one anything flips in a loop.
 */
export function setRailTechnical(map, on) {
  map.setGlobalStateProperty(TECHNICAL_STATE, !!on);
  for (const key of ORM_STATE_SWITCHES) map.setGlobalStateProperty(key, !!on);
}

/**
 * A path from the built style, as a URL MapLibre will accept.
 *
 * Both the sprites and the tile templates have to be absolute — see the notes
 * where each is used — and the build cannot write them that way because the
 * origin is not a thing a build knows. Deliberately string concatenation and
 * not `new URL(path, origin)`: `URL` normalises, and normalising a tile template
 * percent-encodes the placeholders into `%7Bz%7D/%7Bx%7D/%7By%7D`, which
 * MapLibre then cannot substitute — every tile is requested with the braces
 * still in the path and every one of them 404s.
 */
export const railUrl = (path, origin = location.origin) =>
  (/^https?:\/\//.test(path) ? path : origin + path);

/**
 * A number, without the decimals nobody asked for.
 *
 * `16.700000762939453` is a float32 that came out of a database as 16.7, and
 * printing it in full is a way of telling someone their railway is imprecise
 * rather than that our arithmetic is.
 */
const round = (n, dp) => String(Number(Number(n).toFixed(dp)));

/**
 * Whatever shape the value arrived in, as a list.
 *
 * Their tiles carry arrays as **PostgreSQL array literals** — `{BLS}`, or
 * `{SBB,BLS}` for a shared line — which is what put the braces on screen. Their
 * feature API hands back real JSON arrays for the same fields. Both are answered
 * here so a value reads as "SBB, BLS" whichever door it came through.
 */
function asList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value);
  if (/^\{.*\}$/.test(text)) {
    return text.slice(1, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  if (/^\[.*\]$/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* not JSON after all */ }
  }
  return text ? [text] : [];
}

/**
 * A database word as words.
 *
 * Theirs are enum spellings and one of them is a sprite path: `level_crossing`,
 * `spur_junction`, `narrow_gauge`, `general/level-crossing`.
 */
function featureLabel(value) {
  if (!value) return null;
  const words = String(value).split('/').pop().replace(/[_-]+/g, ' ').trim();
  return words || null;
}

/**
 * The same, as something to print in a card.
 *
 * Every enum in their schema is lower case because that is how an enum is
 * spelled, and a card that reads "State present" over "Serves train" is printing
 * the column rather than the answer. The label beside it is already a capitalised
 * phrase, so the value has to be one too or the row reads as half-formatted.
 */
const humanValue = (value) => {
  const words = featureLabel(value);
  return words ? words[0].toUpperCase() + words.slice(1) : '';
};

// Which properties are worth putting in a popup, in the order they read best,
// and how to say each one. The tiles carry thirty-odd keys and most of them are
// rendering hints — `rank`, `way_length`, `operator_color`, `speed_label` — so
// this is a curated list, and every entry that is a quantity carries its unit.
// `usage` ("main", "branch") is deliberately absent: it duplicates what the line
// weight is already saying and is jargon besides.
const POPUP_FIELDS = [
  ['name', 'Name', String],
  // The number painted on the post at the end of the platform. Inside a station
  // it is the one property that says *which* of the twenty parallel lines under
  // the cursor was clicked, and without it every one of them describes itself
  // identically. Distinct from `ref`, which is the number of the *line* the
  // track belongs to and is deliberately absent — see the note below.
  ['track_ref', 'Track', String],
  // `primary_operator` is the plain string; `operator` is the array of all of
  // them. Preferring the array keeps a shared line honest, and asList strips the
  // braces either way.
  ['operator', 'Operator', (v) => asList(v).join(', ')],
  ['primary_operator', 'Operator', String],
  ['railway', 'Type', humanValue],
  ['service', 'Service', humanValue],
  ['state', 'State', humanValue],
  // 15000 → "15 kV", 1500 → "1.5 kV", 750 → "750 V".
  ['voltage', 'Voltage', (v) => (Number(v) >= 1000 ? `${round(Number(v) / 1000, 2)} kV` : `${round(v, 0)} V`)],
  // 16.700000762939453 → "16.7 Hz"; 0 means direct current, not "0 Hz".
  ['frequency', 'Frequency', (v) => (Number(v) === 0 ? 'DC' : `${round(v, 2)} Hz`)],
  ['gauges', 'Gauge', (v) => `${asList(v).join(', ')} mm`],
  ['maxspeed', 'Max speed', (v) => `${round(v, 0)} km/h`],
];

// How OpenRailwayMap spells the three OSM element types in its tiles.
const OSM_TYPES = { N: 'node', W: 'way', R: 'relation' };

// --- Which OSM element a tile feature is ---------------------------------------
//
// Their **tiles carry no `osm_id` at all** — that pair of keys is their feature
// API's, and reading it off a tile was a link that could never appear. What a
// tile carries is the feature's own `id`, which is the OSM identity spelled two
// ways: `relation-9068328` or `node-3080728389-train-train-station` where the
// element type is not implied, and a bare `988282659-0` on the track layers,
// where the suffix is the segment a long way was cut into and the element is
// always a way.
//
// This is worth more than a link. `describeRailFeature` opens no card for a
// feature with nothing to say, and a platform whose relation carries no `name`
// and no `ref` — which is most of them, since the number is usually on the
// platform *edge* — has nothing else. Thun's platforms are named "Thun" and
// opened a card; Spiez's are named nothing and the tap fell through to the
// ground underneath, which read as platforms being clickable in one station and
// not in the next.
const OSM_ID_PREFIXED = /^(node|way|relation)-(\d+)/;
const OSM_ID_SEGMENTED = /^(\d+)-\d+$/;

const osmLink = (type, id) => ({
  type,
  id: String(id),
  url: `https://www.openstreetmap.org/${type}/${id}`,
});

function osmRef(p, sourceLayer, geometry) {
  // Their feature API does answer with these, and a caller that has been there
  // hands them over rather than parsing the id again.
  const explicit = Array.isArray(p.osm_id) ? p.osm_id[0] : p.osm_id;
  if (explicit) {
    const type = OSM_TYPES[Array.isArray(p.osm_type) ? p.osm_type[0] : p.osm_type]
      // Their tiles leave the type off when it is implied by the geometry.
      ?? (geometry?.type === 'Point' ? 'node' : 'way');
    return osmLink(type, explicit);
  }
  const id = String(p.id ?? '');
  const prefixed = OSM_ID_PREFIXED.exec(id);
  if (prefixed) return osmLink(prefixed[1], prefixed[2]);
  const segmented = TRACK_SOURCE_LAYERS.has(sourceLayer) && OSM_ID_SEGMENTED.exec(id);
  // Only where the element type is a fact about the layer. A kilometre post's id
  // has the same shape and is a node, so guessing from the shape alone would
  // link a third of them to somebody else's way.
  return segmented ? osmLink('way', segmented[1]) : null;
}

// Which of the three things with more to say was clicked. Their feature API
// answers a different key for each — `line_routes`, `station_routes`,
// `platform_routes` — and the card asks for different rows.
const PLATFORM_SOURCE_LAYERS = new Set([
  'standard_railway_platforms', 'standard_railway_platform_edges',
]);

function railKind(sourceLayer) {
  if (PLATFORM_SOURCE_LAYERS.has(sourceLayer)) return 'platform';
  if (STATION_SOURCE_LAYERS.has(sourceLayer)) return 'station';
  if (TRACK_SOURCE_LAYERS.has(sourceLayer)) return 'line';
  return 'other';
}

// The one feature word that is thinner as a heading than the thing it names.
// "Light rail" and "Narrow gauge" read perfectly well; a card headed "Rail" over
// a voltage and a gauge does not.
const FEATURE_TITLES = { rail: 'Railway' };

const featureTitle = (words) =>
  (words ? FEATURE_TITLES[words] ?? words[0].toUpperCase() + words.slice(1) : null);

let STYLE = null;
let loading = null;
// Which install the layers on the map belong to. Moved by every `installRail`
// and every `removeRail`, and read by the chunked add in `addLayersOverFrames`
// so that a run interrupted halfway stops rather than finishing into a map that
// has moved on. See the note there.
let installSeq = 0;

/**
 * Kick off (or reuse) the one-time load of the built overlay style.
 *
 * `data` is for callers without a bundler, exactly as in loadCountries and
 * loadRegions: plain Node needs an import attribute to read JSON that Vite does
 * not want, so a test parses rail-style.json itself and hands it over.
 */
export function loadRailStyle(data) {
  if (!loading) {
    loading = (data ? Promise.resolve({ default: data }) : import('./rail-style.json')).then((m) => {
      STYLE = m.default;
      return STYLE;
    });
  }
  return loading;
}

export const railStyleLoaded = () => STYLE !== null;
export const railGroups = () => STYLE?.groups ?? [];

/**
 * How deep it is worth asking each source for, as the server currently sees it.
 *
 * Never fatal: if this cannot be reached the overlay installs at the style's own
 * zoom ranges, which is what it did before any of this existed.
 */
export async function railDetail() {
  try {
    const res = await fetch('/api/rail/detail', { credentials: 'same-origin' });
    if (!res.ok) return { detail: {}, degraded: null, lang: null };
    const body = await res.json();
    return {
      detail: body.detail ?? {},
      degraded: body.degraded ?? null,
      // Not a setting of ours — the server's own answer, handed back so it can
      // go in the tile URL. See the note in installRail.
      lang: typeof body.lang === 'string' && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(body.lang)
        ? body.lang
        : null,
    };
  } catch {
    return { detail: {}, degraded: null, lang: null };
  }
}

/** Whether two detail reports differ, and so whether a rebuild is warranted. */
export function railDetailChanged(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a ?? {})[k] !== (b ?? {})[k]) return true;
  return false;
}

/**
 * Every layer id the overlay owns, whether or not it is currently visible.
 * Used to scope `queryRenderedFeatures` to us — a click must not report the
 * basemap's own railways, which are the less detailed answer this whole overlay
 * exists to draw over.
 */
export const railLayerIds = () => (STYLE?.layers ?? []).map((l) => l.id);

/**
 * Add the overlay's layers, without validating what a build already validated.
 *
 * 288 layers took **1.7 seconds** to add, and 92% of that was MapLibre checking
 * each one against the style spec — 995 ms with validation, 79 ms without,
 * measured on the real overlay. That check is worth having for a layer somebody
 * typed; these are generated by `scripts/build-rail-style.mjs` from a transform
 * that `npm test` exercises on every run, and re-proving it in the browser on
 * every switch-on and every basemap change is the same answer bought at the cost
 * of a visible wait.
 *
 * `Style.addLayer` takes the flag and `Map.addLayer` does not pass one on, hence
 * reaching past it — the one place in this file that touches MapLibre's
 * internals. Both are feature-detected and the supported path is still there
 * underneath, so a future version that renames either is slow rather than
 * broken. `_update(true)` at the end is not optional: without it `_styleDirty`
 * stays false, `Style.update()` never runs, and the sources sit paused with
 * their tiles unrequested.
 */
function addLayers(map, layers, before, fast = true) {
  const style = map.style;
  // `fast` is false on the 3D basemap, and it has to be. Reaching past
  // `Map.addLayer` also reaches past the two wrappers Mapbox needs it to go
  // through — the one that turns this app's anchors into Standard slots, and the
  // one that resolves the `global-state` expressions this style consults 1,529
  // times. Both are in src/gl-engine.js. Without them the layers are added
  // before an anchor that does not exist, reading an expression Mapbox cannot
  // parse; with them it is 288 ordinary addLayer calls — and that wait, which
  // nobody had complained about, turned out to be most of a switch-on that
  // locked a phone up for the better part of a minute.
  if (!fast || typeof style?.addLayer !== 'function' || typeof map._update !== 'function') {
    return addLayersOverFrames(map, layers, before);
  }
  try {
    for (const layer of layers) style.addLayer(layer, before, { validate: false });
  } catch (e) {
    // Half a style is not a state to leave a map in; finish on the slow path.
    console.warn('Rail overlay: fast layer install failed, falling back.', e);
    for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer, before);
  }
  map._update(true);
  return Promise.resolve();
}

// How long to spend adding layers before letting the browser have the thread
// back, in milliseconds.
//
// The slow path is a validated `addLayer` each, and on a phone the whole run is
// seconds — spent in one unbroken block, which is not a slow overlay but a dead
// application: no scroll, no pan, no closing the menu you switched it on from,
// not even the spinner raised to say it was coming, because no frame can be
// painted while this is running.
//
// So it runs to a **time budget** rather than a fixed number of layers. A count
// would have to be tuned for the slowest phone and would then be needlessly slow
// on a laptop — the same 24 layers are a millisecond in one place and most of a
// second in another. Eight milliseconds is about half a frame at 60 Hz, so the
// browser always has the rest of it to handle the tap that closes the menu, and
// the work simply takes as many frames as that device needs.
const RAIL_SLICE_MS = 8;

const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

/**
 * The slow path, spread over frames instead of blocking on one.
 *
 * Abandoned mid-run if the overlay was taken off, or put on again, while this
 * was going: `removeRail` and every `installRail` move `installSeq`, and a run
 * whose number is stale stops where it is. Without that, switching the overlay
 * off during the second it takes to install would go on adding layers to a map
 * that had just removed them — and they would stay, because the removal had
 * already walked the list.
 */
async function addLayersOverFrames(map, layers, before) {
  const mine = installSeq;
  const clock = () => (typeof performance === 'object' ? performance.now() : Date.now());
  let until = clock() + RAIL_SLICE_MS;
  for (const layer of layers) {
    if (clock() >= until) {
      await nextFrame();
      // Checked on the far side of every wait, not once at the top: the overlay
      // can be switched off, or rebuilt onto another basemap, in any of the
      // frames this hands back.
      if (installSeq !== mine) return;
      until = clock() + RAIL_SLICE_MS;
    }
    // Asked per layer rather than trusted from the top, for the same reason: a
    // rebuild that began while this was waiting may have added some already.
    if (!map.getLayer(layer.id)) map.addLayer(layer, before);
  }
}

/**
 * Substitute the basemap's fontstack for the token the build left behind.
 *
 * Their style asks for `OpenRailwayMap-Regular` and friends from their own
 * glyph server, and a style has one `glyphs` URL which the basemap owns — so a
 * label in their font is a label that silently never draws. `styleFont()` in
 * main.js answers what the basemap does serve; the bold and italic variants are
 * lost with nowhere to get them from.
 */
function withFont(layer, font) {
  if (!layer.layout?.['text-font']) return layer;
  return { ...layer, layout: { ...layer.layout, 'text-font': font } };
}

/**
 * Put the overlay on the map.
 *
 * @param {maplibregl.Map} map
 * @param {object} opts
 * @param {string[]} opts.font what styleFont() returned for this basemap
 * @param {'light'|'dark'} opts.theme the basemap's theme, handed to the style's
 *   own `theme` switch so the railways recolour with the map under them
 * @param {string|undefined} opts.before the layer to insert beneath
 * @param {Record<string, boolean>} opts.groups which groups are switched on
 * @param {boolean} [opts.technical] whether sidings, yards, disused track and
 *   the junction-and-site "stations" are drawn
 * @param {Record<string, number>} [opts.detail] the deepest zoom worth asking
 *   each Martin source list for, from `/api/rail/detail`
 * @param {string|null} [opts.lang] the language the proxy is asking their tiles
 *   for, from the same call — put in the tile URL so the browser's own cache is
 *   keyed on it. See the note where the sources are added.
 */
export function installRail(map, { font, theme, before, groups, technical = false, detail = {}, lang = null, fastAdd = true }) {
  if (!STYLE || map.getLayer(STYLE.layers[0].id)) return Promise.resolve();
  // Claims the map for this install, which is what lets a chunked add know it is
  // still the current one — and abandons any that was still running.
  installSeq++;

  // Their sprites, under our namespace. Images resolve as `spriteId:name`
  // except for the sprite called `default`, whose names are bare — and the
  // basemap is already that one, so ORM's cannot be added under it and every
  // reference in the built style was rewritten to match these ids.
  //
  // **Absolute, and this matters far more than it looks.** MapLibre rejects a
  // relative sprite URL outright ("must be absolute"), and it rejects it by
  // firing an error rather than throwing — so the overlay installs, every layer
  // and source lands, every check says it worked, and the map goes completely
  // blank. Not just the railways: a sprite that never resolves leaves the image
  // manager permanently unready, and the renderer will not draw a frame until it
  // is, so the basemap disappears too. The built style stores the path, because
  // the origin is not a thing a build can know; this is where it becomes a URL.
  // Only the sprites something switched on will actually draw from. The
  // full-colour atlas is 1.5 MB at 2x and is read by a single expression in
  // "Signals & crossings"; with that group off it is 1.5 MB fetched, decoded and
  // uploaded to the GPU so that nothing can use it.
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE.sprites) {
    if (have.has(sprite.id)) continue;
    if (!sprite.groups?.some((g) => railGroupOn(groups, g))) continue;
    map.addSprite(sprite.id, railUrl(sprite.url));
  }

  // Absolute here too, and for a stranger reason than the sprites above.
  // MapLibre builds the tile `Request` inside a **web worker**, and a worker has
  // no document to resolve a root-relative URL against — so `/api/rail/tile/…`
  // dies there with "Failed to construct 'Request': Failed to parse URL", one
  // line per tile, off the main thread. The main thread meanwhile reports the
  // source as loaded and `transformRequest` still fires, so every signal short
  // of the console says the overlay is working while not one tile is fetched.
  // **The language belongs in the URL, and it is not there for the server.**
  // The proxy already decides the language and keys its own cache on it (see
  // TILE_LANG in server/rail-tiles.js), and it ignores this parameter — it is
  // the value the server itself published, handed straight back.
  //
  // It is here for the *browser's* HTTP cache, which is keyed on the URL and is
  // the one cache nothing on this side can reach. A rail tile is served
  // `max-age` of about a day, the service worker deliberately passes
  // `/api/rail/` through to the network, and "Reload cached data" can only empty
  // the Cache Storage API. So when the language changed, every tile anyone had
  // already looked at went on being drawn in the old one for a day, on every
  // device, with no way to hurry it: a hard reload does not cover the tiles
  // MapLibre's worker fetches on the next pan. Changing the URL retires those
  // entries instead of waiting for them.
  const langQuery = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  for (const [id, source] of Object.entries(STYLE.sources)) {
    if (map.getSource(id)) continue;
    map.addSource(id, {
      ...source,
      tiles: source.tiles.map((t) => railUrl(t) + langQuery),
      // Capped to what the server says is currently answerable. MapLibre then
      // asks for the parent tile and overzooms it — coarser, but railways on
      // screen rather than a blank where their CDN has no cached copy. It does
      // the rescaling itself and correctly, which is why this is a `maxzoom`
      // and not something clever with the tile URLs.
      maxzoom: Math.min(source.maxzoom, detail[STYLE.sourceLists[id]] ?? Infinity),
    });
  }

  // A grafted layer has no stylesheet `state` block to read defaults from, and
  // every unset key evaluates to null — which for a style that consults `theme`
  // 748 times is the difference between railways and nothing at all.
  for (const [key, value] of Object.entries(STYLE.state)) {
    map.setGlobalStateProperty(key, value);
  }
  map.setGlobalStateProperty('theme', theme);
  // Which of the two names a station is labelled with below z10, and the reason
  // the far view stayed in the local script while everything closer in had
  // already switched to English.
  //
  // Their style has *two* name properties and reads a different one either side
  // of z10. `localized_name` is the one that answers the language the tiles were
  // asked for (see TILE_LANG in server/rail-tiles.js) and is what every layer
  // from z10 up reads. Below that, three layers read whichever this key names,
  // and their default names `label` — which is the station's own name and is
  // never translated, whatever is asked for. So the language landed on half the
  // zoom range and the far view looked like the change had not been made.
  //
  // Safe because `localized_name` is never empty: with no `name:en` to offer it
  // falls back to `name`, which is exactly what `label` would have been.
  map.setGlobalStateProperty('stationLowZoomLabel', 'name');
  // After their defaults, not among them: four of the keys just set are the four
  // this owns, and their answer for a map of railways is not ours for an overlay.
  setRailTechnical(map, technical);

  // In their order, each beneath the same anchor, so the 288 layers keep the
  // relative order their style put them in.
  return addLayers(map, STYLE.layers.map((layer) => {
    const on = railGroupOn(groups, layer.metadata['hexplore:group']);
    const withVisibility = on
      ? layer
      : { ...layer, layout: { ...layer.layout, visibility: 'none' } };
    // The technical filter is written into the layer once, in terms of a
    // global-state key, so the switch is one property rather than a re-parse of
    // every tile per layer. See technicalFilter.
    const extra = technicalFilter(layer['source-layer']);
    const filtered = extra
      ? { ...withVisibility, filter: withVisibility.filter ? ['all', withVisibility.filter, extra] : extra }
      : withVisibility;
    return withFont(filtered, font);
  }), before, fastAdd);
}

/**
 * Take it all off again.
 *
 * `keepSprites` is for the one caller that is putting the overlay straight back:
 * a source's `maxzoom` cannot be changed in place, so a new detail ceiling means
 * remove-and-re-add, and dropping the sprites in the middle of that is not a
 * detail. An image manager with a sprite in flight is not ready, and MapLibre
 * will not draw a *frame* until it is — so the whole map, basemap included,
 * blinks out for as long as 2.25 MB of atlas takes to fetch, decode and upload.
 * Zooming in is exactly what moves the ceiling, so that read as "the railways
 * disappear when I zoom in". The sprites are unchanged by a zoom range; leaving
 * them alone costs nothing and keeps the rebuild invisible.
 */
export function removeRail(map, { keepSprites = false } = {}) {
  if (!STYLE) return;
  // Stops a chunked install that is still running, or it would put layers back
  // on the map immediately after this walked the list taking them off.
  installSeq++;
  for (const layer of STYLE.layers) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const id of Object.keys(STYLE.sources)) {
    if (map.getSource(id)) map.removeSource(id);
  }
  if (keepSprites) return;
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE.sprites) {
    if (have.has(sprite.id)) map.removeSprite(sprite.id);
  }
}

/**
 * Show or hide one group.
 *
 * Visibility rather than adding and removing the layers: the tiles are already
 * fetched and cached, so switching the kilometre posts back on should cost
 * nothing at all — and it keeps the group's layers in their original position
 * in the stack rather than re-adding them on top.
 */
export function setRailGroup(map, key, on) {
  for (const group of railGroups()) {
    if (group.key !== key) continue;
    for (const id of group.layers) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }
  if (!on) return;
  // A group whose sprite was skipped at install because it was switched off then
  // needs it now. Not removed on the way back down: the atlas is already paid
  // for, and dropping it would only make switching the group on again slow.
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE?.sprites ?? []) {
    if (!have.has(sprite.id) && sprite.groups?.includes(key)) {
      map.addSprite(sprite.id, railUrl(sprite.url));
    }
  }
}

// --- Which one is under the cursor ---------------------------------------------
//
// **The highlight is theirs, not ours.** 171 of the 288 layers already paint
// themselves differently for `["boolean", ["feature-state", "hover"], false]` —
// a red platform edge, a red outline round a station, a yellow track number —
// because their own app is a map you point at. Grafting the layers brought the
// styling with them and it had simply never been switched on. So this is not a
// highlight layer of ours drawn over theirs; it is one feature-state write, and
// every one of those 171 answers it in the colour its designer chose.
//
// `promoteId` on every source is what makes it possible at all: without a stable
// id there is nothing to hang a feature state on.

let hovered = null;

/**
 * Mark one feature as hovered, and unmark whatever was.
 *
 * `null` clears. Sources and layers survive a basemap switch by being re-added,
 * so a state set against the old one is written to nothing and forgotten, which
 * is the correct outcome and needs no teardown of its own.
 */
export function setRailHover(map, feature) {
  const next = feature?.id == null || !feature.source
    ? null
    : { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id };
  if (next && hovered
    && next.source === hovered.source
    && next.sourceLayer === hovered.sourceLayer
    && String(next.id) === String(hovered.id)) return;
  // Guarded: a source that has since been removed — a basemap switch, the
  // overlay switched off — throws rather than shrugging.
  if (hovered) {
    try {
      map.removeFeatureState(hovered, 'hover');
    } catch { /* the source it belonged to is gone */ }
  }
  hovered = next;
  if (next) {
    try {
      map.setFeatureState(next, { hover: true });
    } catch {
      hovered = null;
    }
  }
}

/** Forget what was hovered without touching a map that may no longer hold it. */
export function forgetRailHover() {
  hovered = null;
}

/**
 * What a clicked railway feature says about itself, as plain data.
 *
 * Everything here is already in the tile that drew the line. The services that
 * run over it are not — see `railFeature` — so they arrive separately and later.
 *
 * @returns {{title: string, subtitle: string|null, rows: [string, string][],
 *   osm: {type: string, id: string, url: string}|null, kind: string,
 *   routeCount: number, mayHaveRoutes: boolean, source: string|null,
 *   sourceLayer: string|null, id: string|null}|null}
 */
export function describeRailFeature(feature) {
  const p = feature?.properties;
  if (!p) return null;

  const rows = [];
  const seen = new Set();
  for (const [key, label, format] of POPUP_FIELDS) {
    const value = p[key];
    if (value === undefined || value === null || value === '') continue;
    // Two keys can carry one label — `operator` and `primary_operator` both say
    // who runs it — and the first with a value wins.
    if (seen.has(label)) continue;
    let text;
    try {
      text = format(value);
    } catch {
      text = String(value);
    }
    if (!text || text === 'NaN' || /^\s*$/.test(text)) continue;
    seen.add(label);
    rows.push([label, text]);
  }

  // The name is the heading rather than a row when it is there at all — and the
  // heading is the one the map drew. `localized_name` is the station's name in
  // the overlay's language (see TILE_LANG in server/rail-tiles.js) and is only
  // ever different where a place has a name in it, so a card headed "Tokyo" over
  // a map labelled Tokyo is the whole of this. Where the two differ the local
  // spelling stays as a row, because it is what is written on the platform.
  const named = rows.findIndex(([label]) => label === 'Name');
  const local = p.localized_name || null;
  const own = named >= 0 ? rows[named][1] : null;
  if (named >= 0) {
    if (!local || own === local) rows.splice(named, 1);
    else rows[named][0] = 'Local name';
  }
  const title = local ?? own;

  const sourceLayer = feature.sourceLayer ?? null;
  const kind = railKind(sourceLayer);

  // On a platform, `ref` is the platform number — "4", "12A" — which is the one
  // thing anybody standing on one wants to read. It is the same OSM key that
  // carries a line's route number, and that one was asked to go, so this is
  // keyed off what was clicked rather than off the key alone.
  if (kind === 'platform' && p.ref) {
    rows.unshift([/edges/.test(sourceLayer) ? 'Platform edge' : 'Platform', String(p.ref)]);
  }

  const osm = osmRef(p, sourceLayer, feature.geometry);

  // What the feature calls itself when nobody has named it. A card headed
  // "Railway" over a subtitle reading "platform" spends its heading on the word
  // that is true of everything in the overlay; "Platform" says the same thing in
  // the place a reader looks first.
  const kindWords = featureLabel(p.feature);

  if (!title && !rows.length && !osm && !kindWords) return null;
  return {
    title: title || featureTitle(kindWords) || 'Railway',
    subtitle: title ? kindWords : null,
    rows,
    osm,
    kind,
    // How many route relations run over this line. The tile knows the count but
    // not the names, which is what makes the request below worth making.
    routeCount: Number(p.route_count) || 0,
    // Stations and platforms carry no count — their tiles have no equivalent of
    // `route_count` — so for those the only way to find out is to ask, and the
    // card asks rather than showing nothing where there are twenty services.
    mayHaveRoutes: kind === 'station' || kind === 'platform',
    // What `railFeature` needs to ask for the rest.
    source: feature.source ? String(feature.source).replace(/^hexplore-orm-/, '') : null,
    sourceLayer,
    id: feature.id != null ? String(feature.id) : null,
  };
}

/**
 * The services that run over a line — "IC 8: Brig => Romanshorn" and the rest.
 *
 * The only thing in the card that is not already in the tile. Route membership
 * is a relation, and a vector tile carries `route_count` but not the relations
 * themselves, so this is a request — one per click, on a line the person just
 * asked about, which is a very different thing from one per tile. It goes
 * through the same cache as everything else, and it is answered by their `api`
 * container rather than their tile server, which is why it kept working through
 * the outage that took the tiles down.
 *
 * Never fatal: no routes shown is the same card without a line in it.
 */
// Real arrows, not ASCII. `=>` is how the tag is written, not how it should be
// read — and a route with via-points reads as a journey when it is set with the
// right glyph: "R1: Grandson → Lausanne → Bex".
const ARROW_ONE_WAY = '→';
const ARROW_BOTH_WAYS = '↔';

/**
 * Tidy the spacing OSM put in the name.
 *
 * These labels are built from relation tags, and tags are typed by people:
 * "IC 1 : Stuttgart" and doubled spaces both turn up. Collapsing runs of
 * whitespace and closing the gap before a colon costs nothing and is the
 * difference between a card that looks composed and one that looks glitched.
 */
const tidyLabel = (s) => String(s).replace(/\s+/g, ' ').replace(/\s+([:,])/g, '$1').trim();

/**
 * A route label split where it should break: after the service name.
 *
 * "GoldenPass Express: Interlaken Ost <=> Zweisimmen" is wider than the card,
 * and left to itself the browser breaks at whichever space happens to fall at
 * the edge — usually mid-journey, stranding "Zweisimmen" or the arrow on a line
 * of its own. The two parts are rendered separately so the endpoints wrap as one
 * unit, which puts the break after the colon where a reader expects it.
 */
export function splitRouteLabel(label) {
  const m = /^(.*?:)\s*(.+)$/.exec(tidyLabel(label));
  return m ? { name: m[1], ends: m[2] } : { name: '', ends: tidyLabel(label) };
}

/**
 * How a relation name spells "and then".
 *
 * `=>` is the convention their API documents and it is nothing like universal:
 * "TGV 511: Paris -- Toulon -- Hyères" and "TER Morez - Saint-Claude - (Lyon)"
 * are both real, and a separator this did not know about was a journey printed
 * as one undivided run of text with no arrows in it at all.
 *
 * **Every dash form requires whitespace on both sides**, and that is the whole
 * of what keeps Saint-Claude, Aix-en-Provence and Baden-Baden in one piece. The
 * arrow forms do not, because nothing is spelled `A=>B` by accident.
 */
const STOP_SEPARATOR = /\s*(?:<=>|<->|=>|->)\s*|\s+[-–—↔→]{1,2}\s+/;

/**
 * A route label as a service name and the places it calls at.
 *
 * Split on every separator, not just the first: plenty of relations name their
 * via-points, and treating "Grandson => Lausanne => Bex" as a pair would both
 * read wrong and stop it matching its own return working, whose stops are the
 * same list backwards.
 */
export function parseRouteLabel(label) {
  const { name, ends } = splitRouteLabel(label);
  return { name, stops: ends.split(STOP_SEPARATOR).map((s) => s.trim()).filter(Boolean) };
}

/**
 * Fold a route and its return working into one line.
 *
 * OSM models each direction as its own relation, so a line through a station
 * lists "IC 6: Brig => Basel SBB" and "IC 6: Basel SBB => Brig" — six entries
 * for what a passenger would call three services. Matched on the service name
 * plus the unordered pair of endpoints, so only a genuine there-and-back is
 * folded; two different services between the same towns keep their own lines.
 * The direction that was listed first sets the order, and `<=>` says it runs
 * both ways.
 */
export function mergeRouteDirections(routes) {
  const byKey = new Map();
  const out = [];
  for (const route of routes) {
    const label = tidyLabel(route.label);
    const { name, stops } = parseRouteLabel(label);
    if (stops.length < 2) { out.push({ ...route, label }); continue; }
    // Canonical either way round, so a journey and its return working land on
    // the same key however they were listed.
    const forward = stops.join(' ');
    const backward = [...stops].reverse().join(' ');
    const key = `${name}|${forward < backward ? forward : backward}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.both = true;
      // A route with a colour beats one without; theirs is blank often enough.
      seen.color ??= route.color;
      continue;
    }
    const entry = { ...route, label, name, stops };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out.map(({ name, stops, both, ...rest }) => {
    if (!stops) return rest;
    const arrow = both ? ARROW_BOTH_WAYS : ARROW_ONE_WAY;
    return { ...rest, label: `${name} ${stops.join(` ${arrow} `)}`.trim() };
  });
}

// --- The half of the answer that is not in the tile ----------------------------

/**
 * What their feature API adds to a station, in the order it reads best.
 *
 * A station node in a tile carries its name, its size and the colour of whoever
 * runs it, because that is everything the *drawing* needs. Who runs it, what it
 * is called in the timetable and which services call there are none of them a
 * rendering concern, so they live behind one request.
 */
const STATION_DETAIL = [
  ['operator', 'Operator', (v) => asList(v).join(', ')],
  ['owner', 'Owner', (v) => asList(v).join(', ')],
  ['network', 'Network', (v) => asList(v).join(', ')],
  // "train", "tram", "light_rail", "subway" — what stops here, which for a
  // station shared between two of them is the distinction that matters.
  ['station', 'Serves', humanValue],
  ['description', 'Description', String],
];

// `references` — the UIC number and the operating code, "8507483" and "SP" — is
// deliberately not read. Both are real and neither is anything you do with a
// station: one is a booking system's primary key and the other is on an
// operating diagram, and they filled two of the card's five rows with numbers
// nobody looks up. The API still returns them if a use ever turns up.

/**
 * What their feature API adds to a platform.
 *
 * The number first, because a platform whose relation carries no `name` and no
 * `ref` in the tile is exactly the case that used to open no card at all — the
 * API has the `ref` the tile left out.
 */
const PLATFORM_DETAIL = [
  ['ref', 'Platform', (v) => asList(v).join(', ')],
  ['height', 'Height', (v) => `${round(v, 2)} m`],
  ['surface', 'Surface', humanValue],
];

/**
 * The yes/no tags, as one line rather than eight rows of "yes".
 *
 * Standing on a platform, "Shelter · Benches · Step-free" is a sentence; the
 * same thing as a `dl` is a form. Only the true ones are listed, because a
 * platform that has not been surveyed and a platform with no bench are the same
 * missing tag and printing "no" would claim to know which.
 */
const PLATFORM_FACILITIES = [
  ['shelter', 'Shelter'],
  ['bench', 'Benches'],
  ['lit', 'Lit'],
  ['departures_board', 'Departures board'],
  ['tactile_paving', 'Tactile paving'],
  ['elevator', 'Lift'],
  ['wheelchair', 'Step-free'],
];

/** Their API's answer, as the rows a card can print. */
function detailRows(body, kind) {
  const rows = [];
  const add = (fields) => {
    for (const [key, label, format] of fields) {
      const value = body[key];
      if (value === undefined || value === null || value === '') continue;
      let text;
      try {
        text = format(value);
      } catch {
        text = String(value);
      }
      if (!text || text === 'NaN' || /^\s*$/.test(text)) continue;
      rows.push([label, text]);
    }
  };
  if (kind === 'station') add(STATION_DETAIL);
  if (kind === 'platform') {
    add(PLATFORM_DETAIL);
    const has = PLATFORM_FACILITIES.filter(([key]) => body[key] === true).map(([, label]) => label);
    if (has.length) rows.push(['Facilities', has.join(' · ')]);
  }
  return rows;
}

/**
 * Everything about a clicked feature that the tile could not say.
 *
 * The services that run over it are the reason this exists. Route membership is
 * a relation, and a vector tile carries `route_count` but not the relations
 * themselves, so this is a request — one per click, on something the person just
 * asked about, which is a very different thing from one per tile. It goes
 * through the same cache as everything else, and it is answered by their `api`
 * container rather than their tile server, which is why it kept working through
 * the outage that took the tiles down.
 *
 * Their answer keys the routes by what was clicked — `line_routes` for a track,
 * `station_routes` for a station, `platform_routes` for a platform — and reading
 * only the first of the three is why a station used to list nothing at all.
 *
 * Never fatal: nothing shown is the same card without the extra lines in it.
 */
export async function railFeature({ source, sourceLayer, id, kind }) {
  const empty = { rows: [], routes: [], osm: null };
  if (!source || !sourceLayer || !id) return empty;
  const path = [source, sourceLayer, id].map(encodeURIComponent).join('/');
  try {
    const res = await fetch(`/api/rail/feature/${path}`, { credentials: 'same-origin' });
    if (!res.ok) return empty;
    const body = await res.json();
    const routes = body.line_routes ?? body.station_routes ?? body.platform_routes ?? [];
    return {
      rows: detailRows(body, kind),
      routes: mergeRouteDirections(
        routes
          .map((r) => ({ label: String(r.label ?? '').trim(), color: r.color || null }))
          .filter((r) => r.label),
      ),
      // Their API does carry the pair the tiles do not, so anything whose id was
      // too ambiguous to link from — a kilometre post, a signal — gets its link
      // when this arrives.
      osm: osmRef(body, sourceLayer, null),
    };
  } catch {
    return empty;
  }
}
