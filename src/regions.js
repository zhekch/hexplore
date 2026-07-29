// Admin-1 regions — states, provinces, cantons, départements — for the finer
// half of the coverage statistics.
//
// Countries answer "where in the world have I been"; this answers "how much of
// where I live". Twenty-three of a hundred and ninety-five is a number that
// moves once a year and never for the country you actually live in;
// Switzerland is one country and twenty-six cantons, and that number moves on a
// weekend.
//
// The dataset (src/regions.json, built by scripts/build-regions.mjs) is ~2.5 MB
// and dynamic-imported, so nothing pays for it until the statistics panel is
// opened on a section that needs it.
//
// It is also fourteen times as many shapes as the country set, which is why
// there's a grid index below: the country lookup can afford to scan its ~250
// bboxes for every one of ~20k cells, and this one cannot.

import { inPolygon, asMulti, ringAreaM2, unionGeometries } from './polygon.js';

let REGIONS = null; // [{ id, name, country, bbox:[w,s,e,n], geometry }]
let index = null; //   "gx/gy" → region indices whose bbox touches that tile
let loading = null;

// Detailed boundaries, fetched one country at a time.
//
// Natural Earth cannot supply these at any tolerance: even its raw 10m geometry
// gives the canton of Solothurn 276 points, where the national survey gives
// 6,951. Simplifying our own copy less does not help — the detail was never in
// the source. So the overview set stays Natural Earth (small, global, good
// enough for a level that normally lives at z4–5), and when someone zooms in far
// enough to see a boundary cut a straight line across the lake it actually
// follows, the real thing is fetched for the countries on screen and nothing
// else.
//
// This is the app's one runtime geometry fetch. It is the same class of thing as
// a basemap tile — a public boundary file, requested by country code — and no
// user data goes with it: the request says "Switzerland", not where you have
// been. Everything about *your* map stays where it was.
//
// geoBoundaries (gbOpen, CC BY 4.0) composites national survey data; the Swiss
// boundaries here are swisstopo's.
//
// Two things about this URL are deliberate. The commit is pinned, because the
// data should not change under a running map and pinned data is reproducible —
// refresh it from https://www.geoboundaries.org/api/current/gbOpen/. And it is
// the *media* host rather than github.com or jsDelivr: these files are stored in
// Git LFS, so every other route returns a 131-byte pointer instead of a
// boundary, and github.com's own /raw/ redirect cannot be read cross-origin at
// all. media.githubusercontent.com serves the real bytes with CORS.
const GB_COMMIT = '9469f09';
const gbFile = (iso, level) =>
  `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/${GB_COMMIT}/releaseData/gbOpen/${iso}/${level}/geoBoundaries-${iso}-${level}_simplified.geojson`;
// The API is only asked how many units a level has — a 1.7 KB answer that saves
// downloading the wrong file.
const gbApi = (iso, level) => `https://www.geoboundaries.org/api/current/gbOpen/${iso}/${level}/`;

// "Admin-1" does not mean the same thing in the two datasets, and the difference
// is not a detail — it is the difference between a sharper canton and a fifth of
// Italy colouring in.
//
// Natural Earth's admin-1 is provinces for Italy (110) and départements for
// France (101). geoBoundaries' gbOpen hierarchy is shifted for both: Italy's
// ADM1 has *five* units and its ADM2 has the twenty regions; France's ADM1 has
// thirteen régions and its ADM2 the ninety-six départements. Pairing our 110
// Italian provinces against five macro-regions is what put a fifth of the
// country under one province — geometrically it "matched", because their polygon
// genuinely contains our province's centre.
//
// So the level is chosen by unit count rather than by name: whichever of their
// levels has about as many units as we do is the one describing the same thing.
// France then works (96 against 101) and Italy declines (20 against 110), which
// is the honest answer — geoBoundaries has no Italian provinces to give.
const GB_LEVELS = ['ADM1', 'ADM2'];
// min(a,b)/max(a,b) must be at least this for two levels to be the same idea.
const COUNT_MATCH = 0.6;
// And each individual pair has to be about the same size, so a level that passed
// the count test on average cannot still swap one region for a much bigger one.
const AREA_MATCH = [0.3, 3.2];

let FINE = new Map(); // region id → detailed geometry
const fineDone = new Set(); // iso codes fetched (or failed — don't retry a 404)
const finePending = new Set();

// 5° tiles: ~550 km, comfortably bigger than all but a handful of regions, so
// most land in one or two buckets. Small enough that a bucket holds a few dozen
// candidates rather than a continent's worth.
const TILE = 5;

const tileKey = (lng, lat) => `${Math.floor(lng / TILE)}/${Math.floor(lat / TILE)}`;

function buildIndex() {
  index = new Map();
  for (let i = 0; i < REGIONS.length; i++) {
    const [w, s, e, n] = REGIONS[i].bbox;
    // A bbox spanning the antimeridian would enumerate the globe; the few
    // regions that do (Chukotka) are entered under both ends instead.
    const spans = e < w;
    const xs = spans ? [[-180, e], [w, 180]] : [[w, e]];
    for (const [x0, x1] of xs) {
      for (let gx = Math.floor(x0 / TILE); gx <= Math.floor(x1 / TILE); gx++) {
        for (let gy = Math.floor(s / TILE); gy <= Math.floor(n / TILE); gy++) {
          const key = `${gx}/${gy}`;
          const bucket = index.get(key);
          if (bucket) bucket.push(i);
          else index.set(key, [i]);
        }
      }
    }
  }
}

export const regionsLoaded = () => REGIONS !== null;
/** True once any country's detailed boundaries are in memory. */
export const fineRegionsLoaded = () => FINE.size > 0;
/** Which countries have been asked for already, so nothing is fetched twice. */
export const fineCountryKnown = (iso) => fineDone.has(iso) || finePending.has(iso);

/** Kick off (or reuse) the one-time fetch. Resolves when the data is ready. */
export function loadRegions() {
  if (!loading) {
    loading = import('./regions.json').then((m) => {
      REGIONS = m.default;
      buildIndex();
      return REGIONS;
    });
  }
  return loading;
}

const fold = (v) =>
  String(v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// A point that is definitely inside a ring: the average of its vertices when
// that lands inside, and otherwise a walk across the bounding box until
// something does. Needed because the two datasets name the same place
// differently often enough — Luzern/Lucerne, St. Gallen/Sankt Gallen — that
// names alone cannot be trusted to pair them up.
function pointInside(rings) {
  const outer = rings[0];
  let x = 0;
  let y = 0;
  for (const p of outer) {
    x += p[0];
    y += p[1];
  }
  const mean = [x / outer.length, y / outer.length];
  if (inPolygon(mean[0], mean[1], rings)) return mean;
  let w = Infinity;
  let sN = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of outer) {
    if (p[0] < w) w = p[0];
    if (p[1] < sN) sN = p[1];
    if (p[0] > e) e = p[0];
    if (p[1] > n) n = p[1];
  }
  for (let i = 1; i < 8; i++) {
    for (let j = 1; j < 8; j++) {
      const px = w + ((e - w) * i) / 8;
      const py = sN + ((n - sN) * j) / 8;
      if (inPolygon(px, py, rings)) return [px, py];
    }
  }
  return null;
}

// Square metres of a Polygon/MultiPolygon, holes subtracted.
function geometryAreaM2(g) {
  let a = 0;
  for (const poly of asMulti(g)) {
    a += ringAreaM2(poly[0]);
    for (let i = 1; i < poly.length; i++) a -= ringAreaM2(poly[i]);
  }
  return a;
}

// Which of their levels describes the same thing we do. One small JSON request
// per candidate; null when none of them does.
async function chooseLevel(iso, mine) {
  let best = null;
  for (const level of GB_LEVELS) {
    let count = 0;
    try {
      const res = await fetch(gbApi(iso, level));
      if (!res.ok) continue;
      count = Number((await res.json())?.admUnitCount) || 0;
    } catch {
      continue;
    }
    if (!count) continue;
    const ratio = Math.min(count, mine) / Math.max(count, mine);
    if (!best || ratio > best.ratio) best = { level, count, ratio };
  }
  return best && best.ratio >= COUNT_MATCH ? best : null;
}

/**
 * Fetch one country's detailed boundaries and pair them with our regions.
 *
 * Resolves to how many regions gained detail. Never rejects: a country
 * geoBoundaries describes differently than we do is not an error, it just keeps
 * the overview geometry, and it is remembered so it isn't asked for twice.
 *
 * @param {string} iso  ISO3 country code, from our own region records
 * @param {string} country  the country name, to narrow the pairing lookup
 */
export async function loadFineRegions(iso, country) {
  if (!iso || fineDone.has(iso) || finePending.has(iso)) return 0;
  finePending.add(iso);
  try {
    const mine = regionsInCountry(country);
    if (!mine) return 0;
    const pick = await chooseLevel(iso, mine);
    if (!pick) return 0; // they don't have this country at our granularity

    const res = await fetch(gbFile(iso, pick.level));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geo = await res.json();

    // Name first — it pairs most of them for free — then geometry for the rest.
    const byName = new Map();
    const ours = [];
    for (const r of REGIONS ?? []) {
      if (r.country !== country) continue;
      byName.set(fold(r.name), r.id);
      ours.push(r);
    }

    const claimed = new Map(); // our id → their geometry, one each
    for (const f of geo.features ?? []) {
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
      let id = byName.get(fold(f.properties?.shapeName));
      if (!id) {
        // Ask our own dataset which region a point inside theirs belongs to.
        const polys = asMulti(g);
        let biggest = polys[0];
        for (const poly of polys) if (poly[0].length > biggest[0].length) biggest = poly;
        const pt = pointInside(biggest);
        if (pt) id = regionAt(pt[0], pt[1], country)?.id;
      }
      if (!id || claimed.has(id)) continue; // one detailed shape per region

      // The size test. A pairing that replaces a province with the region
      // containing it passes every other check — their polygon really does
      // contain our centre, and the name lookup simply missed — and then paints
      // five times the ground. This is what stops it.
      const theirs = geometryAreaM2(g);
      const oursM2 = regionAreaKm2(id) * 1e6;
      if (!oursM2 || !theirs) continue;
      const ratio = theirs / oursM2;
      if (ratio < AREA_MATCH[0] || ratio > AREA_MATCH[1]) continue;

      claimed.set(id, g);
    }

    // A level that only pairs a handful is describing something else; keeping
    // those few would mean a country drawn at two resolutions at once.
    if (claimed.size < Math.min(mine, pick.count) * COUNT_MATCH) return 0;
    for (const [id, g] of claimed) FINE.set(id, g);
    return claimed.size;
  } catch {
    return 0; // no detail for this country; the overview geometry stands
  } finally {
    finePending.delete(iso);
    fineDone.add(iso);
  }
}

/**
 * The region containing a point, or null (ocean, or a country the dataset
 * doesn't subdivide).
 *
 * @param {number} lng
 * @param {number} lat
 * @param {string} [country] the country already worked out for this point, if
 *   there is one. Regions elsewhere are then skipped without a geometry test,
 *   which is most of them — the statistics sweep already knows the country.
 * @returns {{id:string, name:string, country:string}|null}
 */
export function regionAt(lng, lat, country) {
  if (!REGIONS) return null;
  const bucket = index.get(tileKey(lng, lat));
  if (!bucket) return null;
  for (const i of bucket) {
    const r = REGIONS[i];
    if (country && r.country !== country) continue;
    const [w, s, e, n] = r.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const g = r.geometry;
    if (g.type === 'Polygon') {
      if (inPolygon(lng, lat, g.coordinates)) return r;
    } else {
      for (const poly of g.coordinates) {
        if (inPolygon(lng, lat, poly)) return r;
      }
    }
  }
  return null;
}

/**
 * The region for a point, snapping to the nearest one in the same country when
 * the point falls inside no region at all.
 *
 * Those gaps are real and unavoidable: the country outlines are rounded to
 * ~1 km and each region is simplified relative to its own size, so along
 * coastlines and national borders the two datasets disagree by a sliver. A
 * sweep of Italy finds 1.5% of inland points inside no region, Switzerland 4%.
 * Treating a sliver as "this country has no regions" is what made a single
 * stray cell colour in the whole of Italy underneath the cantons — so a miss
 * snaps to the region it is a sliver outside of, which is the honest answer for
 * ground that is 1 km from a border.
 *
 * @returns {{id:string, name:string, country:string}|null}
 */
export function regionNear(lng, lat, country) {
  const exact = regionAt(lng, lat, country);
  if (exact || !REGIONS || !country) return exact;
  let best = null;
  let bestKey = [Infinity, Infinity];
  for (const r of REGIONS) {
    if (r.country !== country) continue;
    const [w, s, e, n] = r.bbox;
    // Distance to the box, which is 0 for the overwhelmingly common case of a
    // point that is inside the region's bbox and just outside its simplified
    // outline. Ties then go to whichever region's middle is closest.
    const dx = lng < w ? w - lng : lng > e ? lng - e : 0;
    const dy = lat < s ? s - lat : lat > n ? lat - n : 0;
    const box = Math.hypot(dx, dy);
    if (box > bestKey[0]) continue;
    const mid = Math.hypot(lng - (w + e) / 2, lat - (s + n) / 2);
    if (box < bestKey[0] || mid < bestKey[1]) {
      bestKey = [box, mid];
      best = r;
    }
  }
  return best;
}

const areaMemo = new Map();

/** Land area of one region in km², or 0 if it isn't in the dataset. */
export function regionAreaKm2(id) {
  if (areaMemo.has(id)) return areaMemo.get(id);
  const r = REGIONS?.find((x) => x.id === id);
  let km2 = 0;
  if (r) {
    for (const poly of asMulti(r.geometry)) {
      km2 += ringAreaM2(poly[0]);
      for (let i = 1; i < poly.length; i++) km2 -= ringAreaM2(poly[i]);
    }
    km2 /= 1e6;
  }
  areaMemo.set(id, km2);
  return km2;
}

/** How many regions one country is divided into (0 if it isn't in the set). */
export function regionsInCountry(country) {
  if (!REGIONS) return 0;
  let n = 0;
  for (const r of REGIONS) if (r.country === country) n++;
  return n;
}

export const regionCount = () => REGIONS?.length ?? 0;

/**
 * The countries of the given regions whose shapes touch the given view — which
 * is the set worth fetching detail for, and nothing else.
 *
 * @param {Iterable<string>} ids  lit region ids
 * @param {[number, number, number, number]} view  [w, s, e, n]
 * @returns {Array<{iso:string, country:string}>}
 */
export function countriesInView(ids, view) {
  if (!REGIONS) return [];
  const wanted = new Set(ids);
  const out = new Map();
  const [w, s, e, n] = view;
  for (const r of REGIONS) {
    if (!wanted.has(r.id) || !r.iso) continue;
    const [rw, rs, re, rn] = r.bbox;
    if (re < w || rw > e || rn < s || rs > n) continue;
    out.set(r.iso, { iso: r.iso, country: r.country });
  }
  return [...out.values()];
}

/**
 * One region's raw geometry — used by the heat maps, which colour each region
 * separately instead of dissolving them together.
 *
 * @param {string} id
 * @param {boolean} [fine] prefer the fine geometry if it has been fetched
 */
export function regionGeometry(id, fine = false) {
  if (fine && FINE.has(id)) return FINE.get(id);
  return REGIONS?.find((r) => r.id === id)?.geometry ?? null;
}

/**
 * Union the lit regions into one dissolved shape, exactly as the country level
 * does: touching cantons merge with no border between them. Returns the fill
 * and every boundary ring for the outline.
 */
export function mergeRegions(litIds, fine = false) {
  if (!REGIONS || !litIds.size) return { fill: [], rings: [] };
  const geoms = [];
  for (const r of REGIONS) {
    if (litIds.has(r.id)) geoms.push(asMulti(regionGeometry(r.id, fine) ?? r.geometry));
  }
  return unionGeometries(geoms);
}

/**
 * Regions whose name matches, for the search box. Returns nothing when the
 * dataset isn't loaded rather than loading it: 2.5 MB is not a reasonable price
 * for a keystroke, and by the time anyone searches, the trips have usually
 * pulled it in already.
 */
export function searchRegions(query, limit = 3) {
  if (!REGIONS) return [];
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const r of REGIONS) {
    const name = r.name.toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ rank: name === q ? 0 : at === 0 ? 1 : 2, name: r.name, country: r.country, bbox: r.bbox, kind: 'region' });
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  return hits.slice(0, limit);
}
