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
import { bboxOfGeometry } from '../src/geo-filter.js';
import { asMulti, unionGeometries, inPolygon, simplifyRing as simplify } from '../src/polygon.js';
// The same pin, and the same URL, the server fetches detailed boundaries with.
// One place, so the overview set and the detail can never be built against two
// different releases of the same dataset.
import { fileUrl as fineFileUrl } from '../server/regions-fine.js';

const SRC =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';

// This is the overview set only — the one that ships. Detailed boundaries are
// fetched per country at view time from geoBoundaries (see src/regions.js);
// Natural Earth cannot supply them at any tolerance, because even its raw 10m
// geometry gives a Swiss canton ~270 points where the national survey gives
// 7,000.
// Three decimals (~110 m), the same precision the fine set is stored at.
//
// Two was the reasoning for a long time, and the reasoning was about the
// question rather than the picture: a region is only ever asked "is this cell
// inside you?", and a cell is ~900 m across, so a kilometre of slack costs no
// correctness. But this geometry is also *drawn*, up to the zoom where the
// detailed boundaries take over, and there a kilometre of snapping is a
// staircase down the side of every canton. The extra digit costs 11%.
const DECIMALS = 3;
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
// Loosened from 0.02/0.06 once the shapes started being looked at rather than
// only asked about. The clamp was the louder of the two: 6.6 km of permitted
// deviation is a bay missing from a coastline, and it was being spent on
// exactly the large, familiar regions whose outlines anyone would recognise.
// Together these take a Swiss canton from 19–36 points to 31–53, the whole set
// from 133k points to 207k, and the file from 2.5 MB to 4.0 MB.
const SIMPLIFY_FRACTION = Number(process.env.SIMPLIFY_FRACTION ?? 0.012);
const SIMPLIFY_MIN_DEG = Number(process.env.SIMPLIFY_MIN_DEG ?? 0.003); // ~330 m
const SIMPLIFY_MAX_DEG = Number(process.env.SIMPLIFY_MAX_DEG ?? 0.03); //  ~3.3 km
// A piece of a multipolygon smaller than this share of the region's largest
// piece is a rock, a sandbank or a rounding artefact. The largest piece is
// always kept, so no region can vanish.
const MIN_PART_SHARE = 0.004;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', 'regions.json');

const round = (n) => +n.toFixed(DECIMALS);

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

/** How hard to thin one shape: a fraction of its own size, clamped. */
function toleranceFor(geometry) {
  const raw = bboxOfGeometry(geometry);
  const diag = Math.hypot(raw[2] - raw[0], raw[3] - raw[1]);
  return Math.min(SIMPLIFY_MAX_DEG, Math.max(SIMPLIFY_MIN_DEG, diag * SIMPLIFY_FRACTION));
}

// --- Countries organised one level above Natural Earth's "admin-1" ------------
// Natural Earth files Italy's 110 *province* as its admin-1 units, which is a
// level below the one the country is actually organised into and a level below
// what anyone means by "which parts of Italy have I been to". The answer people
// want is the twenty regioni — Toscana, Lombardia, Sicilia — and Natural Earth
// already knows which regione each province belongs to (`region`, with the ISO
// code in `region_cod`), so they can simply be dissolved together.
//
// It fixes the detailed boundaries at the same time, which is the other half of
// the reason. `server/regions-fine.js` picks a geoBoundaries level by unit
// count, and their hierarchy for Italy is ADM1 = 5 macro-regions, ADM2 = the 20
// regioni, ADM3 = 107 provinces. At 110 units we paired against ADM3, which is
// the finest thing they have and a poor match (107 against 110). At 20 we pair
// against ADM2 exactly, and their names are the local ones, so all twenty pair
// by name rather than falling through to the geometry test.
//
// One country, by explicit code, rather than "dissolve wherever `region` is
// set": the field is populated for plenty of countries where admin-1 is already
// the right level, and folding those together would be silently answering a
// different question than the one asked.
const DISSOLVE_BY_REGION = new Set(['ITA']);

// --- …and countries whose admin-1 units come from the detailed source instead --
//
// Dissolving fixes a country whose units are *finer* than the level anyone
// means. It cannot fix one whose units do not exist in the detailed data at all,
// and two countries are in exactly that position:
//
//   - **Hungary.** Natural Earth counts the 23 city-counties as admin-1 units
//     alongside the 19 counties and Budapest, which is 43. Nobody else models it
//     that way: geoBoundaries has 19 counties, with Budapest inside Pest, and so
//     do the national statistics. Eighteen of our 43 paired and the rest would
//     have seamed, so the whole country kept the overview geometry for ever.
//   - **Luxembourg.** Our three units are the districts, which the country
//     abolished in 2015. The detailed set has the twelve cantons. Nothing pairs
//     at all: not one name, and three shapes against twelve.
//
// So for these, the detailed set *is* the answer to "what are this country's
// regions", and the overview shapes are built by simplifying it rather than by
// pairing against it. Everything then agrees by construction: the names are the
// same names, so the runtime pairing is exact, and the country finally sharpens
// like its neighbours.
//
// The price is stated plainly because somebody will notice it: Hungary no
// longer has Budapest as a region of its own. A day in Budapest lights Pest,
// which is what every source with real boundaries says it is. Forty-three
// units nothing can draw is the alternative.
const REPLACE_FROM_FINE = new Map([['HUN', 'ADM1'], ['LUX', 'ADM1']]);
// Their names carry the word for the unit; ours carry the bare name and let
// `regionTerm` in src/regions.js supply the word. "Canton Echternach" would
// otherwise show up as "Canton Echternach Canton" in the search box.
const TERM_PREFIX = /^(Canton|County|Province|District|Region|Governorate|Department)\s+/;

/**
 * Swap in one country's detailed units, simplified the same way everything else
 * here is.
 *
 * Fails the build rather than skipping a country: a silent skip writes a
 * regions.json that looks complete, ships the units this exists to replace, and
 * is indistinguishable from a successful run until somebody zooms in.
 */
async function replaceFromFine(features) {
  if (!REPLACE_FROM_FINE.size) return features;
  const kept = [];
  const countryOf = new Map();
  const dropped = new Map();
  for (const f of features) {
    const iso = f.properties?.adm0_a3 ?? f.properties?.iso_a3 ?? f.properties?.sov_a3 ?? null;
    if (!iso || !REPLACE_FROM_FINE.has(iso)) {
      kept.push(f);
      continue;
    }
    // What Natural Earth calls the country, so region ids keep their prefix and
    // nothing else in the app has to know this happened.
    if (!countryOf.has(iso)) countryOf.set(iso, f.properties?.admin ?? f.properties?.geonunit ?? iso);
    dropped.set(iso, (dropped.get(iso) ?? 0) + 1);
  }
  for (const [iso, level] of REPLACE_FROM_FINE) {
    const country = countryOf.get(iso);
    if (!country) {
      console.error(`${iso} is not in the source at all — nothing to replace, and no name to file it under.`);
      process.exit(1);
    }
    const res = await fetch(fineFileUrl(iso, level));
    if (!res.ok) {
      console.error(`${iso} ${level}: ${res.status} ${res.statusText} — refusing to fall back to the units this replaces.`);
      process.exit(1);
    }
    const geo = await res.json();
    let n = 0;
    for (const f of geo.features ?? []) {
      const name = String(f.properties?.shapeName ?? '').replace(TERM_PREFIX, '').trim();
      if (!name || !f.geometry) continue;
      kept.push({
        type: 'Feature',
        properties: { name, admin: country, adm0_a3: iso, type_en: level },
        geometry: f.geometry,
      });
      n++;
    }
    if (!n) {
      console.error(`${iso} ${level}: the file has no usable features.`);
      process.exit(1);
    }
    console.log(`  ${iso}: ${dropped.get(iso)} Natural Earth units replaced by ${n} from geoBoundaries ${level}`);
  }
  return kept;
}
// Natural Earth gives two of the twenty in English where it gives the other
// eighteen in Italian. `name` is documented as the local short form throughout
// this file, and using it also lands both on the name geoBoundaries uses.
const REGION_NAME_OVERRIDES = { 'IT-75': 'Puglia', 'IT-82': 'Sicilia' };

/**
 * Drop the holes a dissolve opened that are nowhere, keeping the ones that are
 * somewhere — in place, on the union's own coordinates.
 *
 * Natural Earth's Italian provinces do not quite meet at several tripoints, so
 * merging them leaves 5–13 km² holes inland: two in the Apennines, one in
 * Sicily, one in Basilicata. They are gaps in the source's coverage, and by
 * shape they are indistinguishable from a real enclave — that is the lesson
 * `unionGeometries` is annotated with, where a 4.4 km² artifact turned out to be
 * rounder than Llívia, which is a real Spanish town.
 *
 * Here, though, the question can be answered instead of guessed. A dissolve
 * knows what it merged, so a hole can be offered to the rest of the dataset: if
 * any other unit claims that ground it is a place and stays a hole (San Marino
 * and the Vatican are their own admin-1 features and are found this way), and if
 * nobody claims it at all it is ground the source simply failed to cover.
 */
/** A point provably inside one ring, or null if none was found. */
function pointInRing(ring) {
  const n = ring.length - 1; // the last vertex repeats the first
  if (n < 3) return null;
  let x = 0;
  let y = 0;
  for (let k = 0; k < n; k++) {
    x += ring[k][0];
    y += ring[k][1];
  }
  const mean = [x / n, y / n];
  if (inPolygon(mean[0], mean[1], [ring])) return mean;
  // Convex enough is not guaranteed, so fall back to diagonal midpoints.
  for (let a = 0; a < n; a++) {
    for (let b = a + 2; b < n; b++) {
      const mx = (ring[a][0] + ring[b][0]) / 2;
      const my = (ring[a][1] + ring[b][1]) / 2;
      if (inPolygon(mx, my, [ring])) return [mx, my];
    }
  }
  return null;
}

function dropCoverageGaps(fill, allFeatures, members) {
  for (const poly of fill) {
    for (let i = poly.length - 1; i >= 1; i--) {
      const ring = poly[i];
      // A point provably inside the hole. Not the vertex mean on its own: this
      // runs on the *raw* union, where the gap at the Marche tripoint is fifteen
      // points rather than the four it simplifies down to, and a mean can fall
      // outside a shape that bends. A hole no point can be found in is left
      // alone rather than judged on a guess.
      const at = pointInRing(ring);
      if (!at) continue;
      const [x, y] = at;
      let claimed = false;
      for (const f of allFeatures) {
        if (members.has(f) || !f.geometry) continue;
        for (const p of asMulti(f.geometry)) {
          if (inPolygon(x, y, p)) {
            claimed = true;
            break;
          }
        }
        if (claimed) break;
      }
      if (!claimed) poly.splice(i, 1);
    }
  }
}

/**
 * Replace each dissolving country's admin-1 features with one feature per
 * `region`, its parts unioned together.
 *
 * Deliberately before any simplification. Natural Earth's provinces share exact
 * vertices along the borders between them, so the union closes cleanly; thinning
 * each province first would let two neighbours round the same border to
 * different points and open a gap at every crossing — the failure documented
 * against `unionGeometries` in src/polygon.js.
 */
function dissolveByRegion(features) {
  const groups = new Map();
  const out = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const iso = p.adm0_a3 ?? p.iso_a3 ?? p.sov_a3 ?? null;
    if (!iso || !DISSOLVE_BY_REGION.has(iso) || !p.region || !f.geometry) {
      out.push(f);
      continue;
    }
    const key = `${iso}/${p.region_cod ?? p.region}`;
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = {
        properties: { ...p, name: REGION_NAME_OVERRIDES[p.region_cod] ?? p.region, type_en: 'Region' },
        geoms: [],
        tolerances: [],
        members: new Set(),
      }));
    }
    g.members.add(f);
    // Speck-filtered here, against the province, and not again afterwards.
    // MIN_PART_SHARE is a share of the region's *largest* part, so merging
    // moves the goalposts: Capri is 0.9% of the province of Napoli and 0.08% of
    // Campania. Applying it after the dissolve quietly deleted ten Italian
    // islands — the country's outline went from 15 polygons to 5.
    g.geoms.push(dropSpecks(asMulti(f.geometry)));
    g.tolerances.push(toleranceFor(f.geometry));
  }
  for (const g of groups.values()) {
    const { fill } = unionGeometries(g.geoms);
    if (!fill.length) continue;
    dropCoverageGaps(fill, features, g.members);
    // Simplified as finely as the provinces it is made of, not as coarsely as
    // the shape it became.
    //
    // The tolerance is normally a fraction of a region's own bounding box, so
    // merging twelve Lombard provinces into Lombardia takes it from ~0.008° to
    // the 0.03° clamp and thins the *coastline* four times over — the first cut
    // of this took Italy from 4,046 points to 1,015, fewer than Germany's
    // sixteen Länder for a far more intricate outline, and it looked exactly
    // like what it was: Italy alone drawn badly.
    //
    // Nothing about the coast changed when the administrative lines inland were
    // dissolved, so neither should its fidelity. The finest of the parts rather
    // than their median, because the median still thins the coastline — Italy's
    // outline went from a 4.40 km median segment to 5.92 km on it. This is the
    // only setting under which no stretch of coast is drawn worse than it was
    // before the dissolve, and it costs one country a few thousand points.
    g.properties.dissolvedTolerance = Math.min(...g.tolerances);
    out.push({ type: 'Feature', properties: g.properties, geometry: { type: 'MultiPolygon', coordinates: fill } });
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
const sourceFeatures = await replaceFromFine(dissolveByRegion(geo.features));
for (const iso of DISSOLVE_BY_REGION) {
  const before = geo.features.filter((f) => (f.properties?.adm0_a3 ?? f.properties?.iso_a3) === iso).length;
  const after = sourceFeatures.filter((f) => (f.properties?.adm0_a3 ?? f.properties?.iso_a3) === iso).length;
  console.log(`  ${iso}: dissolved ${before} admin-1 units into ${after} regions`);
}

const regions = [];
const seen = new Map(); // "country/name" → how many, so duplicates get numbered
for (const f of sourceFeatures) {
  const p = f.properties ?? {};
  // `name` is the local short form ("Bern", "Île-de-France"); the fallbacks are
  // for the handful of features that leave it null.
  const name = p.name ?? p.name_en ?? p.gn_name ?? p.woe_name ?? null;
  const country = p.admin ?? p.geonunit ?? p.sov_a3 ?? null;
  if (!name || !country || !f.geometry) continue;
  // The ISO3 code, so the app can ask geoBoundaries for this country's detailed
  // boundaries when someone zooms in far enough to see the difference.
  const iso = p.adm0_a3 ?? p.iso_a3 ?? p.sov_a3 ?? null;

  // Sized from the raw geometry, before anything is thinned — except for a
  // region that was dissolved from smaller ones, which keeps theirs.
  const tol = p.dissolvedTolerance ?? toleranceFor(f.geometry);

  let geometry;
  if (f.geometry.type === 'Polygon') {
    const rings = processRings(f.geometry.coordinates, tol);
    if (!rings.length) continue;
    geometry = { type: 'Polygon', coordinates: rings };
  } else if (f.geometry.type === 'MultiPolygon') {
    const processed = f.geometry.coordinates.map((poly) => processRings(poly, tol)).filter((poly) => poly.length);
    // A dissolved region had its specks dropped per source unit, before the
    // union — doing it again here would measure each island against the whole
    // merged region and delete it.
    const polys = p.dissolvedTolerance != null ? processed : dropSpecks(processed);
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
    iso,
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
