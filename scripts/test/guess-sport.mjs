// What the activity classifier should and shouldn't claim.
//
// The cases that matter are the ones speed alone gets wrong: a day on the
// pistes averages about 10 km/h, which is exactly the pace of a run, so
// guessing from the number alone filed both of the author's real ski days as
// "Run". The name is checked first for that reason, and these tests exist so
// nobody later "simplifies" it back to a pure speed lookup.
//
//   node scripts/test/guess-sport.mjs

import { guessSport, sportFromName, canonicalSport } from '../../src/routes.js';

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = got === want;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : ` — got "${got}", wanted "${want}"`}`);
  ok ? pass++ : fail++;
};

const hour = 3600;

// --- The name wins, because speed cannot tell these apart -------------------
eq(
  guessSport({ name: 'Slopes - A day skiing at Jungfrau', lengthM: 68000, seconds: 6.3 * hour }),
  'Skiing',
  'a Slopes ski day is skiing, not a run (10.8 km/h)',
);
eq(guessSport({ name: 'Hike', lengthM: 20000, seconds: 9 * hour }), 'Hiking', '"Hike" is a hike');
eq(
  guessSport({ name: 'Evening Ride', lengthM: 20000, seconds: 4 * hour }),
  'Cycling',
  'a named ride beats its 5 km/h average',
);

// A place name must not trip a keyword: "Brunnen" contains "run", "Skien" is a
// Norwegian town. Word boundaries are what keep these out.
eq(sportFromName('Brunnen loop'), '', 'Brunnen is not a run');
eq(sportFromName('Interlaken → Thun'), '', 'no false hit on a plain route name');

// --- Falling back to pace ----------------------------------------------------
eq(guessSport({ name: 'Bern → Frutigen', lengthM: 63000, seconds: 3.66 * hour }), 'Cycling', '17 km/h is a ride');
eq(guessSport({ name: 'Como', lengthM: 8000, seconds: 3.6 * hour }), 'Walking', '2.2 km/h is a walk');
eq(guessSport({ name: 'morning', lengthM: 10000, seconds: 1.09 * hour }), 'Running', '9.2 km/h is a run');
eq(
  guessSport({ name: 'up the hill', lengthM: 12000, seconds: 4 * hour, elevUp: 900 }),
  'Hiking',
  'a walk that climbed 900 m is a hike',
);

// A brisk walker at 6.6 km/h is still walking — the old boundary called it a run.
eq(guessSport({ name: 'Frutigen loop', lengthM: 20000, seconds: 3.03 * hour }), 'Walking', '6.6 km/h is a walk');

// --- Saying nothing is a valid answer ---------------------------------------
eq(guessSport({ name: 'Bern loop', lengthM: 12000, seconds: 120 * hour }), '', 'nonsense pace stays blank');
eq(guessSport({ name: 'x', lengthM: 20000, seconds: 0 }), '', 'no clock, no guess');
eq(guessSport({ name: 'x', lengthM: 50, seconds: 600 }), '', 'too short to judge');
// 5 km in three minutes is a car, and saying so is more useful than a shrug.
eq(guessSport({ name: '', lengthM: 5000, seconds: 0.05 * hour }), 'Driving', '100 km/h is a drive');
// Faster than any vehicle you'd map: that's a bad clock, not a rocket.
eq(guessSport({ name: '', lengthM: 5000, seconds: 5 }), '', 'an impossible pace stays blank');

// --- One vocabulary ---------------------------------------------------------
// Five sources spell the same activity five ways; canonicalSport is the single
// place that decides which spelling wins, so the list and the colour menu don't
// end up with three flavours of "went for a ride".
eq(canonicalSport('Road ride'), 'Cycling', 'Road ride is Cycling');
eq(canonicalSport('cycling'), 'Cycling', 'lower-case GPX <type> is Cycling');
eq(canonicalSport('Ride'), 'Cycling', "Strava's Ride is Cycling");
eq(canonicalSport('Bike tour'), 'Mountain cycling', 'Bike tour is Mountain cycling');
eq(canonicalSport('Mountain bike'), 'Mountain cycling', 'Mountain bike is Mountain cycling');
eq(canonicalSport('mtb'), 'Mountain cycling', 'mtb is Mountain cycling');
eq(canonicalSport('Walk'), 'Walking', 'Walk is Walking');
// Every name is in the same tense, so the list never mixes "Walking" with "Run".
eq(canonicalSport('Trail_running'), 'Running', 'Trail_running is Running');
eq(canonicalSport('Ski'), 'Skiing', 'Ski is Skiing');
eq(canonicalSport('Swim'), 'Swimming', 'Swim is Swimming');
eq(canonicalSport('Flight'), 'Flying', 'Flight is Flying');
eq(canonicalSport('running'), 'Running', 'running is Running');
eq(canonicalSport('hiking'), 'Hiking', 'hiking is Hiking');
eq(canonicalSport('Ski touring'), 'Ski touring', 'ski touring stays its own thing');
eq(canonicalSport(''), '', 'blank stays blank');
// Anything it doesn't recognise is kept — inventing a category is worse than
// carrying an unusual one — but with a consistent shape.
eq(canonicalSport('Mountaineering'), 'Mountaineering', 'an unknown activity survives');
eq(canonicalSport('mountaineering'), 'Mountaineering', '…and only its case is tidied');

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
