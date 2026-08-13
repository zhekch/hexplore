// MapTiler's Outdoor vector tiles, fetched once for everyone and kept.
//
// The second way of drawing the waymarked routes, beside server/trail-tiles.js.
// That one is a picture of the routes; this one is the routes, which is what
// makes "only the main ones" a filter in the renderer rather than a thing that
// cannot be asked for. See the head of src/trails-vector.js for what that buys
// and what it costs.
//
// **Why this is a third cache and not a third caller of one.** rail-tiles.js and
// trail-tiles.js already say why they are not each other; this file's answer is
// shorter and is about the one thing neither of them has. **These requests carry
// a key**, which is somebody's account with a monthly quota on it. The key
// decides whether a tile can be fetched at all, it must never reach the disk,
// the logs or the browser, and it is the reason a 403 here means "fix your
// settings" where a 403 there means "their server is unhappy". Putting that in
// the file whose entire header is about being gentle with a volunteer project
// would make both of them harder to read than keeping the two apart. What is
// left is deliberately the smallest of the three, because MapTiler needs less
// than either: no sprite sheets, no language, no per-zoom hit rate, and no
// symbol or detail API.
//
// The obligations are the same and they are not weaker for the provider being
// commercial: **nothing is fetched that a person did not just look at**, and it
// says who it is.
//
// **What the browser must never do is fetch these itself.** api.maptiler.com
// answers `access-control-allow-origin: *`, so the page could — and that is
// exactly the trade the trails proxy exists to refuse. This app is a map of
// somebody's location history; every tile request is a coordinate, and a tile
// fetched from the page is that coordinate handed to a third party, with an
// account attached to it this time. The key stays here, the coordinates stay
// here, and MapTiler sees one server fetching tiles.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Point this at a local render and nothing else in this file changes.
const ORIGIN = process.env.MAPTILER_ORIGIN || 'https://api.maptiler.com';

// Which tileset. `outdoor` is the one with a `trail` layer in it — the standard
// vector schemas (OpenMapTiles, Shortbread, Protomaps, Mapbox Streets) carry no
// route relations at all, which is why this is MapTiler and not one of the many
// interchangeable sources of vector basemap tiles.
const TILESET = 'outdoor';

// Not faked, and not a browser. Same shape the other two caches send.
const USER_AGENT = 'HexPlore/0.1 (+https://github.com/zhekch/hexplore; personal map, server-side tile cache)';

// **The deepest zoom the tileset has, and it is 14 rather than the 18 the raster
// trails go to.** Past it their server answers 400 — not an empty tile, a
// refusal — so asking is a request that can only fail. The client caps its
// source here and lets the renderer overzoom, which for vector data is not the
// compromise it is for pixels: the lines are geometry, so a z17 view of a z14
// tile is drawn at full sharpness and merely carries no detail that was dropped
// on the way in. Nothing this app draws at z15+ was in the tile at z14 either.
export const MAPTILER_MAX_ZOOM = 14;

// How long a stored tile is served without asking.
//
// **Their `max-age` is four hours and is deliberately not honoured as a
// ceiling.** It is a CDN's answer about how long an edge should hold an object,
// not a statement about how often this data changes — and this data is a planet
// build with a datestamp on it, republished on the order of a month. Honouring
// four hours would be forty-two revalidations a week per tile to be told the
// same `Last-Modified` every time. A longer `max-age`, if they ever send one, is
// a considered answer about a cache and is taken.
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_MIN_MS = 60 * 60 * 1000;
const TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

// **Remembering that they said no**, so a tile their server could not answer is
// not asked for again on every pan. Starts short and doubles while the failures
// keep coming.
//
// A rejected key is deliberately kept at the short end: it is the one failure
// here that a person fixes from the settings dialog, and half an hour of
// remembering "your key is wrong" after they have pasted a right one would look
// exactly like the new key being wrong too.
const FAIL_TTL_MS = 30 * 1000;
const FAIL_TTL_MAX_MS = 30 * 60 * 1000;
const KEY_FAIL_TTL_MS = 15 * 1000;

// Disk budget. Their gzipped tiles run a few hundred bytes over open country to
// about 160 KB over the Alps at z10, so this is on the order of ten thousand
// tiles; the sweep drops the least recently used down to LOW_WATER.
const MAX_BYTES = Number(process.env.MAPTILER_CACHE_BYTES) || 256 * 1024 * 1024;
const LOW_WATER = 0.8;

// At most this many requests to their servers at any instant, across every
// browser this server is talking to.
const MAX_UPSTREAM = 6;
const FETCH_TIMEOUT_MS = 20000;

// Reading a file to serve it does not rewrite its mtime — that would be a write
// per tile per pan. See the same constant in server/trail-tiles.js.
const TOUCH_AFTER_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/**
 * A MapTiler key, as their dashboard issues them.
 *
 * Theirs are 20-odd characters of base62 and nothing else. This is not a
 * checksum and cannot tell a live key from a revoked one — what it is for is
 * that the value goes into a URL on their origin, so it must not be able to
 * spell a query separator, a path segment or a scheme. Alphanumeric is the whole
 * of it: without `&`, `?`, `/`, `#` or `:` there is no second parameter to
 * smuggle and no other host to reach.
 *
 * Exported for the test, and for the settings dialog to complain early rather
 * than after a round trip.
 */
export const validMaptilerKey = (key) => (/^[A-Za-z0-9]{8,64}$/.test(String(key ?? '')) ? String(key) : null);

/** `{z}/{x}/{y}` is only ever three integers, and x/y only ever fit the zoom. */
export function validTileCoords(z, x, y) {
  const nums = [z, x, y].map((v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN));
  const [zi, xi, yi] = nums;
  if (nums.some((n) => !Number.isInteger(n))) return null;
  if (zi < 0 || zi > MAPTILER_MAX_ZOOM) return null;
  const span = 2 ** zi;
  if (xi < 0 || xi >= span || yi < 0 || yi >= span) return null;
  return { z: zi, x: xi, y: yi };
}

/**
 * @param {object} opts
 * @param {string} opts.dir where to keep the cache
 * @param {string} [opts.origin] upstream; the tests point this at a local stand-in
 * @param {(msg: string) => void} [opts.log]
 */
export function createMaptilerTiles({ dir, origin = ORIGIN, log = () => {} }) {
  const inFlight = new Map();
  let upstreamBusy = 0;
  const upstreamQueue = [];
  let lastSweep = 0;
  let sweeping = null;
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

  // Sharded, because a flat directory with ten thousand entries in it is slow to
  // read on every filesystem that has ever been shipped.
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

  async function ask(url, headers = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      return await withSlot(() => fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        // Their tiles are gzip on the wire and are stored that way. Asking for
        // it explicitly rather than letting undici negotiate keeps what arrives
        // and what is written the same bytes.
        signal: ac.signal,
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  // --- The store ---------------------------------------------------------------
  // One file per entry, body prefixed by a single-line JSON header, written
  // through a temp name and renamed so a half-written file can never be read
  // back as a complete answer. The same arrangement as the other two caches, and
  // the reason there is no index to fall out of step with the directory.

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

  /** Their `max-age`, if it is longer than ours. See the note on TILE_TTL_MS. */
  function ttlFrom(headers) {
    const m = /max-age=(\d+)/.exec(headers.get('cache-control') ?? '');
    if (!m) return TILE_TTL_MS;
    return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Math.max(TILE_TTL_MS, Number(m[1]) * 1000)));
  }

  /**
   * Fetch one tile, or ask them to confirm the one we hold is still good.
   *
   * **Revalidated on `Last-Modified`, not `ETag`, because they send no `ETag`.**
   * The other two caches use `If-None-Match`; theirs is the weaker of the two
   * validators and it is what is on offer, so a tile we already hold still costs
   * them a 304 and a few hundred bytes rather than the tile again.
   */
  async function fromUpstream(z, x, y, key, previous) {
    // Resolved against the origin rather than glued to it. The coordinates are
    // three integers and the key is alphanumeric before either reaches here, so
    // nothing else can — but that is a promise made elsewhere and checked
    // nowhere. Resolving keeps it true where it matters.
    const url = new URL(`tiles/${TILESET}/${z}/${x}/${y}.pbf?key=${key}`, `${origin}/`).href;
    if (!url.startsWith(`${origin}/`)) {
      noteFailure(`${z}/${x}/${y}`, 'refused: resolves off upstream');
      return { failed: true, status: 0 };
    }
    try {
      const res = await ask(url, previous?.lastModified ? { 'If-Modified-Since': previous.lastModified } : {});
      if (res.status === 304 && previous) {
        return { meta: { ...previous, fetchedAt: Date.now() }, body: previous.body };
      }
      if (!res.ok) {
        // 403 is a rejected key. Said in those words and without the key in
        // them, because this line goes to a log file that is not as private as
        // the key is.
        noteFailure(`${z}/${x}/${y}`, res.status === 403 ? 'MapTiler rejected the key' : `upstream ${res.status}`);
        return { failed: true, status: res.status };
      }
      const raw = Buffer.from(await res.arrayBuffer());

      // **An empty body is an answer, and it is most of the planet.** Their
      // server sends 200 with zero bytes for a square with no trails in it,
      // where OpenRailwayMap sends a 204 — same meaning, different spelling.
      // Stored as one, so that panning over open country does not ask them
      // again for nothing, and sent on as a 204, which both renderers read as
      // "this tile is empty" rather than as a broken tile.
      if (!raw.length) {
        return {
          meta: {
            status: 204, type: '', lastModified: null, gzip: false, ttl: ttlFrom(res.headers), fetchedAt: Date.now(),
          },
          body: Buffer.alloc(0),
        };
      }

      // **Compressed here, not kept as it arrived.** Their tiles are gzip on the
      // wire and it is tempting to store those bytes — but `fetch` has already
      // decoded them by the time `arrayBuffer()` resolves, so what is in hand is
      // protobuf, and storing it under `gzip: true` would label plain bytes as
      // compressed. A browser then gets `Content-Encoding: gzip` over data that
      // is not, and fails at the transport layer with `incorrect header check`
      // — before any of this app's code runs, which is why it reads as the
      // server being broken rather than as a tile being wrong. The same reason
      // server/rail-tiles.js does its own gzip, and the same one line of fix.
      const body = gzipSync(raw);
      return {
        meta: {
          status: 200,
          type: res.headers.get('content-type') ?? 'application/x-protobuf',
          lastModified: res.headers.get('last-modified'),
          gzip: true,
          ttl: ttlFrom(res.headers),
          fetchedAt: Date.now(),
        },
        body,
      };
    } catch (e) {
      noteFailure(`${z}/${x}/${y}`, `upstream unreachable (${e.message ?? e})`);
      return { failed: true, status: 0 };
    }
  }

  return {
    dir,

    /**
     * One vector tile, or null for anything we will not or cannot answer.
     *
     * **An empty tile is an answer, not a miss.** Their server sends 200 with a
     * zero-byte body for a square with no trails in it — which is most of the
     * planet — and storing that is the whole point: without it, every pan over
     * open country asks them again for nothing. It reaches the browser as a 204,
     * which both renderers read as "this tile is empty" rather than as an error.
     *
     * **The key is not part of the cache key**, and that is deliberate rather
     * than an oversight. The tile at 14/8504/5833 is the same tile whoever
     * fetched it, so keying on the account would store one copy per person for
     * identical bytes. It also means the key never reaches the disk in any form
     * — not as a filename, not as metadata.
     *
     * @param {string} key the account's MapTiler key
     */
    async tile(key, z, x, y) {
      const clean = validMaptilerKey(key);
      if (!clean) return null;
      const at = validTileCoords(z, x, y);
      if (!at) return null;

      const cacheKey = `mt:${TILESET}/${at.z}/${at.x}/${at.y}`;
      const existing = await readEntry(cacheKey);
      const age = existing ? Date.now() - existing.fetchedAt : Infinity;

      if (existing?.failed) {
        if (age < existing.ttl) return null;
      } else if (existing && age < (existing.ttl ?? TILE_TTL_MS)) {
        touch(existing.file);
        return existing;
      }

      // One flight per tile however many browsers ask at once. Whichever key
      // arrived first is the one that pays for it, which is right for a cache
      // that is shared on purpose: the bytes are identical and the alternative
      // is fetching them once per account.
      if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
      const job = (async () => {
        const got = await fromUpstream(at.z, at.x, at.y, clean, existing?.failed ? null : existing);
        if (got.failed) {
          // Last week's copy beats no map when their server is unhappy.
          if (existing && !existing.failed) return existing;
          const ttl = got.status === 403
            ? KEY_FAIL_TTL_MS
            : Math.min(FAIL_TTL_MAX_MS, (existing?.ttl ?? FAIL_TTL_MS / 2) * 2);
          await writeEntry(cacheKey, { failed: true, status: got.status, ttl, fetchedAt: Date.now() }, Buffer.alloc(0));
          return null;
        }
        await writeEntry(cacheKey, got.meta, got.body);
        return { ...got.meta, body: got.body };
      })().finally(() => inFlight.delete(cacheKey));

      inFlight.set(cacheKey, job);
      return job;
    },

    /**
     * Is this key one MapTiler will answer for?
     *
     * Asked by the settings dialog before it stores anything, because a key can
     * be wrong in ways that all look identical from the map: a typo, a revoked
     * key, one restricted to other origins, or the free tier's monthly quota
     * spent. Every one of those is a trails overlay that switches on, says it is
     * showing something, and draws nothing at all — which is the failure this
     * app has spent the most hours on.
     *
     * Deliberately not cached and deliberately not the tile path: it is one
     * question a person just asked, and it asks for the tileset's own metadata
     * rather than a tile, so a wrong answer cannot poison the tile cache.
     */
    async check(key) {
      const clean = validMaptilerKey(key);
      if (!clean) return { ok: false, status: 0, why: 'not-a-key' };
      const url = new URL(`tiles/${TILESET}/tiles.json?key=${clean}`, `${origin}/`).href;
      if (!url.startsWith(`${origin}/`)) return { ok: false, status: 0, why: 'refused' };
      try {
        const res = await ask(url);
        if (res.ok) return { ok: true, status: res.status };
        return { ok: false, status: res.status, why: res.status === 403 ? 'rejected' : 'upstream' };
      } catch {
        return { ok: false, status: 0, why: 'unreachable' };
      }
    },
  };
}
