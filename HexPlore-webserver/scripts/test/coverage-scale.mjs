// How a share of a country is written down.
//
// "Ground covered" spans five orders of magnitude on one real map — 7% of
// Switzerland down to 0.014% of Spain — and the first version of this scale
// simply refused to print anything under 0.05%, so France (0.031%) and Spain
// showed a number of square kilometres and no share at all. The number was
// there; the code was hiding it. What it was actually guarding against is
// rounding a real fraction to "0.00%", which only happens three decimal places
// further down.
//
// So the contract is: every non-zero share gets written, decimals are added
// until the scale runs out, and when it does the answer says "smaller than
// this" rather than "zero".
//
//   node scripts/test/coverage-scale.mjs

import { pct, km2 } from '../../src/cell-info.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

console.log('\nshares, from a country you live in to one you clipped a corner of');
check(pct(7.1963) === '7%', 'whole percents lose their decimals', pct(7.1963));
check(pct(100) === '100%', 'and all of it is 100%', pct(100));
check(pct(0.3492) === '0.3%', 'under one percent gains one', pct(0.3492));
check(pct(0.0938) === '0.09%', 'under a tenth gains two', pct(0.0938));

// The regression. These are real numbers off a real map, and both printed
// nothing at all before.
check(pct(0.0314) === '0.03%', 'France is 0.03% of itself, not blank', pct(0.0314));
check(pct(0.0137) === '0.01%', 'and Spain 0.01%', pct(0.0137));

// The thing the cutoff was for. Two decimals cannot say 0.002, so the scale
// stops claiming it can.
check(pct(0.002) === '<0.01%', 'past the last decimal it says so', pct(0.002));
check(pct(0.0049) === '<0.01%', 'just under the rounding edge', pct(0.0049));
check(pct(0.005) === '0.01%', 'and just over it rounds up honestly', pct(0.005));

// No band may ever render a bare zero — that is the one answer that is wrong
// rather than imprecise, because the card only draws this row when there is
// ground to report.
const zeros = [0.004, 0.001, 0.0001, 0.00001].filter((v) => pct(v) === '0.00%' || pct(v) === '0%');
check(zeros.length === 0, 'no positive share is ever written as zero', JSON.stringify(zeros));

// Every band has to be reachable, or a threshold is dead code that lets the
// band above it swallow the range — which is exactly how the bug got in: the
// 0.05 cutoff made the two-decimal band unreachable from below.
const bands = [pct(7), pct(0.3), pct(0.09), pct(0.002)];
check(new Set(bands).size === 4, 'all four bands are reachable and distinct', JSON.stringify(bands));

console.log('\nareas');
check(km2(2971) === '2,971 km²', 'thousands are grouped and rounded', km2(2971));
check(km2(171.7) === '172 km²', 'tens lose their decimal', km2(171.7));
check(km2(7.6) === '7.6 km²', 'and single digits keep one', km2(7.6));
check(km2(0.4) === '0.4 km²', 'a fraction of a square kilometre survives', km2(0.4));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
