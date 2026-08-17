// Where a track stops being a line, and what to call one nobody named.
//
// `splitOnGaps` is the rule that used to live in three places and be applied in
// none of them: Strava hands back one flat stream of points however many times
// you stopped, Komoot the same, and an Apple Health route is a single series
// across every pause in the workout. All three were drawn — and *measured* —
// straight across the gap.
//
// The subtlety worth pinning is that it takes two measurements to call something
// a pause. Time alone would cut a track every time somebody stood still, which
// after thinning is most tracks; distance alone would cut one every descent.
//
//   node scripts/test/track-gaps.mjs

import { splitOnGaps, trackName, sportNoun, buildRoute } from '../../src/routes.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) =>
  check(got === want, label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const T = Math.floor(Date.UTC(2026, 5, 3, 9, 0, 0) / 1000);
// About 22 m apart at this latitude, a second between each: an ordinary walk.
const walk = (n, { from = 0, lat = 46.948, lng = 7.447, step = 0.0002, dt = 10 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ lat: lat + (from + i) * step, lng, t: T + (from + i) * dt }));

// --- Nothing to cut -------------------------------------------------------------
eq(splitOnGaps([walk(20)]).length, 1, 'an unbroken track stays one line');
eq(splitOnGaps([walk(20)])[0].length, 20, 'with every point still in it');
eq(splitOnGaps(splitOnGaps([walk(20)])).length, 1, 'and splitting twice changes nothing');

// --- Standing still is not a pause ----------------------------------------------
// The case that makes the two-measurement rule necessary. Half an hour outside a
// café thins down to two points a few metres apart, half an hour of clock
// between them. A time-only rule cuts here, and it must not.
eq(
  splitOnGaps([[
    { lat: 46.948, lng: 7.447, t: T },
    { lat: 46.94802, lng: 7.447, t: T + 1800 },
    { lat: 46.94804, lng: 7.447, t: T + 3600 },
  ]]).length,
  1,
  'a long stand-still is one line, not three',
);

// --- Moving fast is not a pause either -------------------------------------------
// 150 m in six seconds is 90 km/h — a descent, not a teleport. A distance-only
// rule cuts here.
eq(
  splitOnGaps([[
    { lat: 46.900, lng: 7.447, t: T },
    { lat: 46.9014, lng: 7.447, t: T + 6 },
    { lat: 46.9028, lng: 7.447, t: T + 12 },
  ]]).length,
  1,
  'a fast descent is one line',
);

// --- A real pause ----------------------------------------------------------------
const paused = splitOnGaps([[
  ...walk(10),
  // Ten minutes later and two kilometres away: the recorder was not watching.
  ...walk(10, { from: 100, lat: 46.968 }).map((p) => ({ ...p, t: p.t + 600 })),
]]);
eq(paused.length, 2, 'a stop-and-restart is two lines');
eq(paused[0].length, 10, 'the first leg keeps its points');
eq(paused[1].length, 10, 'and so does the second');

// --- The stale first fix ----------------------------------------------------------
// What a watch hands over before it has a lock: one point, somewhere else,
// stamped before the rest. There is no line to draw through it — and for a
// source that takes its cells from these runs, no place to mark either.
const stray = splitOnGaps([[
  { lat: 46.758, lng: 7.628, t: T - 1400 }, // Thun, 23 minutes early
  ...walk(10),
]]);
eq(stray.length, 1, 'a lone stray fix leaves one line, not two');
eq(stray[0].length, 10, 'and is no part of it');
check(
  !stray[0].some((p) => p.lat === 46.758),
  'the stray point is gone rather than merely last',
);

// A run of one is dropped wherever it falls, not only at the front.
eq(
  splitOnGaps([[...walk(6), { lat: 47.5, lng: 8.5, t: T + 60 + 3600 }]]).length,
  1,
  'a stray fix at the end is dropped too',
);

// --- Points with no clock ----------------------------------------------------------
// Plenty of files carry coordinates and no times. There are no pauses to find in
// one — only the teleport half of the rule can fire — and it must not shred the
// track for want of a timestamp.
eq(
  splitOnGaps([[
    { lat: 46.948, lng: 7.447, t: 0 },
    { lat: 46.958, lng: 7.447, t: 0 },
    { lat: 46.968, lng: 7.447, t: 0 },
  ]]).length,
  1,
  'a track with no timestamps is left whole',
);

// --- What it does to a route ---------------------------------------------------
// The point of all of it: the gap is neither drawn nor counted.
const joined = buildRoute(
  { name: '', segments: [[...walk(30), ...walk(30, { from: 300, lat: 47.01 }).map((p) => ({ ...p, t: p.t + 1200 }))]], firstAt: T, lastAt: 0 },
  { source: 'strava' },
);
eq(joined.geom.length, 2, 'a paused activity is stored as two lines');
check(
  joined.lengthM < 3000,
  'and the kilometres between them are not counted as distance',
  `got ${joined.lengthM} m`,
);

// --- Naming one nobody named -------------------------------------------------------
eq(sportNoun('Walking'), 'walk', 'the label is a verb; the name wants the noun');
eq(sportNoun('Mountain cycling'), 'ride', 'both kinds of cycling are a ride');
eq(sportNoun(''), '', 'and nothing stays nothing');
// The hour is read locally, so build the input the same way rather than assuming
// the machine running this is in any particular place.
const at = (h) => Math.floor(new Date(2026, 5, 3, h, 30).getTime() / 1000);
eq(trackName('Walking', at(9)), 'Morning walk', 'a morning walk');
eq(trackName('Cycling', at(18)), 'Evening ride', 'an evening ride');
eq(trackName('Running', at(14)), 'Afternoon run', 'an afternoon run');
eq(trackName('Running', at(2)), 'Night run', 'and the small hours are night');
eq(trackName('', at(9)), '', 'an activity nobody identified gets no name');
eq(trackName('Walking', 0), '', 'and neither does one with no clock');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
