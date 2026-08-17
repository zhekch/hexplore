// The scale bar's arithmetic: metres per pixel, and the round distance drawn
// from it.
//
// A scale bar that is wrong is worse than no scale bar, and it is wrong in a way
// nobody can see — the map looks the same either way, and the number under it is
// the only thing claiming otherwise. So the two properties that make it a ruler
// are pinned here: the distance is always round, and the bar it draws is that
// distance long at the zoom it was asked about.
//
//   node scripts/test/scale-bar.mjs

import { distanceLabel, metresPerPixel, scaleStep } from '../../src/scale-bar.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\nMetres per pixel');
{
  // The whole world across 512 px at zoom 0: about 78 km per pixel at the
  // equator, which is the number every Web Mercator implementation agrees on.
  check(near(metresPerPixel(0, 0), 78271.5, 1), 'zoom 0 at the equator is ~78 km per pixel',
    metresPerPixel(0, 0).toFixed(1));

  // Each zoom level halves it. Twenty of them is a factor of a million.
  check(near(metresPerPixel(10, 0), metresPerPixel(0, 0) / 1024, 1e-6),
    'and every zoom level halves it');

  // Mercator stretches with latitude, so a pixel covers less ground the further
  // north you are — the reason a cell's ground size is latitude-dependent too.
  check(near(metresPerPixel(12, 60), metresPerPixel(12, 0) / 2, 1e-6),
    'at 60° a pixel covers half the ground it does at the equator');
  check(metresPerPixel(12, 47) < metresPerPixel(12, 0), 'Switzerland is finer than the equator');
}

console.log('\nThe bar is a round number, and the round number is drawn to length');
{
  // Whatever the zoom, the label is 1, 2 or 5 times a power of ten. This is the
  // property that makes it a ruler: nobody multiplies 137 m by eye.
  const allowed = new Set();
  for (let e = -3; e <= 8; e++) for (const s of [1, 2, 5]) allowed.add(s * 10 ** e);
  let worstErr = 0;
  let odd = null;
  for (let z = 0; z <= 22; z += 0.25) {
    for (const lat of [0, 23.5, 47, 60, 71]) {
      const mpp = metresPerPixel(z, lat);
      const step = scaleStep(mpp, 120);
      if (!allowed.has(step.metres)) odd = `${step.metres} at z${z} lat${lat}`;
      // The bar has to be as long as it says. Rounding to whole pixels is the
      // only error allowed, so compare what the width means back to the number.
      worstErr = Math.max(worstErr, Math.abs(step.px * mpp - step.metres) / step.metres);
      if (step.px > 120) odd ??= `${step.px}px at z${z}`;
    }
  }
  check(!odd, 'every zoom from 0 to 22 gives a 1/2/5 distance inside the width', odd);
  check(worstErr < 0.02, 'and the bar drawn is that distance, to within a pixel of rounding',
    `worst ${(worstErr * 100).toFixed(2)}%`);
}

console.log('\nIt uses the width it is given');
{
  // Not just round, but the *longest* round distance that fits — a bar using a
  // fifth of its allowance is a ruler with no precision left in it.
  for (const mpp of [0.3, 1.7, 12, 480, 9000]) {
    const step = scaleStep(mpp, 120);
    check(step.px <= 120 && step.px > 120 / 5.001,
      `at ${mpp} m/px it fills the width rather than a corner of it`, `${step.px}px`);
  }
  const wide = scaleStep(2, 240);
  const narrow = scaleStep(2, 60);
  check(wide.metres >= narrow.metres, 'a wider allowance never gives a shorter distance',
    `${wide.metres} vs ${narrow.metres}`);
}

console.log('\nHow the distance is said');
{
  check(distanceLabel(500) === '500 m', '500 m');
  check(distanceLabel(1000) === '1 km', 'a thousand metres is 1 km, not 1000 m');
  check(distanceLabel(2000) === '2 km', '2 km');
  check(distanceLabel(20000) === '20 km', 'and 20 km is whole');
  check(distanceLabel(5000) === '5 km', '5 km');
  // No "1.0 km", which is the tell of a number formatted rather than chosen.
  const labels = [];
  for (let z = 0; z <= 22; z += 0.5) labels.push(scaleStep(metresPerPixel(z, 47), 120).label);
  check(!labels.some((l) => /\.0 /.test(l)), 'never a trailing .0', labels.find((l) => /\.0 /.test(l)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
