// What ground the camera can see.
//
//   node scripts/test/view.mjs
//
// Every renderer over the basemap is built for a rectangle of Mercator metres,
// and until the map could be turned that rectangle was `map.getBounds()` grown
// by a third — an answer that is correct for exactly one camera. src/view.js
// replaced it with the general one, and the first thing this file pins is that
// the general one still gives the old answer for the old camera: an unturned
// map must not be reframed by a feature nobody switched on.
//
// The rest is the arithmetic that has no other way of being checked. A rotated
// viewport's bounding box, a leaning camera's trapezoid and the clamp that
// stops it running to the horizon are all closed-form, all silent when wrong —
// a box that is slightly too small paints slightly too little ground, which
// looks like a rendering glitch somewhere else entirely.

import {
  DEFAULT_FOV, PITCH_REACH, boxArea, boxContains, groundBox, lngLatBox, mercPerPixel,
} from '../../src/view.js';
import { MAX_MERC_Y, WORLD, mercX, mercY } from '../../src/hexgrid.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const near = (a, b, tol, label) =>
  check(Math.abs(a - b) <= tol, label, `${a.toFixed(3)} vs ${b.toFixed(3)} (±${tol})`);

/** A camera, with the parts a test does not care about filled in. */
const cam = (o = {}) => ({
  lng: 8, lat: 46.8, zoom: 9, bearing: 0, pitch: 0,
  width: 1440, height: 900, fov: DEFAULT_FOV, ...o,
});

const spanX = (b) => b.xMax - b.xMin;
const spanY = (b) => b.yMax - b.yMin;
const VIEW_PAD = 0.35; // main.js's, so the parity check below is the real one

console.log('\nA map nobody has turned is framed exactly as it always was');
{
  // What paddedMerc() used to be, verbatim, against a getBounds() worked out
  // the way MapLibre works it out for an unrotated camera: the corners of the
  // window, unprojected. Web Mercator is linear in screen space, so that is the
  // centre plus half the window in Mercator metres.
  const c = cam();
  const m = mercPerPixel(c.zoom);
  const oldWay = () => {
    const xMin = mercX(c.lng) - (c.width / 2) * m;
    const xMax = mercX(c.lng) + (c.width / 2) * m;
    const yMin = mercY(c.lat) - (c.height / 2) * m;
    const yMax = mercY(c.lat) + (c.height / 2) * m;
    const px = (xMax - xMin) * VIEW_PAD;
    const py = (yMax - yMin) * VIEW_PAD;
    return {
      xMin: xMin - px,
      xMax: xMax + px,
      yMin: Math.max(-MAX_MERC_Y, yMin - py),
      yMax: Math.min(MAX_MERC_Y, yMax + py),
    };
  };
  const was = oldWay();
  const now = groundBox(c, VIEW_PAD);
  for (const k of ['xMin', 'xMax', 'yMin', 'yMax']) {
    near(now[k], was[k], 1e-6, `${k} is unchanged at bearing 0, pitch 0`);
  }
}

console.log('\nA quarter turn swaps the sides and nothing else');
{
  const flat = groundBox(cam(), 0);
  for (const bearing of [90, 180, 270, -90]) {
    const turned = groundBox(cam({ bearing }), 0);
    const swapped = bearing % 180 !== 0;
    near(spanX(turned), swapped ? spanY(flat) : spanX(flat), 1e-6, `bearing ${bearing}: width`);
    near(spanY(turned), swapped ? spanX(flat) : spanY(flat), 1e-6, `bearing ${bearing}: height`);
  }
  // And it stays centred on the camera, whatever it is turned to.
  for (const bearing of [0, 37, 90, 213]) {
    const b = groundBox(cam({ bearing }), 0);
    near((b.xMin + b.xMax) / 2, mercX(8), 1e-6, `bearing ${bearing}: centred east-west`);
    near((b.yMin + b.yMax) / 2, mercY(46.8), 1e-6, `bearing ${bearing}: centred north-south`);
  }
}

console.log('\nOn the diagonal the box grows by exactly what the geometry owes');
{
  // The smallest north-up box around a W×H rectangle turned by b has sides
  // W|cos b| + H|sin b| and W|sin b| + H|cos b|. That is the whole cost of
  // rotation, and it is worth knowing it is being paid and no more.
  const c = cam({ bearing: 45 });
  const m = mercPerPixel(c.zoom);
  const b = groundBox(c, 0);
  const k = Math.SQRT1_2;
  near(spanX(b), (c.width * k + c.height * k) * m, 1e-6, '45°: width is W·cos + H·sin');
  near(spanY(b), (c.width * k + c.height * k) * m, 1e-6, '45°: height is W·sin + H·cos');

  // A square window is the worst case for the *shape* and it is exactly twice
  // the area. Anything longer than it is wide pays a little more, because the
  // ratio is (W+H)²/2WH — 2 at 1:1, 2.11 at 16:10, 2.67 at 3:1. Worth having
  // written down: the cost of a diagonal map is set by the window, and a very
  // wide one is the case that will find the caps in blob-canvas.js first.
  const sq = { width: 1000, height: 1000 };
  const flat = groundBox(cam({ ...sq }), 0);
  const diag = groundBox(cam({ ...sq, bearing: 45 }), 0);
  near(
    (spanX(diag) * spanY(diag)) / (spanX(flat) * spanY(flat)),
    2, 1e-9, 'a square window on the diagonal costs 2× the area',
  );
  for (const [w, h] of [[1000, 1000], [1440, 900], [1500, 500]]) {
    const one = groundBox(cam({ width: w, height: h }), 0);
    let worst = 0;
    for (let deg = 0; deg < 360; deg += 1) {
      const t = groundBox(cam({ width: w, height: h, bearing: deg }), 0);
      worst = Math.max(worst, (spanX(t) * spanY(t)) / (spanX(one) * spanY(one)));
    }
    near(worst, ((w + h) ** 2) / (2 * w * h), 1e-6, `${w}×${h}: the worst bearing costs (W+H)²/2WH`);
  }
}

console.log('\nThe padding is a margin around the window, not a share of the box');
{
  // Rotation must not compound with the pad: a diagonal map already pays for
  // the bigger box, and charging 35% of *that* on top would make the sheet grow
  // faster than the ground it covers.
  const padded = groundBox(cam({ bearing: 45 }), VIEW_PAD);
  const bare = groundBox(cam({ bearing: 45 }), 0);
  const c = cam();
  const m = mercPerPixel(c.zoom);
  const owed = ((c.width + c.height) * Math.SQRT1_2 * 2 * VIEW_PAD) * m;
  near(spanX(padded) - spanX(bare), owed, 1e-6, '45°: the pad is the window\'s, turned');
}

console.log('\nThe poles are where the world stops');
{
  const b = groundBox(cam({ lat: 84, zoom: 3 }), VIEW_PAD);
  check(b.yMax <= MAX_MERC_Y + 1e-9, 'a view over the pole is clamped at the top');
  check(b.yMin >= -MAX_MERC_Y - 1e-9, 'and at the bottom', `${b.yMin}`);
  const world = groundBox(cam({ lat: 0, zoom: 2, width: 3000, height: 3000 }), VIEW_PAD);
  near(world.yMax, MAX_MERC_Y, 1e-9, 'a whole-world view reaches exactly the clamp');
}

console.log('\nA view across the antimeridian keeps going rather than wrapping');
{
  // Unwrapped on purpose: the hex grid canonicalises columns across world
  // copies and the blob painter draws every copy in the window, so a box that
  // wrapped to [-180, 180] would ask for the wrong half of the screen.
  const b = groundBox(cam({ lng: 179.6, zoom: 8 }), 0);
  check(b.xMax > mercX(180), 'the east edge runs past +180', `${lngLatBox(b)[2].toFixed(2)}°`);
  check(b.xMin < b.xMax, 'and west is still less than east');
  near(spanX(b), 1440 * mercPerPixel(8), 1e-6, 'the span is the window, unchanged');
}

console.log('\nA leaning camera sees a trapezoid, wider at the far end');
{
  const flat = groundBox(cam(), 0);
  const leaned = groundBox(cam({ pitch: 50 }), 0);
  // Pitch pulls the camera up and back, keeping the point under the middle of
  // the screen where it was. Both edges therefore move *away* from that point:
  // the far one a great deal, the near one a little. It is the near edge that
  // is easy to get backwards — a lean looks like it should crop the foreground
  // and it does the opposite, which is why the box has to be asked rather than
  // assumed.
  check(leaned.yMin < flat.yMin, 'the near edge eases out', `${leaned.yMin - flat.yMin}`);
  check(leaned.yMax > flat.yMax, 'the far edge runs out', `${leaned.yMax - flat.yMax}`);
  check(
    flat.yMax - flat.yMin < leaned.yMax - leaned.yMin
      && (leaned.yMin - flat.yMin) ** 2 < (leaned.yMax - flat.yMax) ** 2,
    'and the far edge moves much the further of the two',
  );
  // And wider, because the far edge of a perspective view is wider than the near.
  check(spanX(leaned) > spanX(flat), 'and the whole is wider than the window');

  // Monotone in pitch: more lean is always more ground, never less.
  let last = 0;
  let mono = true;
  for (let p = 0; p <= 80; p += 2) {
    const s = spanY(groundBox(cam({ pitch: p }), 0));
    if (s < last - 1e-6) mono = false;
    last = s;
  }
  check(mono, 'every extra degree of pitch is more ground, never less');

  // Turning a leaning camera turns the trapezoid with it: at bearing 90 the
  // ground that ran north now runs east.
  const east = groundBox(cam({ pitch: 50, bearing: 90 }), 0);
  near(spanX(east), spanY(leaned), 1e-6, 'a turned lean swaps the spans');
  near(spanY(east), spanX(leaned), 1e-6, 'both ways');
}

console.log('\nThe lean stops somewhere, and says where');
{
  // Without the clamp the far edge goes to infinity as the pitch approaches the
  // horizon, and the sheet painted for it is a continent at street density.
  const c = cam({ pitch: 84 });
  const b = groundBox(c, 0);
  const m = mercPerPixel(c.zoom);
  const forward = b.yMax - mercY(c.lat);
  check(Number.isFinite(forward), 'a near-horizon pitch still returns a finite box');
  check(
    forward <= PITCH_REACH * c.height * m + 1e-6,
    'and never reaches further than PITCH_REACH screen heights',
    `${(forward / (c.height * m)).toFixed(2)} heights`,
  );
  // The clamp is a ceiling, not a floor: a gentle lean is under it and is left
  // exactly where the geometry put it.
  const gentle = groundBox(cam({ pitch: 20 }), 0);
  check(
    gentle.yMax - mercY(46.8) < PITCH_REACH * 900 * mercPerPixel(9),
    'a gentle lean is nowhere near the clamp',
  );
  // At every pitch, including past it.
  let capped = true;
  for (let p = 0; p <= 85; p += 1) {
    const t = groundBox(cam({ pitch: p }), VIEW_PAD);
    if (!(t.yMax - mercY(46.8) <= PITCH_REACH * 900 * mercPerPixel(9) + 1e-6)) capped = false;
    if (!Number.isFinite(spanY(t)) || spanY(t) <= 0) capped = false;
  }
  check(capped, 'every pitch from 0 to 85 is bounded and non-degenerate');
}

console.log('\nZoom is the only thing that changes how much a pixel is worth');
{
  near(mercPerPixel(0), WORLD / 512, 1e-6, 'z0 is the world across 512 px');
  near(mercPerPixel(1), WORLD / 1024, 1e-6, 'and halves per zoom level');
  // Which is the property the spotlight radius now leans on: the same screen
  // distance is the same ground distance at any latitude and any bearing.
  const at0 = groundBox(cam({ lat: 0 }), 0);
  const at60 = groundBox(cam({ lat: 60 }), 0);
  near(spanX(at60), spanX(at0), 1e-6, 'a window is the same Mercator width at every latitude');
}

console.log('\nContainment is what decides whether anything is rebuilt');
{
  const outer = groundBox(cam(), VIEW_PAD);
  check(boxContains(outer, groundBox(cam(), 0)), 'the padded box contains the bare one');
  check(!boxContains(groundBox(cam(), 0), outer), 'and not the other way round');
  // A rotation is a change of ground exactly as a pan is, and has to be able to
  // fall out of coverage or the map would keep the sheet it painted facing
  // north. On this window the diagonal is what does it.
  check(
    !boxContains(outer, groundBox(cam({ bearing: 45 }), 0)),
    'turning to the diagonal leaves the box that was painted facing north',
  );
}

console.log('\nA lean asks for far more ground than a level camera, and says how much');
{
  // The number main.js's COVERAGE_SLACK is chosen against. A perspective view's
  // far edge is wider as well as further, so the growth is much larger than the
  // forward reach alone suggests — which is the whole reason levelling has to
  // force a repaint rather than being allowed to keep the tilted sheet.
  const level = groundBox(cam({ width: 1710, height: 986 }), VIEW_PAD);
  const tilted = groundBox(cam({ width: 1710, height: 986, pitch: 60 }), VIEW_PAD);
  const growth = boxArea(tilted) / boxArea(level);
  check(growth > 4 && growth < 9, 'a 60° lean is several times the ground', `×${growth.toFixed(2)}`);
  const COVERAGE_SLACK = 2.5; // main.js's
  check(growth > COVERAGE_SLACK, 'and comfortably past the slack that forces the repaint back');

  // ...while an ordinary pan or zoom must never trip it, or the map would
  // repaint itself for nothing. The padded box is 2.89× the viewport by
  // construction, and that ratio is what the slack sits above.
  const bare = groundBox(cam({ width: 1710, height: 986 }));
  near(boxArea(level) / boxArea(bare), 1.7 * 1.7, 1e-9, 'the pad is 2.89× the viewport, as designed');
  for (const bearing of [0, 30, 45, 90]) {
    const turned = groundBox(cam({ width: 1710, height: 986, bearing }), VIEW_PAD);
    const ratio = Math.max(boxArea(level) / boxArea(turned), boxArea(turned) / boxArea(level));
    check(ratio < COVERAGE_SLACK, `bearing ${bearing} alone never trips the slack`, `×${ratio.toFixed(2)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
