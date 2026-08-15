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
globalThis.document = {
  createElement: element,
  addEventListener: () => {},
  removeEventListener: () => {},
};

/** Run every frame that is due, at `t` milliseconds. */
function tick(t) {
  clock = t;
  const due = frames.splice(0, frames.length);
  for (const fn of due) fn();
}

const {
  BEAM_CLASS, easeHeading, headingFrom, headingUpOn, installHeading, screenHeading, turnBetween,
  wrapDeg,
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
      at: { lng: 7.44, lat: 46.94 },
      rotationAlignment: 'auto',
      pitchAlignment: 'auto',
      getLngLat() { return this.at; },
      setRotation(v) { this.rotation = v; return this; },
      getRotationAlignment() { return this.rotationAlignment; },
      setRotationAlignment(v) { this.rotationAlignment = v; return this; },
      getPitchAlignment() { return this.pitchAlignment; },
      setPitchAlignment(v) { this.pitchAlignment = v; return this; },
    },
  };
}

/**
 * A map that records what it was asked to do, and projects the dot to wherever
 * the test says it is on screen.
 */
function fakeMap() {
  return {
    eased: [],
    dotAt: { x: 400, y: 300 },
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    project(at) { return at ? this.dotAt : { x: 0, y: 0 }; },
    easeTo(options, eventData) { this.eased.push({ options, eventData }); },
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
  const beam = installHeading(control, '.ctrl-geolocate');
  const undo = beam.stop;
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

console.log('\nTurning the map with you');
{
  const control = fakeControl();
  const map = fakeMap();
  const beam = installHeading(control, '.ctrl-geolocate', map);
  const marker = control._userLocationDotMarker;

  eq(beam.hasCompass(), false, 'before a reading there is no compass to offer');
  eq(headingUpOn(), false, 'and nothing is turning');
  beam.setHeadingUp(true);
  eq(headingUpOn(), false,
    'the mode refuses to switch on without one, so the button cannot advertise it');
  eq(frames.length, 0, 'and books nothing');

  clock = 20000;
  fire({ absolute: true, alpha: -40 });
  eq(beam.hasCompass(), true, 'one reading is enough to offer it');

  beam.setHeadingUp(true);
  eq(headingUpOn(), true, 'switched on');
  eq(frames.length, 1, 'and a frame is booked at once');
  tick(20016);
  eq(map.eased.length, 1, 'the map is aimed in the frame the button was pressed in');
  const aimed = map.eased[0];
  eq(aimed.options.center, { lng: 7.44, lat: 46.94 },
    'centred on where the dot is drawn, not on the fix it is still gliding towards');
  eq(aimed.options.bearing, 40, 'and turned to face the way you are');
  eq(aimed.eventData, { geolocateSource: true },
    'flagged as the control\'s own, or tracking switches itself off a moment later');
  eq(aimed.options.easing(0.25), 0.25, 'with a linear ease, so one turn is one movement');
  eq(marker.rotation, 40,
    'the beam still carries the heading — the library subtracts the bearing, so it points up');

  tick(20100);
  eq(map.eased.length, 1, 'a frame later the camera has not moved: it has a budget');
  tick(20400);
  eq(map.eased.length, 1,
    'and past the budget, standing still with a steady heading still costs nothing');

  // Walking in a straight line: the bearing is unchanged and the dot slides off
  // the middle of the window, which is the other half of staying centred.
  map.dotAt = { x: 430, y: 300 };
  tick(20700);
  eq(map.eased.length, 2, 'the dot drifting off the middle re-aims on its own');
  map.dotAt = { x: 400, y: 300 };

  // Turning on the spot: the position does not change and the bearing does.
  clock = 21000;
  fire({ absolute: true, alpha: -130 });
  for (let t = 21100; t < 23000; t += 100) tick(t);
  check(map.eased.length > 3, 'a turn re-aims repeatedly', `got ${map.eased.length}`);
  near(map.eased.at(-1).options.bearing, 130, 1, 'ending on the heading you turned to');
  check(map.eased.length < 12,
    'and spends a handful of camera moves on it, not one per frame',
    `got ${map.eased.length}`);

  const spent = map.eased.length;
  beam.setHeadingUp(false);
  eq(headingUpOn(), false, 'switched off');
  tick(23200);
  tick(23400);
  eq(map.eased.length, spent, 'the camera is left exactly where it was');
  eq(frames.length, 0, 'and the loop stops rather than idling for ever');

  beam.stop();
  eq(listeners.size, 0, 'and letting go lets go');
}

console.log('\nA control this does not recognise is left alone');
{
  const bare = {};
  const undo = installHeading(bare, '.ctrl-geolocate').stop;
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
  const stop = installHeading(control, '.ctrl-geolocate').stop;
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
    removeEventListener: (type) => clicks.delete(type),
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const press = (hit) => clicks.get('click')?.({ target: { closest: () => (hit ? {} : null) } });

  const fresh = await import('../../src/heading.js?permission');
  const control = fakeControl();
  const undo = fresh.installHeading(control, '.ctrl-geolocate').stop;
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
  const again = fresh.installHeading(fakeControl(), '.ctrl-geolocate').stop;
  eq(asks, 2, 'but a permission already granted is not asked for a second time');
  eq(listeners.size, 1, 'and the compass comes straight back');
  again();
  eq(clicks.size, 0, 'and the gesture listeners come off once they have done their one job');
}

console.log('\nInside the app, where there is no dialog to be careful about');
{
  // The bug: in the app the beam did not appear until the locate button was
  // pressed — a button nobody has any reason to press when the dot is already
  // on the map. The gesture WebKit insists on is a formality there, because
  // `WebPanel.swift` grants without asking, so any touch should satisfy it.
  let asks = 0;
  let grant = false;
  const taps = new Map();
  globalThis.DeviceOrientationEvent = {
    requestPermission() {
      asks += 1;
      return grant ? Promise.resolve('granted') : Promise.reject(new Error('needs a gesture'));
    },
  };
  globalThis.document = {
    createElement: element,
    documentElement: { dataset: { client: 'ios' } },
    addEventListener: (type, fn) => taps.set(type, fn),
    removeEventListener: (type) => taps.delete(type),
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const elsewhere = { target: { closest: () => null } };

  const fresh = await import('../../src/heading.js?ios');
  const stop = fresh.installHeading(fakeControl(), '.ctrl-geolocate').stop;
  await flush();
  eq(asks, 1, 'still asked once on the way in');
  eq(listeners.size, 0, 'and still rejected, because WebKit wants a gesture either way');

  check(taps.has('touchend'),
    'a drag of the map is a gesture that produces no click at all, so touchend is listened for too');

  grant = true;
  taps.get('touchend')(elsewhere);
  eq(asks, 2, 'and a touch anywhere is enough — it is not a question anybody is answering');
  await flush();
  eq(listeners.size, 1, 'so the beam is there by the time you have looked at the map');
  stop();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
