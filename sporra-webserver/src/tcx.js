// Garmin TCX (Training Center XML) — the third file type in a Strava bulk
// export, alongside .gpx and .fit (all of them possibly .gz).
//
// Which one you get depends on what was originally uploaded, and anything that
// came off a Garmin watch or head unit tends to arrive as TCX, so the archive
// is unreadable without this.
//
// Like the GPX and KML readers in src/locations.js this parses XML with
// regexes instead of DOMParser, so the same code runs in the browser importer
// and in the Node CLI script without either growing a dependency.
//
// The part of the format that matters:
//   <TrainingCenterDatabase><Activities><Activity Sport="Biking">
//     <Id>2024-04-21T11:22:42Z</Id>              ← when the activity started
//     <Lap StartTime="…"><Track>
//       <Trackpoint>
//         <Time>2024-04-21T11:22:42Z</Time>
//         <Position>
//           <LatitudeDegrees>46.948</LatitudeDegrees>
//           <LongitudeDegrees>7.436</LongitudeDegrees>
//         </Position>
//
// Two habits of the format drive most of the code below:
//   • a Trackpoint need not carry a Position. A paused recording, an indoor
//     session and the seconds before the GPS locks on all write a Time and
//     nothing else, so those points are dropped rather than emitted as 0,0.
//   • an Activity holds one or more Laps, each holding one or more Tracks, and
//     a fresh Track is where the pen went back down after a stop. Each Track
//     becomes its own segment so a coffee break isn't drawn as a straight line
//     across the valley. Laps are just lap-button bookkeeping — a lap boundary
//     mid-ride is not a gap and must not split the line.

// The root element is the only reliable marker, and it sits in the first few
// hundred bytes unless the writer front-loaded a comment; 4 KB is the same
// window src/locations.js sniffs in.
export function looksLikeTcx(text) {
  return typeof text === 'string' && /TrainingCenterDatabase/i.test(text.slice(0, 4096));
}

// Garmin's own files leave the core elements unprefixed, but exporters that
// merge in the activity/course extension schemas sometimes prefix everything
// (`<ns3:Trackpoint>`). Allowing an optional prefix costs one alternation.
const NS = '(?:\\w+:)?';

// Truncated archives are the normal failure here — the ZIP is huge and people
// interrupt the download — so no block is required to be closed: each one runs
// to its own end tag, the start of the next sibling, or the end of the file,
// whichever comes first. A half-written last activity still yields its points.
const ACTIVITY = new RegExp(`<${NS}Activity\\b([^>]*)>([\\s\\S]*?)(?=</${NS}Activity>|<${NS}Activity\\b|$)`, 'gi');
const TRACK = new RegExp(`<${NS}Track\\b[^>]*>([\\s\\S]*?)(?=</${NS}Track>|<${NS}Track\\b|$)`, 'gi');
import { climb } from './routes.js';

const ALTITUDE = /<AltitudeMeters>([^<]*)<\/AltitudeMeters>/i;
const TRACKPOINT = new RegExp(`<${NS}Trackpoint\\b[^>]*>([\\s\\S]*?)(?=</${NS}Trackpoint>|<${NS}Trackpoint\\b|$)`, 'gi');
const POSITION = new RegExp(`<${NS}Position\\b[^>]*>([\\s\\S]*?)</${NS}Position>`, 'i');
const LATITUDE = new RegExp(`<${NS}LatitudeDegrees>([^<]*)<`, 'i');
const LONGITUDE = new RegExp(`<${NS}LongitudeDegrees>([^<]*)<`, 'i');
const TIME = new RegExp(`<${NS}Time>([^<]*)<`, 'i');
const ID = new RegExp(`<${NS}Id>([^<]*)<`, 'i');
const SPORT = /\bSport\s*=\s*["']([^"']*)["']/i;

// `+''` is 0, which would quietly plant a point on null island every time a
// number is missing or blank. Everything numeric here goes through this.
const num = (raw) => (raw && raw.trim() ? Number(raw) : NaN);

const validLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const validLng = (v) => Number.isFinite(v) && Math.abs(v) <= 180;

// TCX <Time> is xsd:dateTime, so unlike src/locations.js's toEpoch there are no
// epoch-millisecond or "31/07/2024" dialects to guess at. The sanity window is
// the same one: a device with a dead battery-backed clock writes 1989 or 2089,
// and such a fix would otherwise skew a cell's first/last date forever.
const MIN_T = Date.UTC(1990, 0, 1) / 1000;

function epochSeconds(value) {
  if (!value) return 0;
  // A zoneless "2024-04-21T11:22:42" is read as local time, which is what the
  // writer that omitted the Z almost certainly meant by it.
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return 0;
  const sec = ms / 1000;
  return sec > MIN_T && sec < Date.now() / 1000 + 86400 ? Math.round(sec) : 0;
}

// Same rejects as src/locations.js: out of range, or exactly 0,0 — which is
// what a receiver reports when it thinks it has a fix and doesn't.
function addPoint(out, lat, lng, t, ele) {
  if (!validLat(lat) || !validLng(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  const p = { lat, lng, t: t || 0 };
  if (Number.isFinite(ele)) p.ele = ele;
  out.push(p);
  return true;
}

// One Track's positioned points, in file order.
function trackSegment(body) {
  const seg = [];
  TRACKPOINT.lastIndex = 0;
  let m;
  while ((m = TRACKPOINT.exec(body))) {
    const point = m[1];
    const pos = POSITION.exec(point);
    if (!pos) continue; // paused, indoor, or still searching for satellites
    // The Time is optional in practice even though the schema demands it, and
    // a point without one is still a place you were: 0 means "undated" and the
    // cell folding already copes with that.
    addPoint(
      seg,
      num(LATITUDE.exec(pos[1])?.[1]),
      num(LONGITUDE.exec(pos[1])?.[1]),
      epochSeconds(TIME.exec(point)?.[1] ?? ''),
      num(ALTITUDE.exec(point)?.[1]),
    );
  }
  return seg;
}

// Matches src/locations.js's track shape, including its rule that a segment of
// fewer than two points draws nothing and so isn't kept.
//
// The dates are read back off the points that survived that rule, never off the
// raw list: a lone fix in a Track of its own — the GPS re-locking in the car
// park hours later — is not part of the line, and dating the ride by it would
// stretch it across the rest of the day. Undated points are skipped for the
// same reason: a last sample written without its <Time> is a gap in the file,
// not a route whose end is unknown.
function addTrack(tracks, segments, startedAt, sport) {
  const segs = segments.filter((s) => s.length >= 2);
  if (!segs.length) return;
  let firstT = 0;
  let lastT = 0;
  for (const seg of segs) {
    for (const p of seg) {
      if (!p.t) continue;
      if (!firstT) firstT = p.t;
      lastT = p.t;
    }
  }
  tracks.push({
    name: '',
    segments: segs,
    firstAt: startedAt || firstT,
    lastAt: lastT,
    sport: sport || '',
    elevUp: climb(segs),
  });
}

/**
 * Read a TCX activity file.
 *
 * `points` is every positioned Trackpoint in file order, for folding into
 * cells; `tracks` is one entry per Activity in the src/locations.js shape, with
 * a segment per Track so pauses stay pauses. Tracks are left unnamed: a TCX has
 * nowhere to put a title (its <Id> is a timestamp, and the Sport is a category,
 * not a name), so whoever calls this — the Strava importer knows the file name
 * and the activity list — is better placed to name the route.
 *
 * A valid TCX with no GPS at all — a turbo session, a pool swim — comes back
 * with empty points rather than an error, because an importer walking a few
 * hundred files should skip those quietly, not stop on them.
 *
 * @param {string} text raw file contents
 * @returns {{points:Array<{lat:number,lng:number,t:number}>,
 *            tracks:Array<{name:string, segments:Array<Array<object>>, firstAt:number, lastAt:number}>,
 *            sport:string}}
 */
export function parseTcx(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('This TCX file is empty.');
  }
  if (!looksLikeTcx(text)) {
    throw new Error('This is not a TCX file — no TrainingCenterDatabase at the top of it. If it came from a ZIP, it may have been unpacked incorrectly.');
  }

  const points = [];
  const tracks = [];
  let sport = '';

  // Commented-out XML is not data. People do edit these files by hand — to cut
  // the drive home off the end of a ride, most often — and a regex reader that
  // ignores <!-- --> would put every deleted fix back on the map. An unclosed
  // comment in a truncated download takes the rest of the file with it, which
  // is what a parser would do with it too. CDATA is matched alongside only so
  // that a `<!--` quoted inside one can't start a comment that swallows the
  // ride; the scan is skipped entirely for the files that have no comment,
  // which is all of them until someone opens one in an editor.
  const scanned = text.includes('<!--')
    ? text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?(?:-->|$)/g, (m) => (m.startsWith('<!--') ? '' : m))
    : text;

  // A TCX can also hold <Courses><Course>, a route planned in Garmin Connect
  // rather than something ridden. It has Tracks but no Activity and no Sport,
  // so falling back to the whole document reads it without a second code path.
  const blocks = [...scanned.matchAll(ACTIVITY)].map((m) => ({ attrs: m[1], body: m[2], dated: true }));
  if (!blocks.length) blocks.push({ attrs: '', body: scanned, dated: false });

  for (const { attrs, body, dated } of blocks) {
    if (!sport) sport = (SPORT.exec(attrs)?.[1] ?? '').trim();

    const segments = [];
    TRACK.lastIndex = 0;
    let m;
    while ((m = TRACK.exec(body))) {
      const seg = trackSegment(m[1]);
      segments.push(seg);
      // Appended one at a time on purpose: `push(...seg)` passes every point as
      // an argument, and a day-long recording at one fix a second overruns the
      // argument limit and throws where nothing is actually wrong.
      for (const p of seg) points.push(p);
    }

    // <Id> dates the activity as a whole, but only an Activity's does. In the
    // whole-document fallback the nearest <Id> can belong to something else
    // entirely — <Folders><History><ActivityRef><Id> lists activities that
    // aren't in this file, and a course folder's <Id> is a name — so a planned
    // route would inherit a date from a ride it has nothing to do with.
    addTrack(tracks, segments, dated ? epochSeconds(ID.exec(body)?.[1] ?? '') : 0, sport);
  }

  return { points, tracks, sport };
}
