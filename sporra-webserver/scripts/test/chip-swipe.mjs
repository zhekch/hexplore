// Swiping the day chip from one day to the next.
//
//   node scripts/test/chip-swipe.mjs
//
// A gesture is arithmetic wearing a coat, and this one is the same arithmetic
// the photograph card uses with smaller numbers on it — which is exactly the
// kind of change that is made once, in one of the two places, and noticed by
// nobody. What decides whether the chip feels right is how far is far enough,
// what counts as a flick, and which way a pull means: all numbers compared
// against numbers, all invisible in the review that breaks them.
//
// The DOM half is left out on purpose, the way src/scroll-chain.js leaves it
// out: what a browser would add here is layout, and there is no layout in "a
// 50px pull is the next day".

import { swipeStep, SWIPE_COMMIT, SWIPE_FLICK, SWIPE_CLAIM } from '../../src/chip-swipe.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

console.log('\nwhich way a pull means');
{
  // Left drags the chip off towards yesterday and brings tomorrow in behind it,
  // which is the direction time runs in every calendar this app draws.
  check(swipeStep(-80, 200) === 1, 'pulling the chip left is the day after');
  check(swipeStep(80, 200) === -1, 'and right is the day before');
}

console.log('\nfar enough, or fast enough');
{
  check(swipeStep(-(SWIPE_COMMIT + 1), 900) === 1, 'a slow deliberate pull commits on distance');
  check(swipeStep(-(SWIPE_COMMIT - 1), 900) === 0, 'and just short of it goes back');
  // A flick is short and fast: neither test on its own would take it.
  const flick = Math.ceil(SWIPE_FLICK * 40) + 4;
  check(flick < SWIPE_COMMIT, 'the flick below is genuinely shorter than the distance rule', `${flick}px`);
  check(swipeStep(-flick, 40) === 1, 'a quick flick commits on speed alone');
  check(swipeStep(-flick, 4000) === 0, 'the same distance dawdled does not');
}

console.log('\nthings that are not a swipe');
{
  check(swipeStep(0, 100) === 0, 'a press that never moved asks for nothing');
  check(swipeStep(-SWIPE_CLAIM, 300) === 0, 'nor does a press that drifted');
  // Two events in the same frame: the speed rule divides by the duration, and a
  // zero there would make every twitch a flick and step the day under a tap.
  check(swipeStep(-1, 0) === 0, 'a movement with no time on it is not a flick', swipeStep(-1, 0));
  check(swipeStep(NaN, 100) === 0, 'and a pointer with no position is not a crash');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
