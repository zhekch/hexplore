// The 3D basemap: the token it will not accept, the light it is shown in, and
// the two anchors that become slots.
//
// What this cannot test is Standard rendering, and that is not a gap it can
// close: Standard is drawn by Mapbox GL JS against somebody's private token, so
// a check of it would only ever pass on one laptop. What is left is everything
// that is decided *before* a tile is asked for, which is where the mistakes
// worth catching actually were:
//
//   - a secret token (`sk.`) works perfectly well against Mapbox and must be
//     refused anyway, because anything in a web page is public. GL JS does
//     refuse it, deep inside a URL builder, as an exception thrown mid-render —
//     far too late to tell anyone which box was wrong.
//   - two of the four light presets turn the map dark, and everything the app
//     decides from a theme follows. A preset that reported the wrong theme
//     would give you white chrome on a night map.
//   - the wash anchor and the label anchor are layer ids on MapLibre and slots
//     on Standard. Getting the slot wrong is not an error anywhere: the layer is
//     accepted, drawn in the wrong place, and the visited colour ends up over
//     the buildings instead of under them.
//
//   node scripts/test/mapbox.mjs

// mapbox.js reads localStorage at call time and swallows its absence, which is
// right in a browser that has it switched off and useless here — most of the
// checks below are about what happens once something is stored.
let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

const {
  AUTO_LIGHT, BASEMAP_IMPORT, LIGHT_CHOICES, LIGHT_PRESETS, configureStandard, hasMapboxToken,
  landmarksVisibleAt, lightChoice, lightPreset, mapboxToken, presetTheme, refreshAutoLight,
  setLightChoice, setMapboxToken, standardConfig, tokenComplaint,
} = await import('../../src/mapbox.js');
const {
  LABEL_SLOT_ID, WASH_SLOT_ID, ctrlClass, ctrlClasses, ctrlSelector, geolocateStateOf, hasCtrlClass,
  installAddLayerSlots, isSlot,
} = await import('../../src/gl-engine.js');

const { readFileSync } = await import('node:fs');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`,
);

console.log('\nWhat counts as a usable token');
check(tokenComplaint('pk.eyJ1IjoiYSJ9.abc') === null, 'a public token is accepted');
check(tokenComplaint('') !== null, 'an empty box is complained about');
check(/secret/i.test(tokenComplaint('sk.eyJ1IjoiYSJ9.abc') ?? ''), 'a secret token is refused by name');
check(tokenComplaint('   ') !== null, 'and so is a box holding only whitespace');
check(tokenComplaint('  pk.eyJ1IjoiYSJ9.abc  ') === null, 'a pasted token keeps its whitespace to itself');

console.log('\nHolding on to it');
{
  eq(mapboxToken(), '', 'nothing stored is the empty string, not null');
  check(!hasMapboxToken(), 'and there is nothing to try');
  setMapboxToken('  pk.trimmed  ');
  eq(mapboxToken(), 'pk.trimmed', 'a stored token is trimmed on the way in');
  check(hasMapboxToken(), 'and now there is something to try');
  setMapboxToken('');
  eq(mapboxToken(), '', 'saving nothing removes it rather than storing an empty string');
  check(!hasMapboxToken(), 'and the basemap goes back to being unavailable');
}

console.log('\nWhere the sun is');
{
  eq(lightChoice(), AUTO_LIGHT, 'the default is Auto');
  check(LIGHT_PRESETS.some((p) => p.key === lightPreset()),
    'which resolves to one of the four Standard has, whatever the clock says');
  check(!LIGHT_PRESETS.some((p) => p.key === AUTO_LIGHT),
    'and auto is not one of them — nothing may hand it to Mapbox');
  eq(LIGHT_CHOICES.map((c) => c.key), ['auto', 'dawn', 'day', 'dusk', 'night'],
    'the row offers auto and then the four');

  for (const preset of LIGHT_PRESETS) {
    setLightChoice(preset.key);
    eq(lightPreset(), preset.key, `${preset.label} can be chosen`);
    eq(presetTheme(), preset.theme, `and reports the ${preset.theme} theme`);
  }
  // The one that decides whether the app's chrome is legible.
  eq(presetTheme('night'), 'dark', 'night is a dark map');
  eq(presetTheme('day'), 'light', 'day is a light one');
  setLightChoice('nonsense');
  eq(lightChoice(), AUTO_LIGHT, 'and anything else falls back to Auto rather than being stored');
  // A value that predates this list, or a hand-edited one.
  stored['visited-map:mapbox-light:v1'] = 'midnight';
  eq(lightChoice(), AUTO_LIGHT, 'as does a stored value the list has never heard of');
  eq(presetTheme('midnight'), 'light', 'and an unknown preset is assumed light rather than crashing');
}

console.log('\nAuto follows the clock, and reports only when it has moved');
{
  // Bern, so the answers below are ones a person can check against a window.
  stored['visited-map:sun-site:v1'] = JSON.stringify([46.9, 7.4]);
  setLightChoice(AUTO_LIGHT);
  const at = (iso) => refreshAutoLight(new Date(iso));

  eq(at('2026-06-21T10:00:00Z').preset, 'day', 'a June lunchtime is Day');
  eq(at('2026-06-21T21:30:00Z').preset, 'night', 'and half eleven that night is Night');
  check(at('2026-06-21T21:35:00Z').changed === false,
    'a second call five minutes later reports no change, so nothing is relit');
  check(at('2026-06-22T03:00:00Z').changed === true,
    'and one that crosses back into dawn says so');
  eq(at('2026-06-22T03:00:00Z').preset, 'dawn', 'five in the morning in June is Dawn');
  // Eight in the evening, Bern time, in each half of the year — the same hour
  // on the same clock, and the whole argument for computing the sun rather than
  // tabulating hours. A table would darken both, and be wrong about one.
  eq(at('2026-12-21T19:00:00Z').preset, 'night', 'eight on a December evening is Night');
  eq(at('2026-06-21T18:00:00Z').preset, 'day', 'and eight on a June evening is still Day');

  setLightChoice('night');
  check(at('2026-06-21T10:00:00Z').changed === false,
    'a sun chosen by hand is never moved by the clock');
  eq(lightPreset(), 'night', 'and stays exactly where it was put');
  setLightChoice(AUTO_LIGHT);
  delete stored['visited-map:sun-site:v1'];
}

console.log('\nThe two anchors, on a map whose layers cannot be read');
{
  check(isSlot(WASH_SLOT_ID), 'the wash anchor is a slot');
  check(isSlot(LABEL_SLOT_ID), 'so is the label anchor');
  check(!isSlot('building-outline'), 'a real layer id is not');
  check(!isSlot(undefined), 'and neither is nothing at all');

  // A map that records what it was asked to add, which is the whole of what the
  // wrapper is for.
  const added = [];
  const map = { addLayer: (spec, before) => added.push({ spec, before }) };
  installAddLayerSlots(map);

  map.addLayer({ id: 'hex-fill', type: 'fill' }, WASH_SLOT_ID);
  eq(added.at(-1).spec.slot, 'middle', 'the visited wash asks for the middle slot');
  eq(added.at(-1).before, undefined, 'and no beforeId, which Standard has none of');
  eq(added.at(-1).spec.id, 'hex-fill', 'the rest of the layer is untouched');

  map.addLayer({ id: 'photo-dot', type: 'circle' }, LABEL_SLOT_ID);
  eq(added.at(-1).spec.slot, 'top', 'a photograph pin asks for the top slot');

  // The case that must keep working: once installGrid has run, most beforeIds
  // name our own layers rather than the basemap's.
  map.addLayer({ id: 'trip-dot', type: 'circle' }, 'trip-glow');
  eq(added.at(-1).before, 'trip-glow', 'a beforeId naming one of our layers is passed straight through');
  check(!('slot' in added.at(-1).spec), 'and no slot is invented for it');

  map.addLayer({ id: 'select-ring', type: 'line' });
  eq(added.at(-1).before, undefined, 'a layer with no anchor at all still goes on top');
  check(!('slot' in added.at(-1).spec), 'with no slot');

  // The wrapper must not mutate what it was handed — installGrid builds some of
  // these specs once and adds them per level.
  const spec = { id: 'reused', type: 'fill' };
  map.addLayer(spec, WASH_SLOT_ID);
  check(!('slot' in spec), 'and the caller’s own object is never written into');
  check(!('paint' in spec), 'nor given a paint block it did not have');
}

// --- Refusing to be lit by the scene -----------------------------------------
// `line`, `fill`, `circle` and `raster` all default to `*-emissive-strength: 0`,
// which means the style's light dims them — so at dusk a route was being darkened
// by the sun going down. Symbols are the counter-example worth keeping in the
// test: Mapbox already defaults *their* emissive strength to 1, which is the
// admission that some things are drawn on a map rather than lying in it.
console.log('\nOur layers are drawn on the map, not lit by it');
{
  const added = [];
  const map = { addLayer: (spec) => added.push(spec) };
  installAddLayerSlots(map);
  const last = () => added.at(-1);

  map.addLayer({ id: 'route-line', type: 'line' });
  eq(last().paint?.['line-emissive-strength'], 1, 'a line is self-lit');
  map.addLayer({ id: 'hex-fill', type: 'fill' });
  eq(last().paint?.['fill-emissive-strength'], 1, 'so is a fill');
  map.addLayer({ id: 'photo-dot', type: 'circle' });
  eq(last().paint?.['circle-emissive-strength'], 1, 'and a circle');
  map.addLayer({ id: 'blob-layer', type: 'raster' });
  eq(last().paint?.['raster-emissive-strength'], 1, 'and the blob sheet, which is a raster');

  // Symbols are left alone — Mapbox already gives them 1.
  map.addLayer({ id: 'hex-label', type: 'symbol' });
  check(
    !Object.keys(last().paint ?? {}).some((k) => k.includes('emissive')),
    'a symbol is left alone, because Mapbox already defaults it to 1',
  );

  // Existing paint survives, and an explicit choice is never overridden.
  map.addLayer({ id: 'kept', type: 'line', paint: { 'line-width': 3 } });
  eq(last().paint['line-width'], 3, 'paint the layer already had is kept');
  eq(last().paint['line-emissive-strength'], 1, 'alongside the one added');
  map.addLayer({ id: 'own', type: 'line', paint: { 'line-emissive-strength': 0.25 } });
  eq(last().paint['line-emissive-strength'], 0.25, 'a layer that asked to be half-lit stays half-lit');
}

// --- Control classes across a library switch ------------------------------------
//
// The two libraries build identical control DOM under different names, and for
// one moment during a basemap switch the app holds one of each: `switchEngine`
// loads the incoming library before taking the outgoing map down, so from then
// until the new map exists, `ctrlClass` names the library that is arriving and
// the buttons on screen still belong to the one that is leaving.
//
// That is the moment the geolocate control's state is read, to be put back on
// the new map. Read under one prefix it matched nothing, the answer came back
// "off", and the blue dot quietly did not return — twice, because the fix for
// it was written on the wrong side of the load. So reading names both.

// --- What Standard is told about itself -----------------------------------------
//
// Standard's refusals are silent: `Style.setConfigProperty` looks the name up in
// the style's own schema and returns without a word when it is not there. So a
// property never sent and a property misspelled look identical from the outside
// — a plain extrusion where a landmark should be, and nothing in the console.
//
// That silence is why the Bundeshaus-as-a-warehouse was blamed on this file
// twice. It was never this file: the models were blocked by the server's
// `script-src`, which had no wasm source, and Mapbox GL JS decodes the batched
// landmark meshes in WebAssembly. `scripts/test/csp.mjs` is the check that
// belongs to that, and it exists because this one cannot see it — nothing about
// a config property can tell you the renderer was not allowed to run.
//
// There is no way to check these names against Mapbox's schema from here either
// — it arrives with the style, which needs a token and a network. What can be
// checked is that every one of them is actually sent, and that one the renderer
// does not know cannot take the others down with it.

console.log('\nStandard is told what to draw');
{
  const want = standardConfig();
  check(want.show3dFacades === true, 'the detailed facades are asked for');
  check(want.showLandmarkIcons === false,
    'but not the landmark icons, which stand in front of the models rather than beside them');
  check(!('showLandmarkIconLabels' in want),
    'and nothing is said about their labels, which only mean anything once the icons are on');
  check(want.lightPreset === lightPreset(), 'the light preset is read when it is set, not at import');
  check(LIGHT_PRESETS.some((p) => p.key === want.lightPreset),
    'and it is one of the four suns even under Auto, which Standard has never heard of');

  // Standard starts `building-models` at 14 and every other building layer at
  // 15, and the layer's own minzoom cannot be reached from outside the import.
  // So the zoom is answered by re-sending the property, and the value is a
  // plain boolean — an expression here reads back perfectly and does nothing,
  // because `layout.visibility` is not re-resolved as the camera moves.
  {
    check(typeof want.show3dLandmarks === 'boolean',
      'the landmark switch is a boolean, not an expression that would be read once and frozen',
      JSON.stringify(want.show3dLandmarks));
    check(landmarksVisibleAt(15) && landmarksVisibleAt(17.4),
      'the models are drawn from z15, where Standard starts the other buildings');
    check(!landmarksVisibleAt(14) && !landmarksVisibleAt(14.99),
      'and not in the band where they would be the only buildings on the map');
    check(standardConfig(14).show3dLandmarks === false
      && standardConfig(15).show3dLandmarks === true,
      'which is the value the config carries for a given zoom');
    check(standardConfig().show3dLandmarks === true,
      'and a caller with no zoom to offer gets the models rather than losing them');
  }

  // Enough map to get through the terrain half without warning: a source that
  // already exists, and a `setTerrain` that accepts one.
  const fakeMap = (setConfigProperty) => ({
    setConfigProperty,
    getSource: () => ({}),
    setTerrain: () => {},
  });

  const sent = [];
  configureStandard(fakeMap((fragment, key, value) => sent.push([fragment, key, value])));
  check(sent.length === Object.keys(want).length, 'every property reaches the map', `${sent.length} sent`);
  check(sent.every(([fragment]) => fragment === BASEMAP_IMPORT),
    'each one naming the import, which is the only one Standard has');
  // Compared by value rather than by identity: one of these is an expression,
  // and an array that merely looks right is what has to be checked.
  const missing = Object.entries(want)
    .filter(([k, v]) => !sent.some(([, key, value]) => key === k
      && JSON.stringify(value) === JSON.stringify(v)));
  check(missing.length === 0, 'with the value it was given', missing.map(([k]) => k).join(', '));

  // The case that made this a loop rather than one try around the lot: an older
  // Standard, or a renamed property, must not cost the map its sun.
  const after = [];
  configureStandard(fakeMap((fragment, key) => {
    if (key === 'show3dFacades') throw new Error('no such property');
    after.push(key);
  }));
  check(after.length === Object.keys(want).length - 1,
    'a property this Standard has never heard of takes only itself down');
  check(after.includes('lightPreset'), 'and the light preset is still set afterwards');

  // The gate itself. This is the half that an expression in the config value
  // only *looked* like it was doing: the property has to be sent again when the
  // camera crosses z15, because the style resolves it once and keeps the answer.
  {
    let zoom = 10.5;
    const handlers = [];
    const sentHere = [];
    const gatedMap = {
      getZoom: () => zoom,
      on: (ev, fn) => { if (ev === 'zoom') handlers.push(fn); },
      setConfigProperty: (fragment, key, value) => sentHere.push([key, value]),
      getSource: () => ({}),
      setTerrain: () => {},
    };
    const zoomTo = (z) => { zoom = z; handlers.forEach((fn) => fn()); };
    const landmarkCalls = () => sentHere.filter(([k]) => k === 'show3dLandmarks').map(([, v]) => v);

    configureStandard(gatedMap);
    eq(landmarkCalls(), [false], 'a map opened below z15 is told the landmarks are off');
    check(handlers.length === 1, 'and one zoom handler is installed', `${handlers.length}`);

    zoomTo(14.9);
    eq(landmarkCalls(), [false], 'zooming within the band says nothing further');
    zoomTo(15.2);
    eq(landmarkCalls(), [false, true], 'crossing z15 switches them on');
    zoomTo(17.4);
    eq(landmarkCalls(), [false, true], 'and zooming further does not say it again');
    zoomTo(12);
    eq(landmarkCalls(), [false, true, false], 'coming back out switches them off once');

    // A style swap lands here again with the config reset to Standard's own
    // defaults, so the value must be re-sent — but a second handler must not be.
    zoom = 16;
    configureStandard(gatedMap);
    eq(landmarkCalls(), [false, true, false, true], 'a style swap re-sends it for the zoom in force');
    check(handlers.length === 1, 'without stacking a second handler on the same map', `${handlers.length}`);
  }

  // Not a Mapbox map at all. `installGrid` only calls this on Mapbox, but the
  // whole point of the trys is that being wrong about that costs nothing. The
  // terrain half says so out loud, which is the one part of this that is meant
  // to be noisy — it is the part the map is still a map without.
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args[0]);
  configureStandard({});
  console.warn = warn;
  check(warned.length === 1 && /terrain/i.test(warned[0]),
    'a map with no config API at all is not a crash, and says so once about the terrain',
    warned.join(' | '));
}

console.log('\nA control class is readable under either library');
{
  const both = ctrlClasses('ctrl-geolocate');
  check(both.includes('maplibregl-ctrl-geolocate') && both.includes('mapboxgl-ctrl-geolocate'),
    'both libraries\' names for the same control', both.join(', '));
  check(both.includes(ctrlClass('ctrl-geolocate')),
    'including whichever one is live, so nothing is lost by reading widely');

  const sel = ctrlSelector('ctrl-geolocate');
  check(sel === '.maplibregl-ctrl-geolocate, .mapboxgl-ctrl-geolocate',
    'and a selector that matches an element either of them built', sel);

  // A stand-in for the button, since there is no DOM here. What matters is that
  // the answer does not depend on which library happens to be loaded.
  const btn = (...names) => ({ classList: { contains: (c) => names.includes(c) } });
  check(hasCtrlClass(btn('maplibregl-ctrl-geolocate-active'), 'ctrl-geolocate-active'),
    'a MapLibre button reads as active');
  check(hasCtrlClass(btn('mapboxgl-ctrl-geolocate-active'), 'ctrl-geolocate-active'),
    'and so does a Mapbox one, in the same call');
  check(!hasCtrlClass(btn('maplibregl-ctrl-geolocate'), 'ctrl-geolocate-active'),
    'a button that is merely there is not tracking you');
  check(!hasCtrlClass(null, 'ctrl-geolocate-active'),
    'and no button at all is not a crash');
}

// --- What the blue dot survives -------------------------------------------------
//
// A basemap switch replaces the map, and a control belongs to the map that made
// its element — so `switchEngine` reads the state off the outgoing button and
// asks the new one for it back. Everything about whether that works is in one
// table, and the table is the libraries', not ours:
//
//      OFF               (no classes)
//      WAITING_ACTIVE    waiting, active
//      ACTIVE_LOCK       active
//      ACTIVE_ERROR      waiting, active-error
//      BACKGROUND        background
//      BACKGROUND_ERROR  waiting, background-error
//
// **BACKGROUND carries no `active` class.** Both libraries remove it on the way
// in, and reading `background` as a flavour of `active` — which is what the
// obvious spelling of this does — answers "off" for a control that is tracking.
// `restoreGeolocate('off')` returns immediately, so the dot did not come back.
//
// That is the state that matters: it is where panning or zooming away from
// yourself lands, and `dropLockOnZoom` puts you there on purpose. The dot
// survived only for someone who pressed the button and then touched nothing.
//
// Pinned for both libraries and for every state either can be in, because this
// has now been the same bug twice and both times it read as "nothing happened".

console.log('\nThe blue dot is a state that survives a basemap switch');
{
  const btn = (...names) => ({ classList: { contains: (c) => names.includes(c) } });
  const state = (prefix, ...suffixes) =>
    geolocateStateOf(btn(...suffixes.map((s) => `${prefix}-ctrl-geolocate-${s}`)));

  for (const prefix of ['maplibregl', 'mapboxgl']) {
    const lib = prefix === 'mapboxgl' ? 'Mapbox' : 'MapLibre';
    eq(state(prefix), 'off', `${lib}: a control nobody has pressed is off`);
    eq(state(prefix, 'active'), 'locked', `${lib}: ACTIVE_LOCK is the camera following you`);
    eq(state(prefix, 'waiting', 'active'), 'locked', `${lib}: and so is WAITING_ACTIVE, which is on its way there`);
    // The one this whole block exists for.
    eq(state(prefix, 'background'), 'background',
      `${lib}: BACKGROUND is tracking without the camera — not off, whatever the missing 'active' suggests`);
    eq(state(prefix, 'waiting', 'active-error'), 'off', `${lib}: ACTIVE_ERROR is not carried across a rebuild`);
    eq(state(prefix, 'waiting', 'background-error'), 'off', `${lib}: nor BACKGROUND_ERROR`);
  }

  eq(geolocateStateOf(null), 'off', 'and no button at all is off rather than a crash');

  // The mistake that was actually shipped, stated as a case: a button whose only
  // class is `background` must not read as `off`, under either library.
  const missed = ['maplibregl', 'mapboxgl'].filter((p) => state(p, 'background') === 'off');
  check(missed.length === 0,
    'no library reads a backgrounded control as one that was never switched on', missed.join(', '));
}

// --- The stylesheet, and where a switch puts it --------------------------------
//
// A source check rather than a rendering one, and it is the only kind available:
// what went wrong here cannot be seen until a *second* library has been loaded
// into a live page, which is a browser and a basemap switch away from any test
// this suite can run.
//
// What happened: the library's own CSS was pulled in with a plain
// `import('maplibre-gl/dist/maplibre-gl.css')`, which the bundler appends to the
// end of <head> when it resolves. On a first load that lands *before*
// src/style.css and everything is fine. On a basemap switch it lands *after*,
// and `.maplibregl-popup-content` against theirs is one class each — a tie, so
// the later one wins. The tapped-route card came back as a square white box
// with our white text still on it: a card with nothing in it but coloured dots.
//
// So the CSS is fetched as text and put at the top of the head instead. These
// three lines are what stops that quietly going back to an ordinary import.
console.log('\nThe library stylesheet cannot outrank ours');
{
  const src = readFileSync(new URL('../../src/gl-engine.js', import.meta.url), 'utf8');
  // Comments out first: the note above this code quotes the very import it is
  // there to warn against, and a test that reads prose is a test that fails on
  // an explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const plain = /import\(\s*'[^']*-gl\.css'\s*\)/.test(code);
  check(!plain, 'no bare CSS import — those are appended after ours, and win on a tie');
  check(/-gl\.css\?inline'/.test(src), 'the stylesheets are pulled in as text (`?inline`)');
  check(/document\.head\.prepend\(/.test(src), 'and put at the top of the head, ahead of anything this app wrote');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
