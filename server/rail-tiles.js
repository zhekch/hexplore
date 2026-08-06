// The train-tracks overlay's tiles, fetched once for everyone and kept.
//
// **Read this before changing how often it asks upstream.** OpenRailwayMap's
// vector services are hosted "on a best-effort basis using limited resources"
// and their usage policy (USAGE.md in hiddewie/OpenRailwayMap-vector) is short
// enough to quote the parts that shaped this file:
//
//   - "Map tiles may be used in third party applications, on the condition that
//      the third-party application is available publicly and without
//      registration."
//   - "Map tiles may not be downloaded using automated processes or in bulk."
//   - "Usage of the OpenRailwayMap services requires sending a valid `Referer`
//      header (browser applications) or `User-agent` header (automated
//      processes). These headers may not be faked."
//
// This map is behind an account, and a server-side cache is by definition an
// automated process fetching tiles. Both of those are a deliberate, informed
// departure from the letter of that policy, made because the alternative — every
// browser on every device asking them directly, forever — is worse for them.
// What that obliges this file to do:
//
//   **Nothing is ever fetched that a person did not just look at.** There is no
//   seeding, no prefetch, no walking a bounding box, no warming the cache on
//   boot. A tile enters this cache because a viewport asked for it, which is the
//   one thing that keeps "cache" from meaning "bulk download".
//
//   **It says who it is.** `USER_AGENT` names the project and links to it. If
//   they want to throttle or block this, the header is how, and that is the
//   point of it.
//
//   **And it sends a true Referer.** Their nginx answers 403 to any request
//   without one — every combination of User-Agent was tried and none of them is
//   the thing it checks — so the policy's "or `User-agent` header (automated
//   processes)" is not what the server actually implements. The header sent is
//   *this map's own public origin*, resolved per request from the host the
//   browser reached us on. That is the honest answer to what Referer asks: the
//   site on whose behalf the tile is being fetched. Claiming to be
//   openrailwaymap.app would get past the same gate and is exactly the faked
//   header the policy forbids, so it is not done.
//
//   **A repeat costs them a 304 or nothing at all.** Entries outlive their TTL
//   and are revalidated with `If-None-Match`, so the common case for a tile that
//   has not changed is a few hundred bytes rather than a few kilobytes — and
//   inside the TTL it is no request whatsoever.
//
//   **Their outage is not their problem twice.** When upstream fails, a stale
//   entry is served rather than retried in a loop. `MAX_UPSTREAM` caps how many
//   requests can ever be in flight at once, so a cold cache and a hundred tiles
//   on screen is still a trickle.
//
// If the traffic ever stops being personal-scale, the honest fix is not a bigger
// cache here — it is running their stack locally per their SETUP.md and setting
// `RAIL_ORIGIN` to it, which needs no change to any of this.
//
// **Storage.** One file per entry, body prefixed by a single-line JSON header,
// written through a temp name and renamed so a half-written file can never be
// read back as a complete answer. The metadata travels with the bytes, which is
// why there is no index to fall out of step with the directory. Bodies are
// stored gzipped — vector tiles are protobuf and compress to about a third —
// and served that way to the ~every client that accepts it.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

// Point `RAIL_ORIGIN` at a Martin running their stack per SETUP.md and every
// concern in the note above evaporates — nothing else in this file changes.
const ORM_ORIGIN = process.env.RAIL_ORIGIN || 'https://openrailwaymap.app';

// Not faked, and not a browser. See the policy note above.
const USER_AGENT = 'HexPlore/0.1 (+https://github.com/zhekch/hexplore; personal map, server-side tile cache)';

// **What language the railways are labelled in.**
//
// Their tiles carry two names for a station: `name`, which is whatever is
// written on the platform, and `localized_name`, which is the name in a language
// you ask for. Without asking, `localized_name` is simply absent — so their
// style, which reads it, labels a Tokyo suburban line in Japanese and a Greek
// branch in Greek, on top of a basemap that is already labelling both in English.
//
// `?lang=` is the whole ask, and it is a **query parameter on the tile**, which
// makes it part of what a cached entry *is*. It is in the key below for that
// reason: without it, switching this would go on serving what was fetched under
// the old one until the last of it aged out, which for a tile is a week.
//
// Not per-request and not read off the browser: this is one map with one set of
// labels on it, and a per-language cache would multiply every tile by however
// many languages happened to visit. `name` is still in the tile, and their style
// puts it under the English one wherever the two differ, so nothing is lost —
// what is on the sign is still on the map.
//
// The default rather than the value, only so that a test can hold two of them
// over one cache directory and watch them stay apart.
const TILE_LANG = 'en';

// How long a stored tile is served without asking. OpenStreetMap edits reach
// their tiles on the order of days, and a siding that appeared this morning is
// not worth a round trip per tile per week to catch. Upstream's own `max-age`
// wins when it sends one, clamped to this range so neither a missing header nor
// a five-minute one turns into a request storm.
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_MIN_MS = 60 * 60 * 1000;
const TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

// An empty tile is the most common answer over most of the world — ocean,
// desert, anywhere without a railway — and re-asking for "still nothing" is the
// cheapest request to eliminate. Kept for less time than real content because
// "nothing here" is the answer most likely to stop being true.
//
// **Only a 204 counts.** This used to treat their 404 as an empty tile too,
// which is wrong in the one case that matters: Martin answers 404 for a source
// it does not recognise, so a redeploy that renamed something would have been
// remembered as "no railways here" for a day after it was fixed. A 404 is now a
// failure like any other, with the short backoff below.
const EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

// **Remembering that they said no.** Nothing used to record a failure, so a tile
// their server could not answer was asked for again on every pan, forever — the
// single biggest thing this cache was doing wrong while they were unwell. A
// failure is now stored like any other answer, with a TTL that starts short and
// doubles for as long as the failures keep coming, so recovery is noticed within
// half a minute but a persistent outage settles down to a trickle.
const FAIL_TTL_MS = 30 * 1000;
const FAIL_TTL_MAX_MS = 30 * 60 * 1000;

// **There is deliberately no circuit breaker.** One lived here and was removed.
// The idea — after N consecutive failures stop calling upstream for a minute —
// reads as obvious politeness and cost more than it saved. It went wrong twice
// in a way worth remembering: shared across sources it let their permanently
// broken `standard` composite silence the healthy track geometry, and even once
// it was per-source it still blanked the railways for a minute at a time during
// an outage that the per-tile backoff below was already handling. A pause that
// makes the map worse without meaningfully sparing their server is not
// politeness, it is just a pause.
//
// The backoff *is* the protection, and it is the better shape of it: a tile that
// failed is not asked again for thirty seconds, then a minute, then two, up to
// half an hour, so repeated panning over the same broken ground costs nothing
// while ground nobody has looked at yet is still fetched immediately.
// `MAX_UPSTREAM` caps how much of that can be in flight at once.

// **How much detail is worth asking for.**
//
// When their origin is down, everything still being served anywhere — their site
// as much as this one — is Cloudflare replaying tiles it cached before the
// outage, and whether a given tile works is simply whether it is still in the
// edge cache. That is not uniform across zooms: there are sixteen times as many
// distinct tiles at z14 as at z12, so a z14 tile is far less likely to have been
// asked for recently by anyone, and far more likely to miss.
//
// So a zoom that is failing is worth *stepping down from* rather than retrying.
// MapLibre will happily overzoom a parent tile — coarser, but railways on the
// screen instead of nothing — and it does the rescaling correctly because it
// knows the tile is a parent. It only needs to be told, via the source's
// `maxzoom`, not to ask for the deeper ones.
//
// This tracks the hit rate per source per zoom over a rolling window and names
// the deepest zoom still worth asking for. Samples age out, so when their origin
// comes back the ceiling climbs on its own and the detail returns — nothing has
// to be restarted or cleared.
const HEALTH_WINDOW_MS = 10 * 60 * 1000;
// Below this many observations a zoom has not earned an opinion either way; a
// handful of misses over empty countryside should not cost anybody detail.
const HEALTH_MIN_SAMPLES = 8;
const HEALTH_MIN_RATIO = 0.5;
// However bad it gets, never recommend coarser than this. Past here the overlay
// is a smear rather than a map, and "no railways" is the more honest answer.
const DETAIL_FLOOR = 8;

// Sprites and TileJSON change when they redeploy, which is rare, and they are
// fetched once per session rather than once per pan.
const ASSET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One feature's details, asked for when somebody clicks a line. Kept for a day:
// which services run over a stretch of track is an OSM relation that changes on
// the timescale of timetables, and clicking the same line twice in an afternoon
// should not ask twice.
const FEATURE_TTL_MS = 24 * 60 * 60 * 1000;

// Disk budget. Vector tiles run 2–60 KB gzipped, so this is a very large number
// of them; the sweep drops the least recently used down to LOW_WATER when it is
// exceeded. Both are overridable from the environment.
const MAX_BYTES = Number(process.env.RAIL_CACHE_BYTES) || 512 * 1024 * 1024;
const LOW_WATER = 0.8;

// At most this many requests to their server at any instant, across every
// browser this server is talking to.
const MAX_UPSTREAM = 6;
const FETCH_TIMEOUT_MS = 20000;

// Reading a file to serve it does not rewrite its mtime — that would be a write
// per tile per pan. An entry is only touched when the recency it records has
// drifted by more than this, which is plenty precise for choosing what to evict.
const TOUCH_AFTER_MS = 60 * 60 * 1000;
// How often the sweep may run, however many writes happen in between.
const SWEEP_EVERY_MS = 5 * 60 * 1000;

const Z_MAX = 20;

/** `{z}/{x}/{y}` is only ever three integers, and x/y only ever fit the zoom. */
export function validTileCoords(z, x, y) {
  const nums = [z, x, y].map((v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN));
  const [zi, xi, yi] = nums;
  if (nums.some((n) => !Number.isInteger(n))) return null;
  if (zi < 0 || zi > Z_MAX) return null;
  const span = 2 ** zi;
  if (xi < 0 || xi >= span || yi < 0 || yi >= span) return null;
  return { z: zi, x: xi, y: yi };
}

/**
 * The sprite files MapLibre will ask for, given the two sets in the style.
 *
 * It appends `.json`/`.png` and an optional `@2x` to the URL it was handed, so
 * these eight names are the entire surface — enumerated rather than pattern
 * matched, because this is a proxy onto somebody else's origin and the set of
 * paths it will fetch should be a list you can read.
 */
export function spritePaths() {
  const out = new Map();
  for (const [ours, theirs] of [['sprite', 'sprite'], ['sdf-sprite', 'sdf_sprite']]) {
    for (const scale of ['', '@2x']) {
      for (const ext of ['.json', '.png']) {
        out.set(`${ours}/symbols${scale}${ext}`, `${theirs}/symbols${scale}${ext}`);
      }
    }
  }
  return out;
}

const isEmptyBody = (buf) => !buf || buf.length === 0;

/**
 * @param {object} opts
 * @param {string} opts.dir where to keep the cache
 * @param {Set<string>} opts.sources the Martin source lists the style actually
 *   uses. An allowlist, not a convenience: without it this route is an open
 *   proxy onto their origin for anyone with an account here.
 * @param {Set<string>} [opts.featureViews] `source/sourceLayer` pairs the style
 *   actually draws, the same allowlist idea for their feature API.
 * @param {string} [opts.origin] upstream to fetch from; the tests point this at
 *   a local stand-in, since the real one cannot be asked for a 304 on demand.
 * @param {string} [opts.lang] what language to ask for the labels in; see
 *   TILE_LANG, which is what this defaults to and the only value in use.
 * @param {number} [opts.healthWindowMs] how long zoom evidence counts for; only
 *   shortened by the tests, which cannot wait ten minutes to watch a cap lift.
 * @param {(msg: string) => void} [opts.log]
 */
export function createRailTiles({ dir, sources, featureViews = new Set(), origin: upstreamOrigin = ORM_ORIGIN, lang = TILE_LANG, healthWindowMs = HEALTH_WINDOW_MS, log = () => {} }) {
  const inFlight = new Map();
  const sprites = spritePaths();
  let upstreamBusy = 0;
  const upstreamQueue = [];
  let lastSweep = 0;
  let sweeping = null;
  // The log's own restraint: one line per failing minute across everything,
  // rather than one per tile. A thousand identical "upstream 502" lines is not a
  // log, it is the reason nobody reads the log.
  let mutedSince = 0;
  let mutedCount = 0;

  function noteFailure(upstreamPath, why) {
    mutedCount++;
    const now = Date.now();
    if (mutedSince && now - mutedSince < 60_000) return;
    log(`${why} for ${upstreamPath}${mutedCount > 1 ? ` (and ${mutedCount - 1} others since)` : ''}`);
    mutedSince = now;
    mutedCount = 0;
  }

  // scope → zoom → [{ at, ok }], trimmed to HEALTH_WINDOW_MS on read.
  const zoomHealth = new Map();

  function noteZoom(scope, zoom, ok) {
    if (zoom == null) return;
    if (!zoomHealth.has(scope)) zoomHealth.set(scope, new Map());
    const byZoom = zoomHealth.get(scope);
    if (!byZoom.has(zoom)) byZoom.set(zoom, []);
    const samples = byZoom.get(zoom);
    samples.push({ at: Date.now(), ok });
    // Bounded regardless of the window, so a long session cannot grow this.
    if (samples.length > 200) samples.splice(0, samples.length - 200);
  }

  /**
   * The deepest zoom still worth asking this source for, or null for "all of
   * them". One below the shallowest zoom that is currently failing more often
   * than it succeeds — conservative on purpose, because the evidence is about
   * which tiles happen to be cached rather than about a real cliff, and because
   * being one zoom too cautious costs a little sharpness while being one too
   * eager costs the railways entirely.
   */
  function detailCeiling(scope) {
    const byZoom = zoomHealth.get(scope);
    if (!byZoom) return null;
    const since = Date.now() - healthWindowMs;
    let worst = null;
    for (const [zoom, samples] of byZoom) {
      const recent = samples.filter((s) => s.at >= since);
      if (recent.length < HEALTH_MIN_SAMPLES) continue;
      const ratio = recent.filter((s) => s.ok).length / recent.length;
      if (ratio < HEALTH_MIN_RATIO && (worst === null || zoom < worst)) worst = zoom;
    }
    if (worst === null) return null;
    return Math.max(DETAIL_FLOOR, worst - 1);
  }

  // Sharded, because a flat directory with a hundred thousand entries in it is
  // slow to read on every filesystem that has ever been shipped.
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

  /** Their `max-age`, if they sent a usable one, else our default. */
  function ttlFrom(headers, fallback) {
    const m = /max-age=(\d+)/.exec(headers.get('cache-control') ?? '');
    if (!m) return fallback;
    return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number(m[1]) * 1000));
  }

  /**
   * Fetch one upstream path, or revalidate what we already hold.
   *
   * @returns {Promise<{meta: object, body: Buffer}|null>}
   */
  async function fromUpstream(scope, upstreamPath, previous, defaultTtl, referer) {
    const url = `${upstreamOrigin}/${upstreamPath}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { 'User-Agent': USER_AGENT };
      // Our origin, never theirs. See the note at the top of this file.
      if (referer) headers.Referer = `${referer}/`;
      // The cheap half of the bargain: when we already have a copy, ask them to
      // tell us it is still good rather than to send it again.
      if (previous?.etag) headers['If-None-Match'] = previous.etag;
      const res = await withSlot(() => fetch(url, { headers, signal: ac.signal }));

      if (res.status === 304 && previous) {
        return { meta: { ...previous, fetchedAt: Date.now() }, body: previous.body, revalidated: true };
      }
      // A tile with no features in it. The one status that genuinely means
      // "there is no railway here" — see the note on EMPTY_TTL_MS.
      if (res.status === 204) {
        return { meta: { status: 204, type: '', etag: null, gzip: false, ttl: EMPTY_TTL_MS, fetchedAt: Date.now() }, body: Buffer.alloc(0) };
      }
      if (!res.ok) {
        noteFailure(upstreamPath, `upstream ${res.status}`);
        return { failed: true, status: res.status };
      }

      const raw = Buffer.from(await res.arrayBuffer());
      if (isEmptyBody(raw)) {
        return { meta: { status: 204, type: '', etag: null, gzip: false, ttl: EMPTY_TTL_MS, fetchedAt: Date.now() }, body: Buffer.alloc(0) };
      }
      // Stored compressed. `fetch` has already decoded whatever they sent, so
      // this is our own encoding and ours to undo for a client that cannot take
      // it — which in practice is none of them.
      const body = gzipSync(raw);
      return {
        meta: {
          status: 200,
          type: res.headers.get('content-type') ?? 'application/octet-stream',
          etag: res.headers.get('etag'),
          gzip: true,
          ttl: ttlFrom(res.headers, defaultTtl),
          fetchedAt: Date.now(),
        },
        body,
      };
    } catch (e) {
      noteFailure(upstreamPath, `upstream unreachable (${e.message ?? e})`);
      return { failed: true, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The cache proper: hit, revalidate, or fetch — one flight per key however
   * many browsers ask at once, and the stale copy when upstream cannot answer.
   */
  async function fetchCached(scope, key, upstreamPath, defaultTtl, referer, zoom = null) {
    const existing = await readEntry(key);
    const age = existing ? Date.now() - existing.fetchedAt : Infinity;

    // A stored failure is an answer too, and honouring its TTL is the whole
    // point: without this, a tile they cannot serve is asked for again on every
    // pan across it.
    if (existing?.failed) {
      if (age < existing.ttl) {
        // A remembered refusal is still a refusal. Without this the evidence
        // only ever came from tiles that actually reached upstream, so once the
        // backoff had swallowed them all the window emptied, the ceiling lifted,
        // and the overlay went back to asking for a zoom it already knew was
        // unavailable — visible as "after a reload the railways stop rendering
        // until you clear the cache", because clearing it was the only way to
        // make real requests happen again.
        noteZoom(scope, zoom, false);
        return null;
      }
    } else if (existing && age < (existing.ttl ?? defaultTtl)) {
      touch(existing.file);
      // A cached hit still says this zoom is answerable — without this, a source
      // that is entirely served from disk would look like it had no evidence at
      // all and could never climb back out of a ceiling it had been given.
      noteZoom(scope, zoom, true);
      return existing;
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const job = (async () => {
      const got = await fromUpstream(scope, upstreamPath, existing?.failed ? null : existing, defaultTtl, referer);

      noteZoom(scope, zoom, !got?.failed);
      if (got?.failed) {
        // An answer from last week beats no map at all. Otherwise remember the
        // refusal, doubling the wait for as long as it keeps happening.
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
  }

  return {
    dir,

    /**
     * The deepest zoom worth asking each source for right now, for the client to
     * cap its `maxzoom` at. A source with nothing to report is absent, meaning
     * "ask for whatever the style says".
     */
    detail() {
      const out = {};
      for (const scope of zoomHealth.keys()) {
        const ceiling = detailCeiling(scope);
        if (ceiling !== null) out[scope] = ceiling;
      }
      return out;
    },

    /**
     * Whether upstream is currently answering badly enough to be worth telling
     * somebody about — the same evidence the detail ceiling reads, asked as one
     * question rather than per zoom.
     *
     * Deliberately about *recent* traffic only. A source nobody has asked for is
     * not in trouble, and a session that has been going all day should not still
     * be apologising for this morning.
     */
    degraded() {
      const since = Date.now() - healthWindowMs;
      let asked = 0;
      let failed = 0;
      for (const byZoom of zoomHealth.values()) {
        for (const samples of byZoom.values()) {
          for (const s of samples) {
            if (s.at < since) continue;
            asked++;
            if (!s.ok) failed++;
          }
        }
      }
      if (asked < HEALTH_MIN_SAMPLES) return null;
      const ratio = failed / asked;
      if (ratio < HEALTH_MIN_RATIO) return null;
      return { failed, asked, share: Math.round(ratio * 100) };
    },

    /**
     * One vector tile. `origin` is only ever the Referer — the same tile is the
     * same answer whoever asked for it, so it is deliberately not part of the
     * cache key.
     */
    async tile(sourceList, z, x, y, origin) {
      if (!sources.has(sourceList)) return null;
      const at = validTileCoords(z, x, y);
      if (!at) return null;
      // The language is part of the answer, so it is part of the key. See TILE_LANG.
      const key = `tile:${sourceList}/${at.z}/${at.x}/${at.y}@${lang}`;
      const upstreamPath = `${sourceList}/${at.z}/${at.x}/${at.y}?lang=${lang}`;
      return fetchCached(sourceList, key, upstreamPath, TILE_TTL_MS, origin, at.z);
    },

    /**
     * Everything their API knows about one feature — used for the route
     * relations a vector tile cannot carry.
     *
     * Answered by their `api` container rather than their tile server, which is
     * why it survives outages the tiles do not. Both path parts are matched
     * against the style's own sources and source layers, and the id is a
     * conservative token, so this cannot be turned into a general proxy onto
     * their API.
     */
    async feature(source, sourceLayer, id, origin) {
      if (!featureViews.has(`${source}/${sourceLayer}`)) return null;
      if (!/^[\w.:-]{1,64}$/.test(id)) return null;
      const upstreamPath = `api/feature/${source}/${sourceLayer}/${id}`;
      return fetchCached('api', `feature:${source}/${sourceLayer}/${id}`, upstreamPath, FEATURE_TTL_MS, origin);
    },

    /** One sprite sheet or index, from the enumerated set. */
    async sprite(name, origin) {
      const upstreamPath = sprites.get(name);
      if (!upstreamPath) return null;
      return fetchCached('sprites', `sprite:${name}`, upstreamPath, ASSET_TTL_MS, origin);
    },
  };
}
