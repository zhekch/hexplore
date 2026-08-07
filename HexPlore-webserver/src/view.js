// What ground the camera can see.
//
// Everything this map draws over the basemap is built for a *rectangle of
// Mercator metres*: the blob sheet is painted into one, the hex geometry is
// generated inside one, the country loader is told which countries fall in one.
// That rectangle used to be `map.getBounds()` grown by a third, which is the
// right answer for exactly one camera — north up, looking straight down — and
// silently the wrong one for any other. It is the single assumption that kept
// the map from being turned.
//
// So the question is asked once, here, in closed form, from the camera itself:
// centre, zoom, bearing, pitch and the size of the window. Turn the map and the
// rectangle turns with it; lean the camera and it becomes the trapezoid of
// ground a leaning camera actually sees, bounded so a lean cannot ask for a
// continent. Nothing downstream has to know which of those happened — it still
// receives a rectangle of Mercator metres, and everything that consumes one
// goes on working.
//
// Two properties are worth stating because the rest of the app leans on them:
//
//   - **Web Mercator is linear in screen space.** One CSS pixel is the same
//     number of Mercator metres everywhere on screen at a given zoom, at every
//     latitude. That is what makes the arithmetic below exact rather than an
//     approximation, and it is why a screen-space margin can be converted to a
//     Mercator one with a multiply.
//   - **At bearing 0 and pitch 0 this returns precisely the box the old code
//     did.** The unturned map is not a special case in here; it is what the
//     general formula collapses to. A change to how the map is framed should
//     never be able to arrive by accident on a map nobody has turned.
//
// Pure: no DOM, no MapLibre. `cameraOf` reads a map object by duck typing, and
// is deliberately the only place in the app that asks a map for its camera —
// which is what makes swapping the library underneath (Mapbox, for the 3D
// basemaps) a change to one function rather than a search through main.js.
//
// Checked by scripts/test/view.mjs — and, once, against MapLibre itself: the
// box this returns was compared with the Mercator bounds of `map.unproject()`
// over the four screen corners, at seven bearings and pitches up to 60°, and
// agreed to within 3e-13 relative. That is the check worth repeating in a
// browser if any of the arithmetic below is ever touched, because the unit
// tests can only hold it to its own reasoning; MapLibre is what actually draws
// the frame. It is also what caught `transform.fov` being published in degrees
// while this file wanted radians — an error of a factor of 57 that no unpitched
// camera can see, because the camera distance it feeds cancels out at pitch 0.
//
// Note that once PITCH_REACH binds — a hard lean — the box is deliberately
// *smaller* than what the camera can see, so the two stop agreeing. That is the
// clamp doing its job, not a discrepancy.

import { WORLD, MAX_MERC_Y, mercX, mercY, lngOf, latOf } from './hexgrid.js';

/**
 * Vertical field of view, in radians — MapLibre's default, and Mapbox's.
 *
 * Only a pitched camera can tell the difference. It sets how far up the screen
 * the horizon falls, and therefore how much ground the top of a leaning view
 * covers; at pitch 0 the camera distance it feeds cancels out of every formula
 * below, which is worth knowing because it means an unpitched map cannot catch
 * a mistake in it. This one was a mistake in it: both libraries publish
 * `transform.fov` in **degrees** and hold `_fov` in radians, so reading the
 * public number and treating it as radians is wrong by a factor of 57 and
 * invisible until something leans.
 */
export const DEFAULT_FOV = 0.6435011087932844; // 36.87°

/**
 * The camera's field of view in radians, whatever units the map offers it in.
 *
 * `transform` is not public API in either library, so all of this is
 * best-effort and falls back to the value they both ship.
 */
function fovRadiansOf(map) {
  const t = map?.transform;
  if (Number.isFinite(t?.fovInRadians)) return t.fovInRadians;
  // Published in degrees. Guarded by magnitude as well as by name, because a
  // library that switched units would otherwise be a silent factor of 57.
  if (Number.isFinite(t?.fov) && t.fov > 0) {
    return t.fov > Math.PI ? (t.fov * Math.PI) / 180 : t.fov;
  }
  return DEFAULT_FOV;
}

/**
 * How far in front of the camera the ground is still painted, in screen
 * heights, measured from the centre of the view.
 *
 * A camera looking straight down sees one screen height of ground and this
 * never binds. A camera leaning toward the horizon sees an unbounded amount:
 * the trapezoid's far edge runs away to infinity as the pitch approaches the
 * horizon, and the sheet painted for it would be a continent rendered at the
 * density of a street. Every renderer downstream is priced per Mercator metre,
 * so the honest thing is to stop somewhere and say where.
 *
 * Three screen heights is roughly the ground a 60° lean puts in the upper
 * third of the window — far enough that the cut-off is past anything being
 * looked *at*, near enough that a lean costs a few times the paint rather than
 * a hundred times it. Past it the wash simply is not drawn; the basemap
 * continues to the horizon on its own.
 */
export const PITCH_REACH = 3;

/** Mercator metres per CSS pixel. MapLibre's world is 512·2^zoom pixels wide. */
export const mercPerPixel = (zoom) => WORLD / (512 * 2 ** zoom);

/**
 * The camera, as the six numbers this module needs, read off a map object.
 *
 * Duck-typed on purpose: MapLibre and Mapbox agree on every one of these
 * getters, so the same call works against either and the rest of the app never
 * touches the camera directly.
 *
 * @param {object} map
 * @returns {{lng:number, lat:number, zoom:number, bearing:number, pitch:number,
 *            width:number, height:number, fov:number}}
 */
export function cameraOf(map) {
  const c = map.getCenter();
  const canvas = map.getCanvas?.();
  // The drawing buffer is in device pixels and the camera is in CSS ones, so
  // the size comes from the container's box rather than from canvas.width.
  const w = canvas?.clientWidth || map.getContainer?.().clientWidth || 1;
  const h = canvas?.clientHeight || map.getContainer?.().clientHeight || 1;
  return {
    lng: c.lng,
    lat: c.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing?.() ?? 0,
    pitch: map.getPitch?.() ?? 0,
    width: w,
    height: h,
    fov: fovRadiansOf(map),
  };
}

/**
 * The rectangle of Mercator metres the camera can see, padded by `pad` screen
 * heights and widths per side.
 *
 * The maths, in one paragraph. Put the camera at the origin looking down its
 * own -z, screen point (x, y) sitting at z = -d where d is the distance from
 * the camera to the middle of the map (`0.5·height / tan(fov/2)`, in pixels).
 * Pitch θ tips that ray back from vertical, so the camera stands at height
 * d·cos θ and d·sin θ behind the centre point. Intersecting the ray with the
 * ground plane gives, in the same pixel units the camera is measured in:
 *
 *     scale(y) = d·cos θ / (d·cos θ − y·sin θ)      lateral stretch at row y
 *     forward(y) = d·y   / (d·cos θ − y·sin θ)      ground distance from centre
 *
 * At θ = 0 both collapse to `1` and `y` — the screen rectangle, unchanged — and
 * the denominator vanishing is the horizon. The four corners of the padded
 * screen rectangle are pushed through that, rotated by the bearing, and the box
 * around the result is what comes back.
 *
 * @param {ReturnType<cameraOf>} camera
 * @param {number} [pad] extra coverage per side, as a fraction of the viewport
 * @returns {{xMin:number, xMax:number, yMin:number, yMax:number}} Mercator metres
 */
export function groundBox(camera, pad = 0) {
  const { lng, lat, zoom, width, height } = camera;
  const m = mercPerPixel(zoom);
  // Clamped to MapLibre's own ceiling, which is also the ceiling on the maths:
  // at 90° the camera is looking along the ground and the trapezoid has no far
  // edge at all. Both libraries refuse to go there, so this only ever catches a
  // caller passing a number straight in.
  const theta = (Math.min(85, Math.max(0, camera.pitch ?? 0)) * Math.PI) / 180;
  const bearing = ((camera.bearing ?? 0) * Math.PI) / 180;
  const fov = camera.fov ?? DEFAULT_FOV;

  // The padded screen rectangle, in CSS pixels, centred on the camera's centre.
  const halfW = (width * (1 + 2 * pad)) / 2;
  const halfH = (height * (1 + 2 * pad)) / 2;

  // Distance from the camera to the point it is centred on, in those same
  // pixels — which is what lets one number carry both the perspective and the
  // scale. `height` and not the padded height: the field of view describes the
  // window, not the margin we chose to paint outside it.
  const d = (0.5 * height) / Math.tan(fov / 2);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dc = d * cos;

  // How far up the screen the ground is still painted. Two limits, whichever
  // bites first: the top of the padded window, and PITCH_REACH screen heights
  // of ground. Inverting `forward(y) = reach` gives the second directly, and it
  // is finite for every pitch below the horizon — which is what keeps a lean
  // from asking for an unbounded rectangle.
  const reach = PITCH_REACH * height;
  const yTop = sin > 0 ? Math.min(halfH, (reach * dc) / (d + reach * sin)) : halfH;

  // The four corners of that trapezoid, in ground pixels: near edge at the
  // bottom of the window, far edge wherever the clamp above put it. `den` is
  // provably positive for both — the near edge only makes it larger, and yTop
  // is below the horizon for every pitch, since reach·sin < d + reach·sin.
  const corners = [];
  for (const y of [-halfH, yTop]) {
    const den = dc - y * sin;
    const scale = dc / den;
    const forward = (d * y) / den;
    corners.push([-halfW * scale, forward], [halfW * scale, forward]);
  }

  // Screen up points at the bearing, so the ground offsets turn with it. The
  // box is symmetric under the sign of either term, but the rotation is written
  // the right way round rather than the convenient way round.
  const cb = Math.cos(bearing);
  const sb = Math.sin(bearing);
  const cx = mercX(lng);
  const cy = mercY(lat);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [gx, gy] of corners) {
    const x = cx + (gx * cb + gy * sb) * m;
    const y = cy + (-gx * sb + gy * cb) * m;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  return {
    xMin,
    xMax,
    yMin: Math.max(-MAX_MERC_Y, yMin),
    yMax: Math.min(MAX_MERC_Y, yMax),
  };
}

/**
 * The same box as `[west, south, east, north]`, which is what the country and
 * region loaders ask in.
 *
 * Longitudes are not wrapped: a view straddling the antimeridian comes back
 * with a west past -180 or an east past +180, which is the form that stays
 * comparable. Anything matching against it has to be doing so in the same
 * unwrapped space — see `countriesInView`.
 */
export function lngLatBox(box) {
  return [lngOf(box.xMin), latOf(box.yMin), lngOf(box.xMax), latOf(box.yMax)];
}

/** Whether `inner` lies entirely within `outer`. Both Mercator boxes. */
export function boxContains(outer, inner) {
  return (
    inner.xMin >= outer.xMin &&
    inner.xMax <= outer.xMax &&
    inner.yMin >= outer.yMin &&
    inner.yMax <= outer.yMax
  );
}
