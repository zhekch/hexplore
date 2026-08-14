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

// --- The Settings rail, and what is behind each of its tabs -----------------------
//
// The same class of bug as the one above, one floor up. Settings is a rail in
// the markup, a list of keys in src/settings-ui.js and a bag of sections passed
// from src/main.js, and nothing checks that the three agree — so a tab renamed
// in one of them is a rail entry that opens nothing, with no error anywhere and
// a pane that simply never appears.
//
// Three lists, and all three have to match.

console.log('\nThe Settings rail, the panes and the sections agree');

const shell = read('src/settings-ui.js');
const main = read('src/main.js');

// The rail, in markup order.
const railAt = html.indexOf('id="settings-tabs"');
const rail = html.slice(railAt, html.indexOf('id="settings-panes"'));
const tabs = [...rail.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
check(tabs.length >= 6, `the rail has ${tabs.length} tabs`);

// Every tab needs a pane, and every pane needs a tab. Panes are matched by id
// rather than by attribute, because `aria-controls` is the thing most likely to
// be the one left behind by a rename.
const panes = [...html.matchAll(/<section class="settings-pane" id="pane-([^"]+)"/g)].map((m) => m[1]);
{
  const orphanTabs = tabs.filter((t) => !panes.includes(t));
  check(orphanTabs.length === 0, 'every tab has a pane', orphanTabs.join(', '));
  const orphanPanes = panes.filter((p) => !tabs.includes(p));
  check(orphanPanes.length === 0, 'and every pane has a tab', orphanPanes.join(', '));
}

// The shell's own list, which is what decides the order and which two are for
// an admin only.
{
  const listAt = shell.indexOf('const TABS = [');
  const list = shell.slice(listAt, shell.indexOf('];', listAt));
  const keys = [...list.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  check(keys.join(',') === tabs.join(','), 'the shell knows the same tabs, in the same order',
    `${keys.join(',')} vs ${tabs.join(',')}`);
  // The shell looks these up by id, so a tab whose button id does not follow the
  // convention is a tab that can never be selected.
  const missing = keys.filter((k) => !html.includes(`id="settings-tab-${k}"`));
  check(missing.length === 0, 'and every one of them has a button it can find by id', missing.join(', '));
}

// And main.js has to hand a section in for each. A missing one is not an error —
// the shell tolerates it — which is exactly why it needs checking here: the pane
// would open, be empty, and never draw.
{
  const at = main.indexOf('sections: {');
  const block = main.slice(at, main.indexOf('},', at));
  // `key: value` and the shorthand `key,` both count — a section whose handle
  // happens to be named after its tab is written the short way, and reading
  // only the long one would call it missing.
  const given = [...block.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1]).filter((k) => k !== 'sections');
  const missing = tabs.filter((t) => !given.includes(t));
  check(missing.length === 0, 'and main.js hands a section in for each', missing.join(', '));
}

// Buttons a pane declares for the footer. They are *moved* out of the pane at
// runtime, so a listener attached by id at mount is the only thing that keeps
// working — one attached by walking the pane would break the first time the tab
// is left. Checking they are listened to at all is the weakest rule that catches
// a button left behind by a rename.
{
  // To the end of the section rather than to the next `</div>`: the row can hold
  // a note element of its own, and matching the first closing tag would stop
  // inside it and quietly find no buttons at all. It is the last thing in every
  // pane, so the section's own end is the honest boundary.
  const paneButtons = html.split('<div class="pane-actions">').slice(1)
    .flatMap((rest) => [...rest.slice(0, rest.indexOf('</section>'))
      .matchAll(/<button[^>]*\sid="([^"]+)"/g)].map((b) => b[1]));
  check(paneButtons.length >= 3, `${paneButtons.length} buttons sit in a pane's footer row`);
  const deafButtons = paneButtons.filter((id) => !listened(id));
  check(deafButtons.length === 0, 'and every one of them is listened to by id', deafButtons.join(', '));
}

// The Sync folds, which are the same rule one floor down. Each fold's form
// keeps its own buttons at the foot of the fold rather than in the pane's
// footer — Connect, Sync now, Disconnect, Save, Refresh — and each of them
// belonged to a dialog until recently. A button left behind by that move is a
// button that draws, sits there, and does nothing.
{
  const folds = [...html.matchAll(/<button[^>]*\sdata-fold="([^"]+)"/g)].map((m) => m[1]);
  check(folds.length === 3, `${folds.length} connectors fold open in the Sync tab`, folds.join(','));
  // The shell's own list has to name the same three, or a heading opens nothing.
  const syncSrc = read('src/sync-ui.js');
  const at = syncSrc.indexOf('const forms = {');
  // Keys only: an entry begins after the `{` or a comma, so `ha: homeAssistant`
  // contributes `ha` and not the handle it is bound to.
  const names = [...syncSrc.slice(at, syncSrc.indexOf('};', at)).matchAll(/[{,]\s*(\w+)/g)].map((m) => m[1]);
  const unknown = folds.filter((f) => !names.includes(f));
  check(unknown.length === 0, 'and src/sync-ui.js has a form for each', unknown.join(', '));

  const foldButtons = html.split('<div class="sync-fold-actions">').slice(1)
    .flatMap((rest) => [...rest.slice(0, rest.indexOf('</div>'))
      .matchAll(/<button[^>]*\sid="([^"]+)"/g)].map((b) => b[1]));
  check(foldButtons.length >= 5, `${foldButtons.length} buttons sit at the foot of a fold`);
  const deafFolds = foldButtons.filter((id) => !listened(id));
  check(deafFolds.length === 0, 'and every one of them is listened to by id', deafFolds.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
