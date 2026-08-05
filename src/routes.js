// Saved routes: the actual line a track file drew, kept next to the cells it
// lit up so an activity can be drawn on top of the colored map.
//
// Pure functions, shared by the in-app importer (src/import.js), the map
// (src/main.js) and the CLI. Tracks come out of src/locations.js; this module
// thins them down to something worth storing, measures them, and gives each one
// a stable key so re-importing the same file never stores it twice.


// Total ascent over a line. Barometric and GPS altitude both jitter by a metre
// or two at rest, and summing every positive tick turns a flat ride into a
// mountain — so a climb only counts once it has gained NOISE_M over the last
// point that counted.
const CLIMB_NOISE_M = 3;

export function climb(segments) {
  let up = 0;
  for (const seg of segments) {
    let ref = null;
    for (const p of seg) {
      if (!Number.isFinite(p?.ele)) continue;
      if (ref === null) {
        ref = p.ele;
        continue;
      }
      const d = p.ele - ref;
      if (d >= CLIMB_NOISE_M) {
        up += d;
        ref = p.ele;
      } else if (d <= -CLIMB_NOISE_M) {
        ref = p.ele; // descending: move the reference down, count nothing
      }
    }
  }
  return Math.round(up);
}
const R_E = 6378137;
const RAD = Math.PI / 180;

// --- Tuning -------------------------------------------------------------------
// Douglas–Peucker tolerance, in meters. A 1 Hz recording puts ~3600 points in an
// hour of running, nearly all of them noise along a straight; at 6 m the line
// still traces every corner it actually turned.
export const ROUTE_EPSILON_M = 6;
// Ceiling per route — the tolerance doubles until the route fits under it, so a
// pathological file can't park a million points in the database.
export const ROUTE_MAX_POINTS = 3000;
// Shorter than this and it's a stray pair of fixes, not a route worth drawing.
export const ROUTE_MIN_LENGTH_M = 100;
// Coordinates are stored at 5 decimals — about a meter, well under the
// simplification tolerance.
const PRECISION = 1e5;

// --- The same ride, recorded twice ---------------------------------------------
// Two apps watching one afternoon produce two different point streams, which
// simplify to two different lines, which hash to two different keys — so the
// per-file duplicate check that stops you importing the same GPX twice cannot
// see this at all. These three numbers are what does.
//
// They are set from what the real pairs actually look like, not from what felt
// safe: across every duplicate on a real map the two rows start within 5
// seconds of each other and their lengths differ by at most 0.4%. The tolerances
// below are an order of magnitude looser than that, and still nowhere near
// loose enough to catch two genuinely different outings.
// Below this, the clock was left running rather than the ride being slow. Two
// real Komoot tours claim 596 h for 20 km (0.03 km/h) and 163 h for 11.5 km —
// between them 759 of the 956 hours the map thought it had recorded. The
// slowest genuine outing on the same map is a 1.2 km/h walk with stops, so this
// sits ten times below anything real and seven times above the glitches.
export const ROUTE_MIN_SPEED_KMH = 0.5;

// --- Where the recorder stopped watching ----------------------------------------
// A track is only a line where something was actually recorded. Between two
// fixes far apart in both time and space, nothing was — and joining them draws a
// journey nobody made, measures it as distance covered, and names the route
// after two towns at either end of it.
//
// Some formats say where those breaks are: a GPX puts each in its own `<trkseg>`,
// TCX has laps, KML has separate coordinate blocks. The ones that arrive over an
// API do not. Strava hands back one flat stream of points however many times you
// stopped, Komoot the same, and an Apple Health route is a single series across
// every pause in the workout. Those three used to be drawn straight across.
//
// So the rule lives here, applied to every track from every source on its way in,
// rather than three times in three parsers with three sets of numbers.
//
// **It takes two measurements to call something a pause**, and that is the whole
// subtlety. Time alone is wrong: standing still legitimately produces one long
// gap between two points a few metres apart, and thinning widens it further.
// Distance alone is wrong: a descent covers 150 m in under ten seconds. Only
// both together mean the recorder was not watching for the part in between.
export const TRACK_GAP_SEC = 60;
export const TRACK_GAP_M = 150;
// And the jump nobody made, whatever the clock claims: 30 m/s is 108 km/h,
// comfortably past a fast descent. This is what catches a single stale fix from
// before a watch got its GPS lock, which arrives with a plausible timestamp and
// an implausible position.
export const TRACK_MAX_SPEED_MS = 30;

/**
 * Cut every segment where the recording stopped.
 *
 * Idempotent, and cheap on a track that has no gaps in it — the common case is
 * one comparison per point and the same array back. Runs of a single point are
 * dropped: a fix with nothing either side of it is not a line, and for a source
 * that derives its cells from these segments it is not a place either.
 */
export function splitOnGaps(segments, {
  gapSec = TRACK_GAP_SEC,
  gapM = TRACK_GAP_M,
  maxSpeedMS = TRACK_MAX_SPEED_MS,
} = {}) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!Array.isArray(seg)) continue;
    let run = [];
    let previous = null;
    for (const p of seg) {
      if (previous) {
        const metres = haversine(previous, p);
        // Points with no timestamp can only be judged on distance, and a file
        // with no clock in it has no pauses to find — so only the teleport half
        // of the rule can fire.
        const seconds = previous.t && p.t ? p.t - previous.t : 0;
        const paused = seconds > gapSec && metres > gapM;
        const teleported = seconds > 0 && metres / seconds > maxSpeedMS;
        if (paused || teleported) {
          if (run.length >= 2) out.push(run);
          run = [];
        }
      }
      run.push(p);
      previous = p;
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

const DUP_START_SEC = 120; // how far apart two recordings of one start can be
// …and how far apart they may drift on a long day out, as a fraction of it.
// A flat gate is the wrong shape, and a ski day is where that shows. An hour's
// run is two apps started with the same thumb: every such pair on a real map
// agrees to within thirteen seconds. Six hours on a mountain is a watch started
// at the first lift and a phone remembered somewhere on the way up — six real
// pairs start between 5 and 20 minutes apart, and a flat two minutes hid all of
// them, listing every ski day twice.
//
// Measured against the shorter of the two recordings, every duplicate on a real
// map lands under 5.9%, and the closest thing that must *not* fold — two walks
// round the same block on one afternoon, 2% apart in length and in the same
// place — sits at 257%. A tenth clears the first by 1.7× and stays 26× under
// the second, which is the widest gap any of these three numbers has.
//
// It only ever loosens things for long outings, and that is where it is safest:
// at a tenth, two recordings that fold necessarily overlap by nine tenths of the
// shorter one, and you cannot have been on two outings at once.
const DUP_START_SPAN = 0.1;
const DUP_LENGTH_TOL = 0.05; // 5% — observed worst case is 0.4%
const DUP_BBOX_IOU = 0.6; // and they have to have happened in the same place

// Which copy speaks for an outing when two apps recorded it. Only the three
// that actually produce duplicates are ranked; everything else falls through to
// the tie-breaks in `preferredRoute`, which is the right answer for a source
// this app has no opinion about.
const SOURCE_RANK = { komoot: 3, 'apple-health': 2, strava: 1 };

const round = (v) => Math.round(v * PRECISION) / PRECISION;

// --- Measuring -----------------------------------------------------------------
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_E * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function segmentLength(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversine(points[i - 1], points[i]);
  return m;
}

// --- Simplifying ----------------------------------------------------------------
// Douglas–Peucker on a local planar projection: over one activity the scale
// error is far below the tolerance, and it keeps the whole thing in meters.
function planar(points) {
  let lat = 0;
  for (const p of points) lat += p.lat;
  const k = Math.cos((lat / points.length) * RAD);
  return points.map((p) => ({ x: R_E * p.lng * RAD * k, y: R_E * p.lat * RAD }));
}

// Distance from p to the segment a→b (clamped, so a doubling-back track can't
// be measured against the infinite line and kept by mistake).
function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let px = p.x - a.x;
  let py = p.y - a.y;
  if (len2 > 0) {
    const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
    px -= t * dx;
    py -= t * dy;
  }
  return Math.hypot(px, py);
}

// Iterative rather than recursive: a raw track can be 50k points deep.
function douglasPeucker(points, eps) {
  const n = points.length;
  if (n < 3) return points.slice();
  const flat = planar(points);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let far = -1;
    let max = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(flat[k], flat[i], flat[j]);
      if (d > max) {
        max = d;
        far = k;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Thin a track's segments down, raising the tolerance until the whole route
 * fits under ROUTE_MAX_POINTS.
 */
export function simplifySegments(segments, eps = ROUTE_EPSILON_M) {
  let out = segments.map((s) => douglasPeucker(s, eps));
  let tolerance = eps;
  while (out.reduce((n, s) => n + s.length, 0) > ROUTE_MAX_POINTS && tolerance < 5000) {
    tolerance *= 2;
    out = segments.map((s) => douglasPeucker(s, tolerance));
  }
  return out.filter((s) => s.length >= 2);
}

// --- Keys -----------------------------------------------------------------------
// cyrb53: a short, stable, non-cryptographic digest. Two imports of the same
// file produce the same simplified geometry, so they produce the same key and
// the second one is dropped as a duplicate.
function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// --- Building -------------------------------------------------------------------
const stripExt = (name) => String(name ?? '').replace(/\.[a-z0-9]+$/i, '');

const dateName = (sec) =>
  sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';

/**
 * Turn one parsed track into the record that gets stored and drawn.
 *
 * @param {{name:string, segments:Array<Array<{lat:number,lng:number,t:number}>>, firstAt:number, lastAt:number}} track
 * @param {{source:string, fileName?:string, index?:number}} ctx
 * @returns {object|null} null when the line is too short to be a route
 */
export function buildRoute(track, { source, fileName = '', index = 0 } = {}) {
  // Cut first, simplify second. The other order lets Douglas–Peucker thin away
  // the very points either side of a gap — they are the ones furthest from
  // everything, so they survive, but the run they belong to may not — and it
  // would in any case be measuring a line that had already been joined up.
  const recorded = splitOnGaps(track.segments);
  const segments = simplifySegments(recorded);
  if (!segments.length) return null;

  let lengthM = 0;
  let points = 0;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let firstAt = track.firstAt || 0;
  let lastAt = track.lastAt || 0;
  const geom = [];

  for (const seg of segments) {
    lengthM += segmentLength(seg);
    points += seg.length;
    const line = [];
    for (const p of seg) {
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.t) {
        if (!firstAt || p.t < firstAt) firstAt = p.t;
        if (p.t > lastAt) lastAt = p.t;
      }
      line.push([round(p.lng), round(p.lat)]);
    }
    geom.push(line);
  }
  if (lengthM < ROUTE_MIN_LENGTH_M) return null;

  // Named by the file when the track didn't name itself; several unnamed tracks
  // out of one file get numbered rather than all sharing a title.
  const base = stripExt(fileName);
  let name = track.name;
  if (!name && base) name = index === 0 ? base : `${base} ${index + 1}`;
  if (!name) name = dateName(firstAt) || 'Route';
  name = name.slice(0, 120);

  // On the recorded runs, not the raw ones: a pause that ends 300 m up a
  // hillside is not 300 m you climbed, and the gap the line no longer draws
  // should not be ascent the summary still counts.
  const elevUp = Math.max(0, Math.round(track.elevUp ?? climb(recorded)));
  const guessed = track.sport
    ? ''
    : guessSport({ name, lengthM, seconds: lastAt > firstAt ? lastAt - firstAt : 0, elevUp });

  return {
    name,
    // What the file itself called this track, before any fallback — the caller
    // decides whether that is worth keeping or whether a place name says more
    // (see nameRoutes in src/import.js).
    trackName: track.name || '',
    place: '',
    source,
    // What the file called the activity, and how much of it was uphill. Both
    // are optional: plenty of tracks carry neither. When the file says nothing,
    // the pace is asked instead — see guessSport.
    sport: canonicalSport(track.sport) || guessed,
    sportGuessed: !track.sport && !!guessed,
    // Measured on the full track, not the simplified line: thinning drops the
    // very points a climb is made of.
    elevUp,
    firstAt,
    lastAt,
    lengthM: Math.round(lengthM),
    points,
    bounds: [minLng, minLat, maxLng, maxLat],
    geom,
    // Recognising a route by its shape is quicker than reading its name, and a
    // list of 22 can't carry the real geometry — see routeThumb.
    thumb: routeThumb(geom),
    // The geometry itself is the identity: same file in, same key out. The
    // dates go in too so two laps of an identical loop stay two routes.
    key: hashString(`${firstAt}|${lastAt}|${JSON.stringify(geom)}`),
  };
}

// --- One vocabulary for activities -------------------------------------------
// Five sources name the same thing five ways: a GPX writes `<type>cycling</type>`
// in lower case, Komoot calls a road bike "racebike", Strava says "Ride", the
// guesser below says "Cycling". Left alone that fills the Routes list and the
// colour menu with near-duplicate categories that all mean one activity — and
// you cannot colour "rides" if half of them are filed under a different word.
//
// So every label, wherever it came from, passes through here on the way in.
// Anything unrecognised is kept as-is (only tidied for case), because inventing
// a category is worse than carrying an unusual one.
//
// The names are all in the same tense — Walking, Running, Skiing, Cycling —
// because a list that mixes "Walking" with "Run" reads like two different
// people wrote it. "Train" is the one exception: there is no verb for being on
// one that isn't sillier than the noun.
const SPORT_SYNONYMS = new Map(Object.entries({
  // Everything on a road bike is one thing.
  cycling: 'Cycling',
  cycle: 'Cycling',
  bike: 'Cycling',
  biking: 'Cycling',
  ride: 'Cycling',
  rides: 'Cycling',
  'road ride': 'Cycling',
  'road cycling': 'Cycling',
  'road bike': 'Cycling',
  racebike: 'Cycling',
  'race bike': 'Cycling',
  'gravel ride': 'Cycling',
  'e-road ride': 'Cycling',
  'e-bike': 'Cycling',
  ebike: 'Cycling',
  ebikeride: 'Cycling',
  // …and everything off-road is the other.
  'bike tour': 'Mountain cycling',
  'touring bicycle': 'Mountain cycling',
  touringbicycle: 'Mountain cycling',
  mtb: 'Mountain cycling',
  'mountain bike': 'Mountain cycling',
  'mountain biking': 'Mountain cycling',
  mountainbikeride: 'Mountain cycling',
  'e-mountain bike': 'Mountain cycling',
  'e-bike tour': 'Mountain cycling',
  downhill: 'Mountain cycling',
  'downhill bike': 'Mountain cycling',
  // On foot. Walking and hiking are different things and stay different.
  walk: 'Walking',
  walking: 'Walking',
  'nordic walking': 'Walking',
  stroll: 'Walking',
  hike: 'Hiking',
  hiking: 'Hiking',
  trek: 'Hiking',
  trekking: 'Hiking',
  run: 'Running',
  running: 'Running',
  jog: 'Running',
  jogging: 'Running',
  trailrun: 'Running',
  'trail run': 'Running',
  'trail running': 'Running',
  trailrunning: 'Running',
  // Snow.
  ski: 'Skiing',
  skiing: 'Skiing',
  'alpine ski': 'Skiing',
  'downhill ski': 'Skiing',
  alpineski: 'Skiing',
  'ski touring': 'Ski touring',
  'backcountry ski': 'Ski touring',
  backcountryski: 'Ski touring',
  'cross-country ski': 'Cross-country skiing',
  'cross country ski': 'Cross-country skiing',
  nordicski: 'Cross-country skiing',
  snowboard: 'Snowboarding',
  snowboarding: 'Snowboarding',
  // Everything else that turns up with more than one spelling.
  swim: 'Swimming',
  swimming: 'Swimming',
  kayak: 'Paddling',
  kayaking: 'Paddling',
  canoe: 'Paddling',
  canoeing: 'Paddling',
  paddle: 'Paddling',
  paddling: 'Paddling',
  sup: 'Paddling',
  sail: 'Sailing',
  sailing: 'Sailing',
  drive: 'Driving',
  driving: 'Driving',
  car: 'Driving',
  train: 'Train',
  rail: 'Train',
  flight: 'Flying',
  flying: 'Flying',
  plane: 'Flying',
}));

/** The one spelling of an activity this app uses. '' stays ''. */
export function canonicalSport(label) {
  const raw = String(label ?? '').trim();
  if (!raw) return '';
  const hit = SPORT_SYNONYMS.get(raw.toLowerCase().replace(/[_\s]+/g, ' '));
  if (hit) return hit;
  // Unknown, so keep it — just give it a consistent shape rather than letting
  // "MOUNTAINEERING" and "mountaineering" become two categories.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// --- Naming a workout nobody named -------------------------------------------
// A file names its tracks and Komoot and Strava name their activities. Apple
// Health does not: you do not title a run, you just go for one. That left the
// date as the only thing to call it, so a Routes list built from Health read as
// a column of ISO dates — accurate, and no help at all in finding the ride you
// were looking for.
//
// "Morning walk" is what Strava and Health itself put at the top of the same
// screen, and it is better for the reason it is unremarkable: the two things you
// actually remember about an outing are roughly when in the day it was and what
// you were doing. The date is still right there in the row beside it, and the
// place name the browser works out later replaces neither.

/** The noun for an activity, where the label is the verb. '' if unknown. */
export function sportNoun(sport) {
  const key = String(sport ?? '').trim().toLowerCase();
  if (!key) return '';
  return {
    walking: 'walk',
    running: 'run',
    hiking: 'hike',
    cycling: 'ride',
    'mountain cycling': 'ride',
    swimming: 'swim',
    paddling: 'paddle',
    rowing: 'row',
    sailing: 'sail',
    skiing: 'ski',
    'ski touring': 'ski tour',
    'cross-country skiing': 'ski',
    snowboarding: 'snowboard',
    driving: 'drive',
    flying: 'flight',
  }[key] ?? key;
}

/**
 * "Morning walk", "Evening ride" — or '' when there is nothing to go on.
 *
 * The hour is read in whatever timezone the caller is in, which for the server
 * is the machine the map is self-hosted on. That is right often enough to be
 * worth having and wrong only for a workout recorded in another timezone, where
 * the cost is a ride at 7 p.m. filed as an afternoon one.
 */
export function trackName(sport, sec) {
  const noun = sportNoun(sport);
  if (!noun || !sec) return '';
  const hour = new Date(sec * 1000).getHours();
  const part = hour < 5 ? 'Night' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 21 ? 'Evening' : 'Night';
  return `${part} ${noun}`;
}

// --- Working out the activity ------------------------------------------------
// Most files say what they were: GPX has <type>, TCX a Sport attribute, FIT a
// sport message, and Komoot and Strava both label their own. When none of them
// does, the track can usually still be worked out without anyone typing it in.
//
// Two signals, in order of how much they can be trusted:
//
//  1. The name. Apps write what they were into it — Slopes calls every export
//     "Slopes - A day skiing at …", and a file someone named "Hike" is a hike.
//     This goes first because it is the only thing that identifies a sport
//     speed cannot: a day on the pistes averages ~10 km/h, which is squarely
//     the pace of a run, and guessing from the number alone got both of the
//     real ski days in the author's own map wrong.
//  2. Failing that, the average pace, in deliberately wide bands.
//
// It is still a guess and is stored as one (`sportGuessed`), so the dialog can
// say so and a label from a file always wins. The uncertain middle is left
// blank rather than filled in with a coin toss: "" is a better answer than a
// confident wrong one.
const NAME_HINTS = [
  [/\b(ski|skiing|slopes?|piste|schi|schnee)\b/i, 'Skiing'],
  [/\b(snowboard|boarding)\b/i, 'Snowboarding'],
  [/\b(hike|hiking|hik|wander\w*|trek\w*)\b/i, 'Hiking'],
  [/\b(run|running|jog\w*|lauf)\b/i, 'Running'],
  [/\b(ride|riding|cycl\w*|bike|biking|velo|rad\w*|mtb)\b/i, 'Cycling'],
  [/\b(walk\w*|spazier\w*)\b/i, 'Walk'],
  [/\b(swim\w*)\b/i, 'Swimming'],
  [/\b(paddle|kayak\w*|canoe\w*|sup)\b/i, 'Paddling'],
  [/\b(sail\w*)\b/i, 'Sailing'],
  [/\b(drive|driving|car)\b/i, 'Driving'],
  [/\b(flight|flying|plane)\b/i, 'Flying'],
  [/\b(train|rail)\b/i, 'Train'],
];

const SPEED_BANDS = [
  [2, 7, 'Walking'],
  // A brisk walk tops out around 6.5–7 km/h and a slow jog starts near 8, so
  // the boundary sits between them rather than at the pace of a fast walker.
  [7, 13, 'Running'],
  [13, 32, 'Cycling'],
  [32, 160, 'Driving'],
  [160, 1200, 'Flying'],
];
// Below these a "speed" is mostly GPS drift and rounding.
const GUESS_MIN_M = 300;
const GUESS_MIN_SEC = 120;
// A walk that climbed this much was a hike, whatever its average pace.
const HIKE_CLIMB_M = 400;

/** What the track calls itself, if it calls itself anything. '' otherwise. */
export function sportFromName(name) {
  const text = String(name ?? '');
  if (!text) return '';
  const hit = NAME_HINTS.find(([re]) => re.test(text))?.[1];
  return hit ? canonicalSport(hit) : '';
}

/**
 * What this track probably was. '' when it can't tell.
 * @param {{name?:string, lengthM:number, seconds:number, elevUp?:number}} m
 */
export function guessSport({ name = '', lengthM, seconds, elevUp = 0 }) {
  const named = sportFromName(name);
  if (named) return named;
  if (!(lengthM >= GUESS_MIN_M) || !(seconds >= GUESS_MIN_SEC)) return '';
  const kmh = (lengthM / 1000) / (seconds / 3600);
  if (!Number.isFinite(kmh)) return '';
  const label = SPEED_BANDS.find(([lo, hi]) => kmh >= lo && kmh < hi)?.[2];
  if (!label) return '';
  return canonicalSport(label === 'Walking' && elevUp >= HIKE_CLIMB_M ? 'Hiking' : label);
}

/** Every track in a parsed file, as storable routes (short ones dropped). */
export function buildRoutes(tracks, { source, fileName = '' } = {}) {
  const out = [];
  tracks.forEach((track, index) => {
    const route = buildRoute(track, { source, fileName, index });
    if (route) out.push(route);
  });
  return out;
}

// --- Thumbnails ------------------------------------------------------------------
// A route's shape is the fastest way to recognise it — far faster than reading
// its name — but the list can't afford the geometry: 22 routes of 3,000 points
// is megabytes, and the whole reason the list is metadata-only is to avoid
// exactly that. So each route carries a *tiny* version of itself, worked out
// once when it is saved.
//
// 28 points is enough to tell a loop from an out-and-back from a straight line,
// and it stores as a ~200-byte string. Coordinates are normalised into a 0–100
// box on the longer axis so the drawing code needs no bounds arithmetic, and
// the aspect ratio is kept so a long thin ride doesn't render as a square
// scribble. Segments are separated by `|`, points by space, x and y by comma.
export const THUMB_POINTS = 28;

export function routeThumb(geom) {
  if (!Array.isArray(geom) || !geom.length) return '';
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let total = 0;
  for (const seg of geom) {
    for (const [lng, lat] of seg) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      total++;
    }
  }
  if (!total || !Number.isFinite(minLng)) return '';

  // Longitude is compressed by latitude, exactly as it is on the map — without
  // this a route at 47°N comes out stretched to about 1.5× its real width.
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const w = Math.max((maxLng - minLng) * k, 1e-9);
  const h = Math.max(maxLat - minLat, 1e-9);
  const span = Math.max(w, h);
  const ox = (span - w) / 2;
  const oy = (span - h) / 2;

  // Thin every segment down proportionally, keeping its ends.
  const budget = Math.max(2, THUMB_POINTS);
  const out = [];
  for (const seg of geom) {
    if (seg.length < 2) continue;
    const want = Math.max(2, Math.round((seg.length / total) * budget));
    const step = Math.max(1, Math.floor(seg.length / want));
    const pts = [];
    for (let i = 0; i < seg.length; i += step) pts.push(seg[i]);
    if (pts[pts.length - 1] !== seg[seg.length - 1]) pts.push(seg[seg.length - 1]);
    out.push(
      pts
        .map(([lng, lat]) => {
          const x = ((lng - minLng) * k + ox) / span * 100;
          // SVG's y grows downward; north should be up.
          const y = 100 - ((lat - minLat + oy) / span) * 100;
          return `${Math.round(x)},${Math.round(y)}`;
        })
        .join(' '),
    );
  }
  return out.join('|');
}

/** A cached thumb back into SVG polyline point lists, one per segment. */
export function thumbSegments(thumb) {
  return String(thumb ?? '')
    .split('|')
    .filter((seg) => seg.includes(','));
}

// --- Drawing ---------------------------------------------------------------------
/** Routes → a FeatureCollection of MultiLineStrings, one feature per route. */
export function routesToFC(routes) {
  return {
    type: 'FeatureCollection',
    features: routes
      .filter((r) => r.geom?.length)
      .map((r) => ({
        type: 'Feature',
        id: r.id,
        // `sport` rides along so the map can colour and filter by activity
        // without a second lookup per feature.
        properties: { id: r.id, name: r.name, sport: r.sport || '' },
        geometry: { type: 'MultiLineString', coordinates: r.geom },
      })),
  };
}

// --- Formatting -------------------------------------------------------------------
export function formatDistance(m) {
  if (!m) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString()} km`;
}

export function formatDuration(sec) {
  if (!sec || sec < 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}

export const totalLength = (routes) => routes.reduce((m, r) => m + (r.lengthM || 0), 0);

/**
 * How long a route actually took, or 0 when the clock cannot be believed.
 *
 * A recording that was never stopped keeps counting: one tour here says it took
 * twenty-five days to cover twenty kilometres. Both ends of it are real
 * timestamps, so nothing upstream can tell they are wrong — but a route that
 * implies you moved slower than `ROUTE_MIN_SPEED_KMH` is a clock left running,
 * not an outing, and adding it to a total makes the total meaningless rather
 * than approximate.
 *
 * Undated and reversed spans return 0 the same way: the answer to "how long did
 * this take" is "no idea", and 0 is how the callers already spell that.
 */
export function recordedSeconds(route) {
  const sec = route?.firstAt && route?.lastAt > route.firstAt ? route.lastAt - route.firstAt : 0;
  if (!sec) return 0;
  const km = (route.lengthM || 0) / 1000;
  return km / (sec / 3600) < ROUTE_MIN_SPEED_KMH ? 0 : sec;
}

// --- The same ride, recorded twice ---------------------------------------------

const bboxIou = (a, b) => {
  if (!a || !b || a.length !== 4 || b.length !== 4) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const over = w * h;
  const area = (x) => Math.max(0, x[2] - x[0]) * Math.max(0, x[3] - x[1]);
  const union = area(a) + area(b) - over;
  return union > 0 ? over / union : 0;
};

// How far the two starts may be apart, for this pair. The span is the *shorter*
// of the two recordings, so one app that stopped watching early tightens the
// gate rather than loosening it — and a row whose clock was left running scores
// 0 from `recordedSeconds`, which drops the pair back to the flat floor instead
// of granting it a week of slack.
const startGate = (a, b) =>
  Math.max(DUP_START_SEC, Math.min(recordedSeconds(a), recordedSeconds(b)) * DUP_START_SPAN);

/**
 * Are these two rows the same outing, recorded by two apps?
 *
 * The start time carries this. You cannot begin two rides in the same minute,
 * and in practice the two clocks agree to within a few seconds — so it is the
 * gate, and the other two only have to rule out the freak case of two different
 * things starting together. How far apart the two starts may be scales with how
 * long the outing ran: see `DUP_START_SPAN` for why a flat gate listed every ski
 * day twice.
 *
 * What is deliberately not used:
 *  · the *end* time, and any overlap computed from it. One real Komoot row
 *    claims a 9,802-minute ride for what Strava recorded as 110 minutes; the
 *    end of a tour is not a reliable clock. `recordedSeconds` is not that: it
 *    hands back 0 for exactly those rows, so a nonsense end widens nothing.
 *  · `sport` — the same walk came back as "Walking" from one app and "Hiking"
 *    from the other.
 *  · `source` — the obvious duplicate is Komoot against Strava, but real maps
 *    also hold Strava against Strava, and gating on a difference would miss
 *    exactly those. Which of the two then *speaks* for the outing is a different
 *    question, and `preferredRoute` does read the source to answer it.
 *  · `points` — a tie-break at most. Both sides pass through the same
 *    simplifier, so the counts land close, but "close" is not a fact to bet on.
 */
export function routesLookAlike(a, b) {
  if (!a?.firstAt || !b?.firstAt) return false; // undated: nothing to compare
  if (Math.abs(a.firstAt - b.firstAt) > startGate(a, b)) return false;
  const longest = Math.max(a.lengthM || 0, b.lengthM || 0);
  if (!longest) return false;
  if (Math.abs((a.lengthM || 0) - (b.lengthM || 0)) / longest > DUP_LENGTH_TOL) return false;
  // `bounds` is what the API calls it; `bbox` is what a freshly built route
  // carries before it has been round-tripped. Both are [w, s, e, n].
  return bboxIou(a.bounds ?? a.bbox, b.bounds ?? b.bbox) >= DUP_BBOX_IOU;
}

/**
 * Which copy speaks for the outing. Ordered so the answer is the same on every
 * device and every reload — a fold that changed its mind between loads would be
 * worse than showing both.
 *
 * Which app it came from leads, because it is the only rank that answers the
 * question the same way every time: Komoot, then Apple Health, then Strava.
 * Komoot because a Komoot route opens on Komoot and no amount of Strava data
 * turns into that; Health above Strava because Health is the watch's own record
 * of the day and Strava is a copy of it, and because a Strava row can be edited
 * after the fact while the workout it came from cannot.
 *
 * The ranks below it decide between two rows of the same app, and between two
 * sources this app has no opinion about — a link first, then a sport somebody
 * actually recorded over one this app guessed from the speed, which is what
 * separates the two Strava rows that are the same run.
 */
export function preferredRoute(a, b) {
  const rank = [
    (r) => SOURCE_RANK[r.source] || 0,
    (r) => (r.link ? 1 : 0),
    (r) => (r.sportGuessed ? 0 : 1),
    (r) => (r.elevUp > 0 ? 1 : 0),
    (r) => r.points || 0,
  ];
  for (const of of rank) {
    const d = of(b) - of(a);
    if (d) return d > 0 ? b : a;
  }
  return (a.id ?? 0) <= (b.id ?? 0) ? a : b; // stable, and the older row wins
}

/**
 * Fold copies of one outing together. Returns a Map of hidden route id → the id
 * of the route standing in for it, derived fresh from the list every time: this
 * is a fact about the data rather than a judgement about it, so storing it
 * would only mean a stale answer after the next import.
 */
export function duplicateRoutes(routes) {
  const folded = new Map();
  // By start time, so the scan is local rather than every pair against every
  // other — a map with a thousand routes would otherwise do half a million
  // comparisons to find a handful of duplicates.
  const byStart = [...routes].filter((r) => r.firstAt).sort((a, b) => a.firstAt - b.firstAt);
  for (let i = 0; i < byStart.length; i++) {
    const a = byStart[i];
    if (folded.has(a.id)) continue;
    // The widest gate `a` could grant anyone: its own gate against itself, since
    // the span is the shorter of the two recordings and so never exceeds a's.
    // Past that the scan is done — this is what keeps it local instead of every
    // route against every other.
    const reach = startGate(a, a);
    for (let j = i + 1; j < byStart.length; j++) {
      const b = byStart[j];
      if (b.firstAt - a.firstAt > reach) break;
      if (folded.has(b.id) || !routesLookAlike(a, b)) continue;
      const keep = preferredRoute(a, b);
      folded.set(keep === a ? b.id : a.id, keep.id);
      if (keep !== a) break; // `a` is spoken for; move on to the next start
    }
  }
  // Four copies of one ski day fold pairwise, and pairwise the second can land
  // behind the third before the third lands behind the fourth — which hides the
  // right rows but leaves the map pointing at a row that is itself hidden. Walk
  // each answer through to the row still standing. No cycles to guard against:
  // a route is written into the map at most once and skipped from then on, so
  // every chain ends at a key that isn't there.
  for (const [hidden, stand] of folded) {
    let end = stand;
    while (folded.has(end)) end = folded.get(end);
    if (end !== stand) folded.set(hidden, end);
  }
  return folded;
}
