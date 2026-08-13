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
  OPACITY_MAX, OPACITY_MIN, TRAIL_THEMES, bboxAround, describeTrail, installTrails, isMainTrail,
  isTrailTheme, orderTrails, removeTrails, setTrailOpacity, setTrailTheme,
  tapCorners, trailLayerIds, trailLayerSpec, trailOpacity, trailSourceSpec,
  trailStatsLine, trailTheme, trailThemeLabel,
} = await import('../../src/trails.js');

const {
  TRAIL_THEMES: SERVER_THEMES, TRAIL_MAX_ZOOM, mercatorBbox, oneDetail, toMercator,
  validRelationId, validSymbolId, validTileCoords,
} = await import('../../server/trail-tiles.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`,
);

console.log('\nThe menu and the allowlist are the same themes');
{
  eq(TRAIL_THEMES.map((t) => t.key), SERVER_THEMES,
    'the client offers exactly what the proxy will fetch');
  // Their fifth. It is horse riding rather than a second word for cycling, and
  // it is deliberately in neither list — checked from both sides, because an
  // allowlist quietly permitting a theme nothing can ask for is a proxy onto a
  // path this app does not use.
  check(!SERVER_THEMES.includes('riding'), 'horse riding is not in the allowlist');
  check(!TRAIL_THEMES.some((t) => t.key === 'riding'), 'and not in the menu');
  check(!isTrailTheme('riding'), 'so nothing stored can select it');
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
  stored = {};
  const dark = trailLayerSpec('dark').paint['raster-opacity'];
  const light = trailLayerSpec('light').paint['raster-opacity'];
  // One number for both sides now. It was 0.95 against 0.72 — the reasoning held
  // and the numbers were the wrong conclusion from it, since near-full over
  // Light is ink laid *on* the map rather than in it. What is still per basemap
  // is the strength somebody chooses, which is checked below.
  check(light === dark && light === 0.75, 'the ink lands at three quarters, either way round',
    `${light} vs ${dark}`);
  check(dark > 0.5, 'never so quiet that a pale local path disappears', String(dark));
  check(light <= 1 && dark > 0, 'and both are opacities');
  // Their renderer draws a different *set* of routes at each zoom, so the
  // default half-second dissolve shows two maps at once.
  check(trailLayerSpec('dark').paint['raster-fade-duration'] === 0, 'with no cross-fade between zooms');

  // **Except over terrain, where zero is what thinned the routes to hairlines.**
  // Mapbox holds a tile's deeper children while the tile is still fading, and
  // reads that off `fadeEndTime` — which `registerFadeDuration` declines to set
  // at all when the duration is zero, because `0 + timeAdded` is always already
  // past. Nothing ever stops fading, so nothing is ever released, and the drape
  // draws the deepest tile it has. See DRAPED_FADE_MS in src/trails.js.
  const drapedFade = trailLayerSpec('dark', { draped: true }).paint['raster-fade-duration'];
  check(drapedFade > 0, 'and a real one over the basemap with terrain under it', String(drapedFade));
  check(trailLayerSpec('dark', { draped: false }).paint['raster-fade-duration'] === 0,
    'which is asked for rather than assumed');
  check(trailLayerSpec('light', { draped: true }).paint['raster-opacity']
    === trailLayerSpec('light').paint['raster-opacity'],
    'draping changes the fade and nothing else');
  check(trailLayerSpec('dark').paint['raster-resampling'] === 'linear',
    'and smoothed, because there are no retina tiles to be sharp with');
  // Anything unexpected takes the dark treatment rather than throwing: five
  // basemaps today, and a sixth should not be able to break the overlay.
  check(trailLayerSpec(undefined).paint['raster-opacity'] === dark,
    'an unknown basemap is treated as dark rather than as an error');
}

console.log('\nHow loud, which is stored as two answers rather than one');
{
  stored = {};
  const lightDefault = trailOpacity('light');
  const darkDefault = trailOpacity('dark');

  check(setTrailOpacity('light', 0.5) === 0.5, 'a strength is taken');
  check(trailOpacity('light') === 0.5, 'and read back');
  // The whole reason a *chosen* strength is stored per side: it is a correction
  // for what is underneath, so one number set while looking at Light is not the
  // same statement the moment the basemap goes dark. The defaults agree; what
  // somebody drags does not have to.
  check(trailOpacity('dark') === darkDefault, 'without touching the other side',
    String(trailOpacity('dark')));
  setTrailOpacity('dark', 0.9);
  check(trailOpacity('light') === 0.5 && trailOpacity('dark') === 0.9, 'both are kept at once');
  check(trailLayerSpec('light').paint['raster-opacity'] === 0.5, 'and the layer reads them');

  // Anything absent still gets the default, not a number somebody dragged once
  // on the other side.
  stored = {};
  check(trailOpacity('light') === lightDefault && trailOpacity('dark') === darkDefault,
    'nothing stored means three quarters on both');

  // It is a number in localStorage: a newer build, an older one, or somebody
  // with the devtools open can all have written it. A `raster-opacity` of
  // "loud" is a layer that does not render at all.
  check(setTrailOpacity('dark', 5) === OPACITY_MAX, 'a strength past opaque is clamped');
  check(setTrailOpacity('dark', -1) === OPACITY_MIN, 'and one past invisible too');
  check(setTrailOpacity('dark', NaN) === OPACITY_MIN, 'a value that is not a number is refused',
    String(trailOpacity('dark')));
  stored['visited-map:trail-opacity:v1'] = '{"dark":"loud"}';
  check(trailOpacity('dark') === darkDefault, 'a stored string falls back to the default');
  stored['visited-map:trail-opacity:v1'] = 'not json at all';
  check(trailOpacity('dark') === darkDefault, 'and so does a corrupt entry');
  stored['visited-map:trail-opacity:v1'] = '{"dark":9}';
  check(trailOpacity('dark') === OPACITY_MAX, 'a stored value past opaque is clamped on the way out');
  stored = {};
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

console.log('\nCrossing onto the 3D basemap, and off it again');
{
  // The fade is the one paint property that differs per basemap, and it is
  // invisible until it is wrong: a layer that survives the crossing with a zero
  // fade goes on drawing stale deep tiles for good. See DRAPED_FADE_MS.
  const paints = [];
  const sources = new Map();
  const layers = new Map();
  const map = {
    sources,
    layers,
    getSource: (id) => sources.get(id) ?? undefined,
    addSource: (id, spec) => sources.set(id, { ...spec }),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id) ?? undefined,
    addLayer(spec) { layers.set(spec.id, spec); },
    removeLayer: (id) => layers.delete(id),
    setPaintProperty: (id, k, v) => { paints.push([id, k, v]); layers.get(id).paint[k] = v; },
  };
  const [layerId] = trailLayerIds();
  const fadeOf = () => map.getLayer(layerId).paint['raster-fade-duration'];

  installTrails(map, { theme: 'hiking', basemap: 'dark', before: undefined });
  check(fadeOf() === 0, 'a flat basemap draws it with no cross-fade');

  installTrails(map, { theme: 'hiking', basemap: 'dark', draped: true, before: undefined });
  check(fadeOf() > 0, 'crossing onto the 3D one gives the layer a real fade');
  check(map.layers.size === 1 && map.sources.size === 1,
    'without rebuilding either the layer or the source');

  installTrails(map, { theme: 'hiking', basemap: 'dark', draped: false, before: undefined });
  check(fadeOf() === 0, 'and coming back off puts it back');

  // The source is untouched by any of this: only the layer's paint moves.
  eq(map.getSource('hexplore-trails-src').tileSize, 256, 'the tiles are the same either way');
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
    itinerary: ['Vaduz', 'Montreux'],
    symbolId: 'swiss_NAT_00310031', symbol: 'weisse 1 auf grünem Rechteck',
  }, 'hiking');
  check(viaAlpina.title === 'Via Alpina', 'the name is the title');
  check(viaAlpina.between === 'Vaduz → Montreux', 'and where it runs is one clause after it');
  // The waymark used to be a clause reading "Waymark: weisse 1 auf grünem
  // Rechteck" — a German sentence in the middle of an English list, describing a
  // picture nobody was being shown. It is the picture now.
  check(!JSON.stringify(viaAlpina).includes('Waymark'), 'and the waymark is not a sentence any more');
  check(viaAlpina.symbol.url === '/api/trails/symbol/hiking/swiss_NAT_00310031.svg',
    'the sign is drawn, through our own proxy', viaAlpina.symbol.url);
  check(viaAlpina.symbol.alt === 'weisse 1 auf grünem Rechteck',
    'with their sentence about it kept as the alt, which is what an alt is for');
  // The number is on the symbol — that is the whole point of the symbol being a
  // picture — so a "No. 1" clause beside it is the same fact twice.
  check(!viaAlpina.between?.includes('No.'), 'and the number is not repeated beside it');
  check(viaAlpina.main === true, 'a national route is one of the main ones');
  check(viaAlpina.osm === 'https://www.openstreetmap.org/relation/12359033',
    'with the relation as the way back to the original');

  // A numbered node-network leg is *called* its number. Printing "Unnamed route"
  // over a route signed as 57 would lose the one thing on the sign.
  const leg = describeTrail({ id: 1, ref: '57', group: 'NDS', itinerary: [] }, 'hiking');
  check(leg.title === '57', 'a route with only a number is called its number');
  check(leg.between === null, 'with nothing after it when it goes nowhere named');
  check(leg.symbol === null, 'and no picture when their listing has no symbol for it');
  check(leg.main === false, 'a node-network leg is not a main route');

  // The case the whole rewrite is about: a route with no name at all. It used to
  // read "Unnamed route · Interlaken → Grindelwald"; the second half was always
  // the better title.
  const unnamed = describeTrail({ id: 7, group: 'AL1', itinerary: ['Interlaken', 'Grindelwald'] }, 'hiking');
  check(unnamed.title === 'Interlaken → Grindelwald', 'an unnamed route is called where it runs');
  check(unnamed.between === null, 'and does not then say so twice');

  const bare = describeTrail({ id: 2, group: '' }, 'hiking');
  check(bare.title === 'Unnamed route', 'a route with none of the three gets a word rather than a blank');
  check(bare.between === null, 'leaving no empty clause behind');

  // The one theme that groups by *what you would be doing* rather than by reach,
  // and says so with an integer. Reading 1..6 as a difficulty is the obvious
  // misreading; 5 is a cleared footpath. It is the last-resort title now: a
  // piste with no name, no number and no ends is still a piste.
  check(describeTrail({ id: 4, group: 5 }, 'slopes').title === 'Winter hiking',
    'a nameless winter route is named by what it is for');
  check(describeTrail({ id: 5, group: 1 }, 'slopes').title === 'Downhill piste',
    'and 1 is a piste rather than the easiest of anything');
  // The same integer under hiking means nothing, and must not be read off the
  // other table.
  check(describeTrail({ id: 6, group: 5 }, 'hiking').title === 'Unnamed route',
    'and the two vocabularies do not leak into each other');
  // Hiking hands back AL1..AL4 and LOC for levels of a local hierarchy, and
  // there is no sentence about reach that is true of all of them. A row reading
  // "Other route" would be "we did not recognise this" dressed as a fact.
  check(describeTrail({ id: 3, group: 'AL2' }, 'hiking').title === 'Unnamed route',
    'including the ones their own site buckets as other');

  check(describeTrail(null, 'hiking') === null, 'nothing describes as nothing');
}

console.log('\nWhich routes are the ones you have heard of');
{
  // Reach, because the listing has no superroute flag and the record that does
  // is a quarter of a megabyte per route. See MAIN_GROUPS in src/trails.js.
  for (const g of ['INT', 'NAT', 'REG']) {
    check(isMainTrail({ group: g }, 'hiking'), `${g} is a main route`);
  }
  for (const g of ['LOC', 'NDS', 'AL1', 'AL4', '', undefined]) {
    check(!isMainTrail({ group: g }, 'hiking'), `${g || 'nothing'} is not`);
  }
  // Slopes group by what you would be doing rather than by how far the route
  // reaches, so every piste counts as a route with a name of its own.
  check(isMainTrail({ group: 1 }, 'slopes') && isMainTrail({ group: 5 }, 'slopes'),
    'every piste is a main route, because pistes have no hierarchy');

  const near = [
    { id: 1, group: 'AL1' }, { id: 2, group: 'NAT' }, { id: 3, group: 'LOC' },
    { id: 4, group: 'REG' }, { id: 5, group: 'NDS' },
  ];
  // **Ordered, never filtered.** The *Main routes only* switch is gone, so the
  // legs are always listed — below the routes they belong to, which is the order
  // a junction reads in. A card that silently dropped four of these five was the
  // thing being fixed.
  eq(orderTrails(near, 'hiking').map((r) => r.id), [2, 4, 1, 3, 5],
    'main routes first, and their own order kept inside each half');
  eq(orderTrails(near, 'hiking').length, near.length, 'and nothing is dropped');
  eq(orderTrails([], 'hiking'), [], 'nothing in, nothing out');
}

console.log('\nHow far, how much up, how much down');
{
  // Metres in — what OSM tags and their renderer both count in — kilometres and
  // metres out, which is how anybody planning a walk says it.
  check(trailStatsLine({ length: 50_700, ascent: 3076, descent: 2235 })
    === '50.7 km · ↑ 3,076 m · ↓ 2,235 m',
    'the three numbers, with their units', trailStatsLine({ length: 50_700, ascent: 3076, descent: 2235 }));
  check(trailStatsLine({ length: 510_000 }) === '510 km',
    'a long route drops the decimal it cannot mean', trailStatsLine({ length: 510_000 }));
  check(trailStatsLine({ length: 8420 }) === '8.4 km', 'a short one keeps it');
  // Most local paths carry no `distance` tag and never will, and a card that
  // said "0 km" about one would be inventing a measurement.
  check(trailStatsLine({}) === null, 'a route that says none of the three says nothing');
  check(trailStatsLine({ length: 0, ascent: 0 }) === null, 'and zero is not a measurement');
  check(trailStatsLine() === null, 'nor does it throw when handed nothing at all');
  check(trailStatsLine({ ascent: 1200 }) === '↑ 1,200 m', 'climb alone still reads');
}

console.log('\nAnd what the server keeps of a detail record');
{
  // Their answer is the whole route — every way, every coordinate. What a card
  // wants out of it is eighty bytes, which is why this reduction happens on the
  // server and not in the page.
  const full = oneDetail({
    official_length: 63000, route: { length: 59959 },
    tags: { ascent: '2200', descent: '2100', type: 'route' },
  });
  eq(full, { length: 63000, ascent: 2200, descent: 2100, superroute: false },
    'the three numbers and nothing else');
  // The signposted number wins over the measured one: it is what the guidebook
  // says and what somebody is checking against.
  check(oneDetail({ official_length: 63000, route: { length: 59959 }, tags: {} }).length === 63000,
    'the distance on the sign beats the distance along the ways');
  check(oneDetail({ route: { length: 59959 }, tags: {} }).length === 59959,
    'and the measured one is used when the route does not claim one');
  // OSM tag values are typed by people. Half of these are real.
  check(oneDetail({ tags: { ascent: '1,200' } }).ascent === 1200, 'a thousands comma is read');
  check(oneDetail({ tags: { ascent: '2200 m' } }).ascent === 2200, 'and a unit somebody typed');
  check(oneDetail({ tags: { ascent: 'about 40' } }).ascent === null, 'a sentence is not a measurement');
  check(oneDetail({ tags: { ascent: '-5' } }).ascent === null, 'nor is a negative climb');
  check(oneDetail({ tags: { ascent: '999999' } }).ascent === null, 'nor is one past the sky');
  check(oneDetail({ tags: { type: 'superroute' } }).superroute === true,
    'a route made of routes says so — the one place that distinction exists');
  check(oneDetail(null) === null && oneDetail('nope') === null, 'and nothing reduces to nothing');
}

console.log('\nThe two ids that go into their URLs');
{
  check(validSymbolId('osmc_LOC_empty_yellow-diamond') === 'osmc_LOC_empty_yellow-diamond',
    'a symbol id passes');
  check(validSymbolId('swiss_REG_00320036') === 'swiss_REG_00320036', 'and the other kind');
  // No slash is the whole of the check: without one there is no path to walk up
  // and no second host to name.
  check(validSymbolId('../../etc/passwd') === null, 'a path walk is refused');
  check(validSymbolId('//evil.example/x') === null, 'and so is another origin');
  check(validSymbolId('a b') === null, 'and a space, which their generator never emits');
  check(validSymbolId('') === null && validSymbolId(undefined) === null, 'and nothing at all');
  check(validSymbolId('x'.repeat(200)) === null, 'and a symbol id longer than any symbol id');

  check(validRelationId('12359033') === 12359033, 'a relation id is a number');
  check(validRelationId(12359033) === 12359033, 'given either way');
  check(validRelationId('0') === null, 'zero is not a relation');
  check(validRelationId('-1') === null, 'nor is a negative one');
  check(validRelationId('12e3') === null, 'nor is exponent notation');
  check(validRelationId('1/../2') === null, 'and nothing with a path in it');
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
