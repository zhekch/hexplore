// The 3D basemap, held to the parts of it that are not the network.
//
// Almost everything src/mapbox.js does is string work over a document whose
// shape is published and stable, which is lucky, because the one thing this
// test cannot do is ask Mapbox: it would need somebody's private token, and a
// test suite that only passes on one laptop is not a test suite. So the fixture
// below is the real layer order of `mapbox/streets-v12`, trimmed to the part
// that decides where the visited colour goes, and the checks are the questions
// that were actually got wrong while writing it:
//
//   - a token put on early ends up inside the sprite filename, because MapLibre
//     builds the real URL by concatenating `.json` onto whatever string it is
//     given. Hence `mapboxAuth` at request time and no token in resolveUrl.
//   - `extrude` is the string 'true', not a boolean, so the obvious filter
//     matches nothing and the city comes out flat with no error anywhere.
//   - the extrusions have to go *under* the labels, or `labelStart()` in
//     main.js hands the railways, the airports and the photographs an anchor
//     above them and every pin sinks into a tower block.
//
//   node scripts/test/mapbox.mjs

// mapbox.js reads localStorage at call time and swallows its absence, which is
// right in a browser that has it switched off and useless here — half the
// checks below are about what happens once a token exists. So there is one.
let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

const {
  addExtrusions, labelStartIn, localiseStyle, mapboxAuth, resolveMapboxUrl,
  setMapboxToken, tokenComplaint, washAnchorIn,
} = await import('../../src/mapbox.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(got === want, label, `got ${JSON.stringify(got)}`);

const API = 'https://api.mapbox.com';

// --- mapbox:// is not a scheme anything can fetch ----------------------------
console.log('\nResolving Mapbox URLs');
eq(
  resolveMapboxUrl('mapbox://styles/mapbox/streets-v12'),
  `${API}/styles/v1/mapbox/streets-v12`,
  'a style',
);
// The one that has to end in `/sprite` with nothing after it: MapLibre appends
// `.json` and `@2x.png` itself.
eq(
  resolveMapboxUrl('mapbox://sprites/mapbox/streets-v12'),
  `${API}/styles/v1/mapbox/streets-v12/sprite`,
  'a sprite sheet, with room for the extension MapLibre adds',
);
check(
  !resolveMapboxUrl('mapbox://sprites/mapbox/streets-v12').includes('?'),
  'and no query string on it, which would land inside the filename',
);
eq(
  resolveMapboxUrl('mapbox://fonts/mapbox/{fontstack}/{range}.pbf'),
  `${API}/fonts/v1/mapbox/{fontstack}/{range}.pbf`,
  'a glyph range, placeholders intact',
);
eq(
  resolveMapboxUrl('mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2'),
  `${API}/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure`,
  'a pair of tilesets, as TileJSON',
);
eq(
  resolveMapboxUrl('https://example.com/style.json'),
  'https://example.com/style.json',
  'and anything that is not a mapbox:// URL is left exactly alone',
);

// --- The token goes on at request time ---------------------------------------
console.log('\nAuthorising requests');
setMapboxToken('pk.test-token');
eq(
  mapboxAuth(`${API}/styles/v1/mapbox/streets-v12/sprite.json`)?.url,
  `${API}/styles/v1/mapbox/streets-v12/sprite.json?access_token=pk.test-token`,
  'the sprite URL MapLibre actually builds gets the token after the extension',
);
eq(
  mapboxAuth(`${API}/v4/mapbox.mapbox-terrain-dem-v1.json?secure`)?.url,
  `${API}/v4/mapbox.mapbox-terrain-dem-v1.json?secure&access_token=pk.test-token`,
  'a URL that already has a query string gets an ampersand, not a second ?',
);
eq(
  mapboxAuth(`${API}/v4/x.json?access_token=pk.already`),
  undefined,
  'a URL Mapbox already tokenised is left alone',
);
// The whole reason this is safe to install globally on the map.
eq(
  mapboxAuth('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'),
  undefined,
  'and every other basemap in the app is untouched',
);
setMapboxToken('');
eq(
  mapboxAuth(`${API}/styles/v1/mapbox/streets-v12`),
  undefined,
  'with no token stored, nothing is added rather than "access_token=null"',
);
setMapboxToken('pk.test-token');

// --- Which strings are worth refusing ----------------------------------------
console.log('\nWhat counts as a usable token');
check(tokenComplaint('pk.eyJ1IjoiYSJ9.abc') === null, 'a public token is accepted');
check(tokenComplaint('') !== null, 'an empty box is complained about');
check(/secret/i.test(tokenComplaint('sk.eyJ1IjoiYSJ9.abc') ?? ''), 'a secret token is refused by name');
check(tokenComplaint('  pk.eyJ1IjoiYSJ9.abc  ') === null, 'and a pasted token keeps its whitespace to itself');

// --- The published layer order of mapbox/streets-v12 --------------------------
// Trimmed to the part that answers "where does the visited colour go", in the
// order Mapbox publishes it. The names are real.
const L = (id, type = 'line') => ({ id, type });
const streetsV12 = [
  L('background', 'background'),
  L('landcover', 'fill'),
  L('national-park', 'fill'),
  L('landuse', 'fill'),
  L('waterway-shadow'),
  L('water-shadow', 'fill'),
  L('waterway'),
  L('water', 'fill'),
  L('hillshade', 'fill'),
  L('land-structure-polygon', 'fill'),
  L('land-structure-line'),
  L('aeroway-polygon', 'fill'),
  L('aeroway-line'),
  L('building-outline'),
  L('building', 'fill'),
  L('tunnel-street-low'),
  L('road-street-low'),
  L('road-primary'),
  L('road-motorway-trunk'),
  L('bridge-street'),
  L('admin-1-boundary'),
  L('admin-0-boundary'),
  L('road-label', 'symbol'),
  L('waterway-label', 'symbol'),
  L('poi-label', 'symbol'),
  L('airport-label', 'symbol'),
  L('settlement-major-label', 'symbol'),
  L('country-label', 'symbol'),
  L('continent-label', 'symbol'),
];

console.log('\nWhere the visited colour lands on a Mapbox style');
{
  const anchor = washAnchorIn(streetsV12);
  const at = streetsV12.findIndex((l) => l.id === anchor);
  const where = (id) => {
    const i = streetsV12.findIndex((l) => l.id === id);
    return i < 0 ? 'absent' : i >= at ? 'above' : 'below';
  };
  eq(anchor, 'building-outline', 'the anchor is the first rooftop in the stack');
  check(where('building') === 'above', 'rooftops draw over the colour — the thing that was asked for');
  check(where('road-primary') === 'above', 'so do the streets');
  check(where('bridge-street') === 'above', 'and the bridges carrying them');
  check(where('water') === 'below', 'water is ground, and stays under it');
  check(where('landuse') === 'below', 'so is landuse');
  check(where('aeroway-line') === 'below', 'and so is a runway, the same as on every other basemap');
  check(where('hillshade') === 'below', 'and the relief the colour is meant to sit on');
}

// --- The extrusions go under the labels, not on top of everything ------------
console.log('\nExtruded buildings');
{
  const style = {
    sources: { composite: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' } },
    // As if Mapbox had already shipped one, which v12 does: it must not end up
    // with two.
    layers: [...streetsV12.slice(0, 22), { id: 'building-extrusion', type: 'fill-extrusion' }, ...streetsV12.slice(22)],
  };
  addExtrusions(style);
  const ids = style.layers.map((l) => l.id);
  const extrusions = style.layers.filter((l) => l.type === 'fill-extrusion');
  eq(extrusions.length, 1, 'exactly one extrusion layer survives');
  eq(extrusions[0].id, 'building-3d', 'and it is ours');
  eq(extrusions[0].source, 'composite', 'pointed at the vector source the style actually has');
  eq(extrusions[0]['source-layer'], 'building', 'and at the building layer inside it');
  check(
    ids.indexOf('building-3d') > ids.indexOf('admin-0-boundary'),
    'above every road, boundary and flat rooftop',
  );
  check(
    ids.indexOf('building-3d') < ids.indexOf('road-label'),
    'and below the first label — which is where labelStart() anchors the railways, '
      + 'the airports and the photographs, so they land on the buildings rather than inside them',
  );
  // The one that silently draws nothing if it is written the obvious way.
  // Asked structurally rather than of the serialised filter: `true` and "true"
  // are one character apart once it is a string, which is the whole point.
  const comparand = extrusions[0].filter
    .find((clause) => Array.isArray(clause) && JSON.stringify(clause[1]) === '["get","extrude"]')?.[2];
  eq(comparand, 'true', "the extrude filter compares against the string 'true'");
  check(
    typeof comparand !== 'boolean',
    'and not against the boolean, which matches nothing in mapbox-streets-v8',
  );
}

console.log('\nWhere a layer goes to be over the map but under its names');
eq(labelStartIn(streetsV12), 22, 'the bottom of the topmost run of symbol layers');
eq(labelStartIn([L('a', 'fill'), L('b', 'fill')]), 2, 'a style with no labels puts it at the end');
eq(labelStartIn([L('a', 'symbol'), L('b', 'symbol')]), 0, 'a style that is all labels puts it at the start');

// --- What MapLibre must never be shown ---------------------------------------
console.log('\nMaking the document one MapLibre can read');
{
  const style = {
    version: 8,
    // Mapbox writes `{"name": "globe"}` where MapLibre reads `{"type": ...}`,
    // so left in place it is neither obeyed nor ignored — it is an error on
    // every load.
    projection: { name: 'globe' },
    fog: { range: [0.5, 10] },
    imports: [{ id: 'basemap', url: 'mapbox://styles/mapbox/standard' }],
    owner: 'mapbox',
    id: 'streets-v12',
    sprite: 'mapbox://sprites/mapbox/streets-v12',
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    sources: {
      composite: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' },
      other: { type: 'raster', tiles: ['mapbox://tiles/x/{z}/{x}/{y}'] },
    },
    layers: [{ id: 'a', type: 'fill', slot: 'middle' }],
  };
  localiseStyle(style);
  for (const key of ['projection', 'fog', 'imports', 'owner', 'id']) {
    check(!(key in style), `${key} is dropped`);
  }
  eq(style.version, 8, 'and the version it actually needs is kept');
  check(!style.sprite.startsWith('mapbox://'), 'the sprite is fetchable');
  check(!style.glyphs.startsWith('mapbox://'), 'so are the glyphs');
  check(!style.sources.composite.url.startsWith('mapbox://'), 'and the vector source');
  check(!style.sources.other.tiles[0].startsWith('mapbox://'), 'including a source listing tiles rather than a url');
  check(!('slot' in style.layers[0]), 'and Standard’s per-layer slot goes, which a flat style has no use for');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
