// Every switch in the markup is connected to something.
//
// This exists because it has now been broken twice in one sitting, both times
// the same way and both times silently. Removing a block of listeners takes the
// neighbouring ones with it, the build still succeeds, the tests still pass, and
// what ships is a checkbox that ticks and does nothing at all. There is no error
// to notice — the box even remembers its state, because `updateLayersUi` goes on
// writing `checked` into it — so the only way to find out is to press it.
//
// The rule is the weakest one that would have caught it: **a checkbox in the
// layers menu must be listened to.** Not "must exist in the source", which was
// already true of both casualties — the handle was still declared and still
// being read, and it was the `addEventListener` that had gone.
//
// **Scoped to the layers menu**, which is where the invariant is actually true.
// Every switch there applies the moment it is pressed, so one that nothing
// listens to is a bug without exception. The dialogs are a different contract:
// several of them read their boxes when Save is pressed and quite correctly
// never listen to them at all, so a rule covering those would be noise, and a
// noisy test is one somebody turns off.
//
// Checkboxes only, for the same reason. A button may legitimately be inert
// markup, or be handled by a delegated click on an ancestor — both of which this
// app does.
//
//   node scripts/test/wiring.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const html = read('index.html');
// Just the layers menu: the panel beside the map, not the dialogs it opens.
const menuAt = html.indexOf('id="layers-menu"');
const menu = html.slice(menuAt, html.indexOf('id="layers-cluster"'));
const sources = readdirSync(path.join(ROOT, 'src'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => read(path.join('src', f)))
  .join('\n');

// `<input type="checkbox" ... id="…">` in either attribute order.
const boxes = [...menu.matchAll(/<input(?=[^>]*type="checkbox")[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);

console.log('\nEvery switch in the layers menu is listened to');
check(boxes.length >= 5, `${boxes.length} switches in the layers menu carry an id`);

/**
 * Is anything listening to this one?
 *
 * Two spellings, because the app uses both and neither is wrong: the listener
 * hung straight off the lookup, and the lookup kept in a `const` that is
 * listened to somewhere further down. The second is why this cannot simply
 * search for the id near the word `addEventListener` — the two can be four
 * hundred lines apart, which is exactly the distance that let the bug through.
 */
function listened(id) {
  // Both the plain lookup and the `$('id')` helper that several of these modules
  // define for themselves.
  const look = `(?:document\\.getElementById|\\$)\\(['"]${id}['"]\\)`;
  if (new RegExp(`${look}\\??\\.addEventListener`).test(sources)) return true;
  const bound = [...sources.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${look}`, 'g'))];
  return bound.some(([, name]) => new RegExp(`\\b${name}\\??\\.addEventListener`).test(sources));
}

const deaf = boxes.filter((id) => !listened(id));
check(deaf.length === 0, 'and every one of them has a handler', deaf.join(', '));

// The two that were actually broken, named so a future removal of the block they
// live in fails on the row that says why rather than on a count.
for (const id of ['trails-toggle', 'rail-toggle']) {
  if (!boxes.includes(id)) continue;
  check(listened(id), `#${id} — the overlay switch, which has been silently unwired before`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
