#!/usr/bin/env node
// Downloads the world's airports, trims them hard, and writes one
// src/airports-*.json per group.
//
//   node scripts/build-airports.mjs      (or: npm run build:airports)
//
// The source is **OurAirports**, which is a public-domain dataset rather than an
// API — and that is the whole design decision, so it is worth saying why here
// rather than only in ARCHITECTURE.md.
//
// The obvious way to draw airports is the way the railways are drawn: ask
// somebody's server per viewport. That cost this project a 584-line caching
// proxy, a rate-limit policy, a per-zoom health monitor and a banner apologising
// for an outage — all of it correct, and all of it the price of geometry that is
// genuinely too big to ship (OpenRailwayMap is every siding on Earth). Airports
// are not that. There are 85,835 of them including the closed ones, they are
// points rather than geometry, and the whole set is smaller than the region
// boundaries this repo already commits. Fetching it forever, from a server that
// can be down, to avoid shipping it once is the wrong trade — and shipping it
// means the overlay works offline, which the rest of the app cares about.
//
// So: no key, no proxy, no quota, no third party to be polite to at runtime.
// Re-run only to refresh the data; the output is committed so normal installs
// and builds need no network access (same deal as build-places.mjs).
//
// The upstream file is rebuilt daily from the live OurAirports database and is
// dedicated to the public domain, so there is no attribution obligation — the
// app carries a credit anyway, because a dataset this good deserves the traffic.
//
// **One file per group, and that is the other half of the design.** All 85,835
// of them are 2.6 MB gzipped, which is a great deal to spend on a switch — and
// almost all of it is the long tail: 42,707 small airfields, 23,143 helipads on
// hospital roofs, 13,378 closed. The 5,272 places an airline flies to are 250 KB.
// Measured per field, nothing is trimmable — the bytes *are* the names and the
// coordinates — so the saving has to come from not fetching what is not drawn.
// Splitting on the group boundary means the byte cost lands exactly where the
// switch is, the same way the rail overlay fetches a sprite atlas only if a
// switched-on group draws from it.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://davidmegginson.github.io/ourairports-data';
const AIRPORTS_URL = `${BASE}/airports.csv`;
const RUNWAYS_URL = `${BASE}/runways.csv`;

// ~11 m at the equator. An airport is a point standing for a couple of square
// kilometres of concrete; more precision than this is dead weight ×86,000.
const DECIMALS = 4;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src');

// --- What each kind is, in one character --------------------------------------
//
// The tuple below is read 86,000 times by a browser, so the type is a letter
// rather than the word `large_airport`. `src/airports.js` holds the other half
// of this mapping and the test asserts the two agree — a letter nobody can
// decode is worse than the bytes it saved.
const KINDS = {
  large_airport: 'L',
  medium_airport: 'M',
  small_airport: 'S',
  heliport: 'H',
  seaplane_base: 'W',
  balloonport: 'B',
  closed: 'X',
};

// --- Which kinds travel together ----------------------------------------------
//
// The group is the unit of *both* the switch and the download, so this table
// decides which file each airport lands in as well as what the dialog offers.
// `src/airports.js` holds the labels and the loaders and the test asserts the
// two key sets agree — a file nothing imports is a group that silently does not
// exist.
//
// The split is by what somebody means by the word. "Airport" is a place an
// airline flies to and there are five thousand of them; everything else is
// aviation infrastructure, which is real, correctly mapped, and — exactly like
// the railway's sidings and yard roads — several times as much ink as the thing
// you switched the layer on to see.
const GROUPS = [
  ['airline', ['L', 'M']],
  ['airfields', ['S', 'W', 'B']],
  ['helipads', ['H']],
  ['closed', ['X']],
];

const groupOf = (kind) => GROUPS.find(([, kinds]) => kinds.includes(kind))?.[0];

// --- Surfaces -----------------------------------------------------------------
//
// 650 distinct spellings for about eight materials: `ASP`, `ASPH`, `Asphalt`,
// `asp`, `ASPH-G`, `ASPH/ CONC`. They are typed by whoever filed the airport and
// nobody has ever normalised them, which is fine for a database and no good at
// all on a card that claims to say what the runway is made of.
//
// Matched on a prefix of the upper-cased string after the punctuation is taken
// out, longest pattern first, so `CONC` cannot be claimed by `CON` — they happen
// to agree here, but the next pair will not. Anything unrecognised becomes null
// rather than being printed raw: "PIÇARRA" is a real surface (compacted laterite)
// and showing it to someone who wants to know if it is paved says nothing.
const SURFACES = [
  [['ASPH', 'ASP', 'BIT', 'TAR', 'PEM', 'PAVED', 'MAC'], 'Asphalt'],
  [['CONC', 'CON', 'PSP', 'CEM'], 'Concrete'],
  [['GRASS', 'GRS', 'GRE', 'TURF', 'SOD', 'GRAS'], 'Grass'],
  [['GRAVEL', 'GVL', 'GRVL', 'GRV', 'COP', 'CORAL', 'LATERITE'], 'Gravel'],
  [['DIRT', 'EARTH', 'CLAY', 'SOIL', 'GROUND', 'NAT', 'SAND'], 'Dirt'],
  [['WATER', 'WAT'], 'Water'],
  [['SNOW', 'ICE', 'GLACIER'], 'Snow or ice'],
  [['MATS', 'MAT', 'METAL', 'ALUMINIUM', 'ALUMINUM', 'STEEL'], 'Matting'],
  [['WOOD', 'DECK', 'ROOF', 'CONCRETE/ROOF'], 'Deck'],
];

/** One of the eight materials above, or null for "nobody wrote one down". */
export function normaliseSurface(raw) {
  const text = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!text) return null;
  // Longest pattern first across the whole table, so a short code cannot claim a
  // longer one's string. Sorted once per call is wasteful and this runs 47,000
  // times at build time, which is nothing.
  const all = SURFACES.flatMap(([codes, label]) => codes.map((c) => [c, label]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [code, label] of all) if (text.startsWith(code)) return label;
  return null;
}

// --- CSV ----------------------------------------------------------------------
//
// Hand-rolled rather than a dependency: this repo has three runtime dependencies
// and a build script is not the place to add a fourth. OurAirports quotes any
// field containing a comma or a quote and doubles quotes inside them, which is
// RFC 4180 and is all this has to understand — but names genuinely contain
// newlines inside quotes ("Nyaung U\nAirport"), so the scan is character by
// character rather than line by line.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// --- Runways ------------------------------------------------------------------

/**
 * What each airport's runways add up to, as the card asks it.
 *
 * Not the runways themselves. The full table is 47,000 rows and the questions a
 * card answers are "how many" and "how big is the biggest" — a list of every
 * threshold identifier and displaced-threshold offset is an aviation chart, not
 * a map popup. The longest runway is the one that decides what can land, so it
 * is the one whose surface and lighting are kept.
 *
 * Closed runways are dropped, including at airports that are otherwise open: a
 * field with one runway left open and two lifted has one runway.
 */
function runwaySummaries(rows) {
  const byAirport = new Map();
  for (const r of rows) {
    if (r.closed === '1') continue;
    const key = r.airport_ident;
    if (!key) continue;
    const feet = Number(r.length_ft) || 0;
    const found = byAirport.get(key) ?? { count: 0, longest: 0, surface: null, lit: false };
    found.count++;
    // `lighted` is per runway and the summary is about the airport, so any lit
    // runway makes it a field you can land at after dark.
    if (r.lighted === '1') found.lit = true;
    if (feet > found.longest) {
      found.longest = feet;
      found.surface = normaliseSurface(r.surface);
    }
    byAirport.set(key, found);
  }
  return byAirport;
}

// --- The tuple ----------------------------------------------------------------
//
// Field order is fixed and mirrored by `AIRPORT_FIELDS` in src/airports.js. An
// array rather than an object per record because the keys would otherwise be
// repeated 86,000 times — 5.6 MB against 14 MB, before gzip.
//
// Ordered by kind and then by country, which is not cosmetic: it puts the two
// lowest-cardinality columns into long runs, and gzip is a great deal happier
// about `"L","L","L"` than about the same letters scattered. Collision order on
// the map is set with `symbol-sort-key` rather than by source order, so nothing
// visual depends on this.
const ORDER = ['L', 'M', 'S', 'W', 'B', 'H', 'X'];

const round = (n) => +(+n).toFixed(DECIMALS);

/** A wikipedia URL as just its title, or null. Restored by the client. */
function wikiTitle(url) {
  const m = /^https?:\/\/en\.wikipedia\.org\/wiki\/(.+)$/.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

function build(airports, runways) {
  const summaries = runwaySummaries(runways);
  const out = [];
  const counts = {};
  for (const a of airports) {
    const kind = KINDS[a.type];
    // A type nobody has taught this script about is a build failure rather than
    // a silent omission: OurAirports adding a category should be a decision
    // somebody makes, not an airport that quietly stops being drawn.
    if (!kind) throw new Error(`Unknown airport type ${JSON.stringify(a.type)} (${a.ident})`);
    const lng = Number(a.longitude_deg);
    const lat = Number(a.latitude_deg);
    // A handful of records carry an empty or nonsense coordinate. They cannot be
    // drawn and a NaN in a GeoJSON source is a source that fails to parse.
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const rw = summaries.get(a.ident);
    const elevation = a.elevation_ft === '' ? null : Number(a.elevation_ft);
    out.push([
      round(lng),
      round(lat),
      kind,
      a.name ?? '',
      a.iata_code ?? '',
      // The published ICAO code where there is one, and otherwise whatever code
      // the airport is actually known by — `gps_code` for most of the world,
      // `local_code` for a US field with neither. `ident` is OurAirports' own
      // key and is one of the three, so it is not stored separately.
      a.icao_code || a.gps_code || a.local_code || '',
      a.municipality ?? '',
      a.iso_country ?? '',
      Number.isFinite(elevation) ? Math.round(elevation) : null,
      a.scheduled_service === 'yes' ? 1 : 0,
      rw?.count ?? 0,
      rw?.longest ?? 0,
      rw?.surface ?? '',
      rw?.lit ? 1 : 0,
      wikiTitle(a.wikipedia_link) ?? '',
      String(a.home_link ?? '').trim(),
    ]);
  }
  out.sort((x, y) => (ORDER.indexOf(x[2]) - ORDER.indexOf(y[2]))
    || String(x[7]).localeCompare(String(y[7]))
    || String(x[3]).localeCompare(String(y[3])));
  return { rows: out, counts };
}

async function main() {
  process.stdout.write('Fetching OurAirports…\n');
  const [airportsCsv, runwaysCsv] = await Promise.all([
    download(AIRPORTS_URL),
    download(RUNWAYS_URL),
  ]);
  const airports = parseCsv(airportsCsv);
  const runways = parseCsv(runwaysCsv);
  process.stdout.write(`  ${airports.length} airports, ${runways.length} runways\n`);

  const { rows, counts } = build(airports, runways);

  for (const [key, kinds] of GROUPS) {
    const mine = rows.filter((r) => kinds.includes(r[2]));
    const json = {
      // What this is and where it came from, in the file rather than only in a
      // build script somebody would have to go and find.
      attribution: 'OurAirports',
      attributionUrl: 'https://ourairports.com/data/',
      group: key,
      // No timestamp. A rebuild against unchanged upstream data should reproduce
      // the file byte for byte, the same rule build-rail-style.mjs follows, so a
      // diff means the world changed rather than that the clock did.
      airports: mine,
    };
    const file = path.join(outDir, `airports-${key}.json`);
    const text = JSON.stringify(json);
    writeFileSync(file, text);
    process.stdout.write(
      `  ${path.relative(root, file).padEnd(30)} ${String(mine.length).padStart(6)} airports  ${String((text.length / 1024) | 0).padStart(5)} KB\n`,
    );
  }
  const missing = Object.keys(counts).filter((k) => !groupOf(k));
  if (missing.length) throw new Error(`No group claims kind(s): ${missing.join(', ')}`);

  // How many are behind each switch, in a file small enough to import
  // unconditionally. The dialog says the number because here — unlike the
  // railway, whose groups filter tiles that arrive anyway — switching a group on
  // is a download, and a cost you cannot see is a cost you cannot weigh. Written
  // by the build rather than typed into the dialog, so it cannot drift from the
  // files it describes.
  const countsFile = path.join(outDir, 'airports-counts.json');
  writeFileSync(countsFile, JSON.stringify(Object.fromEntries(
    GROUPS.map(([key, kinds]) => [key, kinds.reduce((n, k) => n + (counts[k] ?? 0), 0)]),
  )));
  process.stdout.write(`  ${path.relative(root, countsFile)}\n`);
}

// Importable for the test without running the download.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exit(1);
  });
}

export { parseCsv, build, runwaySummaries, KINDS, GROUPS, groupOf, wikiTitle };
