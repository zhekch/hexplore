#!/usr/bin/env node
// Downloads the place names used to title imported routes, trims them hard, and
// writes src/places.json.
//
//   node scripts/build-places.mjs      (or: npm run build:places)
//
// Two sources, picked for what a route actually needs — "which town was this
// near, and did it go round a lake":
//
//   • GeoNames cities1000, thinned (see below). Coarser sets are far smaller but
//     they only know cities: a hike above Interlaken comes out named after a
//     city 40 km away, which is worse than no name. CC BY 4.0, so the app
//     carries a GeoNames credit.
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

const TOWNS_URL = 'https://download.geonames.org/export/dump/cities1000.zip';

// Everything over this many people is kept outright. Below it, a place is kept
// only where nothing bigger is close enough to speak for the area — see
// `thin()`.
const BIG_POP = 5000;
// How far a big town's name reaches, for the purpose of deciding whether a
// smaller neighbour is worth shipping. Roughly the radius within which a small
// place would lose the naming anyway: nearestTown gives a big place up to
// PROMINENCE_M (6 km) of head start, so at this separation the small one still
// owns a few kilometres around itself and is worth its ~30 bytes.
const FILL_GAP_M = 15000;
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
// cities1000.txt is a tab-separated GeoNames dump: name is column 1, latitude 4,
// longitude 5, feature code 7, population 14.

const R_E = 6371000;
const RAD = Math.PI / 180;
const metres = (aLng, aLat, bLng, bLat) => {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(s)));
};

/**
 * Keep the whole ≥5,000 set, and fill in below it only where the map would
 * otherwise have nothing to say.
 *
 * The full ≥1,000 set is 161k places and 1.9 MB gzipped — more than twice what
 * the app downloads today, nearly all of it villages in places that already
 * have a town speaking for them. What the ≥5,000 set actually gets *wrong* is
 * the opposite case: the upper Engadin has no settlement over 5,000 in it at
 * all, so a day in St. Moritz (4,952 people) was named after Chur, an hour's
 * drive away. Villages that are the only name for miles are worth their bytes;
 * villages inside a city's shadow are not.
 */
function thin(all) {
  const big = all.filter((t) => t[3] >= BIG_POP);
  // Same 1° grid the app's own nearest-town index uses: one degree of latitude
  // is ~111 km, so a 3×3 neighbourhood always covers the gap being tested.
  const index = new Map();
  big.forEach((t, i) => {
    const k = `${Math.floor(t[1])}/${Math.floor(t[2])}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(i);
    else index.set(k, [i]);
  });
  const shadowed = (lng, lat) => {
    const cl = Math.floor(lng);
    const ct = Math.floor(lat);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of index.get(`${cl + dx}/${ct + dy}`) ?? []) {
          if (metres(lng, lat, big[i][1], big[i][2]) <= FILL_GAP_M) return true;
        }
      }
    }
    return false;
  };
  return all.filter((t) => t[3] >= BIG_POP || !shadowed(t[1], t[2]));
}

async function buildTowns() {
  const zip = await download(TOWNS_URL);
  const dir = mkdtempSync(path.join(tmpdir(), 'places-'));
  try {
    const zipPath = path.join(dir, 'cities1000.zip');
    writeFileSync(zipPath, zip);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
    const text = readFileSync(path.join(dir, 'cities1000.txt'), 'utf8');
    const towns = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const c = line.split('\t');
      // PPLX is "section of a populated place" — a city district, not a place.
      // They carry their own population and so compete with the city they are
      // part of: a day in Zürich came out as "Zürich (Kreis 9) / Altstetten",
      // and a week in Lisbon as "Lumiar". Nobody names a trip after a
      // neighbourhood, and dropping them makes the file smaller as well.
      if (c[7] === 'PPLX') continue;
      const name = c[1];
      const lat = +c[4];
      const lng = +c[5];
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Population in thousands: it only ever breaks ties between two towns at
      // a similar distance, and it saves a couple of bytes a hundred thousand
      // times over. Kept in full for the thinning below, which needs to know
      // 4,952 from 5,001.
      towns.push([name, round(lng), round(lat), Math.round((+c[14] || 0) / 1000), +c[14] || 0]);
    }
    const kept = thin(towns.map((t) => [t[0], t[1], t[2], t[4]]));
    return kept.map((t) => [t[0], t[1], t[2], Math.round(t[3] / 1000)]);
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
