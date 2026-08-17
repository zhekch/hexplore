// The snow easter egg: which hemisphere's winter it is, and what reaches the map.
//
// Three things here are worth a test and the rest is decoration:
//
//   - "in winter" is answered against the *map's* latitude, not the viewer's, so
//     the southern hemisphere has to get the opposite half of the year. This is
//     the bug that would not be noticed for six months, in either direction.
//   - `applySnow` is called on a MapLibre map on four of the five basemaps, and
//     must do nothing at all rather than throw — the feature does not exist
//     there and never will.
//   - the mode is read back from storage on every load, and anything unknown has
//     to land on `off`. A stored value from a future build must not switch snow
//     on permanently with no control that admits to it.
//
//   node scripts/test/snow.mjs

let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

// Before snow.js, because its mode labels are read at import time — the same
// ordering src/boot.js guarantees in the browser. Without it the labels below
// print as their keys, which passes and reads as nonsense.
await (await import('../../src/i18n.js')).loadLocale('en');

const {
  SNOW_MODES, applySnow, isSnowMode, isWinterAt, setSnowMode, snowMode, snowSpec, snowWanted,
} = await import('../../src/snow.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// Midday local, matching the other suites: a date pinned to midnight UTC lands
// on the day before for anyone west of Greenwich, and this is a question about
// which month it is.
const on = (day) => new Date(`${day}T12:00:00`);

const BERN = 46.95;
const SYDNEY = -33.87;

console.log('\nWinter belongs to a hemisphere');
{
  check(isWinterAt(BERN, on('2026-01-15')), 'January is winter in Bern');
  check(isWinterAt(BERN, on('2026-12-20')), 'and so is December');
  check(isWinterAt(BERN, on('2026-02-28')), 'and February, to the last day of it');
  check(!isWinterAt(BERN, on('2026-07-15')), 'July is not');
  check(!isWinterAt(BERN, on('2026-03-01')), 'and nor is the first of March');

  check(isWinterAt(SYDNEY, on('2026-07-15')), 'July *is* winter in Sydney');
  check(isWinterAt(SYDNEY, on('2026-06-01')), 'as is June');
  check(isWinterAt(SYDNEY, on('2026-08-31')), 'and August');
  check(!isWinterAt(SYDNEY, on('2026-01-15')), 'and January is not');

  // The whole point of asking the map rather than the viewer: on one day, the
  // two hemispheres must disagree.
  const day = on('2026-01-15');
  check(isWinterAt(BERN, day) && !isWinterAt(SYDNEY, day),
    'on one day in January the two hemispheres disagree');
  const july = on('2026-07-15');
  check(!isWinterAt(BERN, july) && isWinterAt(SYDNEY, july), 'and again in July, the other way round');

  check(!isWinterAt(NaN, day), 'a map with no centre yet is not in winter');
  check(!isWinterAt(undefined, day), 'and neither is one with no latitude at all');
}

console.log('\nWhat each mode decides');
{
  const jan = on('2026-01-15');
  const jul = on('2026-07-15');
  check(!snowWanted('off', BERN, jan), 'off is off in the depths of winter');
  check(!snowWanted('off', BERN, jul), 'and off in summer');
  check(snowWanted('always', BERN, jul), 'always is on in summer');
  check(snowWanted('always', SYDNEY, jan), 'and on at the other end of the world');
  check(snowWanted('winter', BERN, jan), 'winter is on in January in Bern');
  check(!snowWanted('winter', BERN, jul), 'and off in July');
  check(snowWanted('winter', SYDNEY, jul), 'and on in July in Sydney');

  // Anything that is not one of the three is not an instruction to snow.
  check(!snowWanted('sometimes', BERN, jan), 'a mode nobody defined does not snow');
  check(!snowWanted(undefined, BERN, jan), 'and neither does no mode at all');
}

console.log('\nThe setting survives a round trip');
{
  check(snowMode() === 'off', 'nothing stored means off');
  for (const mode of SNOW_MODES) {
    setSnowMode(mode.key);
    check(snowMode() === mode.key, `${mode.label} can be chosen`);
  }
  setSnowMode('blizzard');
  check(snowMode() === 'off', 'and anything else falls back to off rather than being stored');
  // A value written by a build that has a fourth mode. It must not be honoured,
  // because the dialog here has no way to show it or turn it off.
  stored['visited-map:snow:v1'] = 'thundersnow';
  check(snowMode() === 'off', 'as does a stored value this build has never heard of');
  check(isSnowMode('winter') && !isSnowMode('winters'), 'and the guard the prefs adopter uses agrees');
}

console.log('\nWhat actually reaches the renderer');
{
  setSnowMode('always');

  // MapLibre: no setSnow at all. This is four of the five basemaps.
  const maplibre = { getCenter: () => ({ lat: BERN }) };
  check(applySnow(maplibre) === false, 'a map with no setSnow is left alone');

  const calls = [];
  const mapbox = {
    getCenter: () => ({ lat: BERN }),
    setSnow: (spec) => calls.push(spec),
  };

  check(applySnow(mapbox, 'always', on('2026-07-15')) === true, 'always snows in July');
  check(calls.at(-1) !== null, 'and hands Mapbox a specification');

  check(applySnow(mapbox, 'off', on('2026-01-15')) === false, 'off does not snow in January');
  check(calls.at(-1) === null, 'and clears it with a null rather than leaving it standing');

  check(applySnow(mapbox, 'winter', on('2026-01-15')) === true, 'winter snows on Bern in January');
  check(applySnow(mapbox, 'winter', on('2026-07-15')) === false, 'and stops in July');

  // A map whose style has not parsed throws from inside setSnow. Losing the
  // snow is acceptable; losing the basemap is not.
  const angry = {
    getCenter: () => ({ lat: BERN }),
    setSnow: () => { throw new Error('style is not done loading'); },
  };
  check(applySnow(angry, 'always') === false, 'a map that throws costs the snow and nothing else');

  // And one that has not been given a camera yet.
  const blank = { getCenter: () => undefined, setSnow: (s) => calls.push(s) };
  check(applySnow(blank, 'winter') === false, 'a map with no centre yet does not snow');
  check(applySnow(blank, 'always') === true, 'but "always" does not need to know where it is');
}

console.log('\nThe specification itself');
{
  const spec = snowSpec();
  check(Array.isArray(spec.density), 'density is a zoom ramp rather than a flat number');
  check(spec.density[0] === 'interpolate', 'built as an interpolate expression');
  // The reason the ramp exists: no snow when the frame holds several climates.
  const stops = spec.density.slice(3);
  check(stops[1] === 0, 'which starts at nothing');
  check(stops[3] > 0, 'and reaches something by the time the map is showing one place');
  check(stops[0] < stops[2], 'with the zooms in increasing order, as interpolate requires');
  check(spec.opacity <= 1 && spec.opacity > 0, 'opacity is a fraction');
  check(spec.vignette < 0.5, 'and the vignette is restrained enough not to read as a dirty lens');
}

// --- Against Mapbox's own specification -----------------------------------------
//
// Everything above is this file's opinion of the settings. This asks the
// renderer's, and it is the check that was missing: `direction` was [-40, 55],
// which is the right bearing written the one way the spec forbids — its minimum
// is 0. `Snow.set` validates before it applies, so an out-of-range number meant
// *nothing* was applied and there was no snow at all, on any basemap, in any
// month. It fires an error on the map rather than throwing, so `applySnow`'s
// try/catch saw nothing wrong and went on reporting snow as on.
//
// Reading the vendor's spec rather than restating it is the whole point: the
// next tuning constant nudged past a limit fails here instead of on a phone in
// December.

console.log('\nAnd Mapbox will actually accept it');
{
  const styleSpec = (await import('mapbox-gl/dist/style-spec/index.cjs')).default;
  const spec = styleSpec.v8 ?? styleSpec.latest;
  const errorsFor = (snow) => styleSpec
    .validate({ version: 8, sources: {}, layers: [], snow })
    .filter((e) => String(e.message).startsWith('snow'));

  const errors = errorsFor(snowSpec());
  check(errors.length === 0, 'every property is one the renderer will take',
    errors.map((e) => e.message).join('; '));

  // Every property named here has to be one that exists, in the version that is
  // installed: these are experimental in Mapbox's own types, which is them
  // reserving the right to rename one in a minor release. A property that is no
  // longer called this is a property that silently does nothing.
  const unknown = Object.keys(snowSpec()).filter((k) => !(k in spec.snow));
  check(unknown.length === 0, 'and every one of them is a property this Mapbox has',
    unknown.join(', '));

  // The check checking the check: with the bug put back, this has to fail.
  check(errorsFor({ ...snowSpec(), direction: [-40, 55] }).length > 0,
    'a bearing written as a negative is caught rather than shrugged at');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
