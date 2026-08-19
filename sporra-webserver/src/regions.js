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

import { inPolygon, asMulti, ringAreaM2, snapGeometry, unionGeometries } from './polygon.js';
import { stripDetachedTerritories } from './geo-filter.js';
import { fold, matchRank } from './fold.js';

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
// "Admin-1" does not mean the same thing in the two datasets, and the difference
// is not a detail — it is the difference between a sharper canton and a fifth of
// Italy colouring in.
//
// Natural Earth's admin-1 is départements for France (101), and its Italian
// provinces are dissolved to the twenty regioni at build time (see
// DISSOLVE_BY_REGION in scripts/build-regions.mjs). geoBoundaries' gbOpen
// hierarchy is shifted for both: Italy's ADM1 has *five* macro-regions and its
// ADM2 the twenty regioni; France's ADM1 has thirteen régions and its ADM2 the
// ninety-six départements. Pairing Italy against the five macro-regions is what
// put a fifth of the country under one unit — geometrically it "matched",
// because their polygon genuinely contains our unit's centre.
//
// So the level is chosen by unit count rather than by name: whichever of their
// levels has about as many units as we do is the one describing the same thing.
// France works (96 against 101) and Italy pairs exactly (20 against 20).
// Each pair has to be about the same size. See pairFineRegions().
export const AREA_MATCH = [0.3, 3.2];

let FINE = new Map(); // region id → detailed geometry
// A country's own detailed outline, for the countries whose regions cannot be
// paired against ours — see `outlineFor` in server/regions-fine.js. Keyed by
// ISO3, and separate from FINE because it answers a different question: FINE is
// "what shape is this canton", this is "what shape is this country", and a
// country can have an answer to the second and none to the first.
const FINE_OUTLINE = new Map(); // ISO3 → the country's own detailed outline
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
/**
 * True once there is any sharper geometry in memory at all — a country's
 * regions, or just its own outline.
 *
 * Both, because both are things the map can be drawn from and the gate that
 * reads this decides whether to draw sharply *at all*. Counting only the
 * regions is what kept a country blunt after its outline had been fetched:
 * there was something sharper to draw and nothing would look at it.
 */
export const fineRegionsLoaded = () => FINE.size > 0 || FINE_OUTLINE.size > 0;
/** Which countries have been asked for already, so nothing is fetched twice. */
export const fineCountryKnown = (iso) => fineDone.has(iso) || finePending.has(iso);

/** Kick off (or reuse) the one-time fetch. Resolves when the data is ready. */
export function loadRegions(data) {
  if (!loading) {
    loading = (data ? Promise.resolve({ default: data }) : import('./regions.json')).then((m) => {
      REGIONS = m.default;
      idIndex = null;
      recordIndex = null;
      byIso = null;
      foldedRegions = null;
      buildIndex();
      return REGIONS;
    });
  }
  return loading;
}

// Pairing two datasets' names is the same question a search box asks — is this
// the same word, typed by someone else — so it is the same fold. See src/fold.js.
export const foldName = fold;

// How finely to sample a shape when asking what is underneath it. 7×7 interior
// candidates, plus the mean of the outer ring. Enough to outvote an enclave —
// see regionUnder() — and cheap, because it is only ever run for a shape whose
// name did not pair, once per country, on the server.
const SAMPLE_STEPS = 8;

/**
 * Points that are definitely inside a ring, best first: the average of its
 * vertices when that lands inside, then a walk across the bounding box.
 *
 * Needed because the two datasets name the same place differently often enough —
 * Luzern/Lucerne, St. Gallen/Sankt Gallen, and every Ukrainian oblast, which
 * geoBoundaries suffixes " Oblast" and Natural Earth does not — that names alone
 * cannot be trusted to pair them up.
 */
export function interiorPoints(rings) {
  const outer = rings[0];
  const out = [];
  let x = 0;
  let y = 0;
  let w = Infinity;
  let sN = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of outer) {
    x += p[0];
    y += p[1];
    if (p[0] < w) w = p[0];
    if (p[1] < sN) sN = p[1];
    if (p[0] > e) e = p[0];
    if (p[1] > n) n = p[1];
  }
  const mean = [x / outer.length, y / outer.length];
  if (inPolygon(mean[0], mean[1], rings)) out.push(mean);
  for (let i = 1; i < SAMPLE_STEPS; i++) {
    for (let j = 1; j < SAMPLE_STEPS; j++) {
      const px = w + ((e - w) * i) / SAMPLE_STEPS;
      const py = sN + ((n - sN) * j) / SAMPLE_STEPS;
      if (inPolygon(px, py, rings)) out.push([px, py]);
    }
  }
  return out;
}

/** The single best interior point, for callers that only want somewhere to aim. */
export const pointInside = (rings) => interiorPoints(rings)[0] ?? null;

/**
 * Which of our regions a detailed shape is standing on, by a vote of the points
 * inside it rather than by one of them.
 *
 * One point is not enough, and Kyiv is why. Not a single Ukrainian name pairs —
 * geoBoundaries calls every one "<name> Oblast" where Natural Earth calls it
 * "<name>" — so all 25 fall through to geometry, and 24 of them land correctly.
 * Kyiv oblast is a **ring around the capital**: both datasets cut the hole, in
 * slightly different places, and the average of a ring's vertices is its centre,
 * which is the hole. That one point came down in the sliver where the two
 * disagree — inside their oblast and inside *our* Kyiv City — so the lookup
 * answered "Kyiv City", the size guard correctly rejected 28,105 km² against
 * 1,649, and the oblast kept its overview shape while all 24 neighbours
 * sharpened. Exactly the shape of the report: one region, low detail, no reason
 * visible from the map.
 *
 * The answer was already in the data. A walk across the same polygon lands in
 * our Kyiv oblast thirty times and in Kyiv City twice, so the majority is not a
 * close call — and every capital-inside-a-province in the world is the same
 * shape of problem.
 */
function regionUnder(rings, iso) {
  const votes = new Map();
  for (const [x, y] of interiorPoints(rings)) {
    const hit = regionAt(x, y, iso);
    if (hit) votes.set(hit.id, (votes.get(hit.id) ?? 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [id, n] of votes) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

// Regions by country. Held, because the export's borders slider asks this once
// per country in the frame on every redraw and the answer is a scan of 4,553
// records — which is fine once and not fine forty times a second.
let byIso = null;

/**
 * Every region of one country, found by ISO3 code.
 *
 * By code, never by name: Natural Earth's admin-0 and admin-1 files disagree on
 * twelve country names (Czechia/Czech Republic, eSwatini/Swaziland,
 * Cabo Verde/Cape Verde…). Joining on the name meant those countries had "no
 * regions", which the region level then drew as one flat country-shaped blob.
 */
export function regionsOf(iso) {
  if (!REGIONS) return [];
  if (!byIso) {
    byIso = new Map();
    for (const r of REGIONS) {
      if (!r.iso) continue;
      const list = byIso.get(r.iso);
      if (list) list.push(r);
      else byIso.set(r.iso, [r]);
    }
  }
  return byIso.get(iso) ?? [];
}

/**
 * A short hash of our region ids for one country, sent with the request for its
 * detailed boundaries so the *browser's* cache is keyed by them.
 *
 * That answer is served `immutable` for a year, on the grounds that the
 * geoBoundaries commit is pinned and so it can never change. Half true, and the
 * expensive half is the other one: the payload is a map from our region ids to
 * their geometry, so it changes whenever `regions.json` does. When Italy's 110
 * provinces became 20 regioni, browsers went on replaying the province answer
 * out of the HTTP cache — through rebuilds, restarts and reloads, because
 * `immutable` means "do not even revalidate". Rebuilding the world could not
 * dislodge it.
 *
 * Putting this in the query string makes the URL change exactly when the answer
 * would, which is what `immutable` was always claiming. It is a cache key and
 * nothing else — the server reads it for logging, never for logic, so a browser
 * that sends a stale or absent one still gets a correct answer.
 *
 * djb2: it has to be synchronous (crypto.subtle is not) and it only has to
 * change when the ids do.
 */
export function regionSetTag(iso) {
  let h = 5381;
  for (const r of regionsOf(iso)) {
    for (let i = 0; i < r.id.length; i++) h = ((h * 33) ^ r.id.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

let isoIndex = null;

/**
 * The country name this dataset uses for an ISO3 code. The detailed boundaries
 * are requested by code and paired by name, so something has to bridge the two.
 */
export function countryForIso(iso) {
  if (!isoIndex) {
    isoIndex = new Map();
    for (const r of REGIONS ?? []) if (r.iso) isoIndex.set(r.iso, r.country);
  }
  return isoIndex.get(iso) ?? null;
}

/** Square metres of a Polygon/MultiPolygon, holes subtracted. */
export function geometryAreaM2(g) {
  let a = 0;
  for (const poly of asMulti(g)) {
    a += ringAreaM2(poly[0]);
    for (let i = 1; i < poly.length; i++) a -= ringAreaM2(poly[i]);
  }
  return a;
}

/**
 * Pair detailed boundary features against our regions for one country.
 *
 * Shared with the server, which does the fetching (see server/regions-fine.js):
 * the browser cannot ask geoBoundaries directly — their API answers a level that
 * doesn't exist with an error page carrying no CORS headers, so probing turns
 * into console noise on a real origin — and one machine fetching each country
 * once is politer to them than every browser doing it.
 *
 * Pairing is by name, then by geometry, then checked by size:
 *
 * - Names pair most of them for free. The two datasets agree on 24 of 26 Swiss
 *   cantons and disagree on Luzern/Lucerne and St. Gallen/Sankt Gallen.
 * - A name miss falls back to the region most of their polygon's interior points
 *   land in — a vote, not one point, because a province shaped like a ring
 *   around its capital puts its own centre inside the capital. See regionUnder.
 * - And then every pair has to be about the same *size*. This is the guard that
 *   matters: geoBoundaries' Italian ADM1 has five macro-regions, each of which
 *   genuinely contains one of our 110 provinces' centres, so geometry alone
 *   "paired" them and one province painted a fifth of the country.
 *
 * Partial answers are kept. Norway is the standing example: eleven of our
 * twenty-one pair, because the country merged its counties in 2020 and the two
 * datasets are on opposite sides of that. Every shape that does pair is still
 * the right shape for what it represents, which is why a partial answer is
 * worth having at all — whether the partial set can be *laid down* is the
 * separate question `seamedRegion` asks.
 *
 * @param {string} iso  ISO3 country code
 * @param {Array<object>} features  GeoJSON features with a `shapeName`
 * @returns {Map<string, object>} our region id → detailed geometry
 */
export function pairFineRegions(iso, features) {
  const byName = new Map();
  for (const r of regionsOf(iso)) byName.set(foldName(r.name), r.id);

  const claimed = new Map();
  for (const f of features ?? []) {
    const g = f?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    let id = byName.get(foldName(f.properties?.shapeName));
    if (!id) {
      const polys = asMulti(g);
      let biggest = polys[0];
      for (const poly of polys) if (poly[0].length > biggest[0].length) biggest = poly;
      id = regionUnder(biggest, iso);
    }
    if (!id || claimed.has(id)) continue; // one detailed shape per region

    const theirs = geometryAreaM2(g);
    const ours = regionAreaKm2(id) * 1e6;
    if (!ours || !theirs) continue;
    const ratio = theirs / ours;
    if (ratio < AREA_MATCH[0] || ratio > AREA_MATCH[1]) continue;

    claimed.set(id, g);
  }
  return claimed;
}

// Bumped whenever the detailed set grows, so that anything holding geometry
// *built* from it can tell that the answer it is holding is now the blunt one.
//
// A version rather than a callback, and lives here rather than beside any one
// cache, because the fetch has two callers who do not know about each other: the
// map sharpens the country you zoomed into, and the image export sharpens every
// country in its frame. The export's own cache was invalidated on the map's
// signal alone, so a poster saved after the export had fetched its own
// boundaries was drawn from the coarse shapes it had cached before them —
// sharpening happened, and nothing read it.
let fineVersion = 0;

/** How many times the detailed set has grown. See addFineRegions. */
export const fineRegionsVersion = () => fineVersion;

/**
 * Take a country's detailed outline, as fetched.
 *
 * @returns {number} 1 if it is new to us, 0 otherwise — the same currency
 *   `addFineRegions` deals in, because the caller's question is only ever "did
 *   anything change".
 */
export function addFineOutline(iso, geometry) {
  if (!iso || !geometry || FINE_OUTLINE.has(iso)) return 0;
  FINE_OUTLINE.set(iso, stripDetachedTerritories(geometry));
  fineOutlineMemo.delete(iso);
  fineVersion++;
  return 1;
}

/** Take detailed geometry the server worked out: { "<id>": geometry, … }. */
export function addFineRegions(byId) {
  fineOutlineMemo.clear();
  let n = 0;
  let ignored = 0;
  for (const [id, g] of Object.entries(byId ?? {})) {
    if (!g) continue;
    // Keyed by *our* region ids, which means the two sides have to be looking
    // at the same `regions.json`. The server reads its copy once at startup and
    // holds it, so a rebuilt dataset with the server left running gives an
    // answer keyed to regions this browser no longer has — every id misses, no
    // detail is gained, and the country quietly stays coarse while its
    // neighbours sharpen. That is a stale process, not a missing dataset, and
    // it cost a long time to find once. Say so rather than failing silently.
    if (!byIdIndex().has(id)) {
      ignored++;
      continue;
    }
    // Snapped at the door: see COORD_SNAP. A border only disagrees with its
    // neighbour once the two are dissolved together, which is far from here.
    FINE.set(id, snapGeometry(g));
    n++;
  }
  if (ignored) {
    console.warn(
      `[regions] ignored ${ignored} detailed boundaries keyed to regions this map does not have`
      + ' — the server is holding an older regions.json than the browser. Restart it.',
    );
  }
  if (n) fineVersion++;
  return n;
}

// Region ids, built once and reused: addFineRegions is called per country and
// would otherwise walk the whole dataset each time.
let idIndex = null;
function byIdIndex() {
  if (!idIndex) idIndex = new Set((REGIONS ?? []).map((r) => r.id));
  return idIndex;
}

const boxesOverlap = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/**
 * The first region of a country that would be drawn beside a sharper neighbour,
 * or null if the detailed set can be laid down without a seam anywhere.
 *
 * **Two resolutions cannot tile.** Where a detailed region meets an overview
 * one, the two disagree about their shared border by up to the overview set's
 * ~1 km simplification — so the border is drawn twice a hairline apart, and the
 * union of the two leaves a sliver of unfilled ground running between them.
 * Hungary was the case that showed it: Natural Earth counted its city-counties
 * as admin-1 units and geoBoundaries folds them into the counties around them,
 * so 18 of our 43 paired — each of the 18 wrapped in one that did not — and a
 * poster of the country came out double-ruled and full of holes. Hungary's
 * regions are built from the detailed set now and pair 19 of 19 (see
 * `REPLACE_FROM_FINE` in scripts/build-regions.mjs), which is the other way out
 * of this and the better one where it is available. Norway, whose counties were
 * merged in 2020 on one side of the datasets and not the other, is what the
 * rule catches today.
 *
 * `pairFineRegions` is still right to keep a partial answer: every shape it
 * returns is the right shape for what it names. This is the separate question of
 * whether a set of shapes can be laid down next to each other.
 *
 * **A count is the wrong test for that, and it was the first one written.** "Nine
 * tenths of the country paired" sounds like the same question and is not: the
 * Netherlands pairs 12 of 15, and the three it misses are Bonaire, St. Eustatius
 * and Saba — eight thousand kilometres away in the Caribbean, sharing a border
 * with nothing. A ratio threw the whole country's detail away over them, so a
 * poster of the Netherlands came out with blunt provinces inside a sharp
 * coastline. What matters is whether an unpaired region *touches* a paired one,
 * which is what this asks. France's five overseas départements pass for the same
 * reason; a city-county sitting inside the county around it does not.
 *
 * Bounding boxes rather than geometry: two regions that share a border always
 * have overlapping boxes, so this cannot miss a seam. It can invent one — two
 * regions near each other but not touching — and that costs a country its
 * detail rather than costing the picture its integrity, which is the right way
 * round to be wrong.
 */
export function seamedRegion(iso, byId) {
  const mine = regionsOf(iso);
  if (!mine.length) return null;
  const got = new Set(Object.keys(byId ?? {}));
  const missing = mine.filter((r) => !got.has(r.id));
  if (!missing.length) return null;
  const paired = mine.filter((r) => got.has(r.id));
  for (const m of missing) {
    for (const p of paired) {
      if (boxesOverlap(m.bbox, p.bbox)) return m.name;
    }
  }
  return null;
}

/**
 * Ask our own server for one country's detailed boundaries — its regions, its
 * own outline, or both.
 *
 * Never rejects: a country nobody has boundaries for at our granularity keeps
 * the overview geometry, and is remembered so it isn't asked for twice.
 *
 * @returns {Promise<number>} how many things this changed. Callers only read it
 *   as "was there any news", and there are two kinds of news now — a country
 *   whose regions all seam can still come back with a sharp outline.
 */
export async function loadFineRegions(iso) {
  if (!iso || fineDone.has(iso) || finePending.has(iso)) return 0;
  finePending.add(iso);
  try {
    // `?r=` is the cache key, not an argument — see regionSetTag.
    const res = await fetch(`/api/regions/${encodeURIComponent(iso)}?r=${regionSetTag(iso)}`);
    if (!res.ok) return 0;
    const body = await res.json();
    // The country's own outline is taken whatever happens to its regions: they
    // are two different questions, and the country level asks the second one.
    const outline = addFineOutline(iso, body?.outline);
    const seam = seamedRegion(iso, body?.regions);
    if (seam) {
      // Loud, because this is a country quietly drawn blunter than the data
      // allows, and the next person to wonder why should not have to find it.
      console.info(
        `[regions] ${iso}: ${seam} has no detailed boundary and touches one that does`
        + ' — keeping the overview set, which at least agrees with itself.'
        + (outline ? ' The country outline is sharp; only its regions are not.' : ''),
      );
      return outline;
    }
    return addFineRegions(body?.regions) + outline;
  } catch {
    return 0;
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
 * @param {string} [iso] the ISO3 code of the country already worked out for this
 *   point, if there is one. Regions elsewhere are then skipped without a
 *   geometry test, which is most of them — the sweep already knows the country.
 * @returns {{id:string, name:string, country:string, iso:string}|null}
 */
export function regionAt(lng, lat, iso) {
  if (!REGIONS) return null;
  const bucket = index.get(tileKey(lng, lat));
  if (!bucket) return null;
  for (const i of bucket) {
    const r = REGIONS[i];
    if (iso && r.iso !== iso) continue;
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
export function regionNear(lng, lat, iso) {
  const exact = regionAt(lng, lat, iso);
  if (exact || !REGIONS || !iso) return exact;
  let best = null;
  let bestKey = [Infinity, Infinity];
  for (const r of REGIONS) {
    if (r.iso !== iso) continue;
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

// Counting means a sweep of all 4,553 regions, and the answer is asked for
// once per country in the statistics and once per cell that lands in no region
// at all during a grid build.
const countMemo = new Map();

/** How many regions one country is divided into (0 if it isn't in the set). */
export function regionsInCountry(iso) {
  if (!REGIONS) return 0;
  if (countMemo.has(iso)) return countMemo.get(iso);
  let n = 0;
  for (const r of REGIONS) if (r.iso === iso) n++;
  countMemo.set(iso, n);
  return n;
}

export const regionCount = () => REGIONS?.length ?? 0;

// Region records by id. A second index rather than a `find`, because the image
// export names every region in a selection and a linear scan of 4,553 shapes
// per name adds up on a list the user is dragging a filter across.
let recordIndex = null;

/** One region's record — its name, its country, its bbox — or null. */
export function regionById(id) {
  if (!REGIONS) return null;
  if (!recordIndex) recordIndex = new Map(REGIONS.map((r) => [r.id, r]));
  return recordIndex.get(id) ?? null;
}

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
  // Through the index rather than a `find`. The export's borders slider asks
  // for every region the frame reaches, which at world scale is all 4,553 of
  // them — a linear scan each makes that twenty million comparisons per redraw,
  // and the redraw happens while somebody is dragging the slider.
  return regionById(id)?.geometry ?? null;
}

// A country's own outline, built from its detailed regions. Keyed by ISO3 and
// held, because dissolving 26 cantons of a few thousand points each costs real
// milliseconds and an export redraws on every drag of a slider.
const fineOutlineMemo = new Map();

/**
 * The sharp shape of a whole country: its detailed regions dissolved, trimmed
 * back to the country proper. Null until `loadFineRegions` has fetched them.
 *
 * **Trimmed, and that is the whole subtlety.** `src/countries.json` ships with
 * far-detached territories already filtered out, so mainland France is what the
 * map means by France. This dataset deliberately keeps them — an overseas
 * département has to light itself rather than the mainland — so dissolving them
 * hands French Guiana back, and a poster of France came out with a piece of
 * South America in the frame. The same filter at the same thresholds runs here
 * (see src/geo-filter.js), so the two datasets agree about the shape of a
 * country however the shape was arrived at.
 */
export function fineCountryOutline(iso) {
  if (!iso) return null;
  if (fineOutlineMemo.has(iso)) return fineOutlineMemo.get(iso);
  // The dissolve of paired regions is the sharper of the two where it can be
  // built — Switzerland's 26 cantons come to 10,111 points against ADM0's 2,368
  // — so the fetched outline is the fallback rather than the answer.
  let geometry = null;
  if (FINE.size) {
    const ids = new Set(regionsOf(iso).map((r) => r.id));
    // Only worth building once the detailed set is what would be dissolved:
    // otherwise this is the overview geometry with a slower path to it.
    const anyFine = [...ids].some((id) => FINE.has(id));
    if (anyFine) {
      // `exact` only: an undissolved pile of regions is not a country outline.
      // Stroked as one it draws every internal border, over the region level
      // already drawing them — so the shipped outline, one clean ring per
      // country, is the better answer by a distance.
      const { fill, exact } = mergeRegions(ids, true);
      if (exact && fill.length) geometry = stripDetachedTerritories({ type: 'MultiPolygon', coordinates: fill });
    }
  }
  // Nothing to dissolve, or a dissolve that came out inexact: the country's own
  // outline, where the server was able to fetch one. This is the whole of what
  // Norway and Ireland get, and it is several times what they had.
  if (!geometry) geometry = FINE_OUTLINE.get(iso) ?? null;
  fineOutlineMemo.set(iso, geometry);
  return geometry;
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

// What one admin-1 unit is called, per country, so a search result can say
// *Canton Zürich* rather than leaving "Zürich" to mean the canton, the city, the
// lake or the airport depending on which row you are looking at.
//
// The rule for being in this table is strict: the word has to be right for
// **every** unit the dataset holds for that country. That is why the obvious
// entries are missing. Canada is ten provinces and three territories; the United
// States is fifty states and the District of Columbia; Spain is fifty provinces
// and two autonomous cities; the United Kingdom's 232 units are councils,
// districts and boroughs at once. Calling Nunavut a province is a worse answer
// than calling it a region, so those countries take the default.
//
// The default is "Region", which is also literally correct for a good many of
// them — Italy's regioni, Chile's regiones, Czechia's kraje, Denmark's regioner.
const REGION_TERM = {
  CHE: 'Canton',
  // Both of these are true only because their regions were rebuilt from the
  // detailed source (see `REPLACE_FROM_FINE` in scripts/build-regions.mjs).
  // Hungary's 43 Natural Earth units were 19 counties, 23 city-counties and a
  // capital, for which no single word is right; its 19 are all counties.
  HUN: 'County',
  LUX: 'Canton',
  LIE: 'Municipality',
  FRA: 'Département',
  DEU: 'State',
  AUT: 'State',
  JPN: 'Prefecture',
  POL: 'Voivodeship',
  SWE: 'County',
  ZAF: 'Province',
  TUR: 'Province',
  IDN: 'Province',
  EGY: 'Governorate',
  KEN: 'Province',
  URY: 'Department',
};

/** What this country calls one of its admin-1 units. Never empty. */
export const regionTerm = (iso) => REGION_TERM[iso] ?? 'Region';

// The folded names, worked out once. 4,500 of them is a millisecond a
// keystroke, which is not the reason — the reason is that it is the same list
// every time and the search reads it on every character typed.
let foldedRegions = null;

/**
 * Regions whose name matches, for the search box. Returns nothing when the
 * dataset isn't loaded rather than loading it: 2.5 MB is not a reasonable price
 * for a keystroke, and by the time anyone searches, the trips have usually
 * pulled it in already.
 *
 * The id comes out with the name, because a region picked out of a list is a
 * shape the map can draw and count cells inside — not a coordinate to fly to.
 * See **Searching for a region** in ARCHITECTURE.md.
 */
export function searchRegions(query, limit = 3) {
  if (!REGIONS) return [];
  const q = fold(query);
  if (q.length < 2) return [];
  foldedRegions ??= REGIONS.map((r) => fold(r.name));
  const hits = [];
  for (let i = 0; i < REGIONS.length; i++) {
    const rank = matchRank(foldedRegions[i], q);
    if (rank < 0) continue;
    const r = REGIONS[i];
    hits.push({
      rank, id: r.id, name: r.name, country: r.country, bbox: r.bbox, kind: 'region',
      term: regionTerm(r.iso),
    });
  }
  // Every hit, then sorted. It used to stop at 400 and sort what it had, which
  // is the wrong 400: a broad query collects the alphabet and throws away the
  // exact match sitting at the end of it.
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  return hits.slice(0, limit);
}
