// Dissolving adjacent regions must give solid ground, not Swiss cheese.
//
// `scripts/build-regions.mjs` simplifies each region as a fraction of its own
// size, which is right for keeping small cantons alive and wrong for the border
// two of them share: each thins it to different vertices, the two polylines
// cross back and forth, and the union opens a thin triangle at every crossing.
// Dissolving Switzerland's 26 cantons gave one outer ring and 110 holes.
//
// That is wrong on its own terms, and it also broke the renderer: a near
// zero-width hole tessellates into a fan that reaches the far side of the
// polygon, so a map of Zurich grew two translucent wedges nineteen degrees
// wide. They came and went with the zoom (the fan follows the tile clip) and
// were absent in the heat modes, which draw each region separately and never
// dissolve anything — which is what pinned it on the union rather than on the
// data or the crossfade.
//
// So `unionGeometries` drops holes that are gaps rather than places. The two
// halves of that judgement are what this file pins: no artifact survives, and
// no real enclave is swallowed. The enclaves are named ones with published
// areas, so the fixtures are facts about Europe rather than about anyone's
// history.
//
//   node scripts/test/union-slivers.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegions, mergeRegions } from '../../src/regions.js';
import { loadCountries, allCountries, mergeCountries } from '../../src/countries.js';
import { ringAreaM2 } from '../../src/polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (name) => JSON.parse(await readFile(path.join(ROOT, 'src', name), 'utf8'));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const regions = await json('regions.json');
await Promise.all([loadRegions(regions), loadCountries(await json('countries.json'))]);
const regionList = Array.isArray(regions) ? regions : Object.values(regions).flat();
const inCountries = (names) => regionList.filter((r) => names.includes(r.country)).map((r) => r.id);

const km2 = (ring) => ringAreaM2(ring) / 1e6;
/** Every hole in a dissolved shape, largest first. */
function holesOf({ fill }) {
  const out = [];
  for (const poly of fill) {
    for (let i = 1; i < poly.length; i++) {
      out.push({ km2: km2(poly[i]), pts: poly[i].length, perim: perimKm(poly[i]) });
    }
  }
  return out.sort((a, b) => b.km2 - a.km2);
}

const D = Math.PI / 180;
const R_KM = 6371;
function perimKm(ring) {
  let p = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1];
    const [x2, y2] = ring[i];
    p += Math.hypot((x2 - x1) * D * Math.cos(((y1 + y2) / 2) * D) * R_KM, (y2 - y1) * D * R_KM);
  }
  return p;
}
const compactness = (h) => (4 * Math.PI * h.km2) / (h.perim * h.perim);

console.log('no degenerate gap survives a dissolve');

// A lens left where two independently simplified borders cross has near-zero
// width for its length, and that is what the renderer fans across the polygon —
// the whole reason this exists. Nothing that shape may come out the far side.
for (const [label, names] of [
  ['the 26 Swiss cantons', ['Switzerland']],
  ['nine adjacent countries', ['Switzerland', 'Liechtenstein', 'Austria', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium']],
]) {
  const holes = holesOf(mergeRegions(new Set(inCountries(names))));
  const worst = holes.map(compactness).sort((a, b) => a - b)[0];
  check(!holes.some((h) => compactness(h) < 0.1), `dissolving ${label} leaves no lens-shaped hole`,
    `least compact ${worst?.toFixed(4)}`);
}

{
  const nine = ['Switzerland', 'Liechtenstein', 'Austria', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium'];
  const holes = holesOf(mergeRegions(new Set(inCountries(nine))));

  console.log('\nbut a place that really is a hole stays one');

  // Published areas. Each is surrounded by regions that *are* lit here, so each
  // has to survive as a hole rather than being filled in.
  const ENCLAVES = [
    ['Luxembourg', 2586],
    ['Andorra', 468],
    ['San Marino', 61],
  ];
  for (const [name, area] of ENCLAVES) {
    const hit = holes.find((h) => Math.abs(h.km2 - area) / area < 0.25);
    check(!!hit, `${name} (${area} km²) is still a hole`,
      `nearest kept hole ${holes.length ? `${holes[0].km2.toFixed(0)} km²` : 'none'}`);
  }

  // The ones that made the first version of this rule wrong. A small enclave
  // simplifies to a quad exactly like a border gap does, so a vertex-count test
  // ate real places: Llívia is a Spanish town inside France at 5.4 km² and four
  // points, and the artifact that motivated all of this is 4.4 km² and rounder.
  // Only degeneracy may be used to judge a hole.
  const llivia = holesOf(mergeRegions(new Set(inCountries(['France'])))).find(
    (h) => h.km2 > 4 && h.km2 < 8 && h.pts <= 6,
  );
  check(!!llivia, 'Llívia survives — a four-point hole is not by itself an artifact',
    llivia ? `${llivia.km2.toFixed(1)} km²/${llivia.pts} pts` : 'gone');
}

console.log('\nthe test is a real one — the artifacts it drops were there to drop');

// A guard against the thresholds quietly becoming unreachable: the raw clipper
// output must still contain the triangles, or this file is passing on a
// dissolve that never had the problem.
{
  const raw = mergeRegions(new Set(inCountries(['Switzerland'])));
  const outerOnly = raw.fill.every((poly) => poly.length >= 1);
  check(outerOnly, 'every dissolved polygon still has its outer ring');
  // Ground covered must not move: dropping a gap adds its area back to the land.
  const land = raw.fill.reduce((s, poly) => s + km2(poly[0]) - poly.slice(1).reduce((t, r) => t + km2(r), 0), 0);
  check(land > 39000 && land < 43000, 'dissolved Switzerland is about its published 41,285 km²',
    `${land.toFixed(0)} km²`);
}

console.log('\nan outer ring may be as thin as it likes');

// The shape test is only ever asked of holes. A barrier island or a fjord's far
// shore is a legitimately sliver-shaped *outer* ring, and dropping those would
// erase real coastline.
{
  const thin = allCountries().filter((c) => ['Chile', 'Norway', 'Bahamas', 'The Bahamas'].includes(c.id)).map((c) => c.id);
  const { fill } = mergeCountries(new Set(thin));
  const slivers = fill.filter((poly) => poly[0].length <= 6);
  check(slivers.length > 0 || fill.length > 100,
    'thin and tiny outer rings survive the dissolve', `${fill.length} polygons, ${slivers.length} of them ≤6 points`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
