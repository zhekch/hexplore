// Clicking away, and the drag that only looks like it.
//
// The bug this exists to stop is one line of the DOM spec: a `click` is
// dispatched on the **nearest common ancestor** of the press and the release.
// Select a sentence inside a dialog, run the cursor past the edge of the card
// and let go, and the browser reports a click on the backdrop. Every dialog in
// this app read that as "you clicked away" and shut itself, taking the selection
// with it.
//
// Nothing here needs a browser: the rule is entirely about which of two events
// is trusted, so a fake EventTarget that records handlers and lets a test fire
// them in order is a complete stand-in — and a faster one than a real DOM, which
// would not synthesise the common-ancestor rule for us anyway.
//
//   node scripts/test/dismiss.mjs

import { onBackdropClick, onClickAway } from '../../src/dismiss.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

/** An EventTarget that remembers what was registered, and can fire it. */
function node() {
  const handlers = { pointerdown: [], click: [] };
  return {
    addEventListener: (type, fn) => handlers[type]?.push(fn),
    removeEventListener: (type, fn) => {
      const list = handlers[type] ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    fire: (type, target) => {
      for (const fn of [...(handlers[type] ?? [])]) fn({ type, target });
    },
    count: () => handlers.pointerdown.length + handlers.click.length,
  };
}

// A dialog is the dimmed area with a card floating on it, and `onBackdropClick`
// asks whether an event's target *is* the dim area — so the overlay is the fake
// node itself, and anything inside the card is some other object entirely.
const card = 'card';

console.log('\nThe backdrop, which is what a dialog dismisses on');
{
  let closed = 0;
  const el = node();
  const overlay = el;
  onBackdropClick(el, () => closed++);

  // A plain tap on the dim area: pressed there, released there.
  el.fire('pointerdown', overlay);
  el.fire('click', overlay);
  check(closed === 1, 'a press and release on the backdrop closes', String(closed));

  // The bug. Press inside the card (selecting text), release past its edge —
  // the browser reports the click on their common ancestor, the overlay.
  el.fire('pointerdown', card);
  el.fire('click', overlay);
  check(closed === 1, 'text dragged out of the card and released does not', String(closed));

  // And the same gesture the other way round, which is a real one too: start on
  // the dim area, end inside the card.
  el.fire('pointerdown', overlay);
  el.fire('click', card);
  check(closed === 1, 'nor does a press on the backdrop that ends in the card', String(closed));

  // A press that ends outside must not be left standing to answer the next
  // click — that is how one gesture eats the one after it.
  el.fire('pointerdown', overlay);
  el.fire('click', card); // spends the press without closing
  el.fire('click', overlay); // a click with no press of its own
  check(closed === 1, 'and a spent press cannot close on a later click', String(closed));

  // Back to normal afterwards: none of the above is a latch.
  el.fire('pointerdown', overlay);
  el.fire('click', overlay);
  check(closed === 2, 'a tap on the backdrop still closes after all that', String(closed));
}

console.log('\nA click with no press behind it');
{
  // Enter on a focused button dispatches a click and no pointerdown. It must not
  // dismiss anything: nobody pressed the backdrop.
  let closed = 0;
  const el = node();
  onBackdropClick(el, () => closed++);
  el.fire('click', el);
  check(closed === 0, 'a keyboard-dispatched click dismisses nothing', String(closed));
}

console.log('\nThe general form, for something with no backdrop of its own');
{
  // The colour picker: a floating panel, listening on the document, with a hex
  // field somebody will select the contents of.
  let closed = 0;
  const el = node();
  const inPanel = new Set(['panel', 'hex-field']);
  const stop = onClickAway(el, (e) => !inPanel.has(e.target), () => closed++);

  el.fire('pointerdown', 'map');
  el.fire('click', 'map');
  check(closed === 1, 'a click on the map closes the panel', String(closed));

  el.fire('pointerdown', 'hex-field');
  el.fire('click', 'body');
  check(closed === 1, 'selecting the hex box and letting go outside does not', String(closed));

  // The disposer is not decoration: the per-activity pickers are rebuilt on
  // every re-render of the routes menu, and these listeners are on `document`.
  stop();
  check(el.count() === 0, 'and it can take both listeners off again', String(el.count()));
  el.fire('pointerdown', 'map');
  el.fire('click', 'map');
  check(closed === 1, 'a torn-down picker answers nothing', String(closed));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
