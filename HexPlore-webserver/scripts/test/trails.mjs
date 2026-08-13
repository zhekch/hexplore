// The trails overlay, on both sides of the wire.
//
// Most of this module is a source spec and a handful of labels, and neither is
// worth a test. Four things here are, and every one of them fails silently:
//
//   - **Their API counts in metres.** `by_area` takes a bounding box in EPSG:3857
//     and a box in degrees is a perfectly valid request that answers
//     `{"results":[]}` for everywhere on earth. That is the most expensive kind
//     of wrong: it reads as "no trails here", it looks like the overlay working,
//     and nothing anywhere says so.
//   - **The theme list is the same list in two places** — a path segment on their
//     server that the proxy will allow, and a button in the layers menu — and
//     nothing but this connects them. A theme in the menu and not in the
//     allowlist is a button that draws nothing; the other way round is a
//     rendering nobody can reach.
//   - **The source has to go through this app's own proxy**, because a `tiles`
//     entry pointed straight at their origin still works, still looks right, and
//     quietly undoes the reason server/trail-tiles.js exists.
//   - **`maxzoom` has to be their real ceiling.** One too deep is a request that
//     can only 404; one too shallow throws away detail they do render.
//
//   node scripts/test/trails.mjs

let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

// Before trails.js, because its theme labels are read at import time — the same
// ordering src/boot.js guarantees in the browser. Without it the labels below
// print as their keys, which passes and reads as nonsense.
await (await import('../../src/i18n.js')).loadLocale('en');

const {
  TRAIL_THEMES, bboxAround, describeTrail, installTrails, isTrailTheme, removeTrails,
  setTrailTheme, tapCorners, trailLayerIds, trailLayerSpec, trailSourceSpec, trailTheme,
  trailThemeLabel,
} = await import('../../src/trails.js');

const { TRAIL_THEMES: SERVER_THEMES, TRAIL_MAX_ZOOM, mercatorBbox, toMercator, validTileCoords } =
  await import('../../server/trail-tiles.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`,
);

console.log('\nThe menu and the allowlist are the same five themes');
{
  eq(TRAIL_THEMES.map((t) => t.key), SERVER_THEMES,
    'the client offers exactly what the proxy will fetch');
  check(TRAIL_THEMES.every((t) => t.label && t.label !== `trails.${t.key}`),
    'and every one of them has a word rather than its key',
    TRAIL_THEMES.map((t) => t.label).join(', '));
  check(new Set(SERVER_THEMES).size === SERVER_THEMES.length, 'with nothing listed twice');
  // Their tile server's path segment and their API's subdomain are the same
  // token, which is what lets one list serve both. A theme with a capital or a
  // slash in it would be neither.
  check(SERVER_THEMES.every((t) => /^[a-z]+$/.test(t)),
    'and each is a bare lowercase token, which is what their URLs are made of');
}

console.log('\nWhich rendering is remembered');
{
  stored = {};
  check(trailTheme() === 'hiking', 'nothing stored means hiking');
  check(setTrailTheme('slopes') === 'slopes', 'a known theme is taken');
  check(trailTheme() === 'slopes', 'and read back');
  // A value from a future build, or a corrupted one. It must not leave the
  // overlay pointed at a path their server will 404 forever.
  stored['visited-map:trail-theme:v1'] = 'via-ferrata';
  check(trailTheme() === 'hiking', 'anything unknown falls back rather than sticking');
  check(setTrailTheme('nonsense') === 'hiking', 'and cannot be stored in the first place');
  check(isTrailTheme('mtb') && !isTrailTheme('mtb '), 'the guard the prefs adopter uses is exact');
  check(trailThemeLabel('cycling') === 'Cycling', 'a theme can say its own name');
  check(trailThemeLabel('made-up') === 'made-up', 'and an unknown one says something rather than nothing');
}

console.log('\nThe source goes through our own proxy');
{
  const spec = trailSourceSpec('hiking');
  eq(spec.tiles, ['/api/trails/tile/hiking/{z}/{x}/{y}.png'],
    'the tile URL is this origin, not theirs');
  check(spec.type === 'raster', 'it is a raster source');
  // Both renderers work in 512 internally and derive which zoom to *ask for*
  // from this number. Getting it wrong does not scale the picture; it fetches
  // the wrong tile.
  check(spec.tileSize === 256, 'declared at their real tile size');
  check(spec.maxzoom === TRAIL_MAX_ZOOM && spec.maxzoom === 18,
    'and capped at the deepest zoom they render', String(spec.maxzoom));
  check(/waymarkedtrails\.org/.test(spec.attribution ?? ''),
    'the rendering is credited on the source, so it comes and goes with the layer');
  check(/rel="noopener noreferrer"/.test(spec.attribution ?? ''),
    'and the credit opens safely');
  // The whole point of the proxy is that the browser never talks to them. A
  // theme that leaked into the URL as an absolute origin would undo it silently.
  check(TRAIL_THEMES.every((t) => trailSourceSpec(t.key).tiles[0].startsWith('/api/trails/tile/')),
    'no theme can produce a URL that leaves this origin');
}

console.log('\nAnd the layer knows which way round the map is');
{
  const dark = trailLayerSpec('dark').paint['raster-opacity'];
  const light = trailLayerSpec('light').paint['raster-opacity'];
  check(light > dark, 'the ink is quieter over a dark basemap than a light one', `${light} vs ${dark}`);
  check(dark > 0.5, 'but never so quiet that a pale local path disappears', String(dark));
  check(light <= 1 && dark > 0, 'and both are opacities');
  // Their renderer draws a different *set* of routes at each zoom, so the
  // default half-second dissolve shows two maps at once.
  check(trailLayerSpec('dark').paint['raster-fade-duration'] === 0, 'with no cross-fade between zooms');
  check(trailLayerSpec('dark').paint['raster-resampling'] === 'linear',
    'and smoothed, because there are no retina tiles to be sharp with');
  // Anything unexpected takes the dark treatment rather than throwing: five
  // basemaps today, and a sixth should not be able to break the overlay.
  check(trailLayerSpec(undefined).paint['raster-opacity'] === dark,
    'an unknown basemap is treated as dark rather than as an error');
}

console.log('\nInstalling and removing it');
{
  // The smallest map either renderer would recognise.
  const fakeMap = () => {
    const sources = new Map();
    const layers = new Map();
    return {
      sources,
      layers,
      order: [],
      getSource: (id) => sources.get(id) ?? undefined,
      addSource: (id, spec) => sources.set(id, { ...spec }),
      removeSource: (id) => sources.delete(id),
      getLayer: (id) => layers.get(id) ?? undefined,
      addLayer(spec, before) { layers.set(spec.id, spec); this.order.push([spec.id, before]); },
      removeLayer: (id) => layers.delete(id),
      setPaintProperty: (id, k, v) => { layers.get(id).paint[k] = v; },
    };
  };

  const map = fakeMap();
  installTrails(map, { theme: 'hiking', basemap: 'dark', before: 'route-glow' });
  const [layerId] = trailLayerIds();
  check(!!map.getLayer(layerId), 'the layer arrives');
  eq(map.order[0], [layerId, 'route-glow'], 'beneath whatever it was anchored on');
  check(map.getSource('hexplore-trails-src').tiles[0].includes('/hiking/'), 'reading the chosen theme');

  installTrails(map, { theme: 'hiking', basemap: 'dark', before: 'route-glow' });
  check(map.order.length === 1, 'installing twice does not stack a second layer');

  // The interesting one: a live source's tile template is not settable in
  // either renderer, so a theme change has to replace the source outright. When
  // this regressed it looked like the switch doing nothing at all.
  installTrails(map, { theme: 'slopes', basemap: 'dark', before: 'route-glow' });
  check(map.getSource('hexplore-trails-src').tiles[0].includes('/slopes/'),
    'switching theme replaces the source rather than leaving the old tiles');
  check(map.layers.size === 1 && map.sources.size === 1, 'and leaves one of each behind');

  // A basemap switch is not a theme switch and must not throw the tiles away.
  const before = map.getSource('hexplore-trails-src');
  installTrails(map, { theme: 'slopes', basemap: 'light', before: 'route-glow' });
  check(map.getSource('hexplore-trails-src') === before, 'a basemap change keeps the source');
  check(map.getLayer(layerId).paint['raster-opacity'] === trailLayerSpec('light').paint['raster-opacity'],
    'and only moves the opacity');

  installTrails(map, { theme: 'not-a-theme', basemap: 'dark', before: undefined });
  check(map.getSource('hexplore-trails-src').tiles[0].includes('/hiking/'),
    'an unknown theme lands on hiking rather than on a 404');

  removeTrails(map);
  check(!map.getLayer(layerId) && !map.getSource('hexplore-trails-src'), 'and it all comes off again');
  removeTrails(map);
  check(true, 'twice, without throwing');
}

console.log('\nWhere the finger was, in the units their API counts in');
{
  // The bug this whole section exists for. Their `by_area` takes EPSG:3857
  // metres; degrees are accepted, answer nothing, and look like empty ground.
  // Checked against the closed form rather than against a recorded value, so
  // this is a statement about the projection and not about one tile.
  const R = 6378137;
  const [x, y] = toMercator(7.45, 46.95);
  check(Math.abs(x - 7.45 * Math.PI / 180 * R) < 1e-6, 'longitude is a straight scaling');
  check(Math.abs(y - Math.log(Math.tan(Math.PI / 4 + 46.95 * Math.PI / 360)) * R) < 1e-6,
    'and latitude is the Mercator one');
  check(x > 800_000 && x < 900_000 && y > 5_900_000 && y < 6_000_000,
    'Bern lands where Bern is', `${x.toFixed(0)}, ${y.toFixed(0)}`);
  // Not exactly zero, and it does not need to be: `tan(π/4)` is a hair off 1 in
  // binary, so the origin comes out a nanometre south of itself. Anything under
  // a metre is far below what their API resolves.
  check(toMercator(0, 0).every((v) => Math.abs(v) < 1), 'the origin is the origin',
    JSON.stringify(toMercator(0, 0)));

  // Mercator has no answer at the pole. A tap up there is a real tap, so it is
  // clamped to the top of the square rather than sent as Infinity.
  const [, north] = toMercator(0, 90);
  check(Number.isFinite(north), 'the north pole is finite rather than Infinity', String(north));
  check(Math.abs(north - 20_037_508) < 2000, 'and sits at the top of the projected square');

  const box = mercatorBbox('7.44,46.94,7.46,46.96');
  const nums = box.split(',').map(Number);
  check(nums.length === 4 && nums.every(Number.isFinite), 'a bbox comes out as four numbers', box);
  check(nums[0] < nums[2] && nums[1] < nums[3], 'ordered west,south,east,north');
  // Metres, emphatically. The number that would have been sent in degrees is
  // 7.44, and this is what makes the difference visible in a test.
  check(nums[0] > 800_000, 'and in metres rather than degrees', String(nums[0]));

  // A box dragged right to left, or south to north, is still a box.
  eq(mercatorBbox('7.46,46.96,7.44,46.94'), box, 'a box given inside out is put the right way round');

  check(mercatorBbox('7.44,46.94,7.46') === null, 'three numbers is not a bbox');
  check(mercatorBbox('a,b,c,d') === null, 'nor is four words');
  check(mercatorBbox('') === null, 'nor is nothing');
  check(mercatorBbox(undefined) === null, 'nor is nothing at all');
  check(mercatorBbox('7.44,146.94,7.46,46.96') === null, 'and a latitude past the pole is refused');
}

console.log('\nThe box a fingertip covers');
{
  // Four corners rather than two, because the map turns: the extent of a rotated
  // square is not the extent of two opposite corners of it.
  const corners = tapCorners({ x: 100, y: 200 });
  check(corners.length === 4, 'a tap has four corners');
  check(new Set(corners.map((c) => `${c.x},${c.y}`)).size === 4, 'and they are four different points');
  check(corners.every((c) => Math.abs(c.x - 100) === Math.abs(c.y - 200)), 'square around the point');
  check(Math.abs(corners[0].x - 100) > 8 && Math.abs(corners[0].x - 100) < 40,
    'about a fingertip wide', String(Math.abs(corners[0].x - 100)));

  const bbox = bboxAround([
    { lng: 7.46, lat: 46.94 }, { lng: 7.44, lat: 46.96 },
    { lng: 7.45, lat: 46.95 }, { lng: 7.455, lat: 46.945 },
  ]);
  eq(bbox.split(',').map(Number), [7.44, 46.94, 7.46, 46.96],
    'the extent of all four, not of the first two');
  // Round-tripped through the server's parser, which is the only consumer.
  check(mercatorBbox(bbox) !== null, 'and it is something the server will accept');
}

console.log('\nWhat a route says about itself');
{
  const viaAlpina = describeTrail({
    id: 12359033, name: 'Via Alpina', ref: '1', group: 'NAT',
    itinerary: ['Vaduz', 'Montreux'], symbol: 'weisse 1 auf grünem Rechteck',
  }, 'hiking');
  check(viaAlpina.title === 'Via Alpina', 'the name is the title');
  check(viaAlpina.kind === 'National route', 'the group is put into words');
  // Composed clauses rather than label-and-value pairs: this is a list of up to
  // twenty routes, not a table about one. Each clause carries whatever word it
  // needs to stand alone, and none carries a word it does not.
  eq(viaAlpina.notes, [
    'National route',
    'No. 1',
    'Vaduz → Montreux',
    'Waymark: weisse 1 auf grünem Rechteck',
  ], 'and each clause reads on its own');
  check(viaAlpina.osm === 'https://www.openstreetmap.org/relation/12359033',
    'with the relation as the way back to the original');

  // A numbered node-network leg is *called* its number. Printing "Unnamed route"
  // over a route signed as 57 would lose the one thing on the sign.
  const leg = describeTrail({ id: 1, ref: '57', group: 'NDS', itinerary: [] }, 'hiking');
  check(leg.title === '57', 'a route with only a number is called its number');
  eq(leg.notes, ['Node network'], 'and does not then repeat it in a clause');
  check(leg.kind === 'Node network', 'node networks are named as such');

  const bare = describeTrail({ id: 2, group: '' }, 'hiking');
  check(bare.title === 'Unnamed route', 'a route with neither gets a word rather than a blank');
  check(bare.kind === null, 'and an unrecognised group says nothing at all');
  eq(bare.notes, [], 'leaving no empty clause behind');
  // Hiking hands back AL1..AL4 and LOC for levels of a local hierarchy, and
  // there is no sentence about reach that is true of all of them. A row reading
  // "Other route" would be "we did not recognise this" dressed as a fact.
  check(describeTrail({ id: 3, group: 'AL2' }, 'hiking').kind === null,
    'including the ones their own site buckets as other');

  // The one theme that groups by *what you would be doing* rather than by reach,
  // and says so with an integer. Reading 1..6 as a difficulty is the obvious
  // misreading; 5 is a cleared footpath.
  check(describeTrail({ id: 4, name: 'Bort', group: 5 }, 'slopes').kind === 'Winter hiking',
    'a winter route is named by what it is for');
  check(describeTrail({ id: 5, name: 'x', group: 1 }, 'slopes').kind === 'Downhill piste',
    'and 1 is a piste rather than the easiest of anything');
  // The same integer under hiking means nothing, and must not be read off the
  // other table.
  check(describeTrail({ id: 6, name: 'x', group: 5 }, 'hiking').kind === null,
    'and the two vocabularies do not leak into each other');

  check(describeTrail(null, 'hiking') === null, 'nothing describes as nothing');
}

console.log('\nAnd the tile coordinates the proxy will accept');
{
  eq(validTileCoords('14', '8529', '5744'), { z: 14, x: 8529, y: 5744 }, 'a real tile passes');
  check(validTileCoords('19', '1', '1') === null, 'z19 is refused, because their server 404s it');
  check(validTileCoords('2', '4', '0') === null, 'an x past the edge of the zoom is refused');
  check(validTileCoords('2', '0', '4') === null, 'and so is a y');
  check(validTileCoords('-1', '0', '0') === null, 'a negative zoom is not a zoom');
  check(validTileCoords('1.5', '0', '0') === null, 'nor is a fractional one');
  check(validTileCoords('..', '0', '0') === null, 'and a path walk is not a number');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
