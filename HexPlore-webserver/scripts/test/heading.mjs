// The beam that says which way you are facing.
//
// Four things here are ways to get a compass wrong, and all four are invisible
// from the code — a beam pointing ninety degrees off looks exactly as
// deliberate as one pointing the right way, and there is no error anywhere:
//
//   - **a reading that is not a compass.** Plain `deviceorientation` reports
//     alpha relative to wherever the device happened to be when the page
//     loaded. It is a number in degrees that looks precisely like a heading and
//     means nothing, and taking it points the beam at whichever way the phone
//     was lying when the tab opened.
//   - **due north.** `webkitCompassHeading` of exactly 0 is a heading, and a
//     truth test on it — which is what Mapbox GL JS's own version does — falls
//     through to the branch above.
//   - **the screen, which turns and takes the map with it while the device
//     frame stays where it is.** A phone in landscape reports a heading ninety
//     degrees from the one the map is drawn in, and the sign of the correction
//     is a coin toss that is wrong half the time.
//   - **the wrap.** Easing from 350° to 10° is twenty degrees clockwise, and
//     the arithmetic that does not know it sweeps three hundred and forty the
//     other way, once per revolution, in front of somebody turning on the spot.
//
//   node scripts/test/heading.mjs

// A clock, a frame queue and just enough of a window and a document, installed
// before the module is imported because it reads all of them at call time.
let clock = 1000;
const frames = [];
const listeners = new Map();
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (fn) => frames.push(fn) && frames.length;
globalThis.cancelAnimationFrame = () => { frames.length = 0; };
globalThis.addEventListener = (type, fn) => listeners.set(type, fn);
globalThis.removeEventListener = (type) => listeners.delete(type);
globalThis.screen = { orientation: { angle: 0 } };

/** A DOM node, to the extent this file touches one. */
function element() {
  return {
    className: '',
    children: [],
    parent: null,
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    querySelector(selector) {
      const want = selector.replace(/^\./, '');
      return this.children.find((c) => c.className === want) ?? null;
    },
    remove() {
      const at = this.parent?.children.indexOf(this) ?? -1;
      if (at >= 0) this.parent.children.splice(at, 1);
    },
  };
}
globalThis.document = { createElement: element, addEventListener: () => {} };

/** Run every frame that is due, at `t` milliseconds. */
function tick(t) {
  clock = t;
  const due = frames.splice(0, frames.length);
  for (const fn of due) fn();
}

const {
  BEAM_CLASS, easeHeading, headingFrom, installHeading, screenHeading, turnBetween, wrapDeg,
} = await import('../../src/heading.js');

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

/** Whatever the module last asked the window to listen to. */
const fire = (event) => {
  const fn = listeners.get('deviceorientationabsolute') ?? listeners.get('deviceorientation');
  if (!fn) throw new Error('nothing is listening for orientation');
  fn(event);
};

/** The half of a GeolocateControl this reaches into. */
function fakeControl() {
  return {
    _dotElement: element(),
    _userLocationDotMarker: {
      rotation: null,
      rotationAlignment: 'auto',
      pitchAlignment: 'auto',
      setRotation(v) { this.rotation = v; return this; },
      getRotationAlignment() { return this.rotationAlignment; },
      setRotationAlignment(v) { this.rotationAlignment = v; return this; },
      getPitchAlignment() { return this.pitchAlignment; },
      setPitchAlignment(v) { this.pitchAlignment = v; return this; },
    },
  };
}

console.log('\nAngles, and the wrap that is the whole difficulty');
{
  eq(wrapDeg(0), 0, 'north is north');
  eq(wrapDeg(360), 0, 'and so is a full turn');
  eq(wrapDeg(-90), 270, 'a negative bearing folds into the circle');
  eq(wrapDeg(730), 10, 'and two turns and ten degrees is ten degrees');

  eq(turnBetween(10, 70), 60, 'sixty degrees clockwise is sixty degrees clockwise');
  eq(turnBetween(70, 10), -60, 'and back again is negative');
  eq(turnBetween(350, 10), 20, 'across north the short way is twenty degrees, not three hundred and forty');
  eq(turnBetween(10, 350), -20, 'and the same the other way');
  eq(turnBetween(0, 180), 180, 'exactly opposite turns clockwise rather than ambiguously');
  eq(turnBetween(45, 45), 0, 'and standing still is standing still');
}

console.log('\nWhat counts as a compass');
{
  eq(headingFrom({ webkitCompassHeading: 90, webkitCompassAccuracy: 15 }), 90,
    'iOS reports a true-north bearing and it is taken as one');
  eq(headingFrom({ webkitCompassHeading: 0, webkitCompassAccuracy: 15 }), 0,
    'due north is a heading, not an absent one — the bug in the library\'s own version');
  eq(headingFrom({ webkitCompassHeading: 90, webkitCompassAccuracy: -1 }), null,
    'a negative accuracy is CoreLocation saying it does not know, and is believed');
  eq(headingFrom({ webkitCompassHeading: 400, webkitCompassAccuracy: 5 }), 40,
    'and whatever arrives is folded into the circle');

  eq(headingFrom({ absolute: true, alpha: 90 }), 270,
    'elsewhere alpha runs anticlockwise from north, so a bearing is its negation');
  eq(headingFrom({ absolute: true, alpha: 0 }), 0, 'with north still at zero');
  eq(headingFrom({ absolute: false, alpha: 90 }), null,
    'a reading that does not claim to be absolute is not a compass, however much it looks like one');
  eq(headingFrom({ alpha: 90 }), null, 'and one that says nothing at all is not either');
  eq(headingFrom({ absolute: true, alpha: null }), null, 'an empty reading is nothing');
  eq(headingFrom(undefined), null, 'as is no reading');
}

console.log('\nThe screen turns and the device frame does not');
{
  eq(screenHeading(90, 0), 90, 'held in portrait, the two agree');
  eq(screenHeading(90, 90), 0,
    'at screen angle 90 the top of the screen is the device\'s left, which is ninety anticlockwise');
  eq(screenHeading(90, 270), 180, 'and the other landscape is the other way');
  eq(screenHeading(90, 180), 270, 'upside down is opposite');
  eq(screenHeading(10, 90), 280, 'the subtraction wraps rather than going negative');
  eq(screenHeading(90, undefined), 90, 'a browser that cannot say is treated as portrait');
}

console.log('\nEasing a heading');
{
  near(easeHeading(10, 70, 120), 47.9, 0.2, 'one time constant closes about two thirds of the turn');
  // The same turn in two halves has to land in the same place, or the filter
  // means something different on a 120 Hz phone from a 60 Hz one.
  const half = easeHeading(10, 70, 60);
  near(easeHeading(half, 70, 60), easeHeading(10, 70, 120), 0.001,
    'and two steps of half the time land exactly where one whole one does');

  near(easeHeading(350, 10, 120), 2.6, 0.2, 'across north it eases the short way');
  eq(easeHeading(10, 70, 0), 70, 'no time elapsed is not a reason to hold still forever');
  eq(easeHeading(10, 70, -5), 70, 'nor is a clock that went backwards');
}

console.log('\nThe beam on the dot');
{
  const control = fakeControl();
  const undo = installHeading(control, '.ctrl-geolocate');
  const marker = control._userLocationDotMarker;

  eq(control._dotElement.children.length, 0, 'nothing is added to a dot before there is a heading');
  eq(marker.rotationAlignment, 'auto', 'and the marker is left exactly as the library built it');

  fire({ absolute: true, alpha: -40 }); // 40° east of north
  eq(control._dotElement.children.length, 1, 'the first reading puts the cone on the dot');
  eq(control._dotElement.children[0].className, BEAM_CLASS, 'under the class the stylesheet draws');
  eq(marker.rotation, 40, 'pointing where the compass says, and not swinging round from north to get there');
  eq(frames.length, 0, 'with no animation for a beam that has only just appeared');
  eq(marker.rotationAlignment, 'map',
    'the marker is aligned to the map, so the library subtracts the bearing itself');
  eq(marker.pitchAlignment, 'map', 'and lies on the ground on a map that is tilted');

  // A phone on a table, wandering.
  fire({ absolute: true, alpha: -40.4 });
  eq(frames.length, 0, 'a reading half a degree away is noise and books no frame');
  eq(marker.rotation, 40, 'and moves nothing');

  // Turning.
  clock = 2000;
  fire({ absolute: true, alpha: -130 });
  eq(marker.rotation, 40, 'a real turn starts from where the beam is');
  eq(frames.length, 1, 'and books a frame to sweep it');

  tick(2120);
  const swept = marker.rotation;
  check(swept > 40 && swept < 130, 'partway through, the beam is partway round', `got ${swept}`);
  near(swept, 96.9, 0.5, 'by one time constant\'s worth');

  for (let t = 2240; t < 4000 && frames.length; t += 120) tick(t);
  eq(marker.rotation, 130, 'and settles exactly on the reading');
  eq(frames.length, 0, 'rather than approaching it forever');

  // The screen turning under a stationary phone.
  globalThis.screen.orientation.angle = 90;
  clock = 5000;
  fire({ absolute: true, alpha: -130 });
  eq(frames.length, 1, 'a landscape screen is ninety degrees of turn even though nothing moved');
  for (let t = 5120; t < 7000 && frames.length; t += 120) tick(t);
  eq(marker.rotation, 40, 'and the beam ends up pointing the same way on the ground');
  globalThis.screen.orientation.angle = 0;

  undo();
  eq(control._dotElement.children.length, 0, 'undone, the cone comes off');
  eq(marker.rotationAlignment, 'auto', 'and the marker is put back the way it was found');
  eq(marker.pitchAlignment, 'auto', 'in both axes');
  eq(marker.rotation, 0, 'facing nowhere in particular again');
  eq(listeners.size, 0, 'with no listener left on the window, which is what a basemap switch leaks');
}

console.log('\nA control this does not recognise is left alone');
{
  const bare = {};
  const undo = installHeading(bare, '.ctrl-geolocate');
  fire({ absolute: true, alpha: -40 });
  eq(Object.keys(bare), [], 'nothing is written onto a control with no dot');
  eq(frames.length, 0, 'and nothing is animated');
  undo();
  eq(listeners.size, 0, 'and it still lets go of the window');

  // A control whose dot has not been built yet — both libraries make theirs
  // behind an async permission check, so the first readings of a session
  // routinely land before there is anything to point.
  const late = fakeControl();
  const marker = late._userLocationDotMarker;
  const control = { _dotElement: null, _userLocationDotMarker: null };
  const stop = installHeading(control, '.ctrl-geolocate');
  fire({ absolute: true, alpha: -40 });
  eq(frames.length, 0, 'a reading with no dot to draw on does nothing');
  control._dotElement = late._dotElement;
  control._userLocationDotMarker = marker;
  clock = 8000;
  fire({ absolute: true, alpha: -70 });
  for (let t = 8120; t < 10000 && frames.length; t += 120) tick(t);
  eq(marker.rotation, 70, 'and the dot is picked up as soon as it exists');
  eq(late._dotElement.children.length, 1, 'cone and all');
  stop();
}

console.log('\nSafari, where the compass is a permission and the permission needs a gesture');
{
  // A second copy of the module, because the one above has already settled its
  // permission on a platform that has none — and this is a test about the state
  // that settling leaves behind.
  let asks = 0;
  let grant = false;
  const clicks = new Map();
  globalThis.DeviceOrientationEvent = {
    requestPermission() {
      asks += 1;
      return grant ? Promise.resolve('granted') : Promise.reject(new Error('needs a gesture'));
    },
  };
  globalThis.document = {
    createElement: element,
    addEventListener: (type, fn) => clicks.set(type, fn),
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const press = (hit) => clicks.get('click')?.({ target: { closest: () => (hit ? {} : null) } });

  const fresh = await import('../../src/heading.js?permission');
  const control = fakeControl();
  const undo = fresh.installHeading(control, '.ctrl-geolocate');
  await flush();
  eq(asks, 1, 'it is asked once on the way in, for a visitor whose grant Safari remembers');
  eq(listeners.size, 0, 'and a rejection outside a gesture leaves nothing listening');

  press(false);
  eq(asks, 1, 'a tap somewhere else on the map raises no dialog about a compass');

  grant = true;
  press(true);
  eq(asks, 2, 'the locate button is the press that asks');
  await flush();
  eq(listeners.size, 1, 'and a yes starts the compass');

  // The bug this exists for: a basemap switch drops the control and builds a new
  // one, so the watcher leaves and comes back. Asking again would be asking
  // without a gesture, which is a rejection — the beam would work until you
  // looked at the 3D map and never again.
  undo();
  eq(listeners.size, 0, 'letting go of the last watcher lets go of the sensor');
  const again = fresh.installHeading(fakeControl(), '.ctrl-geolocate');
  eq(asks, 2, 'but a permission already granted is not asked for a second time');
  eq(listeners.size, 1, 'and the compass comes straight back');
  again();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
