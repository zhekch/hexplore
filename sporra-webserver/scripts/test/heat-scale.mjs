// What the heat ramps do to a distribution that is not the one they were tuned on.
//
// Both date modes have the same failure and it is invisible from the code: the
// ends of a range say nothing about where the middle sits. `visits` solved it
// once with a percentile and a logarithm; `oldest` was still a straight line
// from the earliest date to the latest, and on a real map that put 61% of the
// cells in the last of seven colours because one photograph from 2014 owned the
// far end of the scale.
//
// The fix has to hold for maps that are nothing like that one, which is what
// these cases are for: a fixed curve constant would have fixed the skewed map
// and made the evenly-spread ones *worse than the straight line* — bending
// hardest exactly where no bend was wanted. So the assertions below are about
// the property, not the numbers: no distribution may end up worse than a
// straight line would have left it.
//
//   node scripts/test/heat-scale.mjs

import { HEAT_MODES, UNDATED, ageStopsOf, heatMetric } from '../../src/coloring.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const YEAR = 365.25 * 86400;
const NOW = Date.UTC(2026, 7, 8) / 1000;

// Deterministic, so a failure is the same failure twice.
let seed = 987654321;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ages = (n, yearsAgo) => Array.from({ length: n }, () => Math.round(NOW - yearsAgo() * YEAR));

const rangeOf = (list) => ({
  minAge: Math.min(...list),
  maxAge: Math.max(...list),
  ageStops: ageStopsOf(list.map((age) => ({ age }))),
});

const oldest = heatMetric('oldest');

/** How crowded the worst of the seven ramp colours gets, against an even spread. */
function crowding(list, range) {
  const buckets = new Array(7).fill(0);
  for (const age of list) {
    const v = oldest({ age }, range);
    buckets[Math.min(6, Math.max(0, Math.floor(v * 7)))]++;
  }
  return Math.max(...buckets) / (list.length / 7);
}

const straightLine = (list) => {
  const range = { minAge: Math.min(...list), maxAge: Math.max(...list) }; // no ageStops
  return crowding(list, range);
};

const CASES = {
  'a decade with one ancient outlier': [NOW - 12 * YEAR, ...ages(3000, () => rnd() * 1.5)],
  'evenly spread over five years': ages(3000, () => rnd() * 5),
  'a single summer': ages(1200, () => rnd() * 0.25),
  'an old import and a recent year': [...ages(1000, () => 7 + rnd() * 1.5), ...ages(2000, () => rnd() * 1.5)],
  'steady growth': ages(3000, () => -Math.log(1 - rnd() * 0.98) * 1.4),
};

console.log('First seen: no distribution may be left worse than a straight line\n');
for (const [name, list] of Object.entries(CASES)) {
  const before = straightLine(list);
  const after = crowding(list, rangeOf(list));
  check(
    after <= before + 0.05,
    `${name} — ${before.toFixed(1)}× → ${after.toFixed(1)}×`,
    `the scale made it worse: ${before.toFixed(2)} → ${after.toFixed(2)}`,
  );
}

// The one that motivated all of this: a heavily skewed map must actually get
// better, not merely not-worse.
const skewed = CASES['a decade with one ancient outlier'];
check(
  crowding(skewed, rangeOf(skewed)) < straightLine(skewed) / 2,
  'and a badly skewed map is at least twice as evenly spread',
  `${straightLine(skewed).toFixed(1)}× → ${crowding(skewed, rangeOf(skewed)).toFixed(1)}×`,
);

console.log('\nThe ends still mean what the legend says they mean');
{
  const list = ages(500, () => rnd() * 4);
  const range = rangeOf(list);
  check(oldest({ age: range.minAge }, range) === 0, 'the earliest date sits at the cold end');
  check(oldest({ age: range.maxAge }, range) === 1, 'and the latest at the warm end');
  // Monotone: a later date is never a colder colour.
  const sorted = [...list].sort((a, b) => a - b);
  let monotone = true;
  for (let i = 1; i < sorted.length; i++) {
    if (oldest({ age: sorted[i] }, range) < oldest({ age: sorted[i - 1] }, range)) monotone = false;
  }
  check(monotone, 'and nothing later is ever painted as older');
}

console.log('\nThe cases that have no distribution to read');
{
  const range = rangeOf(ages(10, () => rnd()));
  check(oldest({ age: 0 }, range) === UNDATED, 'a cell with no date is UNDATED, not one end of the ramp');
  check(ageStopsOf([{ age: 0 }, {}]) === null, 'a map with nothing dated has no ladder to build');
  // A range from before this existed, or one nobody built stops for, still works.
  const legacy = { minAge: NOW - YEAR, maxAge: NOW };
  const half = oldest({ age: NOW - YEAR / 2 }, legacy);
  check(Math.abs(half - 0.5) < 0.002, 'and without a ladder it is the straight line it always was');
  check(oldest({ age: NOW }, { minAge: NOW, maxAge: NOW }) === 1, 'a map with one date is all one colour');
}

console.log('\nVisits still ramps the way it did');
{
  const visits = heatMetric('visits');
  const r = { hotHits: 100 };
  check(visits({ hits: 100 }, r) === 1, 'the hot end pins at the hot percentile');
  check(visits({ hits: 1000 }, r) === 1, 'and anything past it stays pinned');
  check(visits({ hits: 10 }, r) < visits({ hits: 50 }, r), 'and more visits is always warmer');
  check(!!HEAT_MODES.visits.ramp && !!HEAT_MODES.oldest.ramp, 'both date modes still carry a ramp');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
