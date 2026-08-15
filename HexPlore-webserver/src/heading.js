// Which way you are facing, as a beam out of the blue dot.
//
// The dot says where you are and nothing else, which is half of what a map is
// asked while you are standing in the street holding it. The other half is
// *which way am I pointing* — the thing every phone map answers with a cone of
// light out of the dot, and the reason people turn on the spot with a phone in
// their hand rather than reading the street names.
//
// **It is a phone feature because it is a magnetometer feature.** Nothing here
// asks what kind of device this is: a heading is taken only from a reading that
// says it is absolute — `webkitCompassHeading` on iOS, `absolute === true`
// everywhere else — and a laptop has no compass to produce one with. So the beam
// appears on the devices that can honestly draw it and is silently absent on the
// rest, with no user-agent test anywhere and nothing to keep in step with the
// next generation of hardware.
//
// **Mapbox GL JS has `showUserHeading` and MapLibre has nothing at all**, so
// neither library's version is usable here: this app switches between the two
// while it is running (see src/gl-engine.js), and a beam that exists on one
// basemap and not on the other four is worse than no beam. What follows is one
// implementation driven onto whichever control is live, the same way
// src/glide.js drives one dot-smoother onto both.
//
// The shape itself is CSS — `.hexplore-user-heading` in src/style.css. This file
// decides where it points.

// --- Tuning -------------------------------------------------------------------

// How quickly the beam catches up with the compass, as the time constant of an
// exponential ease: after `HEADING_TAU_MS` it has closed about 63% of the turn.
//
// A compass is *noisy* in a way GPS is not. A phone lying still reports a
// heading that wanders a couple of degrees at 60 Hz, and pointing a 90 px beam
// straight at each reading makes it shiver — the one thing that reads as
// "broken" rather than "imprecise". Low-passing it costs a fraction of a second
// of lag on a real turn, which nobody can see, and removes all of the shiver,
// which everybody can.
//
// Exponential rather than the linear glide the dot gets, and the difference is
// the input. A position arrives once a second and the honest thing to do
// between two of them is walk the line. A heading arrives sixty times a second
// and is *already* a stream — there is nothing to interpolate across, only
// noise to reject — so this is a filter, not an interpolation.
const HEADING_TAU_MS = 120;

// A new reading has to differ from the one being aimed at by this much before it
// is aimed at instead. Purely so that a phone on a table stops booking animation
// frames: under the threshold the reading is noise, and the beam is already
// pointing where it says.
const HEADING_STEP_DEG = 1;

// …and the beam stops when it is this close, rather than approaching forever.
// An exponential ease never arrives, and a marker that re-projects itself on
// every frame for the last quarter of a degree is a frame budget spent on
// nothing.
const HEADING_STOP_DEG = 0.25;

// --- The arithmetic, which is the part worth testing --------------------------

/** Fold an angle into [0, 360). */
export const wrapDeg = (deg) => ((deg % 360) + 360) % 360;

/**
 * The shorter way round from one bearing to another, signed.
 *
 * Positive is clockwise. Returned in (−180, 180], so easing towards 350° from
 * 10° turns twenty degrees anticlockwise rather than three hundred and forty the
 * other way — which is the whole reason angles cannot be low-passed as numbers.
 */
export function turnBetween(from, to) {
  const delta = wrapDeg(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/**
 * The compass bearing a device orientation event is reporting, or null.
 *
 * Null means "this is not a compass", and it is the common answer: a desktop
 * with no magnetometer, a phone whose sensor has not settled, and every
 * `deviceorientation` event on hardware that can only report rotation relative
 * to wherever it happened to be when the page loaded.
 *
 * **iOS is the special case and it is the good one.** WebKit exposes
 * `webkitCompassHeading`, which is CoreLocation's true-north heading — already a
 * bearing, already corrected for magnetic declination, and alongside a
 * `webkitCompassAccuracy` that goes *negative* to say the reading means nothing
 * (a magnetometer still settling, or a phone that has just been next to a
 * speaker magnet). That is the one signal here that can say "I do not know", and
 * ignoring it would point the beam confidently at a wrong street.
 *
 * Everywhere else the reading is `alpha`, which is a rotation about the vertical
 * axis measured **anticlockwise** from north — so a bearing is its negation.
 * `absolute` is what says north is involved at all, and it is not optional:
 * plain `deviceorientation` on most hardware reports alpha relative to the
 * device's orientation at page load, which is a number that looks exactly like a
 * heading and points nowhere. Where the reading is absolute it is generally
 * *magnetic* north rather than true north, a few degrees out in most of the
 * world; that is smaller than the beam is wide and there is nothing here that
 * could correct it.
 *
 * Note `Number.isFinite` rather than a truth test on `webkitCompassHeading`,
 * which is what Mapbox GL JS's own version does: a heading of exactly 0 is due
 * north, and treating it as absent falls through to the alpha branch and reports
 * whichever way the phone was pointing when the tab opened.
 *
 * @param {DeviceOrientationEvent} event
 * @returns {number|null} degrees clockwise from north, or null
 */
export function headingFrom(event) {
  const webkit = event?.webkitCompassHeading;
  if (Number.isFinite(webkit)) {
    const accuracy = event.webkitCompassAccuracy;
    if (Number.isFinite(accuracy) && accuracy < 0) return null;
    return wrapDeg(webkit);
  }
  if (event?.absolute !== true || !Number.isFinite(event.alpha)) return null;
  return wrapDeg(-event.alpha);
}

/**
 * The same bearing, for the top of the *screen* rather than the top of the
 * device.
 *
 * A compass reports the direction the device's natural top edge is pointing, and
 * that frame does not turn when the screen does — so a phone held in landscape
 * reports a heading ninety degrees away from the one the map is drawn in, and
 * the beam points across the street instead of along it.
 *
 * `screen.orientation.angle` is the bridge, and the sign is worth writing down
 * because it is a coin toss that is wrong half the time. At angle 90 the screen
 * axes map onto the device's as (screen x → device y, screen y → device −x) —
 * this is the same remapping Android's own compass code does for
 * `ROTATION_90` — so screen-up is the device's −x, which is ninety degrees
 * *anticlockwise* of the device's top. Hence a subtraction, and hence 180 and
 * 270 falling out of the same expression rather than needing a table.
 *
 * A browser too old to have `screen.orientation` is treated as portrait, which
 * is right for the case it is nearly always in and wrong by ninety degrees for a
 * case it cannot report anyway.
 *
 * @param {number} deviceHeading bearing of the device's natural top edge
 * @param {number} screenAngle degrees the screen is rotated from natural
 */
export const screenHeading = (deviceHeading, screenAngle) =>
  wrapDeg(deviceHeading - (Number.isFinite(screenAngle) ? screenAngle : 0));

/**
 * One step of the low-pass, framerate-independent.
 *
 * The naive `shown += (target - shown) * 0.2` per frame is a filter whose
 * strength depends on how often it happens to run, so it behaves differently on
 * a 120 Hz phone, on a 60 Hz one, and on a tab that has just come back from the
 * background. Deriving the coefficient from the elapsed time instead makes the
 * time constant mean the same thing everywhere.
 *
 * @param {number} shown where the beam points now
 * @param {number} target where the compass says
 * @param {number} dtMs since the last step
 * @param {number} [tauMs]
 */
export function easeHeading(shown, target, dtMs, tauMs = HEADING_TAU_MS) {
  if (!(dtMs > 0) || !(tauMs > 0)) return wrapDeg(target);
  return wrapDeg(shown + turnBetween(shown, target) * (1 - Math.exp(-dtMs / tauMs)));
}

// --- Where the reading comes from ---------------------------------------------

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());

/** How far the screen is turned from the device's natural orientation. */
const screenAngle = () => {
  const angle = globalThis.screen?.orientation?.angle;
  return Number.isFinite(angle) ? angle : 0;
};

// `deviceorientationabsolute` where it exists, because it is the event that
// promises north; `deviceorientation` otherwise, which is what iOS fires and
// what carries `webkitCompassHeading`. Chrome fires both and only the first is
// a compass, so preferring it is not merely a fallback order.
const eventName = () =>
  ('ondeviceorientationabsolute' in globalThis ? 'deviceorientationabsolute' : 'deviceorientation');

// One listener for the page, however many maps are built on top of it. A basemap
// switch throws the control and its dot away and makes new ones (see
// `switchEngine` in src/main.js), and a window listener per switch would be a
// leak that grew every time somebody looked at the 3D map.
const watchers = new Set();
let listening = false;
let armed = false;
// Whether the browser has said yes — remembered separately from `listening`,
// because the two come apart on a basemap switch. The last watcher leaving takes
// the listener off, the new control puts one back a moment later, and asking
// Safari for the permission a second time *outside a gesture* is a rejection:
// the beam would work until you looked at the 3D map and never again.
let granted = false;

function onOrientation(event) {
  const device = headingFrom(event);
  if (device === null) return;
  const heading = screenHeading(device, screenAngle());
  for (const watcher of watchers) watcher(heading);
}

function listen() {
  granted = true;
  if (listening) return;
  listening = true;
  globalThis.addEventListener?.(eventName(), onOrientation);
}

/**
 * Ask for the compass, on the two very different terms browsers offer it.
 *
 * Most of them simply deliver it. **Safari makes it a permission and makes that
 * permission require a user gesture**, which is the whole reason this is a
 * function rather than a line in `listen()`: `DeviceOrientationEvent
 * .requestPermission()` outside a click is rejected, and a rejection is not a
 * refusal — the same call inside one still raises the prompt. So it is tried
 * once on the way in, for the returning visitor whose grant Safari has
 * remembered, and armed on the locate button for everyone else.
 *
 * **The locate button is the right gesture and not just an available one.** It
 * is the press that means "where am I", it is the press that has already been
 * given the map's other prompt, and it is the only control on this page the
 * question is about. Raising a Motion & Orientation dialog over the map on some
 * unrelated tap would be a prompt nobody asked for, about a feature they had not
 * seen yet.
 */
function askForCompass() {
  if (listening) return;
  const request = globalThis.DeviceOrientationEvent?.requestPermission;
  // A browser that has already agreed, or that never needed to be asked.
  if (granted || typeof request !== 'function') {
    listen();
    return;
  }
  let pending;
  try {
    // **Synchronously**, and that is the whole of why this is not wrapped in a
    // `Promise.resolve().then(…)`: what makes a call count as a gesture is being
    // made while the click is still on the stack, and a microtask is the far
    // side of that. Called on the constructor rather than bare, because WebKit's
    // implementation is a method and loses `this` otherwise.
    pending = request.call(globalThis.DeviceOrientationEvent);
  } catch {
    return;
  }
  Promise.resolve(pending)
    .then((response) => {
      if (response === 'granted') listen();
    })
    .catch(() => {
      // No gesture yet, or refused. Either way there is nothing to say: a map
      // that draws no beam looks exactly like a map that never had one, which
      // is the correct amount of noise for a feature nobody switched on.
    });
}

/**
 * Try now, and try again on the press that means it.
 *
 * Registered once for the page, on the document, in the capture phase — the same
 * shape and for the same reason as `keepGeolocateOn` in src/main.js: the button
 * belongs to the map library, one library builds it inside `onAdd` and the other
 * behind an async permission check, and a `querySelector` beside the
 * `addControl` finds it under exactly one of them.
 *
 * @param {string} buttonSelector matches the locate button under either library
 */
function armCompass(buttonSelector) {
  askForCompass();
  if (armed || typeof document === 'undefined') return;
  armed = true;
  document.addEventListener('click', (e) => {
    if (listening || !e.target?.closest?.(buttonSelector)) return;
    // Synchronously inside the handler, because that is what makes it a gesture.
    askForCompass();
  }, true);
}

/**
 * Watch the compass, for as long as somebody is looking.
 *
 * @param {(heading: number) => void} fn called with degrees clockwise from north
 * @param {string} buttonSelector matches the locate button under either library
 * @returns {() => void} stop
 */
export function watchHeading(fn, buttonSelector) {
  watchers.add(fn);
  armCompass(buttonSelector);
  return () => {
    watchers.delete(fn);
    if (watchers.size || !listening) return;
    listening = false;
    globalThis.removeEventListener?.(eventName(), onOrientation);
  };
}

// --- The beam -----------------------------------------------------------------

/** The class src/style.css draws the cone with. */
export const BEAM_CLASS = 'hexplore-user-heading';

/**
 * Point the location dot the way the compass is pointing.
 *
 * Two things happen the first time a heading arrives, and neither of them
 * before: the cone is added to the dot's element, and the marker is told to
 * align itself to the **map** rather than to the screen, in rotation and in
 * pitch. That
 * alignment is what makes "north-east" mean north-east on a map that has been
 * turned or tilted — the library subtracts the bearing and applies the pitch
 * itself, so the beam lies on the ground the way a shadow would.
 *
 * Deferring it matters. Aligning to the map is also what flattens the dot into
 * an ellipse on a pitched map, and a device with no compass should look exactly
 * as it did before this file existed. Mapbox GL JS's own dot is built this way
 * from the start, which is the same choice made a step earlier; MapLibre's is
 * not, and is left alone until there is something to point.
 *
 * Everything here is read before it is written, like `smoothLocationDot` and
 * `dropLockOnZoom`: a library that has renamed `_userLocationDotMarker` or
 * dropped `setRotation` costs the beam and never the dot.
 *
 * @param {object} control a GeolocateControl from either library
 * @param {string} buttonSelector matches its button under either library
 * @returns {() => void} undo
 */
export function installHeading(control, buttonSelector) {
  let shown = null; // where the beam points, or null before the first reading
  let target = null;
  let steppedAt = 0;
  let frame = 0;
  let drawn = false; // the cone is on the dot
  let found = null; // how the marker was aligned before this touched it

  /** The dot's marker, once the control has built it, and only if it turns. */
  const markerOf = () => {
    const marker = control?._userLocationDotMarker;
    return typeof marker?.setRotation === 'function' ? marker : null;
  };

  /** The cone, added to the dot the first time there is something to point. */
  const addBeam = () => {
    const host = control?._dotElement;
    if (drawn || typeof host?.appendChild !== 'function') return;
    const el = document.createElement('div');
    el.className = BEAM_CLASS;
    host.appendChild(el);
    drawn = true;
  };

  const align = (marker) => {
    if (found) return;
    found = {
      rotation: marker.getRotationAlignment?.() ?? 'auto',
      pitch: marker.getPitchAlignment?.() ?? 'auto',
    };
    marker.setRotationAlignment?.('map');
    marker.setPitchAlignment?.('map');
  };

  // Both halves are retried until they take, because the control builds its dot
  // behind an async permission check: the first readings of a session can easily
  // land before there is anything on the map to point.
  const draw = () => {
    const marker = markerOf();
    if (!marker) return;
    addBeam();
    align(marker);
    marker.setRotation(shown);
  };

  const step = () => {
    frame = 0;
    const at = now();
    shown = easeHeading(shown, target, at - steppedAt);
    steppedAt = at;
    draw();
    if (Math.abs(turnBetween(shown, target)) < HEADING_STOP_DEG) {
      shown = target;
      draw();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const unwatch = watchHeading((heading) => {
    // The first reading is where the beam starts, rather than a turn from north
    // — a beam that swings round from twelve o'clock every time the dot appears
    // is an animation about nothing.
    if (shown === null) {
      shown = heading;
      target = heading;
      draw();
      return;
    }
    if (Math.abs(turnBetween(target, heading)) < HEADING_STEP_DEG) return;
    target = heading;
    if (frame) return;
    steppedAt = now();
    frame = requestAnimationFrame(step);
  }, buttonSelector);

  return () => {
    stop();
    unwatch();
    control?._dotElement?.querySelector?.(`.${BEAM_CLASS}`)?.remove();
    const marker = markerOf();
    if (!marker || !found) return;
    marker.setRotation(0);
    marker.setRotationAlignment?.(found.rotation);
    marker.setPitchAlignment?.(found.pitch);
  };
}
