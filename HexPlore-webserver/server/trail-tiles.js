// The trails overlay's tiles, fetched once for everyone and kept.
//
// **Why this is proxied at all, when their server invites the browser in.**
// Waymarked Trails answers every tile with `access-control-allow-origin: *`,
// which is an explicit invitation to fetch them from the page — and the four
// basemaps in src/basemap.js do exactly that with CARTO's, OpenFreeMap's and
// Esri's tiles. Three things make this one different:
//
//   **They are a volunteer project, and those are funded services with CDNs in
//   front of them.** Waymarked Trails is one maintainer's work on donated
//   hosting. The politeness argument is worth most precisely where the provider
//   is smallest, and a shared cache turns every device that ever opens this map
//   into one fetch rather than one fetch each.
//
//   **The cheap half of the bargain actually works here.** Their tiles carry an
//   `ETag`, so a tile we already hold costs them a 304 and a few hundred bytes
//   rather than a PNG — measured, not assumed.
//
//   **And the browser never has to say where it is looking.** This app is a map
//   of somebody's location history. Every tile request is a coordinate, and a
//   tile fetched from the page is that coordinate handed to a third party. The
//   proxy is the difference between "this server fetched a tile" and "this
//   person was here". The tap lookup below goes through the same door for the
//   same reason, and it is the stronger case of the two: a tap is a *point*.
//
// What that obliges this file to do, in the same terms server/rail-tiles.js sets
// out at greater length: **nothing is ever fetched that a person did not just
// look at** — no seeding, no prefetch, no walking a bounding box — and **it says
// who it is**, so that throttling or blocking this is something they can do.
//
// **Why this is not server/rail-tiles.js.** The two share a shape and
// deliberately not a file. That one stores gzipped, because a vector tile is
// protobuf and compresses to a third; a PNG is already compressed and gzipping
// it is work for nothing. That one keys on a language, carries sprite sheets and
// a feature API, and tracks a per-zoom hit rate so the overlay can step down a
// zoom when their CDN is cold. None of that exists here: there is one image per
// coordinate, and when it is missing the honest answer is no trails rather than
// blurrier ones. What is left is small enough to read in one sitting, which is
// worth more than sharing four functions with a file whose comments are all
// about somebody else's usage policy.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Point these at a local render of their stack and nothing else in this file
// changes. `{theme}` in the API origin is filled in per request: each theme is
// its own host, which is their arrangement rather than ours.
const TILE_ORIGIN = process.env.TRAILS_TILE_ORIGIN || 'https://tile.waymarkedtrails.org';
const API_ORIGIN = process.env.TRAILS_API_ORIGIN || 'https://{theme}.waymarkedtrails.org';

// Not faked, and not a browser. Same string the railway cache sends, for the
// same reason: if they want to throttle this, the header is how.
const USER_AGENT = 'HexPlore/0.1 (+https://github.com/zhekch/hexplore; personal map, server-side tile cache)';

/**
 * The renderings this map offers, in the order the layers menu offers them.
 *
 * The allowlist and the client's list are the same list in two places — a raster
 * theme is a path segment on their server and a label in a menu, and neither
 * half can own both. scripts/test/trails.mjs is what keeps them equal.
 *
 * **Four of their five.** They also publish `riding`, which is horse riding
 * rather than a second word for cycling, and it is left out here as well as in
 * the menu — an allowlist that quietly permitted a theme nothing can ask for
 * would be a proxy onto a path this app does not use.
 */
export const TRAIL_THEMES = ['hiking', 'cycling', 'mtb', 'slopes'];

// The deepest zoom they render. z19 is a 404, so asking for it is a request that
// can only fail — the client caps its source at this and lets the renderer
// overzoom, which is the correct rescaling rather than a guess.
export const TRAIL_MAX_ZOOM = 18;

// How long a stored tile is served without asking. OSM edits reach their tiles
// on the order of days, and a footpath re-tagged this morning is not worth a
// round trip per tile per hour to catch.
//
// **Their `Expires` is deliberately not read.** They send one, and it is three
// hours out — which is an answer about how long a *browser* should hold a tile,
// not a statement about how often a route relation changes. Honouring it here
// would be fifty-six revalidations a week per tile to learn nothing. `max-age`
// is honoured if they ever send one, because that would be a considered answer
// about a cache rather than the nginx default for a page.
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_MIN_MS = 60 * 60 * 1000;
const TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

// **Remembering that they said no**, so a tile their server could not answer is
// not asked for again on every pan. Starts short and doubles for as long as the
// failures keep coming: recovery is noticed within half a minute, a real outage
// settles to a trickle.
const FAIL_TTL_MS = 30 * 1000;
const FAIL_TTL_MAX_MS = 30 * 60 * 1000;

// Disk budget. Their PNGs run 200 bytes to 30 KB, so this is on the order of
// thirty thousand tiles; the sweep drops the least recently used down to
// LOW_WATER when it is exceeded.
const MAX_BYTES = Number(process.env.TRAILS_CACHE_BYTES) || 256 * 1024 * 1024;
const LOW_WATER = 0.8;

// At most this many requests to their servers at any instant, across every
// browser this server is talking to. A cold cache and a hundred tiles on screen
// is still a trickle.
const MAX_UPSTREAM = 6;
const FETCH_TIMEOUT_MS = 20000;

// Reading a file to serve it does not rewrite its mtime — that would be a write
// per tile per pan. An entry is only touched when the recency it records has
// drifted by more than this, which is precise enough to choose what to evict.
const TOUCH_AFTER_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

// How many routes one tap may come back with. A tap in the Alps can sit on a
// national trail, a regional one, three local ones and a node-network leg all at
// once, and a card is not a directory — but truncating below about a dozen
// starts hiding the answer somebody was looking for.
const NEAR_LIMIT = 20;

/** `{z}/{x}/{y}` is only ever three integers, and x/y only ever fit the zoom. */
export function validTileCoords(z, x, y) {
  const nums = [z, x, y].map((v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN));
  const [zi, xi, yi] = nums;
  if (nums.some((n) => !Number.isInteger(n))) return null;
  if (zi < 0 || zi > TRAIL_MAX_ZOOM) return null;
  const span = 2 ** zi;
  if (xi < 0 || xi >= span || yi < 0 || yi >= span) return null;
  return { z: zi, x: xi, y: yi };
}

// --- Where a tap is, in the units their API counts in --------------------------
//
// `by_area` takes a bounding box in **EPSG:3857 metres**, not degrees. Nothing
// says so — a box in degrees is a valid request that answers `{"results":[]}`
// for everywhere on earth, which is the most expensive kind of wrong: it looks
// like "no trails here" and it is "you asked in the wrong units". Their own site
// hands it an OpenLayers map extent, which is metres because their view is, and
// that is the whole of the documentation.
//
// The client sends degrees because degrees are what a map click gives you, and
// this is the one place that knows about their units.

const EARTH_R = 6378137;
// Mercator is undefined at the poles and unhelpful either side of about 85.05°,
// which is where the projection's square ends. Clamped rather than rejected: a
// tap up there is a real tap, and the answer for the top of the square is the
// closest true thing this can say.
const MERCATOR_MAX_LAT = 85.05112878;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** One lon/lat pair as [x, y] in Web Mercator metres. */
export function toMercator(lon, lat) {
  const y = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI / 360;
  return [
    clamp(lon, -180, 180) * Math.PI / 180 * EARTH_R,
    Math.log(Math.tan(Math.PI / 4 + y)) * EARTH_R,
  ];
}

/**
 * `w,s,e,n` in degrees as the `bbox=` their API wants, or null if it is not a
 * bounding box. Ordered on the way out, so a box handed over inside out — which
 * is what dragging a selection right-to-left gives you — is still a box.
 */
export function mercatorBbox(text) {
  const parts = String(text ?? '').split(',');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = nums;
  if (Math.abs(s) > 90 || Math.abs(n) > 90) return null;
  const [x1, y1] = toMercator(Math.min(w, e), Math.min(s, n));
  const [x2, y2] = toMercator(Math.max(w, e), Math.max(s, n));
  return [x1, y1, x2, y2].map((v) => v.toFixed(1)).join(',');
}

/**
 * One of their route records, reduced to what a card actually shows.
 *
 * A pass-through would be simpler and would make their response shape part of
 * this app's client contract, so that a field they rename becomes a card that
 * renders `undefined`. Naming the six fields we read is the check: anything else
 * they add is ignored, and anything they drop is visibly absent here rather than
 * three modules away.
 *
 * `id` is the OSM relation, which is what the card links to.
 */
function oneRoute(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.id)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: r.id,
    name: str(r.name),
    ref: str(r.ref),
    // How far the route runs, in their vocabulary — 'INT' | 'NAT' | 'REG' |
    // 'LOC' | 'NDS' and a few others. Left as their token; src/trails.js has
    // the words.
    //
    // **A number under `slopes`, and that is not a difficulty.** Winter routes
    // are grouped by what you would be doing on them (1 downhill, 2 nordic, and
    // so on), so this field is a string for four themes and an integer for the
    // fifth. Carried across as whichever it arrived as rather than coerced: a
    // `'1'` and a `1` would look the same on the wire and land in different
    // halves of the lookup at the other end.
    group: typeof r.group === 'number' ? r.group : (str(r.group) ?? ''),
    // Where it runs between, as a list of places. Absent on most local routes.
    itinerary: Array.isArray(r.itinerary) ? r.itinerary.filter((v) => str(v)).slice(0, 8) : [],
    // The waymark you would actually see on a post, described in words. Their
    // own field, and the single most useful thing on the card when you are
    // standing at a junction.
    symbol: str(r.symbol_description),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.dir where to keep the cache
 * @param {string} [opts.tileOrigin] upstream tiles; the tests point this at a
 *   local stand-in, since the real one cannot be asked for a 304 on demand
 * @param {string} [opts.apiOrigin] upstream API, with `{theme}` for the host
 * @param {(msg: string) => void} [opts.log]
 */
export function createTrailTiles({
  dir, tileOrigin = TILE_ORIGIN, apiOrigin = API_ORIGIN, log = () => {},
}) {
  const themes = new Set(TRAIL_THEMES);
  const inFlight = new Map();
  let upstreamBusy = 0;
  const upstreamQueue = [];
  let lastSweep = 0;
  let sweeping = null;
  // One line per failing minute across everything, rather than one per tile. A
  // thousand identical "upstream 502" lines is not a log, it is the reason
  // nobody reads the log.
  let mutedSince = 0;
  let mutedCount = 0;

  function noteFailure(what, why) {
    mutedCount++;
    const now = Date.now();
    if (mutedSince && now - mutedSince < 60_000) return;
    log(`${why} for ${what}${mutedCount > 1 ? ` (and ${mutedCount - 1} others since)` : ''}`);
    mutedSince = now;
    mutedCount = 0;
  }

  // Sharded, because a flat directory with thirty thousand entries in it is slow
  // to read on every filesystem that has ever been shipped.
  const fileFor = (key) => {
    const h = createHash('sha1').update(key).digest('hex');
    return path.join(dir, h.slice(0, 2), `${h}.bin`);
  };

  /** One slot at a time, so a cold cache cannot become a burst. */
  function withSlot(fn) {
    if (upstreamBusy < MAX_UPSTREAM) {
      upstreamBusy++;
      return fn().finally(() => {
        upstreamBusy--;
        upstreamQueue.shift()?.();
      });
    }
    return new Promise((resolve) => upstreamQueue.push(resolve)).then(() => withSlot(fn));
  }

  /** Fetch with our name on it and a timeout, or throw. */
  async function ask(url, headers = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      return await withSlot(() => fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: ac.signal,
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  // --- The store ---------------------------------------------------------------
  // One file per entry, body prefixed by a single-line JSON header, written
  // through a temp name and renamed so a half-written file can never be read
  // back as a complete answer. The metadata travels with the bytes, which is why
  // there is no index to fall out of step with the directory.

  async function readEntry(key) {
    const file = fileFor(key);
    let raw;
    try {
      raw = await readFile(file);
    } catch {
      return null;
    }
    const nl = raw.indexOf(0x0a);
    if (nl < 0) return null;
    try {
      const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
      return { ...meta, body: raw.subarray(nl + 1), file };
    } catch {
      return null; // corrupt; treated as a miss and overwritten on the next fetch
    }
  }

  async function writeEntry(key, meta, body) {
    const file = fileFor(key);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), body]));
      await rename(tmp, file);
    } catch (e) {
      log(`could not cache ${key}: ${e.message ?? e}`);
    }
    sweepSoon();
  }

  /** Record that an entry is still wanted, cheaply. See TOUCH_AFTER_MS. */
  async function touch(file) {
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < TOUCH_AFTER_MS) return;
      const now = new Date();
      await utimes(file, now, now);
    } catch {
      /* the sweep may have taken it; nothing to record */
    }
  }

  function sweepSoon() {
    if (sweeping || Date.now() - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = Date.now();
    sweeping = sweep()
      .catch((e) => log(`cache sweep failed: ${e.message ?? e}`))
      .finally(() => { sweeping = null; });
  }

  /** Drop the least recently used until the directory is back under budget. */
  async function sweep() {
    const files = [];
    let total = 0;
    for (const shard of await readdir(dir).catch(() => [])) {
      const shardDir = path.join(dir, shard);
      for (const name of await readdir(shardDir).catch(() => [])) {
        if (!name.endsWith('.bin')) continue;
        const full = path.join(shardDir, name);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        files.push({ full, mtime: s.mtimeMs, size: s.size });
        total += s.size;
      }
    }
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    const target = MAX_BYTES * LOW_WATER;
    let dropped = 0;
    for (const f of files) {
      if (total <= target) break;
      await unlink(f.full).catch(() => {});
      total -= f.size;
      dropped++;
    }
    log(`cache sweep: dropped ${dropped} entries, now ${(total / 1024 / 1024).toFixed(0)} MB`);
  }

  /** Their `max-age`, if they ever send one. See the note on TILE_TTL_MS. */
  function ttlFrom(headers) {
    const m = /max-age=(\d+)/.exec(headers.get('cache-control') ?? '');
    if (!m) return TILE_TTL_MS;
    return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number(m[1]) * 1000));
  }

  /** Fetch one tile, or ask them to confirm the one we hold is still good. */
  async function fromUpstream(upstreamPath, previous) {
    // Resolved against the origin rather than glued to it. The theme is already
    // matched against the allowlist and the coordinates are already three
    // integers, so nothing else can reach here — but that is a promise made
    // elsewhere and checked nowhere. Resolving keeps it true where it matters:
    // `//elsewhere/x`, a `..` walk or a scheme all come out as a different
    // origin, and a different origin is not somebody we fetch from.
    const url = new URL(upstreamPath, `${tileOrigin}/`).href;
    if (!url.startsWith(`${tileOrigin}/`)) {
      noteFailure(upstreamPath, 'refused: resolves off upstream');
      return { failed: true, status: 0 };
    }
    try {
      // The cheap half of the bargain: when we already have a copy, ask them to
      // tell us it is still good rather than to send it again.
      const res = await ask(url, previous?.etag ? { 'If-None-Match': previous.etag } : {});
      if (res.status === 304 && previous) {
        return { meta: { ...previous, fetchedAt: Date.now() }, body: previous.body };
      }
      if (!res.ok) {
        noteFailure(upstreamPath, `upstream ${res.status}`);
        return { failed: true, status: res.status };
      }
      const body = Buffer.from(await res.arrayBuffer());
      return {
        meta: {
          status: 200,
          type: res.headers.get('content-type') ?? 'image/png',
          etag: res.headers.get('etag'),
          // Stored as it arrived. See the note at the head of this file on why
          // this is the one thing the railway cache does that this does not.
          gzip: false,
          ttl: ttlFrom(res.headers),
          fetchedAt: Date.now(),
        },
        body,
      };
    } catch (e) {
      noteFailure(upstreamPath, `upstream unreachable (${e.message ?? e})`);
      return { failed: true, status: 0 };
    }
  }

  return {
    dir,
    themes,

    /**
     * One raster tile, or null for anything we will not or cannot answer.
     *
     * One flight per tile however many browsers ask at once, and last week's
     * copy when upstream cannot answer — an old tile beats no map.
     */
    async tile(theme, z, x, y) {
      if (!themes.has(theme)) return null;
      const at = validTileCoords(z, x, y);
      if (!at) return null;

      const key = `trail:${theme}/${at.z}/${at.x}/${at.y}`;
      const upstreamPath = `${theme}/${at.z}/${at.x}/${at.y}.png`;
      const existing = await readEntry(key);
      const age = existing ? Date.now() - existing.fetchedAt : Infinity;

      // A stored failure is an answer too, and honouring its TTL is the whole
      // point: without it, a tile they cannot serve is asked for again on every
      // pan across it.
      if (existing?.failed) {
        if (age < existing.ttl) return null;
      } else if (existing && age < (existing.ttl ?? TILE_TTL_MS)) {
        touch(existing.file);
        return existing;
      }

      if (inFlight.has(key)) return inFlight.get(key);
      const job = (async () => {
        const got = await fromUpstream(upstreamPath, existing?.failed ? null : existing);
        if (got.failed) {
          if (existing && !existing.failed) return existing;
          const ttl = Math.min(FAIL_TTL_MAX_MS, (existing?.ttl ?? FAIL_TTL_MS / 2) * 2);
          await writeEntry(key, { failed: true, status: got.status, ttl, fetchedAt: Date.now() }, Buffer.alloc(0));
          return null;
        }
        await writeEntry(key, got.meta, got.body);
        return { ...got.meta, body: got.body };
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, job);
      return job;
    },

    /**
     * Which routes run near a place, for the card a tap opens.
     *
     * **Deliberately not cached.** Every other answer in this file is the same
     * for everybody and asked for by the hundred, which is what makes a cache
     * worth its disk. This is one request a person just made, about a box that
     * is different every time — caching it would spend a write to save nothing.
     * It goes through the proxy for the other reason at the top of this file:
     * so that the coordinate somebody just tapped stays here.
     *
     * @param {string} theme
     * @param {string} bbox `w,s,e,n` in degrees
     * @returns {Promise<{routes: object[]}|null>} null if we will not ask
     */
    async near(theme, bbox) {
      if (!themes.has(theme)) return null;
      const box = mercatorBbox(bbox);
      if (!box) return null;
      const origin = apiOrigin.replace('{theme}', theme);
      const url = new URL(`api/v1/list/by_area?bbox=${box}&limit=${NEAR_LIMIT}`, `${origin}/`).href;
      if (!url.startsWith(`${origin}/`)) return null;
      try {
        const res = await ask(url);
        if (!res.ok) {
          noteFailure(`by_area ${theme}`, `upstream ${res.status}`);
          return null;
        }
        const body = await res.json();
        return { routes: (body?.results ?? []).map(oneRoute).filter(Boolean) };
      } catch (e) {
        noteFailure(`by_area ${theme}`, `upstream unreachable (${e.message ?? e})`);
        return null;
      }
    },
  };
}
