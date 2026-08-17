// Deriving trips, coverage and the calendar on the server.
//
// The point of moving these off the browser is that two clients cannot answer
// differently, and the only way that holds is if there is genuinely one
// implementation rather than two that agree today. So the first thing pinned
// here is exactly that: the server's answer is checked against calling
// src/trips.js directly, because server/derive.js is supposed to be importing
// that file rather than reimplementing it.
//
// The rest is the machinery around it — the cache key, which has to notice a
// changed map and must not notice an unchanged one, and the home you set by
// hand, which must beat the guess.
//
//   node scripts/test/derive.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCountries } from '../../src/countries.js';
import { lakeAround, loadPlaces, nearestTown } from '../../src/places.js';
import { loadRegions, regionNear } from '../../src/regions.js';
import { countryNear } from '../../src/countries.js';
import { buildTrips, findHome, nameTrips } from '../../src/trips.js';
import * as derive from '../../server/derive.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400;
const AUG = Math.floor(new Date('2024-08-10T09:00:00Z').getTime() / 1000);

/**
 * A map with a home you keep coming back to and one week away from it.
 *
 * Home has to be *earned* — somewhere needs repeat visits before it can claim
 * the title — so the home cells carry many hits across many days, and the trip
 * cells carry one visit each on consecutive days.
 */
function account({ homeHits = 40 } = {}) {
  const cellMeta = new Map();
  for (let i = 0; i < 20; i++) {
    const at = AUG + i * 3600;
    cellMeta.set(`0/1076/${6668 + i}`, [
      { source: 'gpx', addedAt: AUG, firstAt: at, lastAt: at + 600, hits: 1, fixes: 9 },
    ]);
  }
  for (let i = 0; i < 15; i++) {
    cellMeta.set(`0/2000/${3000 + i}`, [
      { source: 'ha', addedAt: AUG, firstAt: AUG - 200 * DAY + i * DAY, lastAt: AUG - 10 * DAY, hits: homeHits, fixes: 100 },
    ]);
  }
  return cellMeta;
}

const supplyFor = (cellMeta, home = null) => () => ({
  cellMeta,
  cellIds: [...cellMeta.keys()],
  routes: [],
  home,
});

// The gazetteers, handed over rather than imported — the same thing
// server/derive.js does, and the reason plain Node can run any of this.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (name) => JSON.parse(readFileSync(join(SRC, name), 'utf8'));
await Promise.all([
  loadCountries(read('countries.json')),
  loadRegions(read('regions.json')),
  loadPlaces(read('places.json')),
]);

// --- One implementation, not two ---------------------------------------------------

console.log('\nthe server derives what the browser derives');
{
  derive.forget();
  const cellMeta = account();
  const served = await derive.trips(1, 'sig-a', supplyFor(cellMeta));

  // The browser's path, run here: build, then name with the same lookup
  // stats-ui.js supplies.
  const memo = new Map();
  const at = (lng, lat) => {
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
  const direct = buildTrips(cellMeta, [], {});
  nameTrips(direct, at, (t) => lakeAround(t.bbox));

  check(served.trips.length === direct.length, 'the same number of trips',
    `server ${served.trips.length}, browser ${direct.length}`);
  check(
    served.trips.map((t) => t.id).join() === direct.map((t) => t.id).join(),
    'with the same ids',
    served.trips.map((t) => t.id).join(),
  );
  check(
    served.trips.map((t) => t.name).join() === direct.map((t) => t.name).join(),
    'and the same names',
    `${served.trips.map((t) => t.name).join()} vs ${direct.map((t) => t.name).join()}`,
  );
  check(served.trips.length === 1, 'a week away is one trip', String(served.trips.length));
  check(!!served.trips[0]?.name, 'which has a name', served.trips[0]?.name);
}

// --- The home you set by hand ------------------------------------------------------

console.log('\nthe home you set beats the one it guesses');
{
  derive.forget();
  const cellMeta = account();
  const guessed = await derive.trips(2, 'sig-b', supplyFor(cellMeta));
  check(!!guessed.home, 'a map with repeat visits has a home at all', JSON.stringify(guessed.home));
  // findHome answers with coordinates; a client that only renders needs a word.
  check(typeof guessed.home?.name === 'string', 'and the server names it, so a phone needs no gazetteer',
    JSON.stringify(guessed.home?.name));

  derive.forget();
  const set = { lng: 12.4964, lat: 41.9028, name: 'Rome' };
  const chosen = await derive.trips(2, 'sig-b', supplyFor(cellMeta, set));
  check(chosen.home?.name === 'Rome', 'the stored answer wins outright', JSON.stringify(chosen.home));
  check(
    JSON.stringify(chosen.trips.map((t) => t.id)) !== JSON.stringify(guessed.trips.map((t) => t.id)),
    'and it changes which trips exist, which is why it has to be the server that knows it',
  );
}

// --- The cache ---------------------------------------------------------------------

console.log('\nthe cache notices a changed map and nothing else');
{
  derive.forget();
  const cellMeta = account();
  const supply = supplyFor(cellMeta);

  const first = await derive.trips(3, 'sig-1', supply);
  const again = await derive.trips(3, 'sig-1', supply);
  check(first === again, 'the same signature is not recomputed');

  const changed = await derive.trips(3, 'sig-2', supply);
  check(first !== changed, 'a new signature is');

  // A cache hit must not read a single row: the supply callback is the only way
  // in, so counting its calls is the whole test.
  let reads = 0;
  const counted = () => {
    reads++;
    return { cellMeta, cellIds: [...cellMeta.keys()], routes: [], home: null };
  };
  derive.forget();
  await derive.trips(4, 'sig-x', counted);
  const afterFirst = reads;
  await derive.trips(4, 'sig-x', counted);
  check(reads === afterFirst, 'and a hit never opens the database', `${reads} reads`);
}

// --- Statistics and the calendar ----------------------------------------------------

console.log('\ncoverage and the calendar');
{
  derive.forget();
  const cellMeta = account();
  const supply = supplyFor(cellMeta);

  const stats = await derive.stats(5, 'sig-s', supply);
  check(stats.cells === cellMeta.size, 'every cell is counted', `${stats.cells} of ${cellMeta.size}`);
  check(stats.km2 > 0, 'with real ground under them', `${stats.km2.toFixed(1)} km²`);
  check(Array.isArray(stats.countries) && stats.countries.length > 0, 'and a country to put them in',
    JSON.stringify(stats.countries.map((c) => c.id)));
  check(stats.days > 0 && stats.streakDays > 0, 'days carried and the longest run of them',
    `${stats.days} days, streak ${stats.streakDays}`);

  const days = derive.days(5, 'sig-s', supply);
  // A Map would serialise to {} — this is the bug the endpoint would ship with.
  check(!(days instanceof Map), 'the calendar is a plain object, not a Map that JSON drops');
  const keys = Object.keys(days);
  check(keys.length > 0, 'with days on it', `${keys.length} days`);
  check(keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)), 'each one a calendar date', keys[0]);
  check(keys.every((k) => typeof days[k].cells === 'number'), 'carrying what happened on it',
    JSON.stringify(days[keys[0]]));

  const detail = await derive.day(5, 'sig-s', supply, keys[0]);
  check(detail.key === keys[0], 'and one day can be asked about on its own', detail.key);
  check(Array.isArray(detail.points), 'coming back with the ground it covered', String(detail.points?.length));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
