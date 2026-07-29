// Place names for imported routes: "Interlaken → Frutigen", "Lake Thun loop".
//
// A track file rarely says where it went. Its own name is often a bare date, or
// nothing at all, and a filename is no better — so the route gets titled from
// the ground it covered instead. Everything here is local: the dataset
// (src/places.json, built by scripts/build-places.mjs) ships with the app, so
// naming a route never sends a coordinate anywhere.
//
// It's ~2.2 MB, so it's dynamic-imported the same way the country boundaries
// are: Vite splits it into its own chunk that only loads when a route actually
// needs a name.

let TOWNS = null; // [name, lng, lat, popThousands]
let LAKES = null; // [name, minLng, minLat, maxLng, maxLat]
let index = null; // "lngCell/latCell" → town indices, for the nearest search
let loading = null;

// Grid cell size for the town index, in degrees. One degree of latitude is
// ~111 km, so a 3×3 neighbourhood around a point always covers the 30 km search
// radius below, at every latitude the search is used.
const CELL = 1;
const key = (lng, lat) => `${Math.floor(lng / CELL)}/${Math.floor(lat / CELL)}`;

export const placesLoaded = () => TOWNS !== null;

/**
 * Kick off (or reuse) the one-time load. Resolves when the data is ready.
 *
 * `data` is for callers without a bundler — plain Node needs an import
 * attribute to read JSON, which Vite doesn't want, so a script can parse
 * places.json itself and hand it over.
 */
export function loadPlaces(data) {
  if (!loading) {
    loading = (data ? Promise.resolve({ default: data }) : import('./places.json')).then((m) => {
      TOWNS = m.default.towns ?? [];
      LAKES = m.default.lakes ?? [];
      index = new Map();
      for (let i = 0; i < TOWNS.length; i++) {
        const k = key(TOWNS[i][1], TOWNS[i][2]);
        const bucket = index.get(k);
        if (bucket) bucket.push(i);
        else index.set(k, [i]);
      }
      return true;
    });
  }
  return loading;
}

// --- Distance -----------------------------------------------------------------
const R_E = 6371000;
const RAD = Math.PI / 180;

function metres(aLng, aLat, bLng, bLat) {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(s)));
}

// --- Nearest town ---------------------------------------------------------------
// Past this, whatever is "nearest" is not where you were.
const MAX_TOWN_M = 30000;
// How much of a head start size buys, at most. A city is recognisable from
// further out than the hamlet next door, so each place competes on distance
// *minus* a bonus that grows with population — otherwise a run through central
// Bern gets named after whichever 5,000-person suburb the start line fell in.
// Scored rather than compared pairwise: a "closest unless…" rule depends on the
// order the candidates arrive in, and quietly picked the suburb.
const PROMINENCE_M = 6000;
const prominence = (popThousands) =>
  Math.min(PROMINENCE_M, Math.log10(1 + Math.max(0, popThousands)) * 2500);

/**
 * The town a point belongs to, or null if nothing is close enough.
 * @returns {{name:string, distM:number, pop:number}|null}
 */
export function nearestTown(lng, lat) {
  if (!TOWNS) return null;
  const cLng = Math.floor(lng / CELL);
  const cLat = Math.floor(lat / CELL);
  let best = null;
  let bestScore = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.get(`${cLng + dx}/${cLat + dy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        const t = TOWNS[i];
        const d = metres(lng, lat, t[1], t[2]);
        if (d > MAX_TOWN_M) continue;
        const score = d - prominence(t[3]);
        if (score < bestScore) {
          bestScore = score;
          best = { name: t[0], distM: d, pop: t[3] };
        }
      }
    }
  }
  return best;
}

// --- Lakes ----------------------------------------------------------------------
// A lake is worth naming a route after when the route sits inside its bounding
// box — you went round it, or along it — and the two are of comparable size.
// Out of scale in either direction is wrong: a 2 km walk is not "Lake Geneva",
// and a 150 km drive that happens to pass a tarn is not named after the tarn.
const LAKE_SCALE_LIMIT = 6;

export function lakeAround(bounds) {
  if (!LAKES || !bounds) return null;
  const [w, s, e, n] = bounds;
  const midLng = (w + e) / 2;
  const midLat = (s + n) / 2;
  const routeSpan = Math.max(metres(w, midLat, e, midLat), metres(midLng, s, midLng, n), 1);
  let best = null;
  for (const [name, lw, ls, le, ln] of LAKES) {
    if (midLng < lw || midLng > le || midLat < ls || midLat > ln) continue;
    const lakeSpan = Math.max(
      metres(lw, (ls + ln) / 2, le, (ls + ln) / 2),
      metres((lw + le) / 2, ls, (lw + le) / 2, ln),
      1,
    );
    if (lakeSpan > routeSpan * LAKE_SCALE_LIMIT || routeSpan > lakeSpan * LAKE_SCALE_LIMIT) continue;
    // Several lakes can contain the point (a bay inside a sea); the tightest
    // box is the most specific answer.
    if (!best || lakeSpan < best.span) best = { name, span: lakeSpan };
  }
  return best ? best.name : null;
}

// --- Naming ---------------------------------------------------------------------
// A route ending near where it started is a loop, however far it wandered.
const LOOP_CLOSE_M = 750;

function endpoints(geom) {
  const first = geom?.[0]?.[0];
  const lastSeg = geom?.[geom.length - 1];
  const last = lastSeg?.[lastSeg.length - 1];
  return first && last ? { first, last } : null;
}

/**
 * Where a route went, as a line of text: "Interlaken → Frutigen",
 * "Lake Thun loop", "Bern". Null when nothing recognisable is near it —
 * an empty string would claim more than we know.
 *
 * @param {{geom:Array, bounds:Array}} route  a built or stored route
 */
export function describeRoute(route) {
  if (!TOWNS || !route?.geom?.length) return null;
  const ends = endpoints(route.geom);
  if (!ends) return null;

  const from = nearestTown(ends.first[0], ends.first[1]);
  const to = nearestTown(ends.last[0], ends.last[1]);
  const closed = metres(ends.first[0], ends.first[1], ends.last[0], ends.last[1]) < LOOP_CLOSE_M;

  // Point-to-point: both ends, in the order you travelled them.
  if (from && to && from.name !== to.name) return `${from.name} → ${to.name}`;

  const town = from?.name ?? to?.name ?? null;
  const lake = lakeAround(route.bounds);
  // Round a lake is a better description of a loop than the town it started in.
  if (closed) {
    if (lake) return `${lake} loop`;
    if (town) return `${town} loop`;
    return null;
  }
  return town ?? lake;
}

/**
 * Names that carry nothing a place name wouldn't say better: empty, a bare
 * date or time, or one of the words exporters reach for when they have nothing.
 */
export function isGenericName(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T].*)?$/.test(s)) return true; // "2026-06-15"
  if (/^(untitled|unnamed|track|route|activity|path|segment|no name)\b/i.test(s)) return true;
  // What Komoot and Strava call a tour you never named: the sport, sometimes
  // with the time of day in front. "Evening Ride" says nothing "Bern → Thun"
  // doesn't say better — but a title you actually typed still wins.
  if (
    /^(morning|afternoon|evening|night|lunch|midday)?\s*(ride|run|hike|walk|jog|cycle|cycling|bike\s*tour|bike\s*ride|mountain\s*bike|road\s*ride|e-?bike\s*(ride|tour)?|tour|workout|swim|ski|skiing|snowboard)$/i.test(s)
  ) {
    return true;
  }
  return /^[\d\s.:_-]+$/.test(s); // "0001", "2026_06_15 07.30"
}
