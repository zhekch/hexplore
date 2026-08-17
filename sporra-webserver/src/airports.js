// The airports overlay: every airfield on Earth, from a dataset rather than an
// API.
//
// **Why this is not shaped like the railways.** The train tracks come from
// OpenRailwayMap's vector tiles, and everything difficult about that module —
// the caching proxy, the rate-limit policy, the per-zoom health monitor, the
// banner apologising for somebody else's outage — is the price of geometry too
// big to ship. Airports are points, there are 85,835 of them, and the whole set
// is smaller than the region boundaries this repo already commits. So they are
// built into the app by `scripts/build-airports.mjs` (read the note at the top
// of it) and there is no server, no key, no quota and nothing to be down. The
// overlay works offline, which no proxied layer can.
//
// **The data is fetched per group, not all at once.** All of it is 2.6 MB
// gzipped and almost all of that is the long tail — 42,707 grass strips, 23,143
// helipads on hospital roofs, 13,378 closed. The five thousand places an airline
// flies to are 250 KB. So each group is its own file and its own dynamic import,
// and a switch that is off costs nothing at all: the same trade the rail overlay
// makes when it fetches a sprite atlas only if a switched-on group draws from it.

// Everything the overlay owns is namespaced, for the reason `sporra-orm-`
// exists: a basemap is somebody else's style and CARTO ships layers with names
// as ordinary as `rail`. Ours are ours beyond doubt.
const NS = 'sporra-air';
const SOURCE = `${NS}-src`;

// --- The groups ----------------------------------------------------------------
//
// One group is one switch *and* one download, so this table is the other half of
// `GROUPS` in scripts/build-airports.mjs — that decides which file each airport
// lands in, this decides what the file is called in the dialog and whether it is
// fetched at all. The test asserts the two key sets agree, because a file nothing
// imports is a group that silently does not exist.
//
// **Three of the four are off**, which is the same judgement the railways make
// about their kilometre posts and signals: switching an overlay on for the first
// time should answer the question you switched it on to ask. "Where are the
// airports" is answered by the five thousand an airline flies to. The other
// eighty thousand are aviation infrastructure — a farm strip, a hospital roof, a
// field that closed in 1974 — all real, all correctly mapped, and between them
// several times as much ink as the thing you were looking for.
export const AIRPORT_GROUPS = [
  {
    key: 'airline',
    label: 'Airline airports',
    note: 'The large and medium airports — the ones with scheduled flights',
    on: true,
    load: () => import('./airports-airline.json'),
  },
  {
    key: 'airfields',
    label: 'Airfields',
    note: 'Small aerodromes, grass strips, seaplane bases and balloon ports',
    on: false,
    load: () => import('./airports-airfields.json'),
  },
  {
    key: 'helipads',
    label: 'Helipads',
    note: 'Hospital roofs, oil platforms and heliports',
    on: false,
    load: () => import('./airports-helipads.json'),
  },
  {
    key: 'closed',
    label: 'Closed',
    note: 'Airfields that no longer operate — often still visible on the ground',
    on: false,
    load: () => import('./airports-closed.json'),
  },
];

const GROUP_BY_KEY = new Map(AIRPORT_GROUPS.map((g) => [g.key, g]));

/** Whether a group is on, given what has been chosen and what it defaults to. */
export const airportGroupOn = (chosen, key) =>
  chosen?.[key] ?? GROUP_BY_KEY.get(key)?.on ?? false;

/** The keys of every group currently switched on, in the table's own order. */
export const airportGroupsOn = (chosen) =>
  AIRPORT_GROUPS.filter((g) => airportGroupOn(chosen, g.key)).map((g) => g.key);

// --- The tuple ------------------------------------------------------------------
//
// Mirrors the record `build()` writes in scripts/build-airports.mjs, and the test
// checks the two against each other. An array rather than an object because the
// keys would otherwise be repeated 86,000 times.
export const AIRPORT_FIELDS = [
  'lng', 'lat', 'kind', 'name', 'iata', 'icao', 'muni', 'country',
  'elev', 'scheduled', 'runways', 'runwayFt', 'surface', 'lit', 'wiki', 'home',
];

/** What each single-letter kind is, in words. The other half of `KINDS`. */
export const AIRPORT_KINDS = {
  L: 'Large airport',
  M: 'Medium airport',
  S: 'Small airport',
  H: 'Heliport',
  W: 'Seaplane base',
  B: 'Balloon port',
  X: 'Closed',
};

// --- The layers -----------------------------------------------------------------
//
// One layer per kind class rather than one per group, because the two things a
// layer decides — which icon and from which zoom — vary inside a group: a large
// international airport is worth drawing at the zoom where a continent fits on
// screen and the regional field beside it is not.
//
// The zooms are the whole of what keeps this legible. There are 42,707 small
// airfields and much of the American Midwest is a grid of them; drawn from z4
// they would be a texture rather than a map. Each threshold is roughly where
// that kind stops being clutter and starts being the answer to a question.
//
// **Declared most important first, and installed in reverse.** That is not a
// style choice, it is the fix for a real bug: `symbol-sort-key` decides who wins
// a collision *within* one layer and says nothing across two, and MapLibre places
// symbols from the top of the layer stack downwards — so the layer added last
// places first. Installed in declaration order, Zürich Airport lost its label to
// Dübendorf Air Base eight kilometres away, because `medium` was added after
// `large` and therefore sat above it. Reversed, the most important kind is
// top-most, places first, and also *draws* on top, which is the same answer to
// both questions. See `installAirports`.
const LAYERS = [
  { id: 'large', group: 'airline', kinds: ['L'], minzoom: 3, icon: 'plane', scale: 1 },
  { id: 'medium', group: 'airline', kinds: ['M'], minzoom: 5.5, icon: 'plane', scale: 0.82 },
  { id: 'small', group: 'airfields', kinds: ['S'], minzoom: 8.5, icon: 'plane-small', scale: 0.72 },
  { id: 'water', group: 'airfields', kinds: ['W', 'B'], minzoom: 8.5, icon: 'plane-water', scale: 0.72 },
  // Helipads start a step and a half further out than the rest of the table
  // would suggest, which is a correction rather than an inconsistency. z11 was
  // set against the worst case — a city centre where every other hospital roof
  // has one — and that case is the one `icon-allow-overlap: false` already
  // handles: the ones that do not fit are simply not placed. What the high
  // threshold actually cost was the ordinary case, where a helipad is the only
  // aviation on the map for fifty kilometres and you had to be nearly on top of
  // it before it appeared at all.
  { id: 'helipad', group: 'helipads', kinds: ['H'], minzoom: 9.5, icon: 'helipad', scale: 0.7 },
  { id: 'closed', group: 'closed', kinds: ['X'], minzoom: 9, icon: 'closed', scale: 0.7 },
];

export const airportLayerIds = () => LAYERS.map((l) => `${NS}-${l.id}`);

/** The layer table itself, so a test can compile the filters rather than read them. */
export const airportLayers = () => LAYERS.map((l) => ({ ...l, id: `${NS}-${l.id}`, filter: kindFilter(l.kinds) }));

/**
 * The features one layer draws.
 *
 * `coalesce` to the empty string rather than testing the property directly, which
 * is the lesson the railway's `technicalFilter` is written around: `match` on an
 * absent property evaluates its input to **null**, and null is neither a label
 * nor the fallback — it is a type error, and a filter that throws does not fail
 * loudly, it draws nothing. Every feature built here carries `k`, so this cannot
 * currently happen; it is one word against the day somebody adds a source that
 * does not.
 */
const kindFilter = (kinds) => ['match', ['coalesce', ['get', 'k'], ''], kinds, true, false];

/**
 * Which layers belong to a group — for switching one off without touching the
 * rest of the stack.
 */
const layersOfGroup = (key) =>
  LAYERS.filter((l) => l.group === key).map((l) => `${NS}-${l.id}`);

// --- The icons ------------------------------------------------------------------
//
// Drawn into images the style owns, exactly the way the house and the search pin
// are: a sprite would mean shipping and loading one, and a symbol layer with no
// image draws nothing while saying nothing about why.
//
// **Stroked wide in white and then filled dark**, which is the same trick the
// basemap's own labels use and the reason one icon reads on a dark map, a light
// one and a photograph without a coloured disc behind it guaranteeing contrast
// by shouting. Reference data should be legible, not loud — the accent colour
// belongs to the ground you have covered, and an airport is not that.

const ICON_PX = 26;
const ICON_FILL = '#1b2431';
const ICON_HALO = 'rgba(255, 255, 255, 0.95)';

/** A top-down aircraft, nose up: fuselage, swept wings, tailplane. */
function planePath(ctx, { hollow = false } = {}) {
  ctx.beginPath();
  ctx.moveTo(13, 3);
  ctx.bezierCurveTo(14.1, 4.2, 14.4, 6.2, 14.4, 8.6);
  ctx.lineTo(22.5, 14.6);
  ctx.lineTo(22.5, 16.6);
  ctx.lineTo(14.4, 13.6);
  ctx.lineTo(14.4, 18.4);
  ctx.lineTo(17.4, 20.9);
  ctx.lineTo(17.4, 22.2);
  ctx.lineTo(13, 20.9);
  ctx.lineTo(8.6, 22.2);
  ctx.lineTo(8.6, 20.9);
  ctx.lineTo(11.6, 18.4);
  ctx.lineTo(11.6, 13.6);
  ctx.lineTo(3.5, 16.6);
  ctx.lineTo(3.5, 14.6);
  ctx.lineTo(11.6, 8.6);
  ctx.bezierCurveTo(11.6, 6.2, 11.9, 4.2, 13, 3);
  ctx.closePath();
  if (hollow) ctx.stroke();
}

/** A capital H in a ring — what a helipad is painted as on the ground. */
function helipadPath(ctx) {
  ctx.beginPath();
  ctx.arc(13, 13, 8.4, 0, Math.PI * 2);
  ctx.moveTo(9.8, 8.6);
  ctx.lineTo(9.8, 17.4);
  ctx.moveTo(16.2, 8.6);
  ctx.lineTo(16.2, 17.4);
  ctx.moveTo(9.8, 13);
  ctx.lineTo(16.2, 13);
}

/** A ring with a stroke through it: the map symbol for a disused aerodrome. */
function closedPath(ctx) {
  ctx.beginPath();
  ctx.arc(13, 13, 7.6, 0, Math.PI * 2);
  ctx.moveTo(7.8, 7.8);
  ctx.lineTo(18.2, 18.2);
}

/**
 * A plane over water — a seaplane base, and a balloon port with it.
 *
 * The plane is shrunk and lifted rather than drawn at full size with a wave
 * added underneath, which was the first attempt and was unreadable: the wave
 * crossed the tailplane and the two stroked shapes merged into one blob at the
 * only size this is ever seen at. Two clearly separated marks beat one clever
 * one when the whole icon is fourteen pixels across.
 */
function waterPath(ctx) {
  ctx.save();
  ctx.translate(13, 10.4);
  ctx.scale(0.78, 0.78);
  ctx.translate(-13, -13);
  planePath(ctx, { hollow: true });
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(4.2, 22.4);
  ctx.quadraticCurveTo(6.4, 20.4, 8.6, 22.4);
  ctx.quadraticCurveTo(10.8, 24.4, 13, 22.4);
  ctx.quadraticCurveTo(15.2, 20.4, 17.4, 22.4);
  ctx.quadraticCurveTo(19.6, 24.4, 21.8, 22.4);
  ctx.stroke();
}

/**
 * Put one icon in the style, if it is not already there.
 *
 * `map.setStyle` throws every image away, so this runs again on each basemap
 * switch — hence the `hasImage` guard rather than a module-level "done" flag,
 * which would be a lie the moment the basemap changed.
 */
function addIcon(map, name, draw) {
  const id = `${NS}-${name}`;
  if (map.hasImage(id)) return;
  const dpr = Math.min(3, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
  const c = document.createElement('canvas');
  c.width = ICON_PX * dpr;
  c.height = ICON_PX * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  draw(ctx);
  map.addImage(
    id,
    { width: ICON_PX * dpr, height: ICON_PX * dpr, data: ctx.getImageData(0, 0, ICON_PX * dpr, ICON_PX * dpr).data },
    { pixelRatio: dpr },
  );
}

function addAirportIcons(map) {
  // A solid plane for the airports an airline flies to: at the zoom where a
  // country fits on screen this is one shape a few pixels across, and a hollow
  // one that size is a smudge.
  addIcon(map, 'plane', (ctx) => {
    ctx.strokeStyle = ICON_HALO;
    ctx.lineWidth = 3.4;
    planePath(ctx);
    ctx.stroke();
    ctx.fillStyle = ICON_FILL;
    planePath(ctx);
    ctx.fill();
  });
  // Hollow for the small ones, which is how a map says "the same kind of thing,
  // less of it" without needing a legend.
  addIcon(map, 'plane-small', (ctx) => {
    ctx.strokeStyle = ICON_HALO;
    ctx.lineWidth = 3.6;
    planePath(ctx, { hollow: true });
    ctx.strokeStyle = ICON_FILL;
    ctx.lineWidth = 1.6;
    planePath(ctx, { hollow: true });
  });
  // `waterPath` strokes both of its marks itself — the plane is drawn under a
  // transform, so it cannot share one path with the wave — hence no stroke here.
  addIcon(map, 'plane-water', (ctx) => {
    ctx.strokeStyle = ICON_HALO;
    ctx.lineWidth = 3.6;
    waterPath(ctx);
    ctx.strokeStyle = ICON_FILL;
    ctx.lineWidth = 1.6;
    waterPath(ctx);
  });
  addIcon(map, 'helipad', (ctx) => {
    ctx.strokeStyle = ICON_HALO;
    ctx.lineWidth = 3.6;
    helipadPath(ctx);
    ctx.stroke();
    ctx.strokeStyle = ICON_FILL;
    ctx.lineWidth = 1.7;
    helipadPath(ctx);
    ctx.stroke();
  });
  addIcon(map, 'closed', (ctx) => {
    ctx.strokeStyle = ICON_HALO;
    ctx.lineWidth = 3.6;
    closedPath(ctx);
    ctx.stroke();
    ctx.strokeStyle = ICON_FILL;
    ctx.lineWidth = 1.6;
    closedPath(ctx);
    ctx.stroke();
  });
}

// --- The data -------------------------------------------------------------------

/** group key → the rows that file holds, once it has been fetched. */
const loaded = new Map();
/** group key → the in-flight fetch, so two switches cannot start two downloads. */
const loading = new Map();

export const airportGroupLoaded = (key) => loaded.has(key);

/**
 * Fetch the groups that are switched on, and no others.
 *
 * `data` is for callers without a bundler, exactly as in `loadRailStyle`,
 * `loadCountries` and `loadRegions`: plain Node needs an import attribute to
 * read JSON that Vite does not want, so a test hands the parsed file over.
 *
 * A group that fails to load is left absent rather than throwing: three of the
 * four are off by default and an overlay that shows the airline airports is
 * still an overlay. The caller sees a shorter list, not an exception.
 */
export async function loadAirports(keys, data) {
  await Promise.all(keys.map(async (key) => {
    if (loaded.has(key)) return;
    if (data?.[key]) {
      loaded.set(key, data[key].airports ?? []);
      return;
    }
    if (!loading.has(key)) {
      const group = GROUP_BY_KEY.get(key);
      if (!group) return;
      loading.set(key, group.load()
        .then((m) => { loaded.set(key, (m.default ?? m).airports ?? []); })
        .catch((e) => { console.warn(`Airports: the ${key} group could not be loaded.`, e); })
        .finally(() => { loading.delete(key); }));
    }
    await loading.get(key);
  }));
  return keys.filter((k) => loaded.has(k));
}

/**
 * The switched-on groups as one GeoJSON collection.
 *
 * Properties are the tuple's own short keys rather than readable ones: this is
 * built for up to 86,000 features and every character is paid per feature. The
 * card reads them back through `describeAirportFeature`, which is the one place
 * that has to know what `y` means.
 *
 * The feature `id` is the index, which is what makes a hover state possible —
 * MapLibre needs a stable id and a GeoJSON feature has none unless it is given
 * one.
 */
export function airportGeoJson(keys) {
  const features = [];
  let id = 0;
  for (const key of keys) {
    for (const r of loaded.get(key) ?? []) {
      features.push({
        type: 'Feature',
        id: id++,
        geometry: { type: 'Point', coordinates: [r[0], r[1]] },
        properties: {
          k: r[2], n: r[3], c: r[4], i: r[5], m: r[6], y: r[7],
          e: r[8], s: r[9], rn: r[10], rf: r[11], rs: r[12], rl: r[13],
          w: r[14], h: r[15],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// --- Installing ------------------------------------------------------------------

/**
 * What a label says, which is two different things at two zooms.
 *
 * Zoomed out, the code: `ZRH` is both shorter and more recognisable than "Zürich
 * Airport", and at the zoom where a country fits on screen the difference
 * between a three-letter tag and a forty-character name is whether the labels
 * collide into nothing. Zoomed in, the name, because by then you are looking at
 * one airport rather than counting them.
 *
 * An airfield with no IATA code — which is most of them — is named at both ends.
 */
const LABEL = [
  'step', ['zoom'],
  ['case', ['!=', ['coalesce', ['get', 'c'], ''], ''], ['get', 'c'], ['coalesce', ['get', 'n'], '']],
  9.5, ['coalesce', ['get', 'n'], ['coalesce', ['get', 'c'], '']],
];

/**
 * Which airport wins when two labels collide.
 *
 * MapLibre places symbols in source order unless told otherwise, and source
 * order here is the build's gzip-friendly sort — so without this, which of
 * Heathrow and a nearby grass strip gets drawn would be an accident of how the
 * file compresses. Lower sorts first, and first placed wins.
 */
const SORT_KEY = ['match', ['coalesce', ['get', 'k'], ''], 'L', 0, 'M', 1, 'S', 2, 'W', 3, 'B', 4, 'X', 5, 6];

function layerFor(map, spec, { font, theme, groups }) {
  const dark = theme !== 'light';
  return {
    id: `${NS}-${spec.id}`,
    type: 'symbol',
    source: SOURCE,
    minzoom: spec.minzoom,
    filter: kindFilter(spec.kinds),
    layout: {
      visibility: airportGroupOn(groups, spec.group) ? 'visible' : 'none',
      'icon-image': `${NS}-${spec.icon}`,
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        Math.max(0, spec.minzoom), 0.62 * spec.scale,
        12, 0.86 * spec.scale,
        16, 1.05 * spec.scale,
      ],
      'icon-allow-overlap': false,
      'icon-optional': true,
      'text-field': LABEL,
      'text-font': font,
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        Math.max(0, spec.minzoom), 10 * Math.max(0.85, spec.scale),
        14, 12.5 * Math.max(0.85, spec.scale),
      ],
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
      'text-optional': true,
      'text-max-width': 9,
      'symbol-sort-key': SORT_KEY,
    },
    paint: {
      // The label is the basemap's own ink rather than the accent, for the same
      // reason the icons are: this is reference data about where an airport is,
      // not a claim about where you have been.
      'text-color': dark ? 'rgba(226, 232, 240, 0.95)' : 'rgba(30, 41, 59, 0.95)',
      'text-halo-color': dark ? 'rgba(10, 12, 18, 0.85)' : 'rgba(255, 255, 255, 0.9)',
      'text-halo-width': 1.4,
      // A closed airfield is a fact about the past and reads as one.
      'icon-opacity': spec.id === 'closed' ? 0.65 : 1,
      'text-opacity': spec.id === 'closed' ? 0.65 : 1,
    },
  };
}

/**
 * Put the overlay on the map, or bring what is already there up to date.
 *
 * **Deliberately idempotent**, and that is what the caller relies on: a basemap
 * switch rebuilds the whole style and needs a fresh install, while ticking a
 * group needs only new data and new visibilities, and the caller should not have
 * to know which case it is in. Asking it to would mean main.js testing for a
 * source id that lives in here — a name in two places, and the one that drifts
 * fails silently, since a missing source reads as an overlay that simply did not
 * draw.
 *
 * @param {maplibregl.Map} map
 * @param {object} opts
 * @param {string[]} opts.font the basemap's own fontstack — see styleFont() in
 *   main.js; a stack the glyph server has never heard of draws no label at all
 * @param {'light'|'dark'} opts.theme
 * @param {string|undefined} opts.before the layer to insert beneath
 * @param {Record<string, boolean>} opts.groups which groups are switched on
 */
export function installAirports(map, { font, theme, before, groups }) {
  const keys = airportGroupsOn(groups);
  addAirportIcons(map);
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, {
      type: 'geojson',
      data: airportGeoJson(keys),
      // Points, so there is nothing to simplify away, and a dropped airport is
      // a missing answer rather than a smoother line.
      tolerance: 0,
      // On the source rather than on the map's own AttributionControl, which is
      // the same mechanism the region boundaries use: MapLibre shows a source's
      // credit only while that source is present, so this appears when the
      // overlay is switched on and goes away with it. OurAirports is public
      // domain and asks for nothing — the credit is here because a dataset this
      // good deserves the traffic, not because it is owed.
      attribution: '<a href="https://ourairports.com/data/" target="_blank" rel="noopener noreferrer">OurAirports</a>',
      // The feature id set in airportGeoJson is on the feature rather than in
      // its properties, which is what `promoteId` would move — so it is left
      // off deliberately.
      buffer: 64,
    });
  } else {
    map.getSource(SOURCE).setData(airportGeoJson(keys));
  }
  // Reversed, so the most important kind ends up top-most: every layer is
  // inserted immediately beneath the same `before`, which puts each new one
  // above the last. See the note on LAYERS for what went wrong when it was not.
  for (const spec of [...LAYERS].reverse()) {
    const layer = layerFor(map, spec, { font, theme, groups });
    if (!map.getLayer(layer.id)) map.addLayer(layer, before);
  }
  // Set every time rather than only at creation, which is what makes ticking a
  // group in the dialog work through the same one call. Visibility rather than
  // adding and removing layers, so switching a group back on cannot reorder the
  // stack — and a group whose data is absent draws nothing anyway, so the two
  // halves cannot disagree.
  for (const group of AIRPORT_GROUPS) {
    const on = airportGroupOn(groups, group.key);
    for (const id of layersOfGroup(group.key)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }
}

/** Take it all off again — the layers first, then the source they read. */
export function removeAirports(map) {
  for (const id of airportLayerIds()) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

// --- What an airport says about itself --------------------------------------------

const NUM = new Intl.NumberFormat();

/**
 * A country code as the country's name.
 *
 * `Intl.DisplayNames` is in every browser this app runs in and in Node, so a
 * 250-name lookup table would be bytes spent on something the platform already
 * knows — and it answers in the reader's own language for free. `countries.json`
 * is no help here: it is keyed by ISO alpha-3 and OurAirports files by alpha-2.
 */
let regionNames = null;
export function countryName(code) {
  const iso = String(code ?? '').trim().toUpperCase();
  if (iso.length !== 2) return iso || null;
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: 'region' });
    return regionNames.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** Feet as metres, with the feet kept: aviation is feet and this map is metric. */
const feetAndMetres = (ft) =>
  `${NUM.format(Math.round(ft * 0.3048))} m (${NUM.format(Math.round(ft))} ft)`;

/**
 * What a clicked airport says about itself, as plain data.
 *
 * Everything is already in the feature that drew the icon — there is no second
 * request anywhere in this module, which is the dividend of shipping the dataset
 * rather than proxying somebody's API.
 *
 * @returns {{title: string, subtitle: string|null, rows: [string, string][],
 *   links: {label: string, url: string}[]}|null}
 */
export function describeAirportFeature(feature) {
  const p = feature?.properties;
  if (!p) return null;
  const rows = [];

  // The codes, on one line. An airport has up to two and they answer different
  // questions — IATA is the one on a boarding pass, ICAO the one on a flight
  // plan — but a card with a row each spends two of its five lines on tags.
  // Deduplicated because a small field often files the same string as both.
  const codes = [...new Set([p.c, p.i].filter(Boolean))];
  if (codes.length) rows.push([codes.length > 1 ? 'Codes' : 'Code', codes.join(' · ')]);

  const place = [p.m, countryName(p.y)].filter(Boolean).join(', ');
  if (place) rows.push(['Where', place]);

  // Elevation 0 is sea level and is a real answer, so the test is against null
  // rather than against falsiness.
  if (p.e !== null && p.e !== undefined && p.e !== '') rows.push(['Elevation', feetAndMetres(Number(p.e))]);

  if (p.rn) {
    // "2 runways, longest 3,700 m" — the number that decides what can land, and
    // what it is made of, because a 2,000 m grass strip and a 2,000 m paved one
    // are not the same airport.
    const parts = [p.rn === 1 ? '1 runway' : `${NUM.format(p.rn)} runways`];
    if (p.rf) parts.push(`longest ${feetAndMetres(Number(p.rf))}`);
    rows.push(['Runways', parts.join(', ')]);
    const made = [p.rs, p.rl ? 'lit' : null].filter(Boolean).join(', ');
    if (made) rows.push(['Surface', made]);
  }

  if (p.k !== 'X') rows.push(['Scheduled flights', p.s ? 'Yes' : 'No']);

  const links = [];
  // Stored as the article title alone — every one of them was an
  // en.wikipedia.org URL and the prefix is 30 bytes × 16,730.
  if (p.w) links.push({ label: 'Wikipedia', url: `https://en.wikipedia.org/wiki/${p.w}` });
  if (p.h) links.push({ label: 'Website', url: String(p.h) });

  return {
    title: p.n || codes[0] || 'Airport',
    subtitle: AIRPORT_KINDS[p.k] ?? null,
    rows,
    links,
  };
}
