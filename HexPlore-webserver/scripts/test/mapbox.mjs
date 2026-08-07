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
  LIGHT_PRESETS, hasMapboxToken, lightPreset, mapboxToken, presetTheme, setLightPreset,
  setMapboxToken, tokenComplaint,
} = await import('../../src/mapbox.js');
const {
  LABEL_SLOT_ID, WASH_SLOT_ID, installAddLayerSlots, isSlot,
} = await import('../../src/gl-engine.js');

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
  eq(lightPreset(), 'day', 'the default is Day');
  for (const preset of LIGHT_PRESETS) {
    setLightPreset(preset.key);
    eq(lightPreset(), preset.key, `${preset.label} can be chosen`);
    eq(presetTheme(), preset.theme, `and reports the ${preset.theme} theme`);
  }
  // The one that decides whether the app's chrome is legible.
  eq(presetTheme('night'), 'dark', 'night is a dark map');
  eq(presetTheme('day'), 'light', 'day is a light one');
  setLightPreset('nonsense');
  eq(lightPreset(), 'day', 'and anything else falls back to Day rather than being stored');
  // A value that predates this list, or a hand-edited one.
  stored['visited-map:mapbox-light:v1'] = 'midnight';
  eq(lightPreset(), 'day', 'as does a stored value the list has never heard of');
  eq(presetTheme('midnight'), 'light', 'and an unknown preset is assumed light rather than crashing');
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
