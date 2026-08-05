// Continents — the coarsest zoom level, one step out from countries.
//
// There is no continent boundary file. A continent is the countries inside it
// dissolved together (src/countries.json, which is already loaded by the time
// this level can be reached), so the two coarsest steps of the map are cut from
// exactly the same coastline: a separate outline set would disagree with it
// somewhere along every coast, and that shows as a sliver of ocean at one zoom
// level and land at the next. Only the membership is committed
// (src/continent-map.js, built by scripts/build-continents.mjs) — 2 KB, so it
// is imported outright rather than split out like the boundaries themselves.
//
// What this level is *for* is the count on each shape. "Which continents have I
// set foot on" is a question with a seven-item answer that a world map already
// tells you; "how many countries of each" is the one worth zooming out to ask.
import ISOS_BY_CONTINENT from './continent-map.js';
import { allCountries, countryAreaKm2 } from './countries.js';
import { asMulti, unionGeometries } from './polygon.js';

// Inverted once, at module scope: the generated file is grouped by continent
// because that is the shape a human reads a diff of, and every lookup here goes
// the other way.
const CONTINENT_BY_ISO = new Map();
for (const [name, isos] of Object.entries(ISOS_BY_CONTINENT)) {
  for (const iso of isos) CONTINENT_BY_ISO.set(iso, name);
}

// Where each name is drawn. Chosen by hand rather than taken from the union's
// centroid: a continent is a mainland plus a scatter of islands, and the
// centroid of that lands in the sea often enough (and in the wrong sea) that
// hand-placing seven points is both shorter and better.
const ANCHORS = {
  Africa: [21, 2],
  Antarctica: [12, -76],
  Asia: [92, 44],
  Europe: [20, 52],
  'North America': [-101, 46],
  Oceania: [138, -25],
  'South America': [-59, -13],
};

// Country name → continent, and the countries of each. Built once, the first
// time anything asks — the country dataset arrives lazily, so this cannot be
// done at module scope.
let byName = null;
let members = null;

function index() {
  if (byName && byName.size) return;
  byName = new Map();
  members = new Map();
  for (const c of allCountries()) {
    const name = c.iso ? CONTINENT_BY_ISO.get(c.iso) : null;
    if (!name) continue;
    byName.set(c.id, name);
    const list = members.get(name) ?? [];
    list.push(c);
    members.set(name, list);
  }
}

/** The continent a country (by the name the rest of the app uses) is in. */
export function continentOf(countryId) {
  index();
  return byName.get(countryId) ?? null;
}

/** How many countries the dataset puts in it — the denominator of "12 of 50". */
export function countriesInContinent(name) {
  index();
  return members.get(name)?.length ?? 0;
}

// Dissolving 58 African countries costs ~25 ms and dissolving all seven
// continents ~200 ms, so each is held once it has been built. Cleared with the
// country memos when the dataset itself is reloaded.
const geomMemo = new Map();

/** One continent's outline: its countries with the borders between them gone. */
export function continentGeometry(name) {
  if (geomMemo.has(name)) return geomMemo.get(name);
  index();
  const list = members.get(name);
  let geometry = null;
  if (list?.length) {
    const { fill } = unionGeometries(list.map((c) => asMulti(c.geometry)));
    if (fill.length) geometry = { type: 'MultiPolygon', coordinates: fill };
  }
  geomMemo.set(name, geometry);
  return geometry;
}

/** Land area, summed from the countries — the same arithmetic the panel uses. */
export function continentAreaKm2(name) {
  index();
  let km2 = 0;
  for (const c of members.get(name) ?? []) km2 += countryAreaKm2(c.id);
  return km2;
}

/**
 * Dissolve the lit continents into one shape, the way `mergeCountries` does for
 * the level below. One union over every country involved rather than seven
 * unions and then an eighth: the borders all have to go either way, and the
 * clipper does not care which continent a polygon came from.
 */
export function mergeContinents(litNames) {
  index();
  if (!litNames.size) return { fill: [], rings: [] };
  const geoms = [];
  for (const name of litNames) {
    for (const c of members.get(name) ?? []) geoms.push(asMulti(c.geometry));
  }
  return unionGeometries(geoms);
}

/** Where to draw the label, or null for a continent nobody named a spot for. */
export const continentAnchor = (name) => ANCHORS[name] ?? null;

/** Forget the dissolved outlines — the country dataset underneath them moved. */
export function forgetContinents() {
  byName = null;
  members = null;
  geomMemo.clear();
}
