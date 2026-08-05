#!/usr/bin/env node
// Downloads Natural Earth 1:50m country boundaries, trims them to what the map
// needs (id + bbox + rounded geometry), and writes src/countries.json.
//
//   node scripts/build-countries.mjs      (or: npm run build:countries)
//
// Re-run only when you want to refresh the boundary data — the output is
// committed so normal installs/builds don't need network access.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripDetachedTerritories, bboxOfGeometry } from '../src/geo-filter.js';

const SRC =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
// ~1 km precision. Countries only render at zoom < ~5.3, where one pixel is
// several km, so this is visually lossless there and keeps the file light.
const DECIMALS = 2;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', 'countries.json');

const round = (n) => +n.toFixed(DECIMALS);

// Round coordinates, track the polygon's bounding box, and drop consecutive
// duplicate points that rounding can introduce (keeps the union robust).
function processRings(rings, bbox) {
  const out = [];
  for (const ring of rings) {
    const cleaned = [];
    for (const [lng, lat] of ring) {
      if (lng < bbox[0]) bbox[0] = lng;
      if (lat < bbox[1]) bbox[1] = lat;
      if (lng > bbox[2]) bbox[2] = lng;
      if (lat > bbox[3]) bbox[3] = lat;
      const pt = [round(lng), round(lat)];
      const prev = cleaned[cleaned.length - 1];
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) cleaned.push(pt);
    }
    // A ring needs ≥4 points (first == last) to be an area; skip slivers that
    // rounding collapsed.
    if (cleaned.length >= 4) out.push(cleaned);
  }
  return out;
}

console.log(`Fetching ${SRC} …`);
const res = await fetch(SRC);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const geo = await res.json();

const countries = [];
for (const f of geo.features) {
  const p = f.properties;
  const id = p.ADMIN ?? p.NAME_EN ?? p.NAME ?? p.SOVEREIGNT;
  if (!id || !f.geometry) continue;
  // The ISO3 code, because the *name* cannot be trusted to join these two
  // datasets: Natural Earth's admin-0 file says "Czechia" where its own admin-1
  // file says "Czech Republic", and the same for eleven other countries
  // (eSwatini, North Macedonia, Cabo Verde, Vatican…). Joining on the name meant
  // the region lookup found nothing for those, fell through to "this country has
  // no regions", and painted the whole of Czechia in one flat shape.
  const iso = p.ADM0_A3 ?? p.ISO_A3 ?? p.SOV_A3 ?? null;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let geometry;
  if (f.geometry.type === 'Polygon') {
    const rings = processRings(f.geometry.coordinates, bbox);
    if (!rings.length || !rings[0].length) continue;
    geometry = { type: 'Polygon', coordinates: rings };
  } else if (f.geometry.type === 'MultiPolygon') {
    const polys = f.geometry.coordinates
      .map((poly) => processRings(poly, bbox))
      .filter((poly) => poly.length && poly[0].length);
    if (!polys.length) continue;
    geometry = { type: 'MultiPolygon', coordinates: polys };
  } else {
    continue;
  }
  // Drop far-detached overseas territories (France's colonies, Spain's
  // Canaries, etc.) so they don't light up the whole country at the country
  // zoom level. Recompute the bbox afterward since it just shrank.
  geometry = stripDetachedTerritories(geometry);
  countries.push({ id, iso, bbox: bboxOfGeometry(geometry).map(round), geometry });
}

// Larger countries first: the point-in-country lookup returns on first hit, and
// most queried points fall in big countries, so this shortens the average scan.
countries.sort((a, b) => {
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return areaB - areaA;
});

writeFileSync(outFile, JSON.stringify(countries));
const kb = Math.round(Buffer.byteLength(JSON.stringify(countries)) / 1024);
console.log(`${countries.length} countries → ${path.relative(root, outFile)} (${kb} KB)`);
