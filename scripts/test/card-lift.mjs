// The button cluster steps over an open card, and keeps doing it.
//
//   node scripts/test/card-lift.mjs
//
// This exists because the first attempt worked everywhere except the place it
// was written for. Three separate rules position the cluster — the base one, the
// phone media query, and the iOS block at the end of the stylesheet — and a
// `body.card-open .layers` selector has exactly the same specificity as
// `html[data-client='ios'] .layers`. The iOS rule is later in the file, so it
// won, and inside the app the buttons never moved. Nothing said so: the class
// was applied, the height was published, and the CSS quietly disagreed.
//
// The fix is a custom property, which inherits and therefore reaches every one
// of those rules wherever they are. What this checks is that it stays that way —
// that no rule positioning the cluster forgets the lift, and that something
// still declares it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(path.join(ROOT, 'src/style.css'), 'utf8');
const js = readFileSync(path.join(ROOT, 'src/card-lift.js'), 'utf8');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Every `selector { … }` block in the file, crudely but adequately. */
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

console.log('\nEverything that positions the chrome leaves room for a card');
{
  // `.layers` and `.hud` are the two things an open card covers: the button
  // cluster in one corner and the pencil in the other. `(?![\w-])` so
  // `.layers-cluster` and `.hud-panel` are not mistaken for them.
  //
  // Two states are exempt, and both for the same reason — no card can be open in
  // them. `body.menu-open` hides the cards outright and turns the cluster into a
  // full-width sheet, which must stay at the bottom of the screen; `body.editing`
  // does the same with the edit panel, and entering edit mode closes every card.
  // Lifting either would move a sheet that has nothing to clear.
  //
  // `bottom: auto` is exempt too: it is how a rule moves the chrome to the *top*
  // of the screen, where a card along the bottom is not in the way.
  const positioned = blocks.filter(
    (b) => /\.(layers|hud)(?![\w-])/.test(b.selector)
      && !/menu-open|editing/.test(b.selector)
      // The whitespace lives *inside* the lookahead deliberately: written as
      // `:\s*(?!auto)` the star backtracks to nothing, the lookahead then reads
      // " auto" rather than "auto", and every `bottom: auto` passes.
      && /(^|[\s;])bottom\s*:(?!\s*auto)/.test(b.body),
  );
  check(positioned.length >= 3, 'several rules position it, which is the hazard',
    `${positioned.length} found`);
  const forgetful = positioned.filter((b) => !b.body.includes('var(--lift'));
  check(!forgetful.length, 'and every one of them adds the lift',
    forgetful.map((b) => b.selector).join(' | '));
}

console.log('\nAnd something declares it');
{
  const declares = blocks.filter((b) => /--lift\s*:/.test(b.body));
  check(declares.length > 0, 'the lift is declared somewhere', String(declares.length));
  check(declares.every((b) => /card-open/.test(b.selector)),
    'only while a card is open', declares.map((b) => b.selector).join(' | '));
  // Off the top of the screen is not an improvement on behind a card.
  check(declares.every((b) => /min\(/.test(b.body)), 'and never past the top of the screen');
}

console.log('\nThe measuring half');
{
  for (const id of ['cell-info', 'route-info', 'photo-info']) {
    check(js.includes(`'${id}'`), `it watches the ${id} card`);
    check(html.includes(`id="${id}"`), `and the page has one`);
  }
  check(/ResizeObserver/.test(js), 'by size');
  check(/MutationObserver/.test(js) && /hidden/.test(js), 'by being hidden and shown');
  // A ResizeObserver only reports when the browser next runs its rendering
  // steps, which left the published height 350 px stale in a tab that was not
  // being painted — and the photo card's height changes when its picture lands.
  check(/addEventListener\('load'/.test(js) && /true\)/.test(js),
    'and by a picture inside one arriving, captured');
  check(/--card-h/.test(js) && /--card-h/.test(css), 'the height is published and read');
  check(/card-open/.test(js), 'and the class with it');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
