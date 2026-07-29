#!/usr/bin/env node
// Downloads the place names used to title imported routes, trims them hard, and
// writes src/places.json.
//
//   node scripts/build-places.mjs      (or: npm run build:places)
//
// Two sources, picked for what a route actually needs — "which town was this
// near, and did it go round a lake":
//
//   • GeoNames cities5000 — every settlement over ~5,000 people (~70k of them).
//     Coarser sets exist and are far smaller, but they only know cities: a hike
//     above Interlaken comes out named after a city 40 km away, which is worse
//     than no name. CC BY 4.0, so the app carries a GeoNames credit.
//   • Natural Earth 10m lakes — the named ones only. The global file is thin
//     outside the giants (in Switzerland it knows Lake Geneva and Bodensee and
//     nothing else), so the Europe and North America supplements are merged in
//     on top; that is where Thunersee, Zürichsee and the rest live. Public
//     domain, no attribution required.
//
// Re-run only to refresh the data; the output is committed so normal installs
// and builds need no network access (same deal as build-countries.mjs).

import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOWNS_URL = 'https://download.geonames.org/export/dump/cities5000.zip';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const LAKE_URLS = [
  `${NE}/ne_10m_lakes.geojson`,
  `${NE}/ne_10m_lakes_europe.geojson`,
  `${NE}/ne_10m_lakes_north_america.geojson`,
];

// ~110 m. The nearest-town search only has to pick a winner among places that
// are kilometres apart, so more precision than this is dead weight ×70,000.
const DECIMALS = 3;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', 'places.json');
const round = (n) => +(+n).toFixed(DECIMALS);

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- Towns -------------------------------------------------------------------
// cities5000.txt is a tab-separated GeoNames dump: name is column 1, latitude 4,
// longitude 5, population 14.
async function buildTowns() {
  const zip = await download(TOWNS_URL);
  const dir = mkdtempSync(path.join(tmpdir(), 'places-'));
  try {
    const zipPath = path.join(dir, 'cities5000.zip');
    writeFileSync(zipPath, zip);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
    const text = readFileSync(path.join(dir, 'cities5000.txt'), 'utf8');
    const towns = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const c = line.split('\t');
      const name = c[1];
      const lat = +c[4];
      const lng = +c[5];
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Population in thousands: it only ever breaks ties between two towns at
      // a similar distance, and it saves a couple of bytes seventy thousand
      // times over.
      towns.push([name, round(lng), round(lat), Math.round((+c[14] || 0) / 1000)]);
    }
    return towns;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Lakes --------------------------------------------------------------------
// Only the bounding box is kept. A route *around* a lake never enters the water
// polygon, so containment in the box is the useful test, not in the shape.
// A few entries are shouted (MURTENSEE); everything else is already cased the
// way the country writes it, and is left exactly as it is.
const tidyName = (s) =>
  s === s.toUpperCase() && /[A-Z]{4}/.test(s)
    ? s.replace(/\S+/g, (w) => w[0] + w.slice(1).toLowerCase())
    : s;

async function buildLakes() {
  const files = await Promise.all(LAKE_URLS.map((u) => download(u).then((b) => JSON.parse(b.toString('utf8')))));
  const byName = new Map();
  for (const json of files) {
    for (const f of json.features ?? []) {
      const name = f.properties?.name;
      if (!name) continue;
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      const walk = (c) => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') {
          if (c[0] < minLng) minLng = c[0];
          if (c[0] > maxLng) maxLng = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
        } else c.forEach(walk);
      };
      walk(f.geometry?.coordinates);
      if (!Number.isFinite(minLng)) continue;
      // The regional files repeat the big lakes the global one already has;
      // keyed by name and position, the duplicate simply overwrites itself.
      const entry = [tidyName(name), round(minLng), round(minLat), round(maxLng), round(maxLat)];
      byName.set(`${name}@${entry[1].toFixed(1)},${entry[2].toFixed(1)}`, entry);
    }
  }
  return [...byName.values()];
}

const [towns, lakes] = await Promise.all([buildTowns(), buildLakes()]);
towns.sort((a, b) => a[2] - b[2] || a[1] - b[1]); // by latitude, then longitude

writeFileSync(
  outFile,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    attribution: 'Towns: GeoNames (CC BY 4.0). Lakes: Natural Earth (public domain).',
    towns,
    lakes,
  }),
);

const kb = (n) => `${Math.round(n / 1024).toLocaleString()} KB`;
console.log(
  `${towns.length.toLocaleString()} towns + ${lakes.length} named lakes → ` +
    `${path.relative(root, outFile)} (${kb(JSON.stringify({ towns, lakes }).length)})`,
);
