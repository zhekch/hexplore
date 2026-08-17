#!/usr/bin/env node
// Bakes location exports into src/imported-cells.json, which the server merges
// once into the IMPORT_OWNER account (see server/index.js).
//
// This is the offline path — the app itself has an importer in the base-map
// menu ("Import locations") that does the same thing for any account, without
// touching the repo. Use this one to seed your own account on first run.
//
//   1. Drop the export files into ./import  (KML, GPX, GeoJSON, CSV, JSON)
//   2. node scripts/import-locations.mjs       (or: npm run import)
//   3. Restart the app — the cells merge into your visited set once.
//
// All parsing lives in src/locations.js, shared with the in-app importer, so
// both agree on formats, dates and cell ids.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocationFile, pointsToCells, sourceLabel } from '../src/locations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importDir = path.resolve(process.argv[2] ?? path.join(root, 'import'));
const outFile = path.join(root, 'src', 'imported-cells.json');

const EXTS = /\.(json|geojson|kml|gpx|xml|csv|tsv|txt)$/i;

let files;
try {
  files = readdirSync(importDir).filter((f) => EXTS.test(f));
} catch {
  console.error(`Import folder not found: ${importDir}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`No location exports in ${importDir} — drop your files there first.`);
  process.exit(1);
}

// Files are grouped by the format they were detected as, so each source keeps
// its own provenance in the output.
const bySource = new Map();
let totalPoints = 0;

for (const f of files) {
  let parsed;
  try {
    parsed = parseLocationFile(f, readFileSync(path.join(importDir, f), 'utf8'));
  } catch (err) {
    console.error(`skipping ${f}: ${err.message}`);
    continue;
  }
  if (!parsed.points.length) {
    console.error(`skipping ${f}: ${parsed.error ?? 'no coordinates found'}`);
    continue;
  }
  const group = bySource.get(parsed.source) ?? [];
  group.push(...parsed.points);
  bySource.set(parsed.source, group);
  totalPoints += parsed.points.length;
  console.log(`${f}: ${parsed.points.length} fixes → ${sourceLabel(parsed.source)}`);
}

// detail rows: [cellId, source, firstAt, lastAt, hits, fixes] (epoch seconds,
// 0 = no date in the file; `hits` counts separate visits, `fixes` the raw
// points behind them). `cells` stays a plain id list for older readers.
const detail = [];
const ids = new Set();
for (const [source, points] of bySource) {
  const cells = pointsToCells(points);
  for (const c of cells) {
    detail.push([c.id, source, c.first, c.last, c.hits, c.fixes]);
    ids.add(c.id);
  }
  console.log(`  ${sourceLabel(source)}: ${cells.length} cells`);
}
detail.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

writeFileSync(
  outFile,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    points: totalPoints,
    cells: [...ids].sort(),
    detail,
  }),
);
console.log(
  `${totalPoints} fixes → ${ids.size} unique level-0 cells → ${path.relative(root, outFile)}`,
);
console.log('Restart the app to merge them into your visited set.');
// Saved routes are an in-app feature: they need somewhere to live per account,
// and this file is only ever merged into IMPORT_OWNER's cells.
if ([...bySource.keys()].some((s) => s === 'gpx' || s === 'kml' || s === 'geojson')) {
  console.log('Note: tracks are only kept as saved routes when imported from inside the app.');
}
