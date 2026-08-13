// The vector trails overlay: the filter ladder, and the two things that would
// silently draw the wrong map.
//
// This is the provider whose whole reason to exist is a filter, so the filter is
// what is tested. Everything here fails quietly rather than loudly:
//
//   - **The ladder has to be nested.** "Main routes" showing something that
//     "Waymarked" does not is not a filter, it is four unrelated queries wearing
//     the same control. Nothing about the four expressions makes that true on
//     its own, so it is asserted over a corpus rather than reasoned about.
//   - **A missing property is not an empty one.** Their tiles carry `"name": ""`
//     rather than omitting the key, and `["!=", ["get","name"], ""]` is *true*
//     for a property that is absent — so a filter written the obvious way passes
//     every feature in a tile that happens to omit the field, which reads as the
//     filter doing nothing and looks exactly like a map with no filter on it.
//   - **`paths` and `routes` must not overlap.** They are two layers because
//     `line-dasharray` is not data-driven; if their filters ever both match,
//     every route is drawn twice, at two widths, and the dashes show through.
//   - **The source has to go through this app's own proxy.** A `tiles` entry
//     pointed straight at api.maptiler.com still works, still looks right, and
//     quietly undoes both reasons server/maptiler-tiles.js exists — the key and
//     the coordinates.
//   - **`maxzoom` has to be their real ceiling.** z15 is a 400, not an empty
//     tile, so one too deep is a request that can only fail.
//
//   node scripts/test/trails-vector.mjs

let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

// Before the module, because its theme labels are read at import time — the same
// ordering src/boot.js guarantees in the browser.
await (await import('../../src/i18n.js')).loadLocale('en');

const {
  MAPTILER_THEMES, TRAIL_REACH, describeVectorTrail, isMaptilerTheme, isTrailReach,
  maptilerHasReach, nearestMaptilerTheme, reachFilter, setTrailReach, themeFilters,
  trailReach, trailReachLabel, trailsAtTap, vectorTrailLayerIds, vectorTrailLayerSpecs,
  vectorTrailSourceSpec, vectorTrailTapLayers,
} = await import('../../src/trails-vector.js');

const {
  MAPTILER_MAX_ZOOM, validMaptilerKey, validTileCoords,
} = await import('../../server/maptiler-tiles.js');

const {
  TRAIL_PROVIDERS, isTrailProvider, setTrailProvider, trailProvider, usableTrailProvider,
} = await import('../../src/trails.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`,
);

// --- The corpus -----------------------------------------------------------------
//
// Modelled on what the live tiles actually hold, which was counted rather than
// imagined: ten z14 tiles across ten countries came back 256 features, 51 of
// them with a network, over seven distinct network values. The shapes below are
// each a real row from that sample, plus the two that the sample cannot contain
// and the code has to survive anyway — a property that is absent rather than
// empty, and a free-text network somebody invented.

const F = {
  viaAlpina: { class: 'hiking', name: 'Via Alpina', ref: '1', operator: 'Wanderland Schweiz', symbol: 'green:green::1:white', color: 'green', network: 'nwn' },
  intl: { class: 'hiking', name: 'E5', ref: 'E5', operator: '', symbol: '', color: 'red', network: 'iwn' },
  walkers: { class: 'hiking', name: "Chamonix-Zermatt Walker's route", ref: '', operator: '', symbol: '', network: 'rwn' },
  localLoop: { class: 'hiking', name: 'Grindelwald/Station', ref: '', operator: 'Berner Wanderwege', symbol: 'yellow::yellow_diamond', color: 'yellow', network: 'lwn' },
  cycleNat: { class: 'bicycle', name: 'Du Léman au Mont Blanc', ref: 'V61', operator: '', symbol: '', network: 'ncn' },
  cycleLocal: { class: 'bicycle', name: '', ref: '7', operator: '', symbol: '', network: 'lcn' },
  // The flood: a bare OSM footpath, in the same layer as the routes above and
  // carrying nothing but how hard it is. Nine features in ten from z10 down.
  barePath: { class: 'hiking', name: '', ref: '', operator: '', symbol: '', network: '', scale: 'hiking' },
  bareBike: { class: 'bicycle', name: '', ref: '', operator: '', symbol: '', network: '', scale: '2' },
  // Named, and in no network at all — 62 of 240 in the sample.
  namedNoNet: { class: 'hiking', name: 'Petit Balcon Sud', ref: '', operator: '', symbol: '', network: '', scale: 'hiking' },
  // The two the sample cannot contain.
  absent: { class: 'hiking' },
  freeText: { class: 'hiking', name: 'Rundweg', ref: '', operator: '', symbol: '', network: 'Rundweg' },
};
const CORPUS = Object.entries(F);

// --- The ladder ------------------------------------------------------------------

let featureFilter = null;
try {
  // maplibre-gl's own dependency rather than one of ours, so it is asked for
  // rather than assumed — the same guard scripts/test/rail-style.mjs uses.
  ({ featureFilter } = await import('@maplibre/maplibre-gl-style-spec'));
} catch {
  console.log('  --   @maplibre/maplibre-gl-style-spec not resolvable; expressions not compiled');
}

console.log('\nThe reach ladder');

eq(TRAIL_REACH.map((r) => r.key), ['all', 'named', 'waymarked', 'main'],
  'four rungs, loosest first');
check(TRAIL_REACH.every((r) => typeof r.label() === 'string' && r.label() !== ''),
  'every rung has a label that resolved');
check(isTrailReach('main') && !isTrailReach('nonsense'), 'the rungs are checked, not trusted');

if (featureFilter) {
  const passes = (reach, props) => {
    const f = reachFilter(reach);
    if (!f) return true;
    return featureFilter(f).filter({ zoom: 13 }, { type: 2, properties: props });
  };
  const kept = (reach) => CORPUS.filter(([, p]) => passes(reach, p)).map(([k]) => k);

  const all = kept('all');
  const named = kept('named');
  const waymarked = kept('waymarked');
  const main = kept('main');

  eq(all.length, CORPUS.length, '"every path" keeps everything');
  eq(named.sort(), ['cycleLocal', 'cycleNat', 'freeText', 'intl', 'localLoop', 'namedNoNet', 'viaAlpina', 'walkers'].sort(),
    '"named routes" keeps everything that is called something');
  eq(waymarked.sort(), ['cycleLocal', 'cycleNat', 'freeText', 'intl', 'localLoop', 'viaAlpina', 'walkers'].sort(),
    '"waymarked" keeps everything in a network, free text included');
  eq(main.sort(), ['cycleNat', 'intl', 'viaAlpina', 'walkers'].sort(),
    '"main routes" keeps international, national and regional, on foot and on wheels');

  // The property that makes it a ladder rather than four queries.
  const subset = (a, b) => a.every((k) => b.includes(k));
  check(subset(main, waymarked), 'main ⊆ waymarked');
  check(subset(waymarked, named), 'waymarked ⊆ named');
  check(subset(named, all), 'named ⊆ all');
  check(main.length < waymarked.length && waymarked.length < named.length && named.length < all.length,
    'and each rung is strictly smaller than the one below it');

  // The whole point, stated as the thing that was asked for.
  check(!waymarked.includes('barePath') && !waymarked.includes('bareBike'),
    'the unsigned footpaths — nine features in ten — are gone above "every path"');
  check(!main.includes('localLoop') && !main.includes('cycleLocal'),
    'and the local network is gone at "main routes"');
  check(waymarked.includes('localLoop'),
    'while "waymarked" keeps it, which is why that is the default');

  // A network nobody standardised is a network, and is not a national route.
  check(waymarked.includes('freeText') && !main.includes('freeText'),
    'a free-text network counts as waymarked and never as main');

  // The trap this test exists for.
  check(!named.includes('absent') && !waymarked.includes('absent') && !main.includes('absent'),
    'a feature with no properties at all is excluded, not passed by an absent-field comparison');

  console.log('\nThe two line layers must not overlap');
  for (const theme of ['hiking', 'cycling']) {
    const f = themeFilters(theme);
    const both = CORPUS.filter(([, p]) => (
      featureFilter(f.paths).filter({ zoom: 13 }, { type: 2, properties: p })
      && featureFilter(f.routes).filter({ zoom: 13 }, { type: 2, properties: p })
    ));
    eq(both.map(([k]) => k), [], `${theme}: nothing matches both paths and routes`);
  }

  console.log('\nA theme draws only its own classes');
  const hiking = themeFilters('hiking');
  const cycling = themeFilters('cycling');
  const drawnBy = (filter, props) => featureFilter(filter).filter({ zoom: 13 }, { type: 2, properties: props });
  check(drawnBy(hiking.routes, F.viaAlpina) && !drawnBy(hiking.routes, F.cycleNat),
    'hiking draws the hiking route and not the cycle route');
  check(drawnBy(cycling.routes, F.cycleNat) && !drawnBy(cycling.routes, F.viaAlpina),
    'cycling draws the cycle route and not the hiking route');
  check(!drawnBy(hiking.routes, { class: 'horse', network: 'rhn', name: 'Bridleway' }),
    'and neither draws the bridleways, which are in the same layer');

  // A point in the ski layer handed to a line layer draws nothing, so it is
  // filtered out rather than left to the renderer.
  check(!featureFilter(themeFilters('ski').routes).filter({ zoom: 13 }, { type: 1, properties: { class: 'station', name: 'Brévent' } }),
    'ski: a resort point is not a piste');
}

// --- What is stored --------------------------------------------------------------

console.log('\nWhat is remembered');
stored = {};
eq(trailReach(), 'waymarked', 'nothing stored is the signed network, not everything');
eq(setTrailReach('main'), 'main', 'a rung is stored as given');
eq(trailReach(), 'main', 'and read back');
eq(setTrailReach('nonsense'), 'waymarked', 'a rung this build has never heard of falls back');
stored = { 'visited-map:trail-reach:v1': 'sideways' };
eq(trailReach(), 'waymarked', 'and so does one an older build wrote');
check(typeof trailReachLabel('main') === 'string' && trailReachLabel('main') !== 'main',
  'a rung has a word for it');

console.log('\nWhich provider');
stored = {};
eq(TRAIL_PROVIDERS.map((p) => p.key), ['waymarked', 'maptiler'], 'two providers, the free one first');
eq(trailProvider(), 'waymarked', 'nothing stored is the one that needs no key');
eq(setTrailProvider('maptiler'), 'maptiler', 'a provider is stored as given');
eq(setTrailProvider('nonsense'), 'waymarked', 'and an unknown one falls back');
check(isTrailProvider('maptiler') && !isTrailProvider('mapbox'), 'the providers are checked, not trusted');
eq(usableTrailProvider('maptiler', false), 'waymarked',
  'MapTiler without a key draws the raster rather than four empty layers');
eq(usableTrailProvider('maptiler', true), 'maptiler', 'and with one, itself');
eq(usableTrailProvider('waymarked', true), 'waymarked', 'the raster never needs a key');

// --- The themes ------------------------------------------------------------------

console.log('\nThe themes this provider can honestly offer');
eq(MAPTILER_THEMES.map((t) => t.key), ['hiking', 'cycling', 'ski'],
  'three, and mtb is not among them — their `class` has no MTB value');
check(MAPTILER_THEMES.every((t) => typeof t.label === 'string' && t.label && !t.label.startsWith('trails.')),
  'every theme label resolved rather than printing its key');
eq(nearestMaptilerTheme('mtb'), 'cycling', 'mtb lands on cycling, which is the same tiles');
eq(nearestMaptilerTheme('slopes'), 'ski', 'slopes lands on ski, which is the same thing renamed');
eq(nearestMaptilerTheme('hiking'), 'hiking', 'and a theme both providers have is left alone');
eq(nearestMaptilerTheme('riding'), 'hiking', 'anything else falls back');
check(isMaptilerTheme('ski') && !isMaptilerTheme('mtb'), 'the themes are checked, not trusted');
check(maptilerHasReach('hiking') && !maptilerHasReach('ski'),
  'pistes carry no network, so the ladder means nothing for them');

// --- The source and the layers ----------------------------------------------------

console.log('\nThe source');
const src = vectorTrailSourceSpec();
eq(src.type, 'vector', 'a vector source, which is the whole point of this provider');
check(src.tiles.every((u) => u.startsWith('/api/')),
  'the tiles come through this app’s own server — the key and the coordinates are both on the other side of it');
check(!JSON.stringify(src).includes('maptiler.com/tiles'),
  'and nothing in the spec points a browser at their tile origin');
eq(src.maxzoom, MAPTILER_MAX_ZOOM, 'maxzoom is their real ceiling, past which z15 is a 400');
eq(src.maxzoom, 14, 'which is 14, not the raster provider’s 18');
check(/maptiler\.com\/copyright/.test(src.attribution) && /openstreetmap\.org\/copyright/.test(src.attribution),
  'both credits their terms require travel with the source');

console.log('\nThe layers');
const specs = vectorTrailLayerSpecs({
  theme: 'hiking', basemap: 'dark', opacity: 0.75, font: ['Noto Sans Regular'],
});
const layers = [specs.casing, specs.paths, specs.routes, specs.labels];
eq(layers.map((l) => l.id), vectorTrailLayerIds(), 'the ids a caller is given are the ids that are added');
check(layers.every((l) => l['source-layer'] === 'trail'), 'hiking reads the trail layer');
eq(vectorTrailLayerSpecs({ theme: 'ski', basemap: 'dark', opacity: 1, font: ['x'] }).routes['source-layer'], 'ski',
  'and ski reads theirs, which is a layer rather than a class');
check(specs.labels.layout['text-font'][0] === 'Noto Sans Regular',
  'the label layer uses the basemap’s own fontstack, not a guessed one');
eq(specs.routes.paint['line-opacity'], 0.75, 'the strength reaches the routes');
check(specs.casing.paint['line-opacity'] < specs.routes.paint['line-opacity'],
  'and the casing is always quieter than the line it sits under');
check(vectorTrailTapLayers().every((id) => vectorTrailLayerIds().includes(id))
  && !vectorTrailTapLayers().includes(specs.labels.id),
  'a tap asks the lines and never the labels');

// The one thing about the palette that is not taste: a black waymark over a
// near-black basemap is an invisible route.
const darkColors = JSON.stringify(vectorTrailLayerSpecs({ theme: 'hiking', basemap: 'dark', opacity: 1, font: ['x'] }).routes.paint['line-color']);
const lightColors = JSON.stringify(vectorTrailLayerSpecs({ theme: 'hiking', basemap: 'light', opacity: 1, font: ['x'] }).routes.paint['line-color']);
check(darkColors !== lightColors, 'the waymark palette differs by basemap');
check(/#c9c9c9/i.test(darkColors), 'a black waymark is drawn light over a dark map');
check(/#2a2a2a/i.test(lightColors), 'and dark over a light one');

if (featureFilter) {
  console.log('\nThe layer filters compile');
  for (const l of layers) {
    const compiled = featureFilter(l.filter);
    check(!!compiled, `${l.id}: filter compiles`);
    check(!compiled.needGeometry, `${l.id}: and needs no geometry to evaluate`);
  }
}

// The whole style, against the spec that will actually parse it. A filter that
// compiles says nothing about a misspelled paint property — and a property the
// renderer has never heard of is not an error there, it is silence: the layer
// draws, without whatever that line was supposed to do.
let validateStyleMin = null;
try {
  ({ validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec'));
} catch {
  console.log('  --   style-spec not resolvable; layers not validated');
}
if (validateStyleMin) {
  console.log('\nEvery layer, against the style spec');
  for (const theme of MAPTILER_THEMES.map((th) => th.key)) {
    const s = vectorTrailLayerSpecs({
      theme, basemap: 'dark', opacity: 0.75, font: ['Noto Sans Regular'],
    });
    const errs = validateStyleMin({
      version: 8,
      sources: { 'hexplore-mtrails-src': vectorTrailSourceSpec() },
      layers: [s.casing, s.paths, s.routes, s.labels],
    });
    check(errs.length === 0, `${theme}: four valid layers over a valid source`,
      errs.map((e) => e.message).join('; '));
  }
}

// --- A tap -----------------------------------------------------------------------

console.log('\nWhat a tap makes of a feature');
const row = describeVectorTrail({ properties: F.viaAlpina });
eq(row.title, 'Via Alpina', 'a named route is called its name');
check(row.main, 'and a national route is a main one');
eq(row.osm, null, 'there is no OSM link, because their schema carries no relation id');
eq(row.symbol, null, 'and no waymark drawing, because `symbol` is the tag and not a picture');
eq(describeVectorTrail({ properties: F.cycleLocal }).title, '7', 'a route with only a number is called its number');
eq(describeVectorTrail({ properties: F.localLoop }).main, false, 'a local route is not a main one');
eq(describeVectorTrail({ properties: {} }).title, 'Unnamed route', 'and a feature that says nothing says so');
eq(describeVectorTrail(null), null, 'nothing in, nothing out');

// A relation is cut into one feature per way per tile, so a single tap on a
// through route comes back holding it several times.
const fakeMap = {
  getLayer: (id) => vectorTrailTapLayers().includes(id),
  queryRenderedFeatures: () => [
    { properties: F.viaAlpina }, { properties: F.viaAlpina },
    { properties: F.localLoop }, { properties: F.viaAlpina },
    { properties: F.barePath },
  ],
};
const hits = trailsAtTap(fakeMap, { x: 100, y: 100 });
eq(hits.length, 3, 'the same route arriving four times is one row');
eq(hits[0].title, 'Via Alpina', 'and the main route is first');
check(!hits[0].main === false, 'which is the one with a network behind it');
eq(trailsAtTap(fakeMap, { x: 1, y: 1 }, { reach: 'main' }).map((r) => r.title), ['Via Alpina'],
  'at "main routes" the list cannot contradict the map');
eq(trailsAtTap({ getLayer: () => false, queryRenderedFeatures: () => [] }, { x: 0, y: 0 }), [],
  'no layers is an empty answer rather than a throw');
eq(trailsAtTap({ getLayer: () => true, queryRenderedFeatures: () => { throw new Error('style swapped'); } }, { x: 0, y: 0 }), [],
  'and a style swap mid-tap is too');

// --- The proxy's own checks --------------------------------------------------------

console.log('\nWhat the proxy will and will not ask for');
eq(MAPTILER_MAX_ZOOM, 14, 'their tileset stops at 14');
check(!validTileCoords(15, 17008, 11666), 'z15 is refused here rather than 400ed there');
check(!!validTileCoords(14, 8504, 5833), 'z14 is fine');
check(!validTileCoords(14, 2 ** 14, 0), 'and x has to fit the zoom');
check(!validTileCoords('4;rm -rf', 0, 0), 'a coordinate that is not a number is not a coordinate');

eq(validMaptilerKey('V7kQ2mXbNp4TzR8wLcYs'), 'V7kQ2mXbNp4TzR8wLcYs', 'a real-shaped key passes');
check(!validMaptilerKey('abc'), 'too short is refused');
check(!validMaptilerKey('abcdefgh&foo=bar'), 'a key that could spell a second query parameter is refused');
check(!validMaptilerKey('abcdefgh/../../etc'), 'and one that could walk a path');
check(!validMaptilerKey('https://api.maptiler.com/x?key=abcdefgh'), 'and a whole URL pasted into the box');
check(!validMaptilerKey(''), 'and nothing at all');

const { keyComplaint } = await import('../../src/maptiler.js');
console.log('\nWhat the dialog says before asking anybody');
check(/Mapbox/.test(keyComplaint('pk.eyJ1Ijoic29tZWJvZHkifQ')), 'a Mapbox token is named as one');
check(/URL/.test(keyComplaint('https://api.maptiler.com/tiles/outdoor/tiles.json?key=abc')), 'a URL is named as one');
check(keyComplaint('V7kQ2mXbNp4TzR8wLcYs') === null, 'and a key is not complained about');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
