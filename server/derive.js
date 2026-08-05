// Derived data, worked out once, on the server.
//
// Trips, coverage and the calendar are readings of the rows rather than rows
// themselves — nothing stores them, and until now every client worked them out
// for itself. That was the right shape while there was one client. With two it
// is a standing invitation for a phone and a laptop signed into the same
// account to disagree about which holidays you have had: not by failing, but
// quietly, months later, because two implementations of an eight-hundred-line
// heuristic drifted apart on a case neither author thought about.
//
// So it happens here, once, and the clients render what they are given.
//
// **The modules below are the same files the browser uses.** `src/trips.js` and
// `src/stats.js` are pure ES modules with no DOM in them, so this imports them
// directly rather than keeping a second copy — there is exactly one definition
// of what a trip is, and it is the one that has the tests.
//
// The three gazetteers are the only part that needs care. In the browser they
// are dynamic imports of JSON, which plain Node will not do without an import
// attribute; every loader already takes the parsed data as an argument for
// precisely this reason (see the note above `loadCountries`). So they are read
// off disk here and handed over, and the argument-less `loadCountries()` inside
// `computeStats` then finds them already loaded and does no importing at all.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { countryNear, loadCountries } from '../src/countries.js';
import { lakeAround, loadPlaces, nearestTown } from '../src/places.js';
import { loadRegions, regionNear } from '../src/regions.js';
import { computeStats } from '../src/stats.js';
import { activeDays, buildTrips, dayDetail, findHome, nameTrips } from '../src/trips.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// --- The datasets ---------------------------------------------------------------
// 8.1 MB of prepared geography, parsed once and held for the life of the
// process. Deliberately not read at boot: a server whose owner never opens the
// statistics should not pay for them, and the first derived request is a fair
// place to spend the second it costs. Synchronous on purpose — it happens once,
// and an async read here would only move the same wait somewhere less obvious.

let priming = null;

function prime() {
  if (!priming) {
    priming = (async () => {
      const read = (name) => JSON.parse(readFileSync(join(SRC, name), 'utf8'));
      // Handed over rather than imported, so Node never needs an import
      // attribute and Vite never sees one.
      await Promise.all([
        loadCountries(read('countries.json')),
        loadRegions(read('regions.json')),
        loadPlaces(read('places.json')),
      ]);
    })();
  }
  return priming;
}

/**
 * The place lookup naming a trip asks about every cell it holds.
 *
 * Memoised at ~1 km, exactly as the browser does it: being a kilometre out
 * cannot change which country or town a cell belongs to often enough to matter,
 * and it turns some fifteen hundred lookups into five hundred.
 *
 * `countryNear` rather than `countryAt`, because the outlines are simplified to
 * about a kilometre and a cell in a lagoon or a fjord falls outside every
 * polygon — Venice is the case that proves it, and a cell with no country has
 * no region either, so it would get no vote at all.
 */
function placeLookup() {
  const memo = new Map();
  return (lng, lat) => {
    const key = `${Math.round(lng * 100)}/${Math.round(lat * 100)}`;
    const held = memo.get(key);
    if (held) return held;

    const country = countryNear(lng, lat);
    const town = nearestTown(lng, lat);
    const region = country ? regionNear(lng, lat, country.iso) : null;

    const answer = {
      town: town?.name,
      pop: town?.pop ?? 0,
      region: region?.name,
      regionId: region?.id,
      country: country?.id ?? undefined,
    };
    memo.set(key, answer);
    return answer;
  };
}

// --- Cache ------------------------------------------------------------------------
// Keyed on a signature the caller computes from the database rather than on a
// counter this module bumps. A counter has to be remembered at every write, and
// there are six of them — the map's own edits, undo's restore, the file
// importer, the Home Assistant poller, the Strava poller, a route delete. A
// signature read from the rows cannot be forgotten.

const cache = new Map(); // userId → { signature, trips, stats, days }
const MAX_ACCOUNTS = 8; // this is a personal server; the map is nearly always 1

function slot(userId, signature) {
  const held = cache.get(userId);
  if (held && held.signature === signature) return held;

  const fresh = { signature };
  cache.set(userId, fresh);
  // Oldest out. Map iterates in insertion order, so this is the least recently
  // *created* entry, which for a handful of accounts is close enough to LRU.
  if (cache.size > MAX_ACCOUNTS) cache.delete(cache.keys().next().value);
  return fresh;
}

/**
 * Throw away everything derived for an account.
 *
 * Two callers: the tests, and closing an account — where the rows the cache was
 * read from are gone and holding a reading of them would outlive the map it
 * describes.
 */
export function forget(userId) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

// --- Derivations --------------------------------------------------------------------
//
// Each takes a `supply` callback rather than the data itself, so a cache hit
// never pays to read a row. `supply()` returns:
//   { cellMeta, cellIds, routes, home, hiddenTrips }

/**
 * Every trip the history implies, named, plus the home they are measured from.
 *
 * `home` from the account's preferences wins when it is set — it is the answer
 * the owner gave when the guess was wrong, and a guess must never overrule it.
 */
export async function trips(userId, signature, supply) {
  const held = slot(userId, signature);
  if (held.trips) return held.trips;

  await prime();
  const { cellMeta, routes, home } = supply();

  const list = buildTrips(cellMeta, routes, home ? { home } : {});
  try {
    nameTrips(list, placeLookup(), (t) => lakeAround(t.bbox));
  } catch {
    // A trip with no name is still a trip. The alternative — failing the whole
    // request because one gazetteer lookup threw — loses the map to save the
    // label.
    for (const t of list) t.name = t.name || 'Somewhere';
  }

  held.trips = { trips: list.map(forWire), home: home ?? namedHome(findHome(cellMeta)) };
  return held.trips;
}

/**
 * Six decimal places on every coordinate that leaves here.
 *
 * A cell centre is computed, not measured, so it arrives as a full double —
 * `8.279681550709597` — and a trip carries one per cell it touched. Those
 * eleven noise digits are a tenth of a millimetre on a grid whose finest cell
 * is nine hundred metres across, and on a real map they are 80 KB of the
 * answer. Rounding is a wire-format decision and belongs here rather than in
 * `src/trips.js`: the derivation should go on working in full precision, and
 * every consumer of this is drawing dots on a map.
 */
const DP = 1e6;
const round = (n) => (Number.isFinite(n) ? Math.round(n * DP) / DP : n);

function forWire(trip) {
  return {
    ...trip,
    bbox: trip.bbox?.map(round),
    center: trip.center?.map(round),
    spots: trip.spots?.map((s) => ({ ...s, lng: round(s.lng), lat: round(s.lat) })),
  };
}

/**
 * `findHome` answers with coordinates, because the browser had the gazetteer to
 * hand and could name them itself. A client that is only rendering what it is
 * given cannot, so the name is attached here — otherwise every phone would need
 * the 2 MB place dataset for one label.
 */
function namedHome(home) {
  if (!home || !Number.isFinite(home.lng) || !Number.isFinite(home.lat)) return null;
  if (home.name) return home;
  const town = nearestTown(home.lng, home.lat);
  return { ...home, name: town?.name ?? '' };
}

/** Ground covered, by country and by region, plus days, streak and sources. */
export async function stats(userId, signature, supply) {
  const held = slot(userId, signature);
  if (held.stats) return held.stats;

  await prime();
  const { cellIds, cellMeta } = supply();
  held.stats = await computeStats(cellIds, cellMeta);
  return held.stats;
}

/**
 * Every calendar day the history has evidence for, as
 * `{ "2024-08-12": { cells, routes } }`.
 *
 * No gazetteer involved, so this one costs nothing and never waits on the 8 MB.
 */
export function days(userId, signature, supply) {
  const held = slot(userId, signature);
  if (held.days) return held.days;

  const { cellMeta, routes } = supply();
  held.days = Object.fromEntries(activeDays(cellMeta, routes));
  return held.days;
}

/** What happened on one day: its routes, its ground, and the trip it belongs to. */
export async function day(userId, signature, supply, key) {
  const { trips: list } = await trips(userId, signature, supply);
  const { cellMeta, routes } = supply();
  return dayDetail(key, list, routes, cellMeta);
}
