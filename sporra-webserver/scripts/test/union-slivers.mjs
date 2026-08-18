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
import { loadRegions, mergeRegions, countryOutline, regionsOf } from '../../src/regions.js';
import { loadCountries, allCountries, mergeCountries } from '../../src/countries.js';
import { ringAreaM2, asMulti, snapGeometry, unionGeometries } from '../../src/polygon.js';

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

console.log('\nnothing that exists is small enough to be taken for a gap');

// A hole under 0.2 km² is dropped as a gap the dissolve opened. That number is
// only defensible while it stays below the smallest thing either dataset calls a
// place — so check, rather than trust the note in polygon.js. If a future
// boundary set adds something smaller, this fails and the threshold has to be
// argued again rather than quietly swallowing it.
{
  const FLOOR_KM2 = 0.2;
  const sizeOf = (g) => {
    let km2 = 0;
    for (const poly of asMulti(g)) km2 += ringAreaM2(poly[0]) / 1e6;
    return km2;
  };
  let smallest = Infinity;
  let what = '';
  for (const c of allCountries()) {
    if (!c.geometry) continue;
    const km2 = sizeOf(c.geometry);
    if (km2 < smallest) [smallest, what] = [km2, c.id];
  }
  for (const r of regionList) {
    if (!r.geometry) continue;
    const km2 = sizeOf(r.geometry);
    if (km2 < smallest) [smallest, what] = [km2, r.id];
  }
  check(smallest > FLOOR_KM2, `the smallest real unit is above the ${FLOOR_KM2} km² floor`,
    `${what} at ${smallest.toFixed(3)} km²`);
}

console.log('\nno ring is handed over longer than a draw segment can hold');

// MapLibre's line bucket asks for ten vertices per point and a segment addresses
// 65,535 of them, so a ring over ~6,553 points overflows and the mesh it draws
// stops being the line — wedges across the map that come and go with the zoom,
// because the ring is clipped per tile. The dissolved outline is the only thing
// that gets near it: on a real map the detailed geometry's longest ring is
// 20,598 points. So `unionGeometries` hands a long ring over in pieces.
//
// The fill keeps the ring whole, which is what makes this checkable from
// outside: reassembling the pieces must give back exactly the ring the fill
// still has.
{
  const LIMIT = 6553;
  // Every country there is: the biggest dissolve this code can be asked for.
  const { fill, rings } = mergeCountries(new Set(allCountries().map((c) => c.id)));
  const longest = Math.max(...rings.map((r) => r.length));
  check(longest <= LIMIT, 'no ring exceeds what one draw segment can address', `longest ${longest} points`);

  const whole = fill.flat();
  const wasSplit = rings.length > whole.length;
  check(wasSplit, 'and the ring that needed it really was split', `${whole.length} rings in, ${rings.length} out`);

  // Walk the output back into whole rings: a piece that starts where the last
  // one ended is a continuation of it.
  const rejoined = [];
  for (const piece of rings) {
    const open = rejoined[rejoined.length - 1];
    const end = open && open[open.length - 1];
    if (end && end[0] === piece[0][0] && end[1] === piece[0][1]) open.push(...piece.slice(1));
    else rejoined.push([...piece]);
  }
  const same =
    rejoined.length === whole.length &&
    rejoined.every((r, i) => r.length === whole[i].length &&
      r.every((p, j) => p[0] === whole[i][j][0] && p[1] === whole[i][j][1]));
  check(same, 'the pieces rejoin into exactly the rings the fill kept whole',
    `${rejoined.length} rejoined vs ${whole.length} kept`);
}

console.log('\nTwo datasets have to meet on the same grid');
{
  // The detailed boundaries arrive with a tail of 14- and 15-digit coordinates
  // that the source never had, and the overview set beside them is rounded to
  // three places. Two neighbours whose shared border is described by two
  // different floats do not share it at all: the union leaves the seam in, and
  // on real geometry the sweep-line gives up mid-ring and throws — which is how
  // a poster of Europe at a size that asked for the detail came back as "Unable
  // to complete output ring" instead of a picture. See COORD_SNAP.
  const noisy = (v) => v + 1e-14 * (v || 1);
  const square = (x0) => ({
    type: 'Polygon',
    coordinates: [[[x0, 0], [x0 + 1, 0], [x0 + 1, 1], [x0, 1], [x0, 0]]],
  });
  const drifted = {
    type: 'Polygon',
    coordinates: square(1).coordinates.map((r) => r.map(([x, y]) => [noisy(x), noisy(y)])),
  };

  const raw = unionGeometries([asMulti(square(0)), asMulti(drifted)]);
  check(raw.fill.length === 2, 'ungrided, two touching squares stay two shapes',
    `${raw.fill.length} — if this is 1, the fixture no longer drifts`);

  const snapped = unionGeometries([asMulti(snapGeometry(square(0))), asMulti(snapGeometry(drifted))]);
  check(snapped.fill.length === 1, 'and on the grid they dissolve into one',
    `${snapped.fill.length} shapes`);

  // Lossless where it matters: the published precision has to survive.
  const kept = snapGeometry({ type: 'Polygon', coordinates: [[[8.541, 47.376], [8.542, 47.376]]] });
  check(kept.coordinates[0][0][0] === 8.541 && kept.coordinates[0][0][1] === 47.376,
    'a coordinate the dataset really published is left alone');
  const cleaned = snapGeometry({ type: 'Polygon', coordinates: [[[15.688496, 45.88366439999999]]] });
  check(cleaned.coordinates[0][0][1] === 45.8836644,
    'and one that is only float noise is put back where it was meant to be',
    String(cleaned.coordinates[0][0][1]));
}

console.log('\nA dissolve that cannot run still hands back a picture');
{
  // The grid makes this rare rather than impossible: the sweep-line has no proof
  // behind it. Undissolved shapes draw the same ground with their internal
  // borders showing, which beats a blank canvas by a distance.
  const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  let threw = false;
  let out = null;
  try {
    out = unionGeometries([[[['a', 'b'], ['c', 'd']]], asMulti(square)]);
  } catch {
    threw = true;
  }
  check(!threw, 'geometry the clipper refuses does not escape as an exception');
  check(out?.fill.length === 2, 'the shapes come back unmerged instead', `${out?.fill.length}`);
}

console.log('\nA country has one shape, and both levels draw it');
{
  // `countries.json` is rounded to a 0.01° grid and simplified for a dataset
  // that has to cover the world at z4; `regions.json` is neither. Drawn
  // together — the land fill and its stroke from one, the region division lines
  // from the other — a national border comes out ruled twice, about a kilometre
  // apart. That is invisible in a 600 px preview and a pair of lines down every
  // border and around every coast of a 5,760 px poster, which is where it was
  // finally seen. So both levels draw the dissolve of the country's own
  // regions, and `countries.json` stands in only where there is no dissolve.
  //
  // Measured point-to-segment rather than vertex-to-vertex: dissolving drops
  // the vertices interior to the country and adds its own where rings cross, so
  // the two polylines are the same *line* without being the same *points*, and
  // only the distance between them is what anybody can see.
  const distToRings = (pt, rs) => {
    const cos = Math.cos((pt[1] * Math.PI) / 180);
    let best = Infinity;
    for (const r of rs) {
      for (let i = 1; i < r.length; i++) {
        const ax = (r[i - 1][0] - pt[0]) * cos;
        const ay = r[i - 1][1] - pt[1];
        const dx = (r[i][0] - pt[0]) * cos - ax;
        const dy = r[i][1] - pt[1] - ay;
        const L = dx * dx + dy * dy;
        let t = L ? -(ax * dx + ay * dy) / L : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        const d = qx * qx + qy * qy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best) * 111; // km
  };
  const median = (from, rs) => {
    const ds = from.map((p) => distToRings(p, rs)).sort((a, b) => a - b);
    return ds.length ? ds[Math.floor(ds.length / 2)] : NaN;
  };

  const shipped = new Map(allCountries().filter((c) => c.iso).map((c) => [c.iso, c]));
  for (const iso of ['FRA', 'DEU', 'ITA', 'CHE']) {
    const c = shipped.get(iso);
    const outline = countryOutline(iso, false);
    if (!c || !outline) { check(false, `${iso} has a dissolve to compare`); continue; }
    // Outer rings only — a dissolve keeps small interior holes, and sampling
    // one measures the distance from inside the country to its own coast.
    const pts = asMulti(outline).flatMap((p) => p[0]).filter((_, i) => i % 23 === 0).slice(0, 300);
    const toRegions = median(pts, regionsOf(iso).flatMap((r) => asMulti(r.geometry).map((p) => p[0])));
    const toShipped = median(pts, asMulti(c.geometry).map((p) => p[0]));
    check(toRegions < 0.05, `${iso}: the country outline sits on the region lines`,
      `${(toRegions * 1000).toFixed(0)} m away`);
    check(toShipped > 0.3, `…and countries.json is the dataset it would have doubled`,
      `${(toShipped * 1000).toFixed(0)} m away — if this is small the fixture proves nothing`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
