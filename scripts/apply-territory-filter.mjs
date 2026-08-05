#!/usr/bin/env node
// Re-applies the detached-territory filter (src/geo-filter.js) to the
// already-committed src/countries.json, in place — no network download needed.
//
//   node scripts/apply-territory-filter.mjs
//
// build-countries.mjs applies the same filter, so a fresh `npm run build:countries`
// already produces filtered output and running this afterward is a no-op. Use
// this to (re)trim the existing data without re-downloading Natural Earth.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripDetachedTerritories, bboxOfGeometry, OVERSEAS_GAP_DEG } from '../src/geo-filter.js';

const DECIMALS = 2;
const round = (n) => +n.toFixed(DECIMALS);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'countries.json');

const countries = JSON.parse(readFileSync(file, 'utf8'));

const partsOf = (g) => (g.type === 'MultiPolygon' ? g.coordinates.length : 1);

let changed = 0;
let droppedParts = 0;
for (const c of countries) {
  const before = partsOf(c.geometry);
  const g = stripDetachedTerritories(c.geometry);
  const after = partsOf(g);
  if (after !== before) {
    changed++;
    droppedParts += before - after;
    c.geometry = g;
    c.bbox = bboxOfGeometry(g).map(round);
  }
}

writeFileSync(file, JSON.stringify(countries));
console.log(
  `Filtered at ${OVERSEAS_GAP_DEG}° gap: trimmed ${changed} countries, ` +
    `dropped ${droppedParts} detached parts → ${path.relative(root, file)}`,
);
