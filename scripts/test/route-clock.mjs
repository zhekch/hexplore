// A clock left running is not a long ride.
//
// Both ends of a route's span are real timestamps, so nothing upstream can tell
// they are wrong — but a recording that was never stopped keeps counting. Two
// real Komoot tours on one map claim 596 hours for 20 km and 163 hours for
// 11.5 km, and between them they were contributing 759 of the 956 hours the
// statistics said had been recorded. "Time recorded: 916 h" is not an
// approximate answer, it is a wrong one.
//
// The test is speed, because that is the thing that gives it away: covering
// twenty kilometres at 0.03 km/h is not slow, it is stationary. The floor sits
// ten times below the slowest genuine outing on the same map (a 1.2 km/h walk
// with stops) and seven times above the worst glitch, so both sides have room.
//
//   node scripts/test/route-clock.mjs

import { recordedSeconds, ROUTE_MIN_SPEED_KMH } from '../../src/routes.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const H = 3600;
// firstAt is arbitrary; only the span and the distance matter.
const ride = (hours, km) => ({ firstAt: 1_700_000_000, lastAt: 1_700_000_000 + hours * H, lengthM: km * 1000 });

console.log('\nrides that took as long as they say');
check(recordedSeconds(ride(1.1, 9.8)) === Math.round(1.1 * H), 'an hour-long run');
check(recordedSeconds(ride(6.8, 8.1)) === Math.round(6.8 * H), 'a 1.2 km/h walk with long stops',
  'the slowest real outing on the map, and it must survive');
check(recordedSeconds(ride(9.2, 19.8)) === Math.round(9.2 * H), 'a nine-hour hike');
check(recordedSeconds(ride(6.3, 68.3)) === Math.round(6.3 * H), 'a day on the slopes');

console.log('\nclocks left running');
check(recordedSeconds(ride(595.6, 20.3)) === 0, 'twenty-five days for twenty kilometres',
  '0.03 km/h');
check(recordedSeconds(ride(163.4, 11.5)) === 0, 'a week for eleven', '0.07 km/h');

console.log('\nthe edge itself');
// Straddling the floor from both sides, so the constant is load-bearing rather
// than decorative — a threshold nothing is ever measured against is not one.
const atFloor = ride(10, 10 * ROUTE_MIN_SPEED_KMH);
check(recordedSeconds(atFloor) === 10 * H, 'exactly at the floor still counts', `${ROUTE_MIN_SPEED_KMH} km/h`);
check(recordedSeconds(ride(10, 10 * ROUTE_MIN_SPEED_KMH * 0.99)) === 0, 'a hair under it does not');

console.log('\nno clock at all');
check(recordedSeconds({ firstAt: 0, lastAt: 1_700_000_000, lengthM: 9000 }) === 0, 'no start');
check(recordedSeconds({ firstAt: 1_700_000_000, lastAt: 0, lengthM: 9000 }) === 0, 'no end');
check(recordedSeconds({ firstAt: 1_700_000_100, lastAt: 1_700_000_000, lengthM: 9000 }) === 0,
  'and an end before the start');
check(recordedSeconds(undefined) === 0 && recordedSeconds({}) === 0, 'nothing at all is not a crash');
// A route with no length cannot be shown to have moved, so its clock says
// nothing either — this is the case that would otherwise divide by zero and
// call every untraced route a glitch, or none of them.
check(recordedSeconds({ firstAt: 1, lastAt: 1 + 3 * H, lengthM: 0 }) === 0,
  'a three-hour route that covered no ground', 'no distance, no evidence it happened');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
