// The image export: the arithmetic behind the picture, against the real
// boundary datasets.
//
// Everything that can be tested without a canvas is tested here, and that is
// deliberately most of it — the framing, the seam, the type fitting and the
// caption are all pure functions of a spec and a set of cells, precisely so
// that "does a poster of Fiji show Fiji" is a question a script can ask.
//
// The cases below pin the three things that are quietly wrong in every map
// exporter ever written: a frame that spans the globe because the subject
// straddles ±180°, numbers that describe the world when they claim to describe
// a country, and a caption that reports a map of nothing when nothing is picked.
//
//   node scripts/test/export-image.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTION_FIELDS, CELL_SIZES, MAX_PIXELS, SCALES, SHAPES,
  blobLevelFor, cameraFor, captionLines, circularSpan, coverageOf, divisionGeoms, exportFilename, fitCamera,
  fitBox, frameFor, lngLatAt, paletteOf, pickAt, presetOf, scopeAreaKm2, scopeGeometry, scopeName, sizeOf,
  unwrapRing, visitedAreas,
} from '../../src/export-image.js';
import { loadCountries, countryAreaKm2 } from '../../src/countries.js';
import { loadRegions } from '../../src/regions.js';
import { areaOfCell, computeStats } from '../../src/stats.js';
import { stripDetachedTerritories } from '../../src/geo-filter.js';
import { WORLD, colsOf, lngOf, latOf, mercX, mercY, normCol, pointToCell } from '../../src/hexgrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (name) => JSON.parse(await readFile(path.join(ROOT, 'src', name), 'utf8'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

await Promise.all([loadCountries(await json('countries.json')), loadRegions(await json('regions.json'))]);

// Local midday, matching the other suites — which day a timestamp belongs to is
// worked out in local time, so a fixture pinned to midnight UTC lands on the
// day before for anyone west of Greenwich.
const T = (day) => Math.floor(new Date(`${day}T12:00:00`).getTime() / 1000);

const idAt = (lng, lat, L = 0) => {
  const [c, r] = pointToCell(L, mercX(lng), mercY(lat));
  return `${L}/${normCol(c, colsOf(L))}/${r}`;
};

/** A patch of cells walking east from a point, with dates and a source. */
function patch(meta, lng, lat, n, { firstAt, lastAt = firstAt, hits = 1, source = 'test' }) {
  const [L, col, row] = idAt(lng, lat).split('/').map(Number);
  for (let i = 0; i < n; i++) {
    meta.set(`${L}/${col + i}/${row}`, [{ source, addedAt: firstAt, firstAt, lastAt, hits, fixes: 0 }]);
  }
}

// --- The seam ------------------------------------------------------------------
// Mercator has one join in it, and everything that frames a picture has to know
// where it is. A naive min/max over longitudes calls New Zealand "the Pacific".

console.log('\nFraming across the antimeridian');
{
  // Two arcs either side of ±180°, the shape Fiji and Chukotka both have.
  const span = circularSpan([[176, 180], [-180, -178]], 360);
  check(near(span.max - span.min, 6, 1e-9), 'a shape either side of the line spans 6°, not 354°',
    `got ${(span.max - span.min).toFixed(2)}°`);

  const europe = circularSpan([[-10, 30]], 360);
  check(near(europe.max - europe.min, 40, 1e-9), 'and an ordinary shape keeps its own width');
  check(near(((europe.min % 360) + 360) % 360, 350, 1e-9),
    'even when its own width crosses the origin of the representation');

  // Two far-apart subjects: the answer is the smaller of the two ways round.
  const both = circularSpan([[-5, 5], [170, 175]], 360);
  check(both.max - both.min <= 200, 'two distant subjects take the short way round',
    `got ${(both.max - both.min).toFixed(1)}°`);

  check(circularSpan([], 360) === null, 'and nothing at all has no frame');
}

console.log('\nRings that jump the line are put back together');
{
  // A ring walking east across ±180°: stored as +179, -179, it must come back
  // as +179, +181, or it is drawn all the way round the world instead.
  const unwrapped = unwrapRing([[179, 10], [-179, 10], [-179, 12], [179, 12], [179, 10]]);
  const xs = unwrapped.map((p) => p[0]);
  check(Math.max(...xs) - Math.min(...xs) === 2, 'a 2°-wide ring stays 2° wide', `got ${Math.max(...xs) - Math.min(...xs)}`);
  check(xs.includes(181), 'by carrying past ±180 rather than snapping back');

  const plain = [[5, 10], [7, 10], [7, 12], [5, 10]];
  check(JSON.stringify(unwrapRing(plain)) === JSON.stringify(plain), 'a ring that never crosses is untouched');
}

console.log('\nA country frames itself');
{
  const frame = frameFor([scopeGeometry('country', 'Switzerland')], []);
  const west = lngOf(frame.xMin);
  const east = lngOf(frame.xMax);
  const south = latOf(frame.yMin);
  const north = latOf(frame.yMax);
  check(near(west, 5.96, 0.4) && near(east, 10.49, 0.4), 'Switzerland is framed at its own longitudes',
    `${west.toFixed(2)}..${east.toFixed(2)}`);
  check(near(south, 45.82, 0.4) && near(north, 47.81, 0.4), 'and at its own latitudes',
    `${south.toFixed(2)}..${north.toFixed(2)}`);

  // Every country at once, including the ones that cross the line — the frame
  // is the world, and no wider than it.
  const all = frameFor([scopeGeometry('country', 'Fiji'), scopeGeometry('country', 'New Zealand')], []);
  check(all.xMax - all.xMin < WORLD * 0.15, 'Fiji and New Zealand together are a corner of the Pacific',
    `${(((all.xMax - all.xMin) / WORLD) * 360).toFixed(0)}° wide`);
}

console.log('\nAnd so does a set of cells, when nothing is picked');
{
  const meta = new Map();
  patch(meta, 7.44, 46.94, 6, { firstAt: T('2020-05-01') });
  patch(meta, 8.54, 47.37, 6, { firstAt: T('2021-06-01') });
  const frame = frameFor([], meta.keys());
  check(lngOf(frame.xMin) > 6 && lngOf(frame.xMax) < 10, 'the frame is what you have visited, not the planet',
    `${lngOf(frame.xMin).toFixed(2)}..${lngOf(frame.xMax).toFixed(2)}`);
  check(frameFor([], []) === null, 'an empty map has no frame at all');
}

// --- The camera ----------------------------------------------------------------

console.log('\nFitting a frame into a shape');
{
  const bb = { xMin: mercX(6), xMax: mercX(10), yMin: mercY(46), yMax: mercY(48) };
  // Every proportion of every family, because letterboxing is exactly the thing
  // that is right for the ratio it was written against and wrong for 21:9.
  for (const [key, shape] of Object.entries(SHAPES)) {
    for (const preset of shape.presets) {
      const cam = fitCamera(bb, preset);
      const wPx = (bb.xMax - bb.xMin) * cam.k;
      const hPx = (bb.yMax - bb.yMin) * cam.k;
      const label = `${key} ${preset.key}`;
      check(wPx <= preset.w * 0.851 && hPx <= preset.h * 0.851, `${label}: the subject stays inside its margins`,
        `${wPx.toFixed(0)}×${hPx.toFixed(0)} in ${preset.w}×${preset.h}`);
      // Letterboxed: one axis touches the margin exactly, the other has slack.
      check(near(wPx, preset.w * 0.85, 1) || near(hPx, preset.h * 0.85, 1),
        `${label}: and is as large as those margins allow`);
      // Centred: the middle of the frame lands in the middle of the canvas.
      const midX = ((bb.xMin + bb.xMax) / 2 - cam.x0) * cam.k;
      const midY = (cam.y0 - (bb.yMin + bb.yMax) / 2) * cam.k;
      check(near(midX, preset.w / 2, 0.5) && near(midY, preset.h / 2, 0.5), `${label}: and centred in it`);
    }
  }
}

console.log('\nDragging the picture off its own frame');
{
  const bb = { xMin: mercX(6), xMax: mercX(10), yMin: mercY(46), yMax: mercY(48) };
  const size = { w: 1080, h: 1350 };
  const fitted = fitCamera(bb, size);
  check(cameraFor({}, bb, size).k === fitted.k, 'no override leaves the fitted camera alone');

  // A framing is stored as a multiple of the fitted scale, so it has to survive
  // being applied at a different canvas size — which is what the preview is.
  const view = { cx: mercX(8), cy: mercY(47), zoom: 2 };
  const big = cameraFor({ view }, bb, size);
  const small = cameraFor({ view }, bb, { w: 540, h: 675 });
  check(near(big.k, fitted.k * 2, 1e-9), 'a 2× framing is twice the fitted scale');
  const centreOf = (cam) => lngLatAt(cam, cam.w / 2, cam.h / 2);
  const [lngA, latA] = centreOf(big);
  const [lngB, latB] = centreOf(small);
  check(near(lngA, 8, 1e-6) && near(latA, 47, 1e-6), 'and is centred where it was dragged to',
    `${lngA.toFixed(4)}, ${latA.toFixed(4)}`);
  check(near(lngA, lngB, 1e-6) && near(latA, latB, 1e-6),
    'and the preview shows the same middle as the file, at half the size');
}

console.log('\nThe borders inside the picture');
{
  // A frame around Switzerland, and one around the planet. The first is the
  // case the slider is for; the second is the one that has to stay affordable,
  // because the preview redraws while it is being dragged.
  const size = { w: 1080, h: 1350 };
  const swiss = fitCamera({ xMin: mercX(5.9), xMax: mercX(10.5), yMin: mercY(45.8), yMax: mercY(47.8) }, size);
  const world = fitCamera({ xMin: mercX(-179), xMax: mercX(179), yMin: mercY(-80), yMax: mercY(80) }, size);

  check(divisionGeoms('continent', swiss).length === 7, 'continents divide into seven, wherever you are looking',
    String(divisionGeoms('continent', swiss).length));

  // Bounded by the frame, which is the whole reason this is not simply "every
  // shape in the dataset".
  const nearby = divisionGeoms('country', swiss);
  check(nearby.length > 3 && nearby.length < 40, 'a frame over the Alps asks for its neighbours, not for 250 countries',
    `${nearby.length} countries`);
  check(divisionGeoms('country', world).length > 200, 'and a frame over the world asks for the world');

  // 26 cantons, plus whatever the frame reaches of France, Germany, Austria and
  // Italy — but nothing like the 4,553 admin-1 units there are in total.
  const cantons = divisionGeoms('region', swiss);
  check(cantons.length > 26 && cantons.length < 900, 'regions are the cantons and their neighbours, not all of them',
    `${cantons.length} regions`);
  check(cantons.every(Boolean), 'and every one of them is a shape rather than a hole in the list');

  // A country the admin-1 set does not subdivide has to stand in for itself, or
  // it is the one shape in the frame with no line around it.
  const tiny = divisionGeoms('region',
    fitCamera({ xMin: mercX(9.4), xMax: mercX(9.7), yMin: mercY(47.0), yMax: mercY(47.3) }, size));
  check(tiny.length > 0, 'and a country with no regions in the set still gets an outline');
}

console.log('\nA country is its mainland, however the shape was arrived at');
{
  // `countries.json` ships trimmed; the *region* dataset deliberately keeps
  // overseas territories so a cell in Cayenne lights Guyane rather than
  // mainland France. Dissolving the regions to make a sharper country outline
  // therefore hands the colonies straight back — which put a piece of South
  // America in the frame of a poster of France.
  const spread = (g) => {
    let w = 180;
    let e = -180;
    for (const poly of (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) {
      for (const [lng] of poly[0]) {
        if (lng < w) w = lng;
        if (lng > e) e = lng;
      }
    }
    return e - w;
  };
  for (const country of ['France', 'Netherlands', 'Spain', 'Portugal']) {
    const g = scopeGeometry('country', country);
    check(g && spread(g) < 30, `${country} is the country, not the empire`,
      g ? `${spread(g).toFixed(0)}° of longitude` : 'no geometry');
  }
  // …and the filter is the same one the shipped dataset was built with, so the
  // two can never disagree about where the line is.
  const guiana = stripDetachedTerritories({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 45], [4, 45], [4, 49], [0, 49], [0, 45]]], // mainland
      [[[-54, 3], [-52, 3], [-52, 5], [-54, 5], [-54, 3]]], // an ocean away
    ],
  });
  check(guiana.coordinates.length === 1, 'a piece an ocean away is dropped');
  const corsica = stripDetachedTerritories({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 45], [4, 45], [4, 49], [0, 49], [0, 45]]],
      [[[8, 41], [9, 41], [9, 43], [8, 43], [8, 41]]], // just offshore
    ],
  });
  check(corsica.coordinates.length === 2, 'and one just offshore is kept');
}

console.log('\nClicking the picture picks a place');
{
  check(pickAt('country', 8.2, 46.8) === 'Switzerland', 'a point in a country is that country');
  check(pickAt('continent', 8.2, 46.8) === 'Europe', 'and the continent it is on');
  check(pickAt('region', 7.44, 46.94)?.includes('Bern'), 'and the region it is in',
    String(pickAt('region', 7.44, 46.94)));
  check(pickAt('country', -30, 35) === null, 'and the middle of the Atlantic is nowhere');
  // The click and the cells must agree, or the picture and its caption are
  // describing different places.
  check(pickAt('country', 2.35, 48.85) === 'France', 'Paris is in France');
}

console.log('\nA frame past the seam is still a frame beside the geometry');
{
  // circularSpan answers on a circle, so its origin can land a world east. The
  // rectangle handed to the camera must not.
  const frame = frameFor([scopeGeometry('country', 'France')], []);
  const mid = (frame.xMin + frame.xMax) / 2;
  check(Math.abs(mid) < WORLD / 2, 'the middle of the frame is a real longitude',
    `${lngOf(mid).toFixed(1)}°`);
}

// --- Blobs ---------------------------------------------------------------------

console.log('\nHow fine the blobs are drawn');
{
  // A country-sized picture, and a street-sized one.
  const square = SHAPES.square.presets[0];
  const wide = fitCamera(frameFor([scopeGeometry('country', 'Russia')], []), square).k;
  const tight = fitCamera({ xMin: mercX(7.4), xMax: mercX(7.5), yMin: mercY(46.9), yMax: mercY(47) }, square).k;
  check(blobLevelFor(tight) === 0, 'on Auto and zoomed right in, the grid is drawn exactly as stored');
  check(blobLevelFor(wide) > blobLevelFor(tight), 'and Auto coarsens as the picture takes in more ground',
    `${blobLevelFor(wide)} vs ${blobLevelFor(tight)}`);

  // A cell size that is chosen has to *stay* that size. It used to be an offset
  // from whatever Auto picked, so the base moved with the frame and a size you
  // had chosen quietly changed under you as you zoomed out.
  for (const level of [0, 1, 2, 3, 4]) {
    check(blobLevelFor(tight, level) === level && blobLevelFor(wide, level) === level,
      `a pinned ${level} is ${level} at any scale`,
      `${blobLevelFor(tight, level)} / ${blobLevelFor(wide, level)}`);
  }
  check(blobLevelFor(1e-12, 9) === 4 && blobLevelFor(1e12, -3) === 0,
    'and a level off either end of the ladder is clamped to it');
  check(CELL_SIZES[0].key === 'auto' && CELL_SIZES.length === 6,
    'the picker offers Auto and one entry per level');
  check(/^0\.9 km$/.test(CELL_SIZES[1].label), 'named by the ground a cell covers', CELL_SIZES[1].label);
}

// --- The numbers ---------------------------------------------------------------

console.log('\nThe caption measures what the picture shows');
{
  const meta = new Map();
  // Bern, Zürich — Switzerland. Paris — not.
  patch(meta, 7.44, 46.94, 40, { firstAt: T('2016-03-04'), lastAt: T('2024-01-09'), hits: 12 });
  patch(meta, 8.54, 47.37, 25, { firstAt: T('2018-07-19'), lastAt: T('2025-06-02'), hits: 4 });
  patch(meta, 2.35, 48.85, 30, { firstAt: T('2019-04-13'), lastAt: T('2019-04-20'), hits: 3 });
  const cells = [...meta.keys()];
  const memo = new Map();
  const areaOf = (kind, id) => {
    const key = `${kind} ${id}`;
    if (!memo.has(key)) memo.set(key, areaOfCell(kind, id));
    return memo.get(key);
  };
  const data = { cells: () => cells, meta: () => meta, areaOf };

  const swiss = await coverageOf({ kind: 'country', ids: ['Switzerland'] }, data);
  const world = await coverageOf({ kind: 'world', ids: [] }, data);

  check(swiss.cells === 65, 'a country counts only the cells inside it', `got ${swiss.cells}`);
  check(world.cells === 95, 'and everywhere counts them all', `got ${world.cells}`);
  check(swiss.countries === 1 && world.countries === 2, 'one country against two');
  check(swiss.firstAt === T('2016-03-04'), 'the first date is the first one inside the selection');
  check(world.firstAt === T('2016-03-04'), 'which here is also the first one anywhere');
  check(swiss.lastAt === T('2025-06-02'), 'and the last is the last one inside it');

  // The denominator is the thing named, not the planet.
  check(near(swiss.totalKm2, countryAreaKm2('Switzerland'), 1),
    'the share of a country is measured against that country');
  check(swiss.pct > world.worldPct * 100, 'so a country reads as a much bigger share than the world does');
  check(near(swiss.pct, (swiss.km2 / countryAreaKm2('Switzerland')) * 100, 1e-9), 'and the arithmetic is that division');

  // Regions: the denominator is the cantons of the countries actually touched.
  check(swiss.regionsTotal === 26, 'Switzerland is 26 cantons', `got ${swiss.regionsTotal}`);
  check(swiss.regions > 0 && swiss.regions <= 26, 'and you have been to some of them', `got ${swiss.regions}`);

  // Nothing picked is everywhere, in the numbers as well as in the picture.
  const empty = await coverageOf({ kind: 'country', ids: [] }, data);
  check(empty.cells === world.cells, 'picking nothing measures everywhere, not nothing',
    `got ${empty.cells}`);
  check(empty.title === 'The world', 'and says so');

  // The same sweep, unfiltered, has to agree with computeStats itself — this is
  // the guarantee that the poster and the Cells tab are one measurement.
  const direct = await computeStats(cells, meta);
  check(direct.cells === world.cells && near(direct.km2, world.km2, 1e-6),
    'an unfiltered export reads exactly what the statistics panel reads');

  console.log('\nWhat a caption says');
  const lines = captionLines(
    { on: true, fields: ['first', 'title', 'covered'], title: '' },
    swiss,
  );
  check(lines[0].title === true && lines[0].value === 'Switzerland',
    'the title leads, whatever order the fields were ticked in');
  check(lines.map((l) => l.label).join('|') === '|Land covered|First seen',
    'and the rest follow the order they are declared in', lines.map((l) => l.label).join('|'));

  const named = captionLines({ on: true, fields: ['title'], title: '  Home  ' }, swiss);
  check(named[0].value === 'Home', 'a title you type wins over the names of the places');

  const dateless = captionLines({ on: true, fields: ['first', 'last'] }, { ...swiss, firstAt: 0, lastAt: 0 });
  check(dateless.length === 0, 'a line with no honest answer is left out, not printed empty');

  check(captionLines({ on: false, fields: ['title'] }, swiss).length === 0, 'and none of it appears when it is switched off');

  console.log('\nNaming the file');
  check(exportFilename({ shape: 'vertical' }, swiss) === 'switzerland-vertical.png', 'after the place and the shape');
  check(exportFilename({ shape: 'square' }, world) === 'hexplore-square.png', 'and after the app when there is no place');
  check(
    exportFilename({ shape: 'square' }, { names: ['Zürich', 'Neuchâtel'] }) === 'zurich-neuchatel-square.png',
    'with the accents folded away, because a filename travels',
  );

  console.log('\nListing the places worth offering');
  const countries = visitedAreas('country', cells, areaOf);
  check(countries.length === 2, 'only the places you have actually been are listed', `got ${countries.length}`);
  check(countries[0].id === 'Switzerland', 'biggest first', countries.map((c) => c.id).join(', '));
  const regions = visitedAreas('region', cells, areaOf);
  check(regions.every((r) => r.name && r.country), 'and a region carries its country, since a dozen share a name');
}

// --- Specs ---------------------------------------------------------------------

console.log('\nThe spec resolves to a picture');
{
  check(sizeOf({ shape: 'vertical', scale: 1 }).h === 1350, 'a shape has a size');
  check(sizeOf({ shape: 'vertical', scale: 2 }).h === 2700, 'and a quality multiplier multiplies it');
  check(sizeOf({ shape: 'vertical', preset: '9x16' }).h === 1920, 'a proportion within it picks another');
  check(presetOf({ shape: 'horizontal', preset: 'nonsense' }).key === '16x9',
    'and a proportion this build has never heard of falls back to the family default');
  check(sizeOf({ shape: 'nonsense', scale: 9 }).w === 1080, 'a spec from an older build falls back rather than failing');
  check(SCALES.length === 4 && SCALES[3] === 4, 'quality goes up to 4×');

  // Typed pixels are taken at their word, multiplier and all.
  const custom = sizeOf({ shape: 'vertical', scale: 4, custom: true, customW: 800, customH: 600 });
  check(custom.w === 800 && custom.h === 600, 'an exact size is exactly that, whatever the quality says');
  const silly = sizeOf({ custom: true, customW: 0, customH: 0 });
  check(silly.w === 1080 && silly.h === 1350, 'and an empty one falls back rather than drawing nothing');

  // A canvas has a hard area limit and hands back a blank bitmap past it.
  const huge = sizeOf({ shape: 'horizontal', preset: '21x9', scale: 4 });
  check(huge.clamped === true, 'a size no canvas will produce is capped');
  check(huge.w * huge.h <= MAX_PIXELS + 1000, 'to something one will', `${huge.w}×${huge.h}`);
  check(near(huge.w / huge.h, 2520 / 1080, 0.01), 'keeping the proportions it was asked for',
    (huge.w / huge.h).toFixed(3));

  const overridden = paletteOf({ palette: 'paper', colors: { land: '#123456' } });
  check(overridden.background === '#f4f1ea' && overridden.land === '#123456',
    'and a colour you changed sits on top of the palette you chose');

  check(scopeName('country', 'Italy') === 'Italy', 'a country is called by its name');
  check(scopeName('region', 'Switzerland/Bern') === 'Bern', 'and a region by its own, not by its id');
  check(scopeAreaKm2('country', 'Switzerland') > 39_000, 'a country knows how big it is');
  check(CAPTION_FIELDS.every((f) => f.key && f.label), 'every caption field has something to call itself');
}

// --- The box the preview is shown in -------------------------------------------
// The dialog does this itself because CSS gets it wrong (see fitBox). It is also
// where the phone layout's dead space came from: the picture was fitted into a
// slab of fixed height, so every shape but one sat in the middle of a hole.

console.log('\nThe preview is fitted to its shape, not to a slab');
{
  // Wide inside a tall box: the width binds and the height is whatever is left,
  // which is the case CSS could not express.
  const wide = fitBox(16 / 9, 320, 400);
  check(wide.w === 320 && near(wide.h, 180, 0.01), 'a wide picture takes the width and only the height it needs',
    `${wide.w}×${wide.h.toFixed(1)}`);
  check(wide.h < 400, 'leaving the rest of the box to whatever is underneath it');

  // Tall inside the same box: now the height binds instead.
  const tall = fitBox(9 / 16, 320, 400);
  check(near(tall.h, 400, 0.01) && near(tall.w, 225, 0.01), 'a tall one is capped by the height and narrows to suit',
    `${tall.w.toFixed(1)}×${tall.h}`);

  const square = fitBox(1, 320, 400);
  check(square.w === 320 && square.h === 320, 'a square takes the smaller side');

  // Whatever binds, the shape is never changed — a squashed preview is a lie
  // about the file it is previewing.
  for (const [w, h] of [[21, 9], [4, 5], [1, 1], [9, 16], [3, 2]]) {
    const box = fitBox(w / h, 320, 400);
    check(near(box.w / box.h, w / h, 1e-9), `${w}:${h} previews at ${w}:${h}`,
      (box.w / box.h).toFixed(4));
    check(box.w <= 320.001 && box.h <= 400.001, `and ${w}:${h} stays inside the box it was given`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
