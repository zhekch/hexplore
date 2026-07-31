// The same ride, recorded twice.
//
// A route's identity is a hash of its own simplified geometry plus its dates,
// which is exactly right for "you already imported this file" and no use at all
// here: two apps watching one afternoon produce two different point streams,
// which simplify to two different lines, which hash to two different keys. Both
// rows are legitimate, distinct data about one ride, and the map drew the line
// twice, listed it twice, and counted its kilometres twice.
//
// The thresholds below are set from what real duplicates look like rather than
// from what felt safe. Across a real map every duplicate pair starts within
// five seconds and differs in length by at most 0.4%; the gates are an order of
// magnitude looser and still nowhere near loose enough to fuse two outings.
//
// The cases that matter are the ones that must NOT fold — two laps of the same
// loop, an out-and-back done twice in a day, a ride with no clock. Getting a
// duplicate wrong hides something you did.
//
//   node scripts/test/route-dupes.mjs

import { routesLookAlike, preferredRoute, duplicateRoutes } from '../../src/routes.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const T = (iso) => Math.floor(new Date(iso).getTime() / 1000);
// Bern → Zollikofen, the real pair, at the real numbers.
const route = (o) => ({
  id: 1, name: 'ride', source: 'strava', link: '', sportGuessed: false, elevUp: 0,
  points: 90, lengthM: 9826, firstAt: T('2025-04-03T11:13:53Z'), lastAt: T('2025-04-03T12:18:13Z'),
  bbox: [7.42, 46.94, 7.47, 46.99], ...o,
});

console.log('\ntwo apps, one ride');
const komoot = route({ id: 14, source: 'komoot', link: 'https://komoot.com/tour/1', points: 178 });
const strava = route({ id: 47, source: 'strava', points: 181, lengthM: 9845 });
check(routesLookAlike(komoot, strava), 'a 0.2% length difference is the same ride');
// The real Komoot row claims its ride ended a week after it started. Anything
// that read the end of a tour as a clock would miss this pair entirely.
const wonkyEnd = route({ id: 14, source: 'komoot', link: 'x', lastAt: T('2025-04-10T09:53:10Z') });
check(routesLookAlike(wonkyEnd, strava), 'and a nonsense end time does not hide it',
  'the end of a tour is not a clock');
// Same walk, filed as Walking by one app and Hiking by the other.
check(routesLookAlike(route({ sport: 'Walking' }), route({ id: 2, sport: 'Hiking' })),
  'a disagreement about the activity is not a disagreement about the ride');
// The obvious duplicate is Komoot against Strava — but real maps hold Strava
// against Strava, and gating on a difference of source would miss those.
check(routesLookAlike(route({ id: 20, sportGuessed: true }), route({ id: 65 })),
  'and two rows from the same app still fold');

// The API calls the corners `bounds`; a route built in the browser and not yet
// round-tripped calls them `bbox`. Reading only one of the two silently folded
// nothing at all, because every pair failed the place test on undefined.
const bounded = (o) => { const r = route(o); r.bounds = r.bbox; delete r.bbox; return r; };
check(routesLookAlike(bounded({ id: 14 }), bounded({ id: 47, lengthM: 9845 })),
  'the corners are read under either name', 'bounds from the API, bbox from the builder');
check(routesLookAlike(bounded({ id: 14 }), route({ id: 47, lengthM: 9845 })),
  'even when the two rows disagree about which name to use');

console.log('\nthings that are not duplicates');
check(!routesLookAlike(route({}), route({ id: 2, firstAt: T('2025-04-03T14:00:00Z') })),
  'a second outing later the same day', 'started nearly 3 h apart');
check(!routesLookAlike(route({}), route({ id: 2, lengthM: 19000 })),
  'twice round the same loop is twice as long');
check(!routesLookAlike(route({}), route({ id: 2, bbox: [8.5, 47.3, 8.6, 47.4] })),
  'the same length at the same moment in another canton');
check(!routesLookAlike(route({ firstAt: 0 }), route({ id: 2 })),
  'and a route with no clock never folds', 'nothing to compare');
// The gate is the start, so a pair that drifts past it must part company.
check(!routesLookAlike(route({}), route({ id: 2, firstAt: T('2025-04-03T11:13:53Z') + 121 })),
  'two minutes and one second apart is past the gate');
check(routesLookAlike(route({}), route({ id: 2, firstAt: T('2025-04-03T11:13:53Z') + 119 })),
  'one second under it is not');

console.log('\nwhich copy speaks for the ride');
check(preferredRoute(komoot, strava).id === 14, 'the one that can be opened on Komoot',
  'a link is the one thing the other copy cannot be given');
check(preferredRoute(strava, komoot).id === 14, 'whichever order they are compared in');
// Neither Strava row has a link, so the real discriminator is which app knew
// what the activity was and which one this app guessed.
const guessed = route({ id: 20, sportGuessed: true, points: 88 });
const known = route({ id: 65, sportGuessed: false, points: 86 });
check(preferredRoute(guessed, known).id === 65, 'a recorded activity beats a guessed one',
  'even though the guessed row has more points');
check(preferredRoute(route({ id: 9, elevUp: 0 }), route({ id: 8, elevUp: 404 })).id === 8,
  'and a row that knows the climb beats one that does not');
check(preferredRoute(route({ id: 9 }), route({ id: 8 })).id === 8,
  'ties break on the older row, so the answer never changes between loads');

console.log('\nfolding a list');
const list = [komoot, strava, route({ id: 3, firstAt: T('2025-06-01T08:00:00Z'), lastAt: T('2025-06-01T09:00:00Z') })];
const folded = duplicateRoutes(list);
check(folded.size === 1 && folded.get(47) === 14, 'one copy folded behind the other',
  JSON.stringify([...folded]));
check(!folded.has(3), 'and an unrelated ride is left alone');
// Three copies of one ride must collapse to one row, not to a chain where the
// second hides behind the third and the third behind nothing.
const three = duplicateRoutes([komoot, strava, route({ id: 48, points: 179 })]);
check(three.size === 2 && [...three.values()].every((v) => v === 14),
  'three copies all fold behind the same survivor', JSON.stringify([...three]));
check(duplicateRoutes([]).size === 0, 'an empty map folds nothing');
check(duplicateRoutes([route({ firstAt: 0 }), route({ id: 2, firstAt: 0 })]).size === 0,
  'and undated routes are never guessed at');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
