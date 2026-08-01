// Location-export parsing, shared by the in-app importer (src/import.js) and
// the CLI script (scripts/import-locations.mjs). Pure functions: no DOM, no
// MapLibre, no node APIs — it only ever sees a file name and its text.
//
// `parseLocationFile()` sniffs the format, extracts every coordinate it can
// find (with a timestamp whenever the file carries one) and reports which kind
// of export it thinks it read. `pointsToCells()` folds those fixes into
// level-0 hex cells with per-cell first/last/visit stats.
//
// Formats that draw an actual *line* (a workout, a trip) also give back
// `tracks`: the ordered polylines, so the importer can save the route itself
// next to the cells it lit up (src/routes.js).
//
// Supported shapes:
//   • GPX          — <trkpt>/<rtept>/<wpt> with lat/lon attributes + <time>
//                    tracks: each <trk>'s <trkseg>s, and each <rte>
//   • KML          — <coordinates> blocks and gx:Track <when>/<gx:coord> pairs
//                    tracks: each Placemark's LineString / gx:Track
//   • GeoJSON      — every coordinate of every geometry, properties.time
//                    tracks: Line/MultiLineString features
//   • CSV/TSV      — a header row naming latitude/longitude (+ optional time)
//   • Google Timeline — "geo:46.58,7.65" strings, latitudeE7 records
//   • Snapchat     — ["2026-06-26 00:48:19 UTC", "38.702, -9.228"] pairs and
//                    "lat 46.9 ± 4 meters, long 7.4 ± 4 meters" strings
//   • Apple Photos — [{ "latitude": "50.23", "longitude": "30.37" }, …]
//   • any other JSON — the generic harvester above still walks the whole tree

import { mercX, mercY, pointToCell, normCol, colsOf } from './hexgrid.js';
import { parseTcx, looksLikeTcx } from './tcx.js';
import { climb } from './routes.js';

// Source keys stored per cell. Anything not in here is shown as-is.
export const SOURCE_LABELS = {
  manual: 'Marked by hand',
  'google-timeline': 'Google Timeline',
  'google-maps': 'Google Maps',
  snapchat: 'Snapchat',
  'apple-photos': 'Apple Photos',
  'home-assistant': 'Home Assistant',
  komoot: 'Komoot',
  strava: 'Strava',
  garmin: 'Garmin',
  wahoo: 'Wahoo',
  polar: 'Polar',
  suunto: 'Suunto',
  runkeeper: 'Runkeeper',
  alltrails: 'AllTrails',
  ridewithgps: 'Ride with GPS',
  gpx: 'GPX track',
  tcx: 'TCX activity',
  fit: 'FIT activity',
  kml: 'KML / Google Earth',
  geojson: 'GeoJSON',
  csv: 'CSV table',
  other: 'Other export',
  unknown: 'Unknown',
};

// Sources offered in the importer's dropdown when you want to relabel a file.
export const IMPORT_SOURCES = [
  'google-timeline',
  'google-maps',
  'snapchat',
  'apple-photos',
  'komoot',
  'strava',
  'garmin',
  'gpx',
  'tcx',
  'kml',
  'geojson',
  'csv',
  'manual',
  'other',
];

// --- Which app wrote this track? ------------------------------------------------
// A GPX says so about itself: `<gpx creator="komoot.de">`, or a
// `<metadata><author><name>` inside. Recognizing it means a ride exported from
// Komoot is filed under Komoot rather than lumped in with every other GPX —
// which is what makes the Routes tab's grouping worth anything.
const GPX_CREATOR = /<gpx\b[^>]*\bcreator\s*=\s*["']([^"']*)["']/i;
const GPX_AUTHOR = /<author>[\s\S]{0,400}?<name>([^<]*)<\/name>/i;

const TRACK_APPS = [
  [/komoot/i, 'komoot'],
  [/strava/i, 'strava'],
  [/garmin/i, 'garmin'],
  [/wahoo/i, 'wahoo'],
  [/polar/i, 'polar'],
  [/suunto/i, 'suunto'],
  [/runkeeper/i, 'runkeeper'],
  [/alltrails/i, 'alltrails'],
  [/ridewithgps|ride\s*with\s*gps/i, 'ridewithgps'],
];

/** The app a track file names as its writer, or null if it doesn't say. */
export function trackApp(text) {
  const head = text.slice(0, 4096);
  const said = `${GPX_CREATOR.exec(head)?.[1] ?? ''} ${GPX_AUTHOR.exec(head)?.[1] ?? ''}`;
  if (!said.trim()) return null;
  for (const [re, key] of TRACK_APPS) if (re.test(said)) return key;
  return null;
}

export const sourceLabel = (key) => SOURCE_LABELS[key] ?? key;

// --- Timestamps ---------------------------------------------------------------
// Everything is normalized to epoch seconds; 0 means "no date in the file".
const MIN_T = Date.UTC(1990, 0, 1) / 1000;

function sane(sec) {
  const now = Date.now() / 1000 + 86400;
  return Number.isFinite(sec) && sec > MIN_T && sec < now ? Math.round(sec) : 0;
}

export function toEpoch(value) {
  if (value == null) return 0;
  if (typeof value === 'number') {
    // Milliseconds vs seconds — Google uses both depending on the export.
    return sane(value > 1e11 ? value / 1000 : value);
  }
  if (typeof value !== 'string') return 0;
  const s = value.trim();
  if (!s) return 0;
  if (/^\d{9,14}$/.test(s)) return toEpoch(Number(s)); // "1693801350966"
  let ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    // Safari is pickier than V8: "2024/07/31 17:56:24 UTC" → ISO-ish.
    ms = Date.parse(s.replace(/\//g, '-').replace(/\s+UTC$/i, 'Z').replace(' ', 'T'));
  }
  return Number.isNaN(ms) ? 0 : sane(ms / 1000);
}

// Keys that carry the time of a fix. `startTime` wins over `endTime` so a
// Google visit is dated when it began.
const TIME_KEYS = [
  'startTime', 'timestamp', 'timestampMs', 'time', 'Time', 'when', 'date', 'Date',
  'startTimestamp', 'endTime', 'creationTime', 'photoTakenTime', 'takenAt',
];

function timeFromObject(obj) {
  for (const k of TIME_KEYS) {
    if (obj[k] == null) continue;
    const v = obj[k];
    // Google's photoTakenTime is { timestamp, formatted }.
    const t = toEpoch(typeof v === 'object' ? (v.timestamp ?? v.value ?? v.date) : v);
    if (t) return t;
  }
  // Snapchat's "Daily Top Locations" hides the date in the *key*:
  // { "Date: 2026-06-01 UTC": "lat 46.6 …, long 7.6 …" }
  for (const k of Object.keys(obj)) {
    const m = /^Date:\s*(.+)$/i.exec(k);
    if (m) {
      const t = toEpoch(m[1]);
      if (t) return t;
    }
  }
  return 0;
}

// --- Coordinate shapes ---------------------------------------------------------
// "38.702, -9.228", optionally with accuracy: "46.584 ± 39.66 meters, 7.644 ±
// 39.66 meters" or "46.947, 7.444 +/- 65.0 meters", optionally "geo:"-prefixed.
const PAIR_RE =
  /^\s*(?:geo:)?(-?\d{1,2}(?:\.\d+)?)(?:\s*(?:±|\+\/-)[^,]*)?,\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*(?:±|\+\/-).*)?$/i;
// "lat 46.9 ± 4 meters, long 7.4 ± 4 meters"
const LATLONG_RE = /lat\s+(-?\d+(?:\.\d+)?)[^,]*,\s*long\s+(-?\d+(?:\.\d+)?)/i;

const validLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const validLng = (v) => Number.isFinite(v) && Math.abs(v) <= 180;

// Collects fixes and drops the obvious junk (null island, out-of-range values).
class PointSink {
  constructor() {
    this.points = [];
  }
  add(lat, lng, t = 0, ele) {
    if (!validLat(lat) || !validLng(lng)) return false;
    if (lat === 0 && lng === 0) return false; // null-island noise
    const p = { lat, lng, t: t || 0 };
    // Only when the file actually said so — an absent elevation and a real 0 m
    // are different answers, and climb() has to be able to tell them apart.
    if (Number.isFinite(ele)) p.ele = ele;
    this.points.push(p);
    return true;
  }
}

// --- Tracks ---------------------------------------------------------------------
// A track is one line the file drew, in the order it drew it:
//   { name, segments: [ [{lat,lng,t}, …], … ], firstAt, lastAt }
// Segments are the pen-up/pen-down breaks (GPX <trkseg>s, a MultiLineString) —
// keeping them apart stops a pause from being drawn as a straight jump.
// firstAt/lastAt are 0 unless the file dated the line as a whole; otherwise the
// point timestamps carry the dates.
function addTrack(tracks, name, segments, span, extra) {
  const segs = segments.filter((s) => s.length >= 2);
  if (!segs.length) return;
  tracks.push({
    name: name || '',
    segments: segs,
    firstAt: span?.[0] || 0,
    lastAt: span?.[1] || 0,
    sport: extra?.sport || '',
    elevUp: extra?.elevUp ?? climb(segs),
  });
}

// Text content of an XML element: entities decoded, CDATA unwrapped. Only the
// five predefined entities plus numeric ones — no DOMParser here, and export
// files don't declare their own.
function xmlText(raw) {
  if (!raw) return '';
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const XML_NAME = /<name\b[^>]*>([\s\S]*?)<\/name>/i;
const tagName = (block) => xmlText(XML_NAME.exec(block)?.[1] ?? '');

// --- Generic JSON harvesting ----------------------------------------------------
// Walks any JSON tree looking for coordinates, carrying the nearest enclosing
// timestamp down with it so fixes keep their date even when the date lives on
// a parent object (Google visits, Snapchat areas).
function pairFromObject(obj) {
  const get = (...keys) => {
    for (const k of keys) if (obj[k] != null && obj[k] !== '') return +obj[k];
    return undefined;
  };
  const lat = get('latitude', 'lat', 'Latitude', 'Lat');
  const lng = get('longitude', 'lng', 'lon', 'long', 'Longitude', 'Lng', 'Long');
  if (lat !== undefined && lng !== undefined) return [lat, lng];

  // Google's older Records.json stores coordinates multiplied by 10^7. Kept
  // separate from the plain aliases so a real latitude of 0 isn't mistaken for
  // a missing value.
  const latE7 = get('latitudeE7', 'latE7');
  const lngE7 = get('longitudeE7', 'lngE7', 'lonE7');
  if (latE7 !== undefined && lngE7 !== undefined) return [latE7 / 1e7, lngE7 / 1e7];
  return null;
}

function harvestJson(value, sink, inherited = 0) {
  if (typeof value === 'string') {
    const m = PAIR_RE.exec(value) ?? LATLONG_RE.exec(value);
    if (m) sink.add(+m[1], +m[2], inherited);
    return;
  }
  if (Array.isArray(value)) {
    // Snapchat's Location History rows are ["<date>", "<lat>, <lng>"].
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
      const t = toEpoch(value[0]);
      const m = PAIR_RE.exec(value[1]) ?? LATLONG_RE.exec(value[1]);
      if (t && m) {
        sink.add(+m[1], +m[2], t);
        return;
      }
    }
    for (const v of value) harvestJson(v, sink, inherited);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const t = timeFromObject(value) || inherited;
  const pair = pairFromObject(value);
  // If this object *is* a coordinate, record it; otherwise recurse. (Don't do
  // both — its lat/lng values would double-count further down.)
  if (pair && sink.add(pair[0], pair[1], t)) return;
  for (const [k, v] of Object.entries(value)) {
    // A "Date: … UTC" key dates only its own value.
    const m = /^Date:\s*(.+)$/i.exec(k);
    harvestJson(v, sink, (m && toEpoch(m[1])) || t);
  }
}

// --- GeoJSON -------------------------------------------------------------------
function harvestGeometry(geom, sink, t) {
  if (!geom || typeof geom !== 'object') return;
  if (geom.type === 'GeometryCollection') {
    (geom.geometries ?? []).forEach((g) => harvestGeometry(g, sink, t));
    return;
  }
  // Every geometry's coordinates bottom out in [lng, lat] pairs.
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') sink.add(c[1], c[0], t);
    else c.forEach(walk);
  };
  walk(geom.coordinates);
}

// Line geometry inside a feature, as one track per feature (a MultiLineString
// keeps its parts as segments).
function geoJsonTrack(geom) {
  if (!geom || typeof geom !== 'object') return [];
  if (geom.type === 'GeometryCollection') {
    return (geom.geometries ?? []).flatMap(geoJsonTrack);
  }
  const line = (coords) => {
    const seg = new PointSink();
    for (const c of coords ?? []) if (Array.isArray(c)) seg.add(+c[1], +c[0], 0);
    return seg.points;
  };
  if (geom.type === 'LineString') return [line(geom.coordinates)];
  if (geom.type === 'MultiLineString') return (geom.coordinates ?? []).map(line);
  return [];
}

function parseGeoJson(json, sink, tracks) {
  const feature = (f) => {
    const props = f.properties ?? null;
    const t = props ? timeFromObject(props) : 0;
    harvestGeometry(f.geometry ?? f, sink, t);
    if (!tracks) return;
    const name = props ? String(props.name ?? props.title ?? props.Name ?? '') : '';
    // A GeoJSON line has no per-point times, so the feature's own date (if it
    // has one) dates the whole thing.
    addTrack(tracks, name, geoJsonTrack(f.geometry ?? f), t ? [t, t] : null);
  };
  if (json.type === 'FeatureCollection') (json.features ?? []).forEach(feature);
  else if (json.type === 'Feature') feature(json);
  else feature({ geometry: json });
}

// --- GPX -----------------------------------------------------------------------
// Attribute-order independent, and self-closing tags work too: we match the
// opening tag, then look a short way ahead for this point's <time>.
const GPX_TAG = /<(trkpt|rtept|wpt)\b([^>]*)>/gi;
const ATTR = (attrs, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs);
  return m ? +m[1] : NaN;
};

function gpxPoints(text, sink) {
  GPX_TAG.lastIndex = 0;
  let m;
  while ((m = GPX_TAG.exec(text))) {
    const lat = ATTR(m[2], 'lat');
    const lng = ATTR(m[2], 'lon');
    if (!validLat(lat) || !validLng(lng)) continue;
    // <time> belongs to this point if it shows up before the next one.
    const tail = text.slice(m.index, m.index + 500);
    const tm = /<time>([^<]+)<\/time>/i.exec(tail);
    const nextTag = /<(?:trkpt|rtept|wpt)\b/i.exec(tail.slice(m[0].length));
    const limit = nextTag ? nextTag.index + m[0].length : Infinity;
    const em = /<ele>([^<]+)<\/ele>/i.exec(tail);
    sink.add(
      lat,
      lng,
      tm && tm.index < limit ? toEpoch(tm[1]) : 0,
      em && em.index < limit ? +em[1] : undefined,
    );
  }
}

// The lines a GPX drew: every <trk> (one segment per <trkseg>) and every <rte>.
// Loose <wpt>s are fixes, not a route, so they only reach the flat point list.
const GPX_TRACK = /<(trk|rte)\b[^>]*>([\s\S]*?)<\/\1>/gi;
// <trk><type> is where GPX writers put the activity. Numeric values are Garmin
// sport codes and say nothing a reader would recognize, so they're dropped.
const GPX_TYPE = /<type>([^<]{1,40})<\/type>/i;
const gpxSport = (body) => {
  const t = xmlText(GPX_TYPE.exec(body)?.[1] ?? '');
  return /^\d+$/.test(t) ? '' : t;
};
const GPX_SEG = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi;

function chunkPoints(chunk) {
  const s = new PointSink();
  gpxPoints(chunk, s);
  return s.points;
}

function parseGpx(text, sink, tracks) {
  gpxPoints(text, sink);
  GPX_TRACK.lastIndex = 0;
  let m;
  while ((m = GPX_TRACK.exec(text))) {
    const body = m[2];
    const segments = [];
    if (m[1].toLowerCase() === 'trk') {
      GPX_SEG.lastIndex = 0;
      let s;
      while ((s = GPX_SEG.exec(body))) segments.push(chunkPoints(s[1]));
    } else {
      segments.push(chunkPoints(body));
    }
    addTrack(tracks, tagName(body), segments, null, { sport: gpxSport(body) });
  }
}

// --- KML -----------------------------------------------------------------------
// One pass over <when>, <coordinates> and <gx:coord> in document order, so
// gx:Track points (where the date and the coordinate are siblings) stay paired
// and ordinary Placemarks inherit their own TimeStamp/TimeSpan.
const KML_TOKEN = /<when>([^<]*)<\/when>|<coordinates>([\s\S]*?)<\/coordinates>|<gx:coord>([^<]*)<\/gx:coord>/gi;

function parseKml(text, sink, tracks) {
  KML_TOKEN.lastIndex = 0;
  let lastWhen = 0;
  let m;
  while ((m = KML_TOKEN.exec(text))) {
    if (m[1] !== undefined) {
      lastWhen = toEpoch(m[1]);
    } else if (m[2] !== undefined) {
      // "lng,lat[,alt]" tuples separated by whitespace.
      for (const tok of m[2].trim().split(/\s+/)) {
        const [lng, lat] = tok.split(',').map(Number);
        sink.add(lat, lng, lastWhen);
      }
    } else if (m[3] !== undefined) {
      const [lng, lat] = m[3].trim().split(/\s+/).map(Number);
      sink.add(lat, lng, lastWhen);
    }
  }
  if (tracks) kmlTracks(text, tracks);
}

// Lines drawn by a KML: a Placemark's LineString(s), or a gx:Track (a
// Timeline/Earth recording, where each point carries its own <when>). Points,
// polygons and the rest of a Placemark's geometry stay fixes only.
const KML_PLACEMARK = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
const KML_LINE = /<LineString\b[^>]*>([\s\S]*?)<\/LineString>/gi;
const KML_GX_TRACK = /<gx:Track\b[^>]*>([\s\S]*?)<\/gx:Track>/gi;
const KML_COORDS = /<coordinates>([\s\S]*?)<\/coordinates>/i;
const KML_SPAN = /<begin>([^<]*)<\/begin>\s*<end>([^<]*)<\/end>/i;
const KML_STAMP = /<TimeStamp\b[^>]*>\s*<when>([^<]*)<\/when>/i;

// "lng,lat[,alt]" tuples separated by whitespace.
function kmlCoords(text, t) {
  const out = new PointSink();
  for (const tok of text.trim().split(/\s+/)) {
    const [lng, lat] = tok.split(',').map(Number);
    out.add(lat, lng, t);
  }
  return out.points;
}

function kmlTracks(text, tracks) {
  KML_PLACEMARK.lastIndex = 0;
  let pm;
  while ((pm = KML_PLACEMARK.exec(text))) {
    const body = pm[1];
    const name = tagName(body);
    const span = KML_SPAN.exec(body);
    const stamp = toEpoch(KML_STAMP.exec(body)?.[1] ?? '');
    const at = span ? [toEpoch(span[1]), toEpoch(span[2])] : stamp ? [stamp, stamp] : null;

    KML_GX_TRACK.lastIndex = 0;
    let gx;
    let recorded = false;
    while ((gx = KML_GX_TRACK.exec(body))) {
      // <when> and <gx:coord> come either interleaved or in two blocks
      // depending on the writer; pairing them by index reads both the same.
      const whens = [...gx[1].matchAll(/<when>([^<]*)<\/when>/gi)].map((w) => toEpoch(w[1]));
      const coords = [...gx[1].matchAll(/<gx:coord>([^<]*)<\/gx:coord>/gi)].map((c) => c[1].trim().split(/\s+/));
      const paired = whens.length === coords.length;
      const seg = new PointSink();
      coords.forEach(([lng, lat], i) => seg.add(+lat, +lng, paired ? whens[i] : 0));
      addTrack(tracks, name, [seg.points], paired ? null : at);
      recorded = true;
    }
    if (recorded) continue;

    KML_LINE.lastIndex = 0;
    const segments = [];
    let ls;
    while ((ls = KML_LINE.exec(body))) {
      const coords = KML_COORDS.exec(ls[1]);
      if (coords) segments.push(kmlCoords(coords[1], at?.[0] ?? 0));
    }
    addTrack(tracks, name, segments, at);
  }
}

// --- CSV / TSV -------------------------------------------------------------------
function splitRow(line, delim) {
  // Minimal RFC-4180 handling: quoted fields may contain the delimiter.
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function csvHeader(text) {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].sort((a, b) => line.split(b).length - line.split(a).length)[0];
  const cols = splitRow(line, delim).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names) => cols.findIndex((c) => names.includes(c));
  const lat = find('lat', 'latitude', 'ylat', 'y');
  const lng = find('lon', 'lng', 'long', 'longitude', 'xlong', 'x');
  if (lat < 0 || lng < 0) return null;
  return { delim, lat, lng, time: find('time', 'timestamp', 'date', 'datetime', 'when') };
}

function parseCsv(text, header, sink) {
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = splitRow(lines[i], header.delim);
    sink.add(+row[header.lat], +row[header.lng], header.time >= 0 ? toEpoch(row[header.time]) : 0);
  }
}

// --- Format detection ------------------------------------------------------------
function detectJson(json) {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    if (json['Location History'] || json['Home, School & Work'] || json['Daily Top Locations']) {
      return 'snapchat';
    }
    if (json.type === 'FeatureCollection' || json.type === 'Feature') return 'geojson';
    if (Array.isArray(json.locations)) return 'google-timeline'; // Records.json
    if (Array.isArray(json.semanticSegments) || Array.isArray(json.timelineObjects)) {
      return 'google-timeline';
    }
  }
  if (Array.isArray(json)) {
    const probe = json.slice(0, 40).filter((e) => e && typeof e === 'object');
    if (probe.some((e) => e.visit || e.activity || e.timelinePath || e.timelineMemory)) {
      return 'google-timeline';
    }
    // A flat array of nothing but lat/lng objects is what the Apple Photos
    // geotag dump looks like.
    if (probe.length && probe.every((e) => pairFromObject(e) && Object.keys(e).length <= 3)) {
      return 'apple-photos';
    }
  }
  return 'other';
}

/**
 * Sniff a location export and pull every coordinate out of it.
 *
 * @param {string} name file name (only used for the extension hint)
 * @param {string} text raw file contents
 * @returns {{source:string, format:string, points:Array<{lat:number,lng:number,t:number}>,
 *            tracks:Array<{name:string, segments:Array<Array<object>>, firstAt:number, lastAt:number}>,
 *            error?:string}}
 */
export function parseLocationFile(name, text) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] ?? '').toLowerCase();
  const sink = new PointSink();
  const tracks = [];
  const head = text.slice(0, 4096).trim();

  const done = (source, format) => ({ source, format, points: sink.points, tracks });
  const fail = (source, format, error) => ({ source, format, points: [], tracks: [], error });

  // XML family — GPX, TCX and KML all start with a declaration or a root tag.
  if (head.startsWith('<') || ext === 'gpx' || ext === 'kml' || ext === 'xml' || ext === 'tcx') {
    // TCX before GPX: both are XML with per-point times, but a TCX has no
    // <trkpt> at all, so the GPX pass would quietly find nothing.
    if (looksLikeTcx(head) || ext === 'tcx') {
      try {
        const t = parseTcx(text);
        for (const p of t.points) sink.add(p.lat, p.lng, p.t);
        for (const track of t.tracks) tracks.push(track);
        if (sink.points.length) return done('tcx', 'TCX');
      } catch (e) {
        return fail('other', 'TCX', e.message);
      }
    }
    if (/<gpx\b/i.test(head) || ext === 'gpx') {
      parseGpx(text, sink, tracks);
      // A GPX that names its writer is filed under that app, not under "GPX".
      if (sink.points.length) return done(trackApp(text) ?? 'gpx', 'GPX');
    }
    parseKml(text, sink, tracks);
    if (sink.points.length) {
      // Google Earth / My Maps exports name themselves in the document.
      const google = /google|my\s*maps|takeout/i.test(head);
      return done(google ? 'google-maps' : 'kml', 'KML');
    }
    return fail('other', 'XML', 'No coordinates found in this XML file.');
  }

  // JSON family.
  if (head.startsWith('{') || head.startsWith('[') || ext === 'json' || ext === 'geojson') {
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return fail('other', 'JSON', `Not valid JSON (${e.message}).`);
    }
    const kind = ext === 'geojson' ? 'geojson' : detectJson(json);
    if (kind === 'geojson') parseGeoJson(json, sink, tracks);
    else harvestJson(json, sink);
    return done(kind, kind === 'geojson' ? 'GeoJSON' : 'JSON');
  }

  // Delimited text.
  const header = csvHeader(text);
  if (header) {
    parseCsv(text, header, sink);
    return done('csv', 'CSV');
  }

  return fail(
    'other',
    ext ? ext.toUpperCase() : 'Unknown',
    'Unrecognized file — expected KML, GPX, GeoJSON, CSV or a JSON location export.',
  );
}

// --- Fixes → cells ---------------------------------------------------------------
// A visit is a *stay*, not an arrival. Fixes in the same cell go on counting as
// one visit until a whole day passes with none of them: two fixes a second apart
// are one visit, a morning and an evening in the same place are one visit, and a
// week living there is one visit. Going back next month is a second.
//
// This was an hour, which answered the narrower question of how many times you
// *arrived* somewhere, and there is no reading of the word "visits" under which
// that is what it means. The cost was borne by exactly the places you know best:
// one cell of a real map recorded 1,837 arrivals against 103 stays, because a
// coffee run out and back counted twice and a night at home counted again every
// time the phone woke up on the far side of an hour's silence.
//
// A day is the shortest gap that swallows the silences *inside* a stay — a
// night's sleep, a working day indoors, a phone left on the charger — while
// still being shorter than any real absence. The worry it invites is a cell you
// pass through daily, which never sees a day-long gap and would read as one
// endless visit; measured across 6,953 cells of real history the longest single
// stay is 30 days and the 99th percentile is 3, so it doesn't happen. If it ever
// does, the fix is to break a stay on a calendar day with no fixes rather than
// on a rolling 24 hours, which costs a timezone to be right about.
export const VISIT_GAP_SEC = 86_400;

// Fixes in one cell → how many separate times you were there. Timestamps decide
// it when the file has them; otherwise all we know is the order the fixes came
// in, so each unbroken run through the cell counts once.
function countVisits(times, runs, gap) {
  if (!times.length) return Math.max(1, runs);
  times.sort((a, b) => a - b);
  let visits = 1;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > gap) visits++;
  return visits;
}

/**
 * Fold location fixes into level-0 hex cells.
 * `hits` is the visit count (what the heat map reads); `fixes` is how many raw
 * points landed in the cell, which is only ever shown as a detail.
 * @param {Array<{lat:number,lng:number,t:number}>} points in the order the file listed them
 * @returns {Array<{id:string, first:number, last:number, hits:number, fixes:number}>}
 */
export function pointsToCells(points, { visitGap = VISIT_GAP_SEC } = {}) {
  const N = colsOf(0);
  const cells = new Map();
  let prevId = null;
  for (const p of points) {
    const [col, row] = pointToCell(0, mercX(p.lng), mercY(p.lat));
    const id = `0/${normCol(col, N)}/${row}`;
    let cell = cells.get(id);
    if (!cell) cells.set(id, (cell = { id, first: 0, last: 0, hits: 0, fixes: 0, times: [], runs: 0 }));
    cell.fixes++;
    if (id !== prevId) cell.runs++; // entered the cell (again)
    prevId = id;
    if (p.t) {
      cell.times.push(p.t);
      if (!cell.first || p.t < cell.first) cell.first = p.t;
      if (p.t > cell.last) cell.last = p.t;
    }
  }
  return [...cells.values()].map(({ times, runs, ...cell }) => ({
    ...cell,
    hits: countVisits(times, runs, visitGap),
  }));
}
