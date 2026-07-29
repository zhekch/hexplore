// Detailed region boundaries, fetched once per country and kept.
//
// The overview boundaries that ship with the app are Natural Earth, simplified
// to about a kilometre — right for a level that normally lives at z4–5, and
// visibly wrong when someone pins Detail to Region and zooms into a valley. The
// detail was never in that source: its raw 10m geometry gives the canton of
// Solothurn 276 points where the national survey gives 6,951.
//
// So the real boundaries come from geoBoundaries, and this is the piece that
// gets them. It lives on the server for three reasons, all of which were learned
// the hard way:
//
//   1. The browser cannot do it. Their API answers a level that doesn't exist
//      with an error page carrying no CORS headers, so probing for one turns
//      into "blocked by CORS policy" in the console of a real origin.
//   2. One machine fetching each country once is politer than every browser
//      doing it, and the answers are cached on disk here — the upstream commit
//      is pinned, so the data cannot change and the cache never needs to expire.
//   3. Picking the right administrative level takes several small requests, and
//      the result is the same for everyone.
//
// geoBoundaries (gbOpen, CC BY 4.0) composites national survey data — swisstopo
// for Switzerland. The commit is pinned deliberately: boundary data should not
// change under a running map. Refresh it from the API index at
// https://www.geoboundaries.org/api/current/gbOpen/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pairFineRegions, regionsInCountry, countryForIso } from '../src/regions.js';

const GB_COMMIT = '9469f09';
// The media host, not github.com or jsDelivr: these files are stored in Git LFS,
// so every other route serves a 131-byte pointer instead of a boundary.
const fileUrl = (iso, level) =>
  `https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/${GB_COMMIT}`
  + `/releaseData/gbOpen/${iso}/${level}/geoBoundaries-${iso}-${level}_simplified.geojson`;
// Asked only how many units a level has — a 1.7 KB answer that saves
// downloading the wrong file.
const apiUrl = (iso, level) => `https://www.geoboundaries.org/api/current/gbOpen/${iso}/${level}/`;

// "Admin-1" does not mean the same thing in the two datasets, and it is not off
// by a consistent amount either: Italy's provinces are our admin-1 and their
// ADM3, France's départements are our admin-1 and their ADM2, and Switzerland's
// cantons are admin-1 in both. So every level is a candidate and the one with
// about as many units as we have wins.
const LEVELS = ['ADM1', 'ADM2', 'ADM3'];
// A level has to pair this share of the smaller of the two counts to be worth
// keeping. Partial is fine — Hungary pairs 20 of our 43, because Natural Earth
// counts its city-counties as admin-1 units and geoBoundaries folds them into
// counties — but a handful out of hundreds means the level is describing
// something else and the country is better left at one resolution.
const MIN_PAIRED_SHARE = 0.4;
const MIN_PAIRED = 3;
const FETCH_TIMEOUT_MS = 30000;

const ISO_RE = /^[A-Z]{3}$/;

async function getJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // a level that doesn't exist is an answer, not a failure
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dir where to cache the answers
 * @param {(msg: string) => void} [opts.log]
 */
export function createFineRegions({ dir, log = () => {} }) {
  // One in-flight request per country, however many browsers ask at once.
  const inFlight = new Map();

  const cacheFile = (iso) => path.join(dir, `${iso}.json`);

  async function fromCache(iso) {
    try {
      return JSON.parse(await readFile(cacheFile(iso), 'utf8'));
    } catch {
      return null;
    }
  }

  async function toCache(iso, payload) {
    try {
      await mkdir(dir, { recursive: true });
      // Written via a temp name so a half-written file can never be read back as
      // a complete answer.
      const tmp = `${cacheFile(iso)}.tmp`;
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, cacheFile(iso));
    } catch (e) {
      log(`could not cache ${iso}: ${e.message ?? e}`);
    }
  }

  // Which of their levels to try, best guess first.
  async function rankLevels(iso, mine) {
    const found = [];
    for (const level of LEVELS) {
      const meta = await getJson(apiUrl(iso, level));
      const count = Number(meta?.admUnitCount) || 0;
      if (count) found.push({ level, count });
    }
    // Closest count first; on a tie the coarser level, which is the smaller file.
    return found.sort(
      (a, b) => Math.abs(a.count - mine) - Math.abs(b.count - mine) || a.count - b.count,
    );
  }

  async function build(iso) {
    // The country name our own dataset uses, and how many regions it has.
    const country = countryForIso(iso);
    if (!country) return { iso, level: null, regions: {}, note: 'unknown country code' };
    const mine = regionsInCountry(country);
    if (!mine) return { iso, level: null, regions: {}, note: 'no regions here' };

    for (const { level, count } of await rankLevels(iso, mine)) {
      const geo = await getJson(fileUrl(iso, level));
      const features = geo?.features;
      if (!features?.length) continue;
      const paired = pairFineRegions(country, features);
      const need = Math.max(MIN_PAIRED, Math.min(mine, count) * MIN_PAIRED_SHARE);
      if (paired.size < need) {
        log(`${iso} ${level}: ${paired.size}/${count} paired against ${mine} — not this level`);
        continue;
      }
      log(`${iso} ${level}: ${paired.size} of ${mine} regions gained detail`);
      return { iso, level, regions: Object.fromEntries(paired) };
    }
    // Nothing matched. Remembered, so it is not tried again on every zoom.
    return { iso, level: null, regions: {}, note: 'no level matches this map’s regions' };
  }

  /**
   * Detailed boundaries for one country, from cache when possible.
   * @param {string} iso ISO3 code
   */
  async function get(iso) {
    if (!ISO_RE.test(iso)) return null;
    const cached = await fromCache(iso);
    if (cached) return cached;
    if (inFlight.has(iso)) return inFlight.get(iso);
    const job = build(iso)
      .then(async (payload) => {
        await toCache(iso, payload);
        return payload;
      })
      .finally(() => inFlight.delete(iso));
    inFlight.set(iso, job);
    return job;
  }

  return { get, dir };
}
