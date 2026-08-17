// Where the sun is, for the map that has one.
//
// The 3D basemap is lit by a light preset — dawn, day, dusk or night — and it
// used to open on `day` whatever the clock said. This is what lets it open on
// the one that matches the sky outside the window instead. Nothing else on the
// map uses it, and nothing here talks to Mapbox: it answers *which part of the
// day it is where you are*, and src/mapbox.js is what turns that into a preset.
//
// **The clock alone cannot answer this, and that is the whole reason for the
// arithmetic below.** A table of hours — dawn at six, night at nine — is right
// in March and wrong in June, and wrongest exactly where this app is used: at
// 60°N the sun is still up at ten in the evening in midsummer and down by four
// in the afternoon at Christmas. A rule that darkens Oslo at nine on a bright
// June evening is not a rule about the sun, it is a rule about a spreadsheet.
// So the sun's actual elevation is computed, from a date and a place, and the
// answer is the same one you get by looking out of the window.
//
// The algorithm is the low-precision solar position the US Naval Observatory
// publishes in the Astronomical Almanac: good to about 0.01° between 1950 and
// 2050, which is four orders of magnitude better than a question whose answer
// changes at ±6° needs. It is forty lines of trigonometry and no network.

// --- Where the light changes --------------------------------------------------
//
// Two elevations, in degrees above the horizon, and everything between them is
// the low sun the two twilight presets are for.
//
// **−6° is civil twilight**, the published one: the sun is far enough under the
// horizon that the brightest stars are out and a newspaper cannot be read by
// daylight. Below it, `night` is what it looks like.
//
// **+6° is not published anywhere**, and is chosen for the same reason the
// bottom one is defensible: it is roughly where the golden hour ends and the
// light stops being obviously slanted. Standard's `dawn` and `dusk` are scenes
// with a low sun in them, so they get the band where the sun is low — from six
// under to six over, which is about an hour either side of sunrise in Bern and
// three weeks of continuous dusk in Tromsø, both of which are true.
export const DAY_ABOVE = 6;
export const NIGHT_BELOW = -6;

// Where the client is, remembered from the last time anything knew. See
// `sunSite`: the sun needs a place as well as a time, and the place arrives one
// network round trip after the first thing that wants an answer.
const SITE_KEY = 'visited-map:sun-site:v1';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Fold an angle into (−180, 180], which is where a signed hour angle lives. */
const wrap180 = (deg) => deg - 360 * Math.floor((deg + 180) / 360);

/**
 * The sun's elevation and hour angle, for a place and a moment.
 *
 * The hour angle comes back with it because the two together are the whole
 * answer: elevation says how high the sun is and the *sign* of the hour angle
 * says which side of noon it is on, which is the only difference between dawn
 * and dusk. Computing it twice, or comparing two elevations a few minutes
 * apart, would be a worse way of asking the same question.
 *
 * @param {number} lat  degrees north
 * @param {number} lon  degrees east
 * @param {Date}   when
 * @returns {{elevation: number, hourAngle: number}} both in degrees; the hour
 *   angle is negative before local solar noon and positive after it.
 */
function sunAt(lat, lon, when) {
  // Days since J2000 (2000-01-01 12:00 UTC). `getTime()` is UTC, so no part of
  // this depends on the device's time zone — only on its clock being right.
  const d = when.getTime() / 86400000 + 2440587.5 - 2451545;

  const meanAnomaly = (357.529 + 0.98560028 * d) * RAD;
  const meanLongitude = 280.459 + 0.98564736 * d;
  // The equation of the centre: the Earth's orbit is an ellipse, so the sun
  // runs up to sixteen minutes ahead of or behind the mean sun over the year.
  const eclipticLongitude = (meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  ) * DEG;

  // Greenwich mean sidereal time, in hours: the sky turns 360.9856° per solar
  // day, not 360°, because the Earth has moved along its orbit as well.
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const hourAngle = wrap180(gmst * 15 + lon - rightAscension);

  const phi = lat * RAD;
  const elevation = Math.asin(
    Math.sin(phi) * Math.sin(declination)
    + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle * RAD),
  ) * DEG;

  return { elevation, hourAngle };
}

/**
 * How high the sun is, in degrees above the horizon. Negative is below it.
 *
 * Exported for the test, which checks it against the two days of the year whose
 * answer can be worked out on paper — at the solstices the noon elevation is
 * 90° − |latitude| ± 23.44° and nothing else has to be trusted for that.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Date}   [when]
 */
export function solarElevation(lat, lon, when = new Date()) {
  return sunAt(lat, lon, when).elevation;
}

/**
 * Which part of the day it is at this place: `dawn`, `day`, `dusk` or `night`.
 *
 * The four words are Mapbox Standard's, because they are the four this exists
 * to choose between — but nothing about the maths is Mapbox's, and a caller
 * that wanted the same answer for something else would ask the same way.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Date}   [when]
 * @returns {'dawn'|'day'|'dusk'|'night'}
 */
export function sunPhase(lat, lon, when = new Date()) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'day';
  const { elevation, hourAngle } = sunAt(lat, lon, when);
  if (elevation >= DAY_ABOVE) return 'day';
  if (elevation <= NIGHT_BELOW) return 'night';
  return hourAngle < 0 ? 'dawn' : 'dusk';
}

// --- The place the sun is asked about -------------------------------------------

/**
 * Remember where the client is, coarsely, so the *next* load can answer before
 * the network does.
 *
 * The precision is deliberate: a tenth of a degree is eleven kilometres, which
 * moves sunrise by well under a minute, and there is no reason to write down a
 * street when a canton answers the question exactly as well.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean} whether anything was stored
 */
export function rememberSunSite(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return false;
  try {
    localStorage.setItem(SITE_KEY, JSON.stringify([+lat.toFixed(1), +wrap180(lon).toFixed(1)]));
  } catch {
    // Storage refused. The site is still handed straight to the caller that
    // learned it, so this load is right and only the next one falls back.
    return false;
  }
  return true;
}

/**
 * A latitude and longitude to put the sun over, best answer first.
 *
 * The awkward part of this feature is that the honest answer — where the client
 * actually is — is not known at the moment it is first needed: the chrome is
 * painted from the preset before the map exists, and the map's own position
 * arrives from an IP lookup or a GPS fix after that. So there are three
 * answers, and each is better than the one under it:
 *
 *   1. what was stored last time anything knew (a fix, or the IP landing),
 *   2. failing that, the device's time zone,
 *   3. and the time zone is turned into a longitude rather than into a table of
 *      hours, which is what makes it degrade gracefully rather than guess.
 *
 * That third point is the one worth the words. `getTimezoneOffset` is minutes
 * behind UTC, so a zone two hours ahead reports −120, and dividing by four
 * gives the longitude where the local clock *is* solar time. Pair that with a
 * latitude of zero and the arithmetic above collapses to exactly the naive
 * answer — day between six and six, twilight for the twenty minutes either side
 * — because at the equator that is genuinely when the sun rises and sets, every
 * day of the year. The fallback is the clock table, arrived at honestly, and it
 * stops being the answer the moment a real latitude is known.
 *
 * @param {Date} [when] the moment whose UTC offset to use, since it changes
 *   twice a year
 * @returns {[number, number]} `[lat, lon]`
 */
export function sunSite(when = new Date()) {
  try {
    const held = JSON.parse(localStorage.getItem(SITE_KEY) ?? 'null');
    if (Array.isArray(held) && held.length === 2 && held.every(Number.isFinite)
        && Math.abs(held[0]) <= 90) {
      return [held[0], wrap180(held[1])];
    }
  } catch {
    /* nothing stored, or storage unavailable — the time zone is below */
  }
  const offset = -(when.getTimezoneOffset?.() ?? 0);
  return [0, wrap180(offset / 4)];
}

/**
 * Which part of the day it is where the client is, right now.
 *
 * @param {Date} [when]
 * @param {[number, number]} [site] `[lat, lon]`, defaulting to `sunSite()`
 * @returns {'dawn'|'day'|'dusk'|'night'}
 */
export function timeOfDay(when = new Date(), site = sunSite(when)) {
  return sunPhase(site[0], site[1], when);
}
