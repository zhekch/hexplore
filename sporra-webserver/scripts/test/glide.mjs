// The location dot moving to its fixes rather than appearing at them.
//
// What is worth pinning here is not that the dot ends up in the right place —
// it plainly does, since it is handed the fix — but the four things that make it
// look right on the way, each of which was a way to get this wrong:
//
//   - the frame the *original* would have drawn. Both libraries teleport the
//     marker inside `_updateMarker`, and the wrapper calls the original on
//     purpose (it is what adds the markers and sizes the accuracy circle). If
//     the position is not put back in the same tick, every fix is a jump
//     followed by a glide from the wrong end.
//   - a jump that is not movement. The first fix of a session, or a phone that
//     has just corrected itself by half a suburb, must appear rather than sail.
//   - the antimeridian, where interpolating two longitudes the obvious way
//     sends the dot the long way round the planet.
//   - the camera, which follows a *lock* and must not be flown for every fix —
//     and must tell the library that the move was made on its behalf, or the
//     control drops out of tracking a second after it starts.
//
//   node scripts/test/glide.mjs

// A clock and a frame queue this test drives by hand, installed before the
// module is imported because it reads both at call time.
let clock = 1000;
const frames = [];
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (fn) => frames.push(fn) && frames.length;
globalThis.cancelAnimationFrame = () => { frames.length = 0; };

/** Run every frame that is due, at `t` milliseconds. */
function tick(t) {
  clock = t;
  const due = frames.splice(0, frames.length);
  for (const fn of due) fn();
}

const {
  glideMs, installGlide, lerpLngLat, metresBetween, smoothLocationCamera, smoothLocationDot,
} = await import('../../src/glide.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`,
);
const near = (got, want, tol, label) => check(
  Math.abs(got - want) <= tol, label, `got ${got}, wanted ${want} ± ${tol}`,
);

const fix = (lng, lat) => ({ coords: { longitude: lng, latitude: lat, accuracy: 10 } });

/**
 * A stand-in for the half of a GeolocateControl this reaches into: a marker
 * that records every position it is given, and an `_updateMarker` that
 * teleports it exactly as both libraries' does.
 */
function fakeControl() {
  const dot = { at: null, setLngLat(v) { this.at = v; return this; } };
  const circle = { at: null, setLngLat(v) { this.at = v; return this; } };
  return {
    _userLocationDotMarker: dot,
    _accuracyCircleMarker: circle,
    originals: 0,
    _updateMarker(position) {
      this.originals += 1;
      if (!position) { dot.at = null; circle.at = null; return; }
      const at = [position.coords.longitude, position.coords.latitude];
      dot.at = at;
      circle.at = at;
    },
  };
}

console.log('\nHow long a glide lasts');
{
  eq(glideMs(0), 700, 'with no previous fix to go on, a default');
  eq(glideMs(1000), 1000, 'otherwise the gap the last fix took, so the dot arrives as the next lands');
  eq(glideMs(40), 250, 'a burst of fixes is floored');
  eq(glideMs(90000), 2000, 'and a tab that was asleep for a minute is capped');
  eq(glideMs(NaN), 700, 'nonsense is the default rather than a frozen dot');
}

console.log('\nInterpolating two positions');
{
  eq(lerpLngLat([0, 0], [10, 20], 0), [0, 0], 't = 0 is where it started');
  eq(lerpLngLat([0, 0], [10, 20], 1), [10, 20], 't = 1 is where it is going');
  eq(lerpLngLat([0, 0], [10, 20], 0.5), [5, 10], 'and halfway is halfway');
  eq(lerpLngLat([0, 0], [10, 20], 2), [10, 20], 'past the end it stops at the end');

  // Two hundred metres of walking, across the date line.
  const crossed = lerpLngLat([179.999, 0], [-179.999, 0], 0.5);
  check(Math.abs(crossed[0]) >= 179.999,
    'the antimeridian is crossed the short way', `got ${crossed[0]}`);
  near(metresBetween([179.999, 0], [-179.999, 0]), 223, 5,
    'and the two are a street apart, not a planet');
  near(metresBetween([7.44, 46.94], [7.44, 46.95]), 1113, 5, 'a hundredth of a degree of latitude');
  eq(metresBetween([7.44, 46.94], [7.44, 46.94]), 0, 'and a dot that has not moved has not moved');
}

console.log('\nThe dot, fix by fix');
{
  const control = fakeControl();
  const undo = smoothLocationDot(control);

  control._updateMarker(fix(7.4400, 46.9400));
  eq(control._userLocationDotMarker.at, [7.44, 46.94], 'the first fix appears where it is');
  eq(frames.length, 0, 'with nothing left running');

  // Twenty metres north, a second later — a person walking.
  clock = 2000;
  control._updateMarker(fix(7.44, 46.94018));
  const started = control._userLocationDotMarker.at;
  eq(started, [7.44, 46.94],
    'the next one leaves the dot where it was, undoing the library\'s jump in the same tick');
  check(control.originals === 2, 'though the original still ran, because it owns the markers');
  check(frames.length === 1, 'and a frame is booked to move it');

  tick(2350); // just under halfway through the 1000ms glide
  const half = control._userLocationDotMarker.at[1];
  check(half > 46.94 && half < 46.94018, 'partway through, the dot is partway there', `got ${half}`);
  eq(control._accuracyCircleMarker.at, control._userLocationDotMarker.at,
    'and the accuracy circle is wherever the dot is');

  tick(3000);
  eq(control._userLocationDotMarker.at, [7.44, 46.94018], 'at the end it is exactly on the fix');
  tick(3200);
  eq(frames.length, 0, 'and nothing is left running');

  // Half a kilometre — still movement, if a fast one.
  clock = 4000;
  control._updateMarker(fix(7.44, 46.9445));
  eq(control._userLocationDotMarker.at, [7.44, 46.94018], 'a fix five hundred metres away still glides');
  frames.length = 0;

  // Ten kilometres is not.
  clock = 5000;
  control._updateMarker(fix(7.44, 47.05));
  eq(control._userLocationDotMarker.at, [7.44, 47.05], 'ten kilometres away is a different place, and snaps');
  eq(frames.length, 0, 'with no glide across the canton');

  // The dot being taken off the map, then coming back.
  control._updateMarker(null);
  eq(control._userLocationDotMarker.at, null, 'a null fix takes the dot off');
  clock = 6000;
  control._updateMarker(fix(7.44, 47.05));
  eq(control._userLocationDotMarker.at, [7.44, 47.05], 'and the one after it appears rather than slides in');

  undo();
  clock = 7000;
  control._updateMarker(fix(7.5, 47.1));
  eq(control._userLocationDotMarker.at, [7.5, 47.1], 'undone, the control teleports again exactly as it did');
  eq(frames.length, 0, 'and books no frames of ours');
}

console.log('\nA control this does not recognise is left alone');
{
  const bare = {};
  const undo = smoothLocationDot(bare);
  eq(Object.keys(bare), [], 'nothing is written onto a control with no _updateMarker');
  undo();
  eq(typeof installGlide({}, {}), 'function', 'and installing both halves on one is still safe');
}

console.log('\nThe camera that follows a lock');
{
  const eased = [];
  const flown = [];
  // The centre moves, because every camera move here is measured against where
  // the camera already is — a fixed centre would make the second fix of a walk
  // look like an arrival for no reason other than the stub.
  let center = [7.44, 46.94];
  let easing = false;
  const map = {
    getCenter: () => center,
    project: ([lng, lat]) => ({ x: lng * 100000, y: -lat * 100000 }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    isEasing: () => easing,
    easeTo: (options, eventData) => {
      eased.push({ options, eventData });
      center = options.center;
    },
  };
  const control = {
    _updateCamera(position) {
      flown.push(position.coords.latitude);
      center = [position.coords.longitude, position.coords.latitude];
    },
  };
  smoothLocationCamera(control, map);

  // The first fix of a session, two metres off the centre of the screen. Near
  // enough to be a step of a walk by distance, and an arrival all the same: this
  // is the load where the camera was already zooming into an IP guess of the
  // right city, and easing to the fix cancelled the zoom mid-flight.
  clock = 1000;
  control._updateCamera(fix(7.44, 46.9402));
  eq(flown.length, 1, 'the first fix is an arrival however near it lands');
  eq(eased.length, 0, 'so the opening flight is the library\'s, zoom and all');

  // …and the one after it, a second later, is the walk.
  clock = 2000;
  control._updateCamera(fix(7.44, 46.9403));
  eq(flown.length, 1, 'a step of a walk is not handed to fitBounds');
  eq(eased.length, 1, 'it is eased');
  eq(eased[0].eventData, { geolocateSource: true },
    'and flagged as the control\'s own move, or tracking would switch itself off');
  eq(eased[0].options.center, [7.44, 46.9403], 'onto the fix');
  eq(eased[0].options.easing(0.25), 0.25, 'with a linear ease, so the ground slides at one speed');
  check(!('zoom' in eased[0].options), 'and the zoom is left where the viewer put it');

  // Half the country away: arriving.
  clock = 3000;
  control._updateCamera(fix(7.44, 48.5));
  eq(flown.length, 2, 'a fix most of a window away is an arrival, and the library flies to it');
  eq(eased.length, 1, 'rather than being eased across the map');

  // A fix landing inside that flight is left alone rather than cutting it short.
  clock = 4000;
  easing = true;
  control._updateCamera(fix(7.44, 48.5001));
  eq(flown.length, 2, 'a fix arriving mid-flight does not restart the flight');
  eq(eased.length, 1, 'nor finish it at walking pace');
  easing = false;
  clock = 5000;
  control._updateCamera(fix(7.44, 48.5002));
  eq(eased.length, 2, 'and following resumes once it has landed');

  // Tracking switched off for a while, then back on: a return, not a step.
  clock = 60000;
  control._updateCamera(fix(7.44, 48.5003));
  eq(flown.length, 3, 'a fix long after the last one is an arrival too');

  // A map that cannot answer yet is the library's problem, not ours.
  const half = { easeTo: () => { throw new Error('too early'); } };
  const early = { _updateCamera() { flown.push('original'); } };
  smoothLocationCamera(early, half);
  early._updateCamera(fix(7.44, 46.94));
  eq(flown.at(-1), 'original', 'a map that cannot project falls back to the original');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
