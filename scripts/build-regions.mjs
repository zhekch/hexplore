#!/usr/bin/env node
// Downloads Natural Earth 1:10m admin-1 boundaries — states, provinces,
// cantons, départements, oblasts — simplifies them hard, and writes
// src/regions.json.
//
// It has to be the 10m set: the 50m one only covers nine large countries
// (Russia, the USA, China, Brazil, India…) and has nothing at all for Europe,
// which makes it useless for the one country most maps of a life are mostly
// about. The price is a 40 MB download that has to come down to something a
// browser can be asked to load, which is what the simplification below is for.
//
//   node scripts/build-regions.mjs      (or: npm run build:regions)
//
// Why a second dataset at all: "23 of 195 countries" is a number that moves
// once a year, and never for the country you actually live in. Switzerland is
// one country and twenty-six cantons; a map of your own life needs the finer
// grid to say anything at all about it.
//
// Re-run only when you want to refresh the boundary data — the output is
// committed so normal installs/builds don't need network access.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bboxOfGeometry } from './lib/geo-filter.mjs';

const SRC =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';

// Two builds from the same source: the overview set that ships for the region
// zoom level, and a fine one fetched only when someone pins Region and zooms in,
// where a 6 km-simplified canton border is visibly wrong.
// `npm run build:regions:hi` writes the second.
const HI = process.env.REGIONS_HI === '1';
// Two decimals (~1 km) for the overview set: a region is only ever asked "is
// this cell inside you?" there, and a cell is ~900 m across. The fine set is
// drawn at street zooms, so it gets three (~100 m).
const DECIMALS = HI ? 3 : 2;
// Slivers this small are rounding artefacts of the line above, not places.
const MIN_RING_POINTS = 4;
// How hard to simplify, as a fraction of each region's own size.
//
// A flat tolerance is the wrong instrument: 5 km of slack is nothing to
// Krasnoyarsk Krai and it deletes Basel-Stadt outright — at a fixed 0.05° the
// build lost 329 small regions, every one of them a place you can visit and
// would then never be credited for. So each region is simplified relative to
// its own bounding box and clamped, which spends the bytes where the shape is
// big enough for anyone to notice.
const SIMPLIFY_FRACTION = Number(process.env.SIMPLIFY_FRACTION ?? (HI ? 0.003 : 0.02));
const SIMPLIFY_MIN_DEG = Number(process.env.SIMPLIFY_MIN_DEG ?? (HI ? 0.0004 : 0.003)); // ~45 m / ~330 m
const SIMPLIFY_MAX_DEG = Number(process.env.SIMPLIFY_MAX_DEG ?? (HI ? 0.008 : 0.06)); //  ~900 m / ~6.6 km
// A piece of a multipolygon smaller than this share of the region's largest
// piece is a rock, a sandbank or a rounding artefact. The largest piece is
// always kept, so no region can vanish.
const MIN_PART_SHARE = 0.004;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', HI ? 'regions-hi.json' : 'regions.json');

const round = (n) => +n.toFixed(DECIMALS);

// Perpendicular distance from p to the segment a→b, in degrees. Planar is fine
// here: it is only ever comparing distances against a tolerance in the same
// units, over spans of a few degrees.
function segDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Douglas–Peucker, iterative so a 200k-point Russian coastline can't blow the
// stack. Keeps the first and last point, which for a ring are the same one.
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1;
    let best = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(points[i], points[lo], points[hi]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Shoelace area in square degrees — only ever used to compare the pieces of one
// multipolygon against each other, so the latitude distortion cancels out.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum / 2);
}

function processRings(rings, tol) {
  const out = [];
  for (const ring of rings) {
    // Simplify first, then round: rounding first would quantise the vertices
    // onto a 1 km lattice and leave Douglas–Peucker measuring the staircase it
    // just made rather than the coastline underneath.
    const thinned = simplify(ring, tol);
    const cleaned = [];
    for (const [lng, lat] of thinned) {
      const pt = [round(lng), round(lat)];
      const prev = cleaned[cleaned.length - 1];
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) cleaned.push(pt);
    }
    // A ring has to close: simplification keeps both ends, but rounding can
    // land them on the same point and drop one of them.
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (cleaned.length >= 3 && (first[0] !== last[0] || first[1] !== last[1])) cleaned.push([first[0], first[1]]);
    if (cleaned.length >= MIN_RING_POINTS) out.push(cleaned);
  }
  return out;
}

// Drop the specks. Islands are kept when they are a real part of the region —
// only the pieces that are negligible next to its largest go.
function dropSpecks(polys) {
  if (polys.length < 2) return polys;
  const areas = polys.map((poly) => ringArea(poly[0]));
  const biggest = Math.max(...areas);
  const kept = polys.filter((_, i) => areas[i] >= biggest * MIN_PART_SHARE);
  return kept.length ? kept : polys;
}

console.log(`Fetching ${SRC} …`);
const res = await fetch(SRC);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const geo = await res.json();

const regions = [];
const seen = new Map(); // "country/name" → how many, so duplicates get numbered
for (const f of geo.features) {
  const p = f.properties ?? {};
  // `name` is the local short form ("Bern", "Île-de-France"); the fallbacks are
  // for the handful of features that leave it null.
  const name = p.name ?? p.name_en ?? p.gn_name ?? p.woe_name ?? null;
  const country = p.admin ?? p.geonunit ?? p.sov_a3 ?? null;
  if (!name || !country || !f.geometry) continue;

  // Sized from the raw geometry, before anything is thinned.
  const raw = bboxOfGeometry(f.geometry);
  const diag = Math.hypot(raw[2] - raw[0], raw[3] - raw[1]);
  const tol = Math.min(SIMPLIFY_MAX_DEG, Math.max(SIMPLIFY_MIN_DEG, diag * SIMPLIFY_FRACTION));

  let geometry;
  if (f.geometry.type === 'Polygon') {
    const rings = processRings(f.geometry.coordinates, tol);
    if (!rings.length) continue;
    geometry = { type: 'Polygon', coordinates: rings };
  } else if (f.geometry.type === 'MultiPolygon') {
    const polys = dropSpecks(f.geometry.coordinates.map((poly) => processRings(poly, tol)).filter((poly) => poly.length));
    if (!polys.length) continue;
    geometry = { type: 'MultiPolygon', coordinates: polys };
  } else {
    continue;
  }

  // Detached territories are *kept* here, unlike countries: an overseas
  // département is its own admin-1 region, so lighting it up says exactly what
  // it should rather than colouring in mainland France.
  const key = `${country}/${name}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  regions.push({
    id: n === 1 ? key : `${key} (${n})`,
    name,
    country,
    bbox: bboxOfGeometry(geometry).map(round),
    geometry,
  });
}

// Same reasoning as countries: bigger first, so the average point lookup
// returns sooner. The grid index in src/regions.js does most of the work, but
// this costs nothing.
regions.sort((a, b) => {
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return areaB - areaA;
});

const json = JSON.stringify(regions);
writeFileSync(outFile, json);
const countries = new Set(regions.map((r) => r.country)).size;
const points = regions.reduce(
  (n, r) => n + (r.geometry.type === 'Polygon' ? r.geometry.coordinates : r.geometry.coordinates.flat()).reduce((m, ring) => m + ring.length, 0),
  0,
);
console.log(
  `${regions.length} regions in ${countries} countries, ${points.toLocaleString()} points`
  + ` → ${path.relative(root, outFile)} (${Math.round(Buffer.byteLength(json) / 1024)} KB`
  + ` at ${SIMPLIFY_FRACTION} of each region, ${SIMPLIFY_MIN_DEG}–${SIMPLIFY_MAX_DEG}°)`,
);
