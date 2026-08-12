// Home Assistant client: reads location fixes out of your own HA instance.
//
// This is a *pull*, not a push. HA doesn't send us anything; the server asks it
// "what did these entities do since <cursor>" on a schedule. That survives the
// map being down — the next poll simply asks for a longer window — and it needs
// nothing from HA beyond a long-lived access token.
//
// Two calls are used:
//   GET /api/states                     → which entities even have coordinates
//   GET /api/history/period/<from>?…    → their state changes over a window
//
// A device_tracker's *state* is its zone ("home", "not_home", "Work"); the
// coordinates live in its attributes, so `minimal_response` and `no_attributes`
// are both off and `significant_changes_only=0` is on — HA's default filtering
// drops the attribute-only changes, which for us is the entire point.
//
// Nothing here touches the database or the hex grid: it hands back plain
// {lat, lng, t} fixes, the same shape src/locations.js produces from a file.

import { guardedGetJson } from './net-guard.js';
// Every failure below is something you can act on — a token to replace, an
// address to correct — so it is a UserError and is shown as written. See
// server/user-error.js.
import { UserError } from './user-error.js';

// HA's recorder keeps ~10 days by default, so there's rarely more than that to
// find on a first sync. A longer window is still asked for in day-sized chunks:
// one query for a month of history is slow enough on a Raspberry Pi to time out.
export const FIRST_SYNC_DAYS = 10;
const CHUNK_SEC = 24 * 3600;
const MAX_CHUNKS_PER_RUN = 8;
const REQUEST_TIMEOUT_MS = 30000;

// Stop each run a minute short of now. Two machines' clocks are never exactly
// equal, and the cursor only moves forward — without the margin, a fix stamped
// a few seconds ahead of our clock would fall outside the window and then be
// behind the cursor on the next run, i.e. lost.
const LAG_SEC = 60;

// Entities that carry `latitude`/`longitude`. `zone.*` has them too but never
// moves, and a router-based device_tracker has none at all (it's filtered out
// by the coordinate check, not by domain).
const LOCATION_DOMAINS = ['device_tracker', 'person'];

const isoOf = (sec) => new Date(sec * 1000).toISOString();

/**
 * Tidy a pasted server address into an origin we can append paths to.
 * Accepts "homeassistant.local:8123", a trailing slash, or a copied "…/api/"
 * URL. Returns null if it isn't a usable http(s) address.
 */
export function normalizeBaseUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentials in the URL would be sent on every poll and stored in the clear.
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${url.origin}${path}`;
}

// Something we could actually follow: the right shape, and in a domain that
// carries coordinates. Anything else would just be a wasted filter on every
// history query.
export function isFollowableEntity(id) {
  if (typeof id !== 'string' || id.length > 100) return false;
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id)) return false;
  return LOCATION_DOMAINS.includes(id.slice(0, id.indexOf('.')));
}

// One GET against HA. Errors are deliberately thin — a status code and what it
// usually means — because this URL is whatever the account typed in, and echoing
// a remote body back would turn the sync into a general-purpose page fetcher.
//
// It goes through guardedGetJson rather than fetch() because the address is
// untrusted input: that resolves the name, refuses link-local and reserved
// ranges, and pins the connection to the address it checked so the name can't
// resolve somewhere else in between. See server/net-guard.js.
async function haGet({ baseUrl, token }, pathAndQuery) {
  const res = await guardedGetJson(`${baseUrl}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (res.status === 401 || res.status === 403) {
    throw new UserError('Home Assistant rejected the access token.');
  }
  if (!res.ok) {
    throw new UserError(`Home Assistant answered ${res.status}.`);
  }
  if (res.json === null) {
    throw new UserError("That address answered, but not with Home Assistant's API.");
  }
  return res.json;
}

// The cheapest thing that proves both the address and the token. Throws with a
// readable reason if either is wrong.
export async function ping(link) {
  const hello = await haGet(link, '/api/');
  if (!hello || typeof hello.message !== 'string') {
    throw new UserError("That address answered, but not with Home Assistant's API.");
  }
}

/**
 * Check an address + token and list the entities worth following.
 * @returns {Promise<{entities: Array<{id, name, state, lat, lng, accuracy}>}>}
 */
export async function probe(link) {
  await ping(link);

  const states = await haGet(link, '/api/states');
  if (!Array.isArray(states)) throw new UserError('Home Assistant sent an unexpected list of entities.');

  const entities = [];
  for (const s of states) {
    const id = s?.entity_id;
    if (!isFollowableEntity(id)) continue;
    const a = s.attributes ?? {};
    const lat = +a.latitude;
    const lng = +a.longitude;
    entities.push({
      id,
      name: String(a.friendly_name ?? id),
      state: String(s.state ?? ''),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      accuracy: Number.isFinite(+a.gps_accuracy) ? Math.round(+a.gps_accuracy) : null,
    });
  }
  // Ones that are reporting coordinates right now first — those are the ones
  // worth ticking.
  entities.sort((a, b) => (b.lat !== null) - (a.lat !== null) || a.name.localeCompare(b.name));
  return { entities };
}

// One history response → fixes, keeping only what lands inside (after, until]
// and is precise enough to trust. `after` is exclusive so consecutive chunks
// can share a boundary without counting the state on it twice.
function statesToPoints(payload, { maxAccuracyM, after, until }, out) {
  for (const series of Array.isArray(payload) ? payload : []) {
    for (const s of Array.isArray(series) ? series : []) {
      const a = s?.attributes;
      if (!a) continue;
      const lat = +a.latitude;
      const lng = +a.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (lat === 0 && lng === 0) continue;
      // A fix the phone itself calls vague (cell-tower fallback, indoors) can
      // sit a cell or two away from where you were. Trackers that report no
      // accuracy at all are taken at their word.
      const acc = +a.gps_accuracy;
      if (maxAccuracyM > 0 && Number.isFinite(acc) && acc > maxAccuracyM) continue;
      const ms = Date.parse(s.last_updated ?? s.last_changed ?? '');
      if (Number.isNaN(ms)) continue;
      const t = Math.floor(ms / 1000);
      // HA opens every window with the state as it stood at the start, which is
      // usually older than the window itself — that one is already accounted for.
      if (t <= after || t > until) continue;
      out.push({ lat, lng, t });
    }
  }
  return out;
}

/**
 * Pull everything recorded for `entities` since the cursor.
 *
 * Walks forward in day-sized windows and stops after MAX_CHUNKS_PER_RUN, so
 * catching up after a long outage takes a few runs instead of one enormous
 * query. `through` is how far it actually got — that becomes the new cursor,
 * whether or not the window held any fixes.
 *
 * `chunks` is how many windows were actually asked for — zero means the cursor
 * was already current and Home Assistant was never contacted.
 *
 * @returns {Promise<{points: Array<{lat,lng,t}>, through: number, caughtUp: boolean, chunks: number}>}
 */
export async function pullFixes(link, { since, now, maxAccuracyM = 0 }) {
  const entities = (link.entities ?? []).filter(isFollowableEntity);
  if (!entities.length) throw new UserError('No Home Assistant devices are selected.');

  const end = now - LAG_SEC;
  const filter = entities.join(',');
  const points = [];
  let from = Math.min(since, end);
  let chunks = 0;

  while (from < end && chunks < MAX_CHUNKS_PER_RUN) {
    const to = Math.min(from + CHUNK_SEC, end);
    const query = new URLSearchParams({
      filter_entity_id: filter,
      end_time: isoOf(to),
      significant_changes_only: '0',
    });
    const payload = await haGet(link, `/api/history/period/${encodeURIComponent(isoOf(from))}?${query}`);
    statesToPoints(payload, { maxAccuracyM, after: from, until: to }, points);
    from = to;
    chunks++;
  }

  // Several entities come back as separate series; the visit clustering in
  // pointsToCells() reads them as one timeline, so they have to be in order.
  points.sort((a, b) => a.t - b.t);
  return { points, through: from, caughtUp: from >= end, chunks };
}
