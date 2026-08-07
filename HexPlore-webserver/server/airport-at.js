// Which airport a point is standing in, if any.
//
// This exists for one caller: the phone, which wishes you a happy flight after
// you have been at an airport for ten minutes (`HexPlore-IOS/HexPlore/
// FlightWatch.swift`). The phone cannot answer the question itself — the airport
// dataset is 5,272 records it has no copy of, and bundling one would mean a
// generated resource in the Xcode project that goes stale silently. It can ask,
// and at an airport it has a network by definition.
//
// **Only airports with scheduled service.** `airports-airline.json` is already
// the narrowest of the four groups, and this narrows it again to the ones an
// airline actually flies from. The other 44,000 entries are airfields, helipads
// and closed strips: a flying club on the edge of town is somewhere you can
// legitimately spend an afternoon, and "happy flight" is a strange thing to be
// told while you are mowing a runway. A wrong notification is worse here than a
// missing one, because the missing one costs nothing and the wrong one is the
// app being odd at you.
//
// **The radius is by size and it is generous.** A record is one point — the
// airport reference point, usually near the middle of the field — and an airport
// is not a point. Frankfurt is four kilometres across and Dallas/Fort Worth is
// seven, so a tight radius answers "no" from inside the terminal, which is the
// only place this question is ever asked from. Being generous costs the case
// where somebody lives beside a runway, and they will be told to have a happy
// flight once, and then not again for hours (see the phone's own cooldown).

import { readFileSync } from 'node:fs';
import path from 'node:path';

// How far from the reference point still counts as being at the airport, by the
// dataset's own size letter. Large fields are genuinely kilometres across;
// medium ones are usually a single terminal and a strip.
const RADIUS_KM = { L: 3.2, M: 1.8 };
const DEFAULT_RADIUS_KM = 1.2;

// A degree of latitude is 111.32 km everywhere. Longitude is that times the
// cosine of the latitude, which is the whole of the correction needed at this
// scale — a proper great-circle distance would agree to within a metre or two
// over three kilometres, and this is a question about which side of a fence you
// are on.
const KM_PER_DEG = 111.32;

// The widest radius above, in degrees of latitude, used to reject most of the
// dataset with two comparisons before any arithmetic happens.
const MAX_RADIUS_DEG = 3.2 / KM_PER_DEG;

/** Field order in the tuple — mirrors AIRPORT_FIELDS in src/airports.js. */
const LNG = 0;
const LAT = 1;
const KIND = 2;
const NAME = 3;
const IATA = 4;
const ICAO = 5;
const MUNI = 6;
const COUNTRY = 7;
const SCHEDULED = 9;

// The filtered set, loaded once and kept — keyed by the root it was read from
// rather than held in one variable. There is only ever one root in a running
// server, so the map has one entry; it is keyed anyway because a cache that
// ignores its own argument is a cache that answers the wrong question the
// moment anything asks twice, and the thing that asks twice is the test.
const loaded = new Map();

/**
 * Read the dataset on first use.
 *
 * Lazy rather than at boot because a server nobody flies from should not pay
 * 770 KB of parse for a feature only the phone asks about — and because a
 * missing file has to leave the rest of the server working. No dataset means
 * this answers "no airport", which is what it answers in the middle of the sea.
 *
 * @param {string} root the webserver directory, whose `src/` holds the file
 */
function load(root) {
  const held = loaded.get(root);
  if (held) return held;
  let rows;
  try {
    const file = path.join(root, 'src', 'airports-airline.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    rows = (parsed.airports ?? []).filter((r) => r[SCHEDULED] === 1);
  } catch {
    // Cached as empty, so a missing dataset is not re-read and re-thrown on
    // every fix a phone sends.
    rows = [];
  }
  loaded.set(root, rows);
  return rows;
}

/**
 * The airport this point is standing in, or null.
 *
 * Nearest wins where two overlap, which is the right answer for the handful of
 * cities with two fields close together.
 *
 * @param {string} root the webserver directory
 * @param {number} lat
 * @param {number} lng
 * @returns {{name:string, iata:string, icao:string, city:string, country:string, km:number}|null}
 */
export function airportAt(root, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const rows = load(root);
  const lngScale = Math.cos((lat * Math.PI) / 180);
  // Guarded because at the poles the scale goes to zero and the longitude
  // window would become infinite. Nobody flies from there, but a divide by
  // zero is not the way to say so.
  const lngWindow = lngScale > 0.01 ? MAX_RADIUS_DEG / lngScale : 180;

  let best = null;
  let bestKm = Infinity;

  for (const r of rows) {
    const dLat = r[LAT] - lat;
    if (dLat > MAX_RADIUS_DEG || dLat < -MAX_RADIUS_DEG) continue;
    let dLng = r[LNG] - lng;
    // The antimeridian. Anadyr and Nadi are both real airports with real
    // flights, and a naive difference puts them 360° from a phone standing in
    // the terminal.
    if (dLng > 180) dLng -= 360;
    else if (dLng < -180) dLng += 360;
    if (dLng > lngWindow || dLng < -lngWindow) continue;

    const y = dLat * KM_PER_DEG;
    const x = dLng * KM_PER_DEG * lngScale;
    const km = Math.sqrt(x * x + y * y);
    if (km > (RADIUS_KM[r[KIND]] ?? DEFAULT_RADIUS_KM)) continue;
    if (km >= bestKm) continue;
    bestKm = km;
    best = r;
  }

  if (!best) return null;
  return {
    name: best[NAME] ?? '',
    iata: best[IATA] ?? '',
    icao: best[ICAO] ?? '',
    city: best[MUNI] ?? '',
    country: best[COUNTRY] ?? '',
    km: Math.round(bestKm * 100) / 100,
  };
}

/** Drop the cached dataset. Only the tests need this. */
export function resetAirports() {
  loaded.clear();
}
