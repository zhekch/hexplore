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
// from what felt safe, and the measurement that matters is the start offset as
// a *fraction of the outing*: an hour's run recorded twice agrees to within
// thirteen seconds, a six-hour ski day drifts up to twenty minutes, and both
// land under 5.9% of the shorter recording. The closest thing on the same map
// that must not fold sits at 257%.
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

console.log('\nhow far the two starts may drift');
// A twenty-minute jog is short enough that the flat floor is the whole gate:
// a tenth of it is under two minutes, so two minutes is what it gets.
const jogAt = T('2025-04-03T11:13:53Z');
const jog = (o) => route({ lengthM: 3400, lastAt: jogAt + 1200, ...o });
check(!routesLookAlike(jog({}), jog({ id: 2, firstAt: jogAt + 121 })),
  'two minutes and one second apart is past the floor', 'on a twenty-minute jog');
check(routesLookAlike(jog({}), jog({ id: 2, firstAt: jogAt + 119 })),
  'one second under it is not');

// Gstaad, 16 January 2026 — the pair that started all this. A watch on at the
// first lift and a phone remembered five and a half minutes later, then five
// and a half hours of skiing. A flat two-minute gate listed the day twice.
const skiAt = T('2026-01-16T09:02:05Z');
const ski = (o) => ({
  id: 1, name: 'ski', source: 'apple-health', link: '', sportGuessed: false, elevUp: 0,
  points: 695, lengthM: 49424, firstAt: skiAt, lastAt: skiAt + 21015,
  bbox: [7.3424, 46.4905, 7.3772, 46.5518], ...o,
});
const health = ski({ id: 965 });
const stravaSki = ski({ id: 55, source: 'strava', points: 693, lengthM: 48015, firstAt: skiAt + 343, lastAt: skiAt + 343 + 19462 });
check(routesLookAlike(health, stravaSki), 'five and a half minutes apart on a ski day is one ski day',
  '343 s is 1.8% of the shorter recording');
check(routesLookAlike(stravaSki, health), 'whichever way round they are compared');
// The slack is a tenth of the *shorter* recording, so the app that stopped
// watching early tightens the gate rather than the other one loosening it.
check(!routesLookAlike(health, ski({ id: 2, firstAt: skiAt + 343, lastAt: skiAt + 343 + 1800 })),
  'and a half-hour recording does not inherit a ski day\'s slack');
// The boundary itself, on the hour-long ride the file was built around: a
// 3,860-second recording buys 386 seconds of drift and not a second more.
const rideAt = T('2025-04-03T11:13:53Z');
const shifted = (by) => route({ id: 2, firstAt: rideAt + by, lastAt: rideAt + by + 3860 });
check(routesLookAlike(route({}), shifted(386)), 'a tenth of the recording is still one ride');
check(!routesLookAlike(route({}), shifted(387)), 'and one second over it is two');

// Two walks round the same block on one afternoon: 2% apart in length, in the
// same place, and the only thing that keeps them apart is the start. On a real
// map this is the closest call there is, at 257% of the shorter walk.
const walkAt = T('2026-07-04T14:59:33Z');
const walk = (o) => route({ lengthM: 1752, sport: 'Walking', source: 'apple-health',
  lastAt: walkAt + 2078, firstAt: walkAt, ...o });
check(!routesLookAlike(walk({}), walk({ id: 2, lengthM: 1715, firstAt: walkAt + 4270, lastAt: walkAt + 4270 + 1659 })),
  'the same walk done twice in an afternoon is two walks', '71 minutes apart');

// A clock left running would otherwise hand out a week of slack. `recordedSeconds`
// scores those rows 0, which drops the pair back to the flat floor.
const running = ski({ id: 3, lastAt: skiAt + 7 * 86400 });
check(!routesLookAlike(running, stravaSki), 'a clock left running earns no extra slack',
  'a 0.03 km/h ski day is not a six-hour one');

console.log('\nwhich copy speaks for the ride');
// Which app recorded it leads: Komoot, then Apple Health, then Strava.
check(preferredRoute(health, stravaSki).id === 965, 'Apple Health over Strava');
check(preferredRoute(stravaSki, health).id === 965, 'whichever order they are compared in');
check(preferredRoute(ski({ id: 9, source: 'komoot' }), ski({ id: 8 })).id === 9,
  'and Komoot over Apple Health', 'even though the older row would win a tie');
// Rank beats every other signal, or it would not be a rule you could predict.
check(preferredRoute(ski({ id: 9, source: 'strava', link: 'x', points: 9000 }), ski({ id: 8 })).id === 8,
  'a Strava row with a link and more points still loses to Health');
// A source this app has no opinion about falls through to the ranks below.
check(preferredRoute(ski({ id: 9, source: 'gpx' }), ski({ id: 8, source: 'strava' })).id === 8,
  'an unranked source loses to a ranked one');
check(preferredRoute(ski({ id: 9, source: 'gpx', link: '' }), ski({ id: 8, source: 'garmin', link: 'x' })).id === 8,
  'and between two unranked ones the link decides');

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
// Four copies of one ski day, folded pairwise with the survivor last: without a
// pass to walk the answers through, the first row ends up standing behind a row
// that is itself hidden.
const four = duplicateRoutes([
  ski({ id: 20, source: 'strava' }), ski({ id: 21, source: 'strava' }),
  ski({ id: 30, source: 'apple-health' }), ski({ id: 40, source: 'komoot', link: 'x' }),
]);
check(four.size === 3 && [...four.values()].every((v) => v === 40),
  'and four fold behind the one that speaks, not behind each other',
  JSON.stringify([...four]));
check(![...four.values()].some((v) => four.has(v)), 'no row stands in for another that is hidden');
check(duplicateRoutes([]).size === 0, 'an empty map folds nothing');
check(duplicateRoutes([route({ firstAt: 0 }), route({ id: 2, firstAt: 0 })]).size === 0,
  'and undated routes are never guessed at');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
