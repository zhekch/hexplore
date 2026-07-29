// The two pieces of search that are decisions rather than plumbing: what counts
// as a date when someone types one, and how place names are ranked.
//
// Both are the kind of thing that looks obviously right and is quietly wrong —
// a date parser that reads "2024" as the 20th of some month swallows every text
// search containing a number, and a ranking that ignores size answers "bern"
// with a hamlet called Bernau.
//
//   node scripts/test/search.mjs

import { parseDateQuery } from '../../src/search-ui.js';
import { loadPlaces, searchPlaces } from '../../src/places.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

console.log('\ndates people type');
const d = (q) => parseDateQuery(q);
check(d('2024-08-12') === '2024-08-12', 'an ISO date');
check(d('2024-8-2') === '2024-08-02', 'and a sloppy one is padded', d('2024-8-2'));
check(d('12.08.2024') === '2024-08-12', 'day-first with dots', d('12.08.2024'));
check(d('12/08/2024') === '2024-08-12', 'day-first with slashes', d('12/08/2024'));
check(d('2024-08') === '2024-08', 'a month');
check(d('August 2024') === '2024-08', 'a month by name', d('August 2024'));
check(d('aug 2024') === '2024-08', 'abbreviated', d('aug 2024'));
check(d('2024') === '2024', 'a bare year');
check(d('Bern') === null, 'a place name is not a date');
check(d('') === null, 'nothing is not a date');
check(d('42') === null, 'a number that is not a year is not a date');
// The one that matters: reading a bare number as a day would make every text
// search containing one jump into the calendar.
check(d('1990') === '1990' && d('1889') === null, 'years are bounded', `${d('1889')}`);

console.log('\nplaces by name');
// Node can't import JSON without an attribute Vite dislikes, so the module
// takes the parsed data — the same door scripts/build-places.mjs uses.
await loadPlaces(JSON.parse(await readFile(path.join(ROOT, 'src', 'places.json'), 'utf8')));

const bern = searchPlaces('bern', 5);
check(bern.length > 0, 'something matches "bern"');
check(bern[0].name === 'Bern', 'the exact name comes first, not Bernau', bern.map((p) => p.name).join(', '));

const zurich = searchPlaces('zurich', 3);
check(zurich.some((p) => p.name.startsWith('Z') && /rich$/.test(p.name)), 'accents are folded — "zurich" finds Zürich', zurich.map((p) => p.name).join(', '));

const york = searchPlaces('york', 6);
check(york[0].name === 'York', 'the exact name wins outright', york.map((p) => p.name).join(', '));
// The case the ranking exists for: eight million people in a name that merely
// *contains* the query still outrank a village that happens to start with it.
// (GeoNames calls it New York City.)
const nyAt = york.findIndex((p) => p.name.startsWith('New York'));
const smallYorkAt = york.findIndex((p) => p.name.length > 4 && p.name.startsWith('York'));
check(nyAt >= 0, 'New York is offered for "york"', york.map((p) => p.name).join(', '));
check(smallYorkAt === -1 || nyAt < smallYorkAt, '…ahead of the small towns that merely start with it',
  york.map((p) => `${p.name} ${p.pop}k`).join(' | '));

const paris = searchPlaces('paris', 4);
check(paris[0].name === 'Paris' && paris[0].pop > 1000, 'size breaks ties — the big Paris first', `${paris[0].name} (${paris[0].pop}k)`);

check(searchPlaces('a', 5).length === 0, 'one letter is not a search');
check(searchPlaces('', 5).length === 0, 'nothing is not a search');
check(searchPlaces('zzzzqqqq', 5).length === 0, 'nonsense finds nothing');

const lake = searchPlaces('thun', 6);
check(lake.some((p) => p.kind === 'lake') || lake.some((p) => p.name === 'Thun'), 'lakes are searchable too', lake.map((p) => `${p.name}:${p.kind}`).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
