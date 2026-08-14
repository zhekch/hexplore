// The dot that says where you are, moving the way you actually do.
//
// Both map libraries draw the blue dot the same way and update it the same way:
// a fix arrives from `watchPosition`, `_updateMarker` calls `setLngLat` with it,
// and the dot is *somewhere else* on the next frame. Standing still that reads
// as a twitch — GPS in a city moves ten or twenty metres between fixes with the
// phone on a table — and walking it reads as a hop every second, which is a
// worse description of walking than a line would be.
//
// So the fix is treated as what it is: a report of where you were a moment ago,
// not an instruction to teleport. The dot is moved *towards* it over the time
// the next one is expected to take, which is the interpolation every multiplayer
// game does with the positions it is sent, and for the same reason — the samples
// are late, sparse and truthful, and the thing on screen has to be continuous.
//
// **Two halves, and the second is not optional.** While the control is locked on
// you, the camera is re-centred on every fix as well, and the library does that
// with `fitBounds`, which is a `flyTo` — a zoom-out-and-back swoop, once a
// second, computed for a journey of fifteen metres. A perfectly smooth dot under
// a lurching camera is not a smooth dot. `smoothLocationCamera` follows with a
// linear ease of exactly the same duration instead, so the ground slides under a
// dot that stays where it is, and the zoom is left alone rather than being reset
// to the accuracy fit on every fix.
//
// **Both are wrappers around library internals**, and are written the way this
// app writes those (see `dropLockOnZoom` and `matchMapboxRotation` in
// src/main.js): read the thing before writing it, and leave the control exactly
// as found if it is not there. A MapLibre or Mapbox GL JS that renames
// `_updateMarker` costs the dot its smoothing, which nobody will notice, and
// never the dot itself, which everybody would.

// --- Tuning -------------------------------------------------------------------

// How long the dot takes to reach the fix it was given.
//
// The duration wants to be the gap until the *next* fix, so that the dot arrives
// exactly as its successor lands and the motion never stops. Nothing can know
// that gap, so the previous one stands in for it: `watchPosition` on a phone is
// steady at about a second, and a cadence that changes does so between journeys
// rather than between fixes.
//
// The floor exists because a burst of fixes should not make the dot flicker
// between two of them, and the ceiling because a gap of a minute — a tab that
// was in the background, a walk out of a tunnel — is not a minute of movement to
// draw. Past the ceiling the dot is late rather than smooth, which is the wrong
// trade in the only direction that matters.
const GLIDE_MIN_MS = 250;
const GLIDE_MAX_MS = 2000;
// The first glide of a session has no previous gap to go on.
const GLIDE_DEFAULT_MS = 700;

// Further than this and it is not movement, it is a different place: the first
// fix of a session, a phone that has just found the satellites after being wrong
// by a suburb, a laptop that woke up in another city. A kilometre is an hour's
// walk, a minute's drive and three seconds of a passenger jet, so nothing that
// is genuinely travelling ever crosses it between two fixes — and the one thing
// that does, arriving, should appear where it is rather than sail across the
// map to get there.
const SNAP_M = 1000;

// A camera move longer than this fraction of the window is an arrival, not a
// following step, and the library's own `fitBounds` — which flies, and picks a
// zoom for the accuracy of the fix — is the right thing for it. Measured in
// screen space rather than in metres deliberately: what makes a camera move
// feel like a jump is how far across the window it went, and that is a question
// about the zoom as much as about the ground.
const ARRIVAL_SCREENS = 0.5;

const EARTH_M_PER_DEG = 111320;

// --- The arithmetic, which is the part worth testing --------------------------

/** Fold a longitude difference into (−180, 180]. */
const wrapLng = (deg) => deg - 360 * Math.floor((deg + 180) / 360);

/**
 * How long to take getting from one fix to the next.
 *
 * @param {number} gapMs how long the last fix took to arrive, or 0 if unknown
 */
export function glideMs(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return GLIDE_DEFAULT_MS;
  return Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, gapMs));
}

/**
 * Metres between two `[lng, lat]` pairs, near enough.
 *
 * Equirectangular rather than haversine: this is only ever asked about two
 * consecutive GPS fixes, where the error of the flat approximation is
 * microscopic, and the one thing it is used for is a comparison against a
 * threshold a kilometre wide.
 */
export function metresBetween([lng1, lat1], [lng2, lat2]) {
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = wrapLng(lng2 - lng1) * Math.cos(midLat) * EARTH_M_PER_DEG;
  const dy = (lat2 - lat1) * EARTH_M_PER_DEG;
  return Math.hypot(dx, dy);
}

/**
 * A point `t` of the way from one `[lng, lat]` to another.
 *
 * The longitude is interpolated along the shorter way round, which is the
 * antimeridian: a fix at 179.9° followed by one at −179.9° is two hundred metres
 * of walking, and the naive average of the two numbers is the middle of Africa.
 *
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @param {number} t 0 → from, 1 → to
 */
export function lerpLngLat(from, to, t) {
  const clamped = Math.min(1, Math.max(0, t));
  return [
    wrapLng(from[0] + wrapLng(to[0] - from[0]) * clamped),
    from[1] + (to[1] - from[1]) * clamped,
  ];
}

/** A fix, as `[lng, lat]`, or null if it is not one. */
function coordsOf(position) {
  const lng = position?.coords?.longitude;
  const lat = position?.coords?.latitude;
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());

// --- The dot that would not stop blinking ------------------------------------
//
// A marker on a map with **terrain** on it is dimmed to a fifth while it is
// judged to be behind a hill, and the judging is a knife-edge: Mapbox GL JS
// unprojects the marker's screen position onto the terrain and asks whether that
// point is nearer the camera than nine tenths of the way to the marker itself
// (`_behindTerrain`). A dot standing on the ground *is* the terrain, so the two
// distances are the same number and which one wins is decided by rounding — and
// by which DEM tiles have arrived, since the ground moves as they stream in.
// Every re-evaluation can land the other way, and the dot flicks between full
// strength and a fifth of it.
//
// It shows up on the 3D basemap and nowhere else because that is the only one
// with terrain under it (`setTerrain` in src/mapbox.js); the flat four never run
// the test. And it got much worse when the dot started gliding, because a glide
// re-positions the marker on every animation frame and each of those asks again.
//
// The dot is not in the scene. It is an annotation *about* you drawn on top of
// it — the same argument `selfLit()` in src/gl-engine.js makes for every layer
// this app adds, and it has the same answer here: the ground is not allowed to
// dim it. Both libraries keep the factor as a field, so both are named, and
// setting it on a marker of the other one is a property nothing reads.
const unoccluded = (marker) => {
  marker._occludedOpacity = 1; // Mapbox GL JS
  marker._opacityWhenCovered = '1'; // MapLibre, which stores it as a string
  return marker;
};

// --- The dot ------------------------------------------------------------------

/**
 * Make the control's location dot move to its fixes rather than appear at them.
 *
 * The wrapper still calls the original first, and that is on purpose: the
 * original is what adds the markers to the map, takes them off again when the
 * fix is null, and re-sizes the accuracy circle for the accuracy of this fix.
 * All of that is wanted. Only the *position* it sets is overwritten, put back to
 * where the dot is currently drawn — synchronously, in the same tick, so no
 * frame is ever painted with the jump in it — and then walked forward from
 * there.
 *
 * @param {object} control a GeolocateControl from either library
 * @returns {() => void} undo, restoring the control to how it was found
 */
export function smoothLocationDot(control) {
  const original = control?._updateMarker;
  if (typeof original !== 'function') return () => {};

  let shown = null; // where the dot is drawn, [lng, lat]
  let from = null;
  let to = null;
  let startedAt = 0;
  let duration = 0;
  let fixAt = 0;
  let frame = 0;

  // Read per frame rather than captured: the control builds these behind an
  // async permission check, so they do not exist when this is installed.
  const markers = () => [control._userLocationDotMarker, control._accuracyCircleMarker]
    .filter((m) => typeof m?.setLngLat === 'function')
    .map(unoccluded);

  const draw = (at) => {
    shown = at;
    for (const marker of markers()) marker.setLngLat(at);
  };

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const step = () => {
    frame = 0;
    // Linear, and it is the whole point. An ease-out would decelerate into every
    // fix and start again at the next, which turns a steady walk into a series
    // of arrivals; the camera below is eased the same way for the same reason.
    const t = duration > 0 ? (now() - startedAt) / duration : 1;
    draw(t >= 1 ? to : lerpLngLat(from, to, t));
    if (t < 1) frame = requestAnimationFrame(step);
  };

  control._updateMarker = (position) => {
    original.call(control, position);
    const at = coordsOf(position);
    if (!at) {
      // The dot has just been taken off the map. Nothing to catch up to, and
      // the next fix has to arrive where it is rather than sail in from where
      // this one left off.
      stop();
      shown = null;
      return;
    }
    const at0 = now();
    const gap = fixAt ? at0 - fixAt : 0;
    fixAt = at0;
    if (!shown || metresBetween(shown, at) > SNAP_M) {
      stop();
      draw(at);
      return;
    }
    from = shown;
    to = at;
    startedAt = at0;
    duration = glideMs(gap);
    stop();
    step(); // synchronously, which is what undoes the original's jump
  };

  return () => {
    stop();
    control._updateMarker = original;
  };
}

// --- The camera that follows it -------------------------------------------------

/**
 * Follow a locked-on dot by sliding rather than by flying.
 *
 * Only while the control is in its locked state — the library calls this from
 * nowhere else — and only for the steps that are plausibly *following*. An
 * arrival, which is the press of the button that re-centres on you and the first
 * fix of a session, is handed straight back to the original: that move is meant
 * to be seen, and the library's `fitBounds` also picks the zoom for it, which is
 * exactly right once and exactly wrong every second.
 *
 * **The first fix is an arrival by the clock, not by the distance**, and that is
 * the half `isArrival` cannot see. A page that has just opened has already put
 * the camera on an *IP guess* — the right city, a few hundred metres out — and
 * is zooming into it (see `flyToIpLocation` in src/main.js). The first real fix
 * then lands well inside half a window, so the distance test called it a step of
 * a walk and eased to it linearly: `easeTo` replaces whatever animation is
 * running, so the opening zoom stopped dead and the map slid the rest of the way
 * at a constant rate with no zoom left in it. That is the load everybody sees,
 * and it is a walking-pace ease being asked to do an arrival's job.
 *
 * So the gap since the last *followed* fix decides it too. Zero means nothing
 * has been followed yet — a fresh page, or a control just switched back on — and
 * anything past `GLIDE_MAX_MS` means tracking has been off or backgrounded long
 * enough that this is a return rather than a step. Both are handed to the
 * library, which flies, and which picks a zoom on the way.
 *
 * And then the flight is **left in the air**. A `flyTo` to your street takes a
 * second or two and the next fix lands inside it, so following would cancel the
 * arrival a third of the way through and finish the journey at walking pace —
 * the same fault as before, arriving a second later. While the library's own
 * move is still running the camera is simply not touched; the dot keeps gliding,
 * which is the half of this that was ever visible.
 *
 * `geolocateSource` is not decoration. Both libraries watch their own map for
 * movement and drop out of the locked state when they see some, unless the move
 * carries that flag — so a camera move made on the control's behalf has to say
 * so, or following you would switch tracking off a second after it started.
 *
 * @param {object} control a GeolocateControl from either library
 * @param {object} map the map it was added to
 * @returns {() => void} undo
 */
export function smoothLocationCamera(control, map) {
  const original = control?._updateCamera;
  if (typeof original !== 'function' || typeof map?.easeTo !== 'function') return () => {};

  let cameraAt = 0;
  let arriving = false; // the library's own flight has not landed yet

  control._updateCamera = (position) => {
    const at = coordsOf(position);
    const at0 = now();
    // Zero until something has been followed, and stale once tracking has been
    // away — see the note above about the opening zoom this used to cancel.
    const gap = cameraAt ? at0 - cameraAt : 0;
    const following = gap > 0 && gap <= GLIDE_MAX_MS;
    cameraAt = at ? at0 : 0;
    if (!at || !following || isArrival(map, at)) {
      arriving = !!at;
      original.call(control, position);
      return;
    }
    // Guarded by name as well as by the flag, because `isEasing` is not in
    // either library's documented surface: a map that has stopped answering
    // reads as "landed", which is how this behaved before the flag existed.
    if (arriving && map.isEasing?.() === true) return;
    arriving = false;
    map.easeTo(
      { center: at, duration: glideMs(gap), easing: (t) => t },
      { geolocateSource: true },
    );
  };

  return () => {
    control._updateCamera = original;
  };
}

/**
 * Is this camera move an arrival rather than a step of a walk?
 *
 * Answered in pixels, against the smaller side of the window, so it means the
 * same thing on a phone and on a desk. Anything the map cannot answer — a
 * projection before the style has parsed, a map mid-rebuild — counts as an
 * arrival, which is the library's own behaviour and so the safe way to be wrong.
 */
function isArrival(map, at) {
  try {
    const here = map.project(map.getCenter());
    const there = map.project(at);
    const canvas = map.getCanvas();
    const across = Math.min(canvas.clientWidth, canvas.clientHeight);
    if (!(across > 0)) return true;
    return Math.hypot(there.x - here.x, there.y - here.y) > across * ARRIVAL_SCREENS;
  } catch {
    return true;
  }
}

/**
 * Both halves, for the one caller that wants both.
 *
 * @param {object} control
 * @param {object} map
 * @returns {() => void} undo
 */
export function installGlide(control, map) {
  const undoDot = smoothLocationDot(control);
  const undoCamera = smoothLocationCamera(control, map);
  return () => {
    undoDot();
    undoCamera();
  };
}
