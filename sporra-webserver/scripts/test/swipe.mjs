// Swiping along a series: the day chip, and the calendar's months.
//
//   node scripts/test/swipe.mjs
//
// A gesture is arithmetic wearing a coat, and this one is the photograph card's
// arithmetic with smaller numbers on it — which is exactly the kind of thing
// that gets changed in one of the two places and noticed by nobody. What
// decides whether a swipe feels right is how far is far enough, what counts as
// a flick, and which way a pull means: all numbers compared against numbers,
// all invisible in the review that breaks them.
//
// The DOM half is left out on purpose, the way src/scroll-chain.js leaves it
// out: what a browser would add here is layout, and there is no layout in "a
// 50px pull is the next day".

import {
  swipeStep, wheelStepper, SWIPE_COMMIT, SWIPE_FLICK, SWIPE_CLAIM, WHEEL_STEP, WHEEL_LULL, WHEEL_WAKE,
} from '../../src/swipe.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

console.log('\nwhich way a pull means');
{
  // Left drags the thing off towards yesterday and brings tomorrow in behind
  // it, which is the direction time runs in every calendar this app draws.
  check(swipeStep(-80, 200) === 1, 'pulling it left is the next one');
  check(swipeStep(80, 200) === -1, 'and right is the one before');
  // The vertical axis is the same function: a pull downwards brings in what was
  // above, which is why a trip chip pulled down is a step of −1 into its days.
  check(swipeStep(90, 200) === -1, 'a pull downwards is a step back');
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

console.log('\nthe trackpad, which is one gesture and a hundred events');
{
  check(WHEEL_LULL < WHEEL_WAKE, 'winding down is quieter than picking up again');
  check(WHEEL_STEP > WHEEL_WAKE, 'and one event is never a whole step by itself');

  // A flick as a trackpad actually sends one: a burst that accelerates while
  // the fingers are on the glass, and then a long tail of momentum that decays
  // towards nothing. Every number below is travel, and the whole of it is one
  // instruction — "the next one" — however many events it arrives in.
  const PUSH = [4, 12, 26, 38, 30];
  const TAIL = [22, 18, 14, 11, 9, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1];
  /** Feed a gesture and count what it spent. `gap` is the silence before it. */
  const throwIt = (w, at, sign, gap = 600, spacing = 16) => {
    let t = at + gap;
    let steps = 0;
    for (const d of [...PUSH, ...TAIL]) {
      steps += Math.abs(w.feed(sign * d, t)) ? 1 : 0;
      t += spacing;
    }
    return { steps, at: t };
  };

  {
    const w = wheelStepper();
    const one = throwIt(w, 0, 1);
    check(one.steps === 1, 'one flick is one step', `${one.steps}`);
    // The complaint this is here for: the tail is not four more months.
    const two = throwIt(w, one.at, 1);
    const three = throwIt(w, two.at, -1);
    check(two.steps === 1 && three.steps === 1, 'and so is the next one, and the one back');
  }

  {
    // The tail, arriving in fits. A coasting stream goes quiet for longer than
    // WHEEL_GAP_MS between its last few events, and a rule that only asked
    // about silence would read that as a fresh push and spend a second step on
    // it — the bug that reads as one swipe moving two days.
    const w = wheelStepper();
    let t = 1000;
    let steps = 0;
    for (const d of PUSH) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 16;
    }
    for (const d of TAIL) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 200; // slower than the gap rule, well inside the momentum
    }
    check(steps === 1, 'a tail that arrives in fits is still one step', `${steps}`);
  }

  {
    // …and the other half of the same rule: after a real silence, a slow
    // deliberate push has to be taken even though it begins below the wake
    // threshold. Otherwise the gesture that is not a flick stops working.
    const w = wheelStepper();
    throwIt(w, 0, 1);
    let t = 5000;
    let steps = 0;
    for (const d of [3, 4, 5, 6, 7, 8, 9, 10]) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 30;
    }
    check(steps === 1, 'a slow push after the coasting has stopped is a step', `${steps}`);
  }

  {
    // Two flicks thrown one on top of the other: the second arrives while the
    // first is still coasting, and has to be answered — the alternative reads
    // as a cooldown, which is what it was.
    const w = wheelStepper();
    let t = 0;
    let steps = 0;
    for (const d of PUSH) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 16;
    }
    for (const d of TAIL.slice(0, 8)) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 16;
    }
    for (const d of PUSH) {
      steps += Math.abs(w.feed(d, t)) ? 1 : 0;
      t += 16;
    }
    check(steps === 2, 'a second flick thrown into the first one is answered', `${steps}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
