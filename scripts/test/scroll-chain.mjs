// Handing a touch-scroll from an inner list to the panel around it.
//
// The DOM half of this cannot be tested without a phone, so the decision is
// kept out of the DOM: given a chain of scrollers and a direction, which one
// should move? The cases below are the ones that were actually broken —
// a list at its end with a panel behind it that still has somewhere to go.
//
//   node scripts/test/scroll-chain.mjs

import { canScroll, pickHandoff } from '../../src/scroll-chain.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// A scroller 400 tall holding 1000, so 600 of travel.
const at = (scrollTop) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });
// One that fits its own content, and so never scrolls.
const stuck = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 };

// Finger travel, not scroll direction: a finger moving *down* the screen reveals
// what is above, which is a smaller scrollTop.
const UP = -1; // finger up, going further down the list
const DOWN = 1;

console.log('\ncan a scroller still move?');
{
  check(canScroll(at(300), UP) && canScroll(at(300), DOWN), 'mid-list it goes either way');
  check(!canScroll(at(0), DOWN), 'at the top it has nowhere further up to go');
  check(canScroll(at(0), UP), 'but it can still go down');
  check(!canScroll(at(600), UP), 'at the end it has nowhere further down to go');
  check(canScroll(at(600), DOWN), 'and can still come back');
  check(!canScroll(stuck, UP) && !canScroll(stuck, DOWN), 'content that fits never scrolls');
  check(!canScroll(at(300), 0), 'a finger that has not moved asks for nothing');
}

console.log('\nwho should move?');
{
  // The case the whole module exists for: the country list is at its end and
  // the dialog behind it is not.
  check(pickHandoff([at(600), at(200)], UP) === 1,
    'a list at its end hands the panel behind it the gesture');
  check(pickHandoff([at(200), at(200)], UP) === -1,
    'a list that can still move keeps it, and the browser is left to it');
  check(pickHandoff([at(600), at(600)], UP) === -1,
    'both at the end is nothing to hand on — let it rubber-band');
  check(pickHandoff([at(0), at(200)], DOWN) === 1,
    'and it works the other way, at the top of the list');
  check(pickHandoff([at(600)], UP) === -1,
    'one scroller on its own is always the browser’s business');
  check(pickHandoff([], UP) === -1, 'no scroller at all is not a crash');

  // Three deep: a list inside a section inside a dialog. The first ancestor
  // that can move is the one that gets it, not the outermost.
  check(pickHandoff([at(600), at(600), at(100)], UP) === 2,
    'it walks past ancestors that are also stuck');
  check(pickHandoff([at(600), stuck, at(100)], UP) === 2,
    'including ones that never scrolled in the first place');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
