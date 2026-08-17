// Strava client: OAuth, then the activities you've recorded.
//
// Unlike Komoot, this one runs on the server — not because Strava's API demands
// it (it sends `Access-Control-Allow-Origin: *`, so a browser could call it),
// but because two things need somewhere to live that isn't a tab:
//
//   • the client secret, which the token exchange requires and which must not
//     be shipped inside a page anyone can view-source;
//   • the schedule, so new rides show up on the map without you opening it.
//
// It is *your* Strava app: you register one at https://www.strava.com/settings/api
// (free, instant) and paste its id and secret in. A fresh app is limited to a
// single athlete until you ask Strava for more, which is exactly one more than
// this needs.
//
// Endpoints used:
//   POST /oauth/token                      → exchange a code, or refresh
//   GET  /api/v3/athlete/activities?after= → what's new since the cursor
//   GET  /api/v3/activities/<id>/streams   → the actual line, point by point
//
// Rate limits are 200 requests / 15 min and 2,000 / day for a personal app;
// one poll costs one list request plus one per new activity, so a normal week
// is a rounding error against that.

// Every failure below is something you can act on, so every one of them is a
// UserError and reaches the browser verbatim. See server/user-error.js.
import { UserError } from './user-error.js';

// STRAVA_BASE exists so the whole flow — sign-in, refresh, paging, streams —
// can be run against a stand-in instead of the real Strava. Leave it unset.
const BASE = process.env.STRAVA_BASE || 'https://www.strava.com';
const AUTH = `${BASE}/oauth/authorize`;
const TOKEN = `${BASE}/oauth/token`;
const API = `${BASE}/api/v3`;

const REQUEST_TIMEOUT_MS = 30000;
// A first connection reaches back this far. Strava keeps everything forever, so
// unlike Home Assistant there's no natural limit — this is just a sane start,
// and `Load everything` in the dialog lifts it.
export const FIRST_SYNC_DAYS = 365;
// Per run, so a decade of riding catches up over a few polls instead of
// spending the whole rate limit at once.
export const MAX_ACTIVITIES_PER_RUN = 25;
const PER_PAGE = 50;

// Recorded on a trainer or in a game: the coordinates, where they exist at all,
// are not ground anyone covered.
const INDOOR = new Set(['VirtualRide', 'VirtualRun', 'VirtualRow', 'Workout', 'WeightTraining', 'Yoga']);

export const scopeIsEnough = (scope) => String(scope ?? '').includes('activity:read');

async function call(url, init, what) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new UserError('Strava did not answer in time.');
    throw new UserError('Could not reach Strava.');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (res.status === 401) throw new UserError('Strava rejected the connection — reconnect it.');
  if (res.status === 429) throw new UserError('Strava rate limit reached; it will pick up again later.');
  if (!res.ok) {
    // Strava's errors are readable and about your own app's setup — worth
    // passing on, unlike a remote page body.
    const detail = body?.message || body?.errors?.[0]?.code;
    throw new UserError(`Strava refused the ${what}${detail ? ` (${detail})` : ''}.`);
  }
  if (body == null) throw new UserError(`Strava sent an unreadable ${what}.`);
  return body;
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // read_all so private activities come too — it's your own map.
    scope: 'activity:read_all',
    approval_prompt: 'auto',
    state,
  });
  return `${AUTH}?${q}`;
}

const tokenBody = (fields) =>
  call(
    TOKEN,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    },
    'sign-in',
  );

/** Trade the code from the callback for tokens. */
export async function exchangeCode({ clientId, clientSecret, code }) {
  const j = await tokenBody({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  });
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: String(j.refresh_token ?? ''),
    expiresAt: Math.trunc(+j.expires_at || 0),
    athlete: [j.athlete?.firstname, j.athlete?.lastname].filter(Boolean).join(' ').trim(),
  };
}

/** Strava's access tokens last six hours; the refresh token rotates too. */
export async function refreshToken({ clientId, clientSecret, refresh }) {
  const j = await tokenBody({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: String(j.refresh_token ?? refresh),
    expiresAt: Math.trunc(+j.expires_at || 0),
  };
}

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

/**
 * Activities started after `after` (epoch s), oldest first.
 * Only the ones that actually recorded a position outdoors.
 */
export async function listActivities({ token, after, limit = MAX_ACTIVITIES_PER_RUN }) {
  const out = [];
  for (let page = 1; out.length < limit && page <= 5; page++) {
    const q = new URLSearchParams({ after: String(after), per_page: String(PER_PAGE), page: String(page) });
    const batch = await call(`${API}/athlete/activities?${q}`, auth(token), 'activity list');
    if (!Array.isArray(batch) || !batch.length) break;
    for (const a of batch) {
      const startedAt = Math.floor(Date.parse(a?.start_date ?? '') / 1000) || 0;
      if (!startedAt || startedAt <= after) continue;
      // No summary line means no GPS was recorded at all.
      if (!a?.map?.summary_polyline) continue;
      if (a.trainer || INDOOR.has(a.type) || INDOOR.has(a.sport_type)) continue;
      out.push({
        id: String(a.id),
        name: String(a.name ?? '').trim(),
        sport: String(a.sport_type || a.type || '').trim(),
        startedAt,
        distanceM: +a.distance || 0,
        elapsedSec: Math.trunc(+a.elapsed_time || 0),
        // Strava has already worked the climb out; no need to re-derive it from
        // the altitude stream.
        elevUp: Math.max(0, Math.round(+a.total_elevation_gain || 0)),
      });
    }
    if (batch.length < PER_PAGE) break;
  }
  // `after` returns oldest-first, but don't rely on it: the cursor only ever
  // moves forward, so anything out of order would be silently dropped.
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out.slice(0, limit);
}

/**
 * The recorded line for one activity: [{lat, lng, t}], t absolute epoch seconds.
 * Returns [] when the streams have been stripped (some very old activities).
 */
export async function activityPoints({ token, activity }) {
  const q = new URLSearchParams({ keys: 'latlng,time', key_by_type: 'true' });
  const j = await call(`${API}/activities/${encodeURIComponent(activity.id)}/streams?${q}`, auth(token), 'activity');
  const latlng = j?.latlng?.data;
  if (!Array.isArray(latlng) || !latlng.length) return [];
  const times = Array.isArray(j?.time?.data) ? j.time.data : null;
  const points = [];
  for (const [i, pair] of latlng.entries()) {
    if (!Array.isArray(pair)) continue;
    const lat = +pair[0];
    const lng = +pair[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lat === 0 && lng === 0) continue;
    // `time` counts seconds from the start of the activity.
    const offset = times && Number.isFinite(+times[i]) ? Math.trunc(+times[i]) : 0;
    points.push({ lat, lng, t: activity.startedAt + offset });
  }
  return points;
}
