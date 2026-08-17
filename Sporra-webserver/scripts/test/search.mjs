// The pieces of search that are decisions rather than plumbing: what counts as a
// date when someone types one, how names are folded so they can be typed on any
// keyboard, and how the answers are ranked.
//
// All of them are the kind of thing that looks obviously right and is quietly
// wrong — a date parser that reads "2024" as the 20th of some month swallows
// every text search containing a number, a ranking that ignores size answers
// "bern" with a hamlet called Bernau, and a fold applied to one dataset and not
// the next means "zurich" finds the town and not the canton.
//
//   node scripts/test/search.mjs

import { parseDateQuery, tripInPeriod, tripRelevance } from '../../src/search-ui.js';
import { loadPlaces, searchPlaces, nearestTown } from '../../src/places.js';
import { loadRegions, searchRegions } from '../../src/regions.js';
import { loadCountries, searchCountries } from '../../src/countries.js';
import { fold } from '../../src/fold.js';
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

// A date with no year in it. ISO 8601 already has a notation for exactly this
// ("--MM-DD"), and it is what lets "October 15" mean every October 15 you have
// rather than one arbitrary one.
console.log('\ndates with no year in them');
check(d('october 15') === '--10-15', 'month then day', d('october 15'));
check(d('15 october') === '--10-15', 'and day then month', d('15 october'));
check(d('oct 15') === '--10-15', 'abbreviated', d('oct 15'));
check(d('October 15, 2025') === '2025-10-15', 'a year anywhere in it pins the date', d('October 15, 2025'));
check(d('2025 october 15') === '2025-10-15', 'in any order', d('2025 october 15'));
check(d('2025 october') === '2025-10', 'year before month is still that month', d('2025 october'));
check(d('october') === '--10', 'a bare month is every October', d('october'));

// The strictness that keeps this from swallowing text searches. A month has to
// be spelled out — two bare numbers stay ambiguous forever — and an
// abbreviation only counts when exactly one month starts that way.
check(d('10 15') === null, 'two bare numbers are not a date', `${d('10 15')}`);
check(d('ju') === null, 'an ambiguous abbreviation is no month at all', `${d('ju')}`);
check(d('mar') === '--03', 'but an unambiguous one is', d('mar'));
check(d('october 32') === null, 'a day that month cannot have', `${d('october 32')}`);
check(d('february 30') === null, 'nor February the 30th', `${d('february 30')}`);
check(d('february 29') === '--02-29', 'though the 29th exists somewhere', d('february 29'));
check(d('october 2500') === null, 'a year outside the range is not one', `${d('october 2500')}`);
check(d('1 2 3 october') === null, 'and three numbers is nobody\u2019s date', `${d('1 2 3 october')}`);

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

console.log('\nthe place a point belongs to');
// The gazetteer reaches down to villages now, which is the only way it can name
// the valleys that have nothing bigger in them — the upper Engadin has no
// settlement over 5,000 people in it at all, and a day in St. Moritz used to be
// named after Chur, an hour's drive away.
const moritz = nearestTown(9.838, 46.498);
check(moritz?.name === 'St. Moritz', 'a village that is the only name for miles is in the dataset',
  `${moritz?.name} (${moritz?.pop}k, ${Math.round((moritz?.distM ?? 0) / 100) / 10} km)`);

// …and a district is not a place. GeoNames lists a dozen Lisbon parishes and a
// dozen Zürich Kreise beside the cities they are part of, each with its own
// population, so an afternoon in one used to answer "Lumiar" or "Zürich (Kreis
// 9) / Altstetten". A place with a neighbour five times its size within twelve
// kilometres is a piece of that neighbour and takes its name.
// Two mechanisms hold this up — the build drops GeoNames' PPLX "sections", and
// the lookup folds a small place into a much bigger neighbour — so these check
// the contract rather than either rule: a point inside a city answers with the
// city, whichever of the two got it there. (Lisbon's parishes are plain PPL
// entries, so only the second rule can catch that one.)
const altstetten = nearestTown(8.489, 47.391); // Zürich, Kreis 9
check(altstetten?.name === 'Zürich', 'a point in a city district answers with the city', altstetten?.name);
const lumiar = nearestTown(-9.157, 38.775); // a parish of Lisbon
check(lumiar?.name === 'Lisbon', 'and one in a city parish with the city', lumiar?.name);
// The rule has to leave real towns alone, which is the whole reason it is
// bounded by distance as well as by size. These two are far enough from the
// nearest city to be themselves.
const zermatt = nearestTown(7.748, 46.021);
check(zermatt?.name === 'Zermatt', 'a real village keeps its own name', zermatt?.name);
check(nearestTown(9.838, 46.498)?.name === 'St. Moritz',
  'and so does one with a much bigger town an hour away', nearestTown(9.838, 46.498)?.name);
// Nothing within 30 km is still nothing: the middle of an ocean has no town.
check(nearestTown(-30, 40) === null, 'and the open Atlantic has none at all');

console.log('\nnames typed on the keyboard you have');
// Both sides of every comparison go through this, which is the whole point:
// applying it to the town dataset and not the region one is exactly how
// "zurich" came to find the town and not the canton it is in.
check(fold('Zürich') === 'zurich', 'an umlaut folds', fold('Zürich'));
check(fold('Québec') === 'quebec', 'and an accent', fold('Québec'));
// The half that NFD cannot do: these are their own letters, not marked-up ones.
check(fold('Weißenfels') === 'weissenfels', 'ß is spelled out', fold('Weißenfels'));
check(fold('Tromsø') === 'tromso', 'and ø', fold('Tromsø'));
check(fold('Łódź') === 'lodz', 'and ł', fold('Łódź'));
check(fold('St. Moritz') === 'st moritz', 'punctuation is a gap between words', fold('St. Moritz'));
check(fold('  Bern  ') === 'bern', 'and so is the space around it', `"${fold('  Bern  ')}"`);
// Not ASCII-only: a few dozen gazetteer names are in another script, and
// folding those to nothing would make them unreachable rather than easier.
check(fold('Москва') === 'москва', 'another script keeps its letters', fold('Москва'));

console.log('\nregions and countries by name');
await loadRegions(JSON.parse(await readFile(path.join(ROOT, 'src', 'regions.json'), 'utf8')));
await loadCountries(JSON.parse(await readFile(path.join(ROOT, 'src', 'countries.json'), 'utf8')));

const canton = searchRegions('zurich', 3);
check(canton[0]?.name === 'Zürich', 'the canton answers to "zurich"', canton.map((r) => r.name).join(', '));
check(canton[0]?.id === 'Switzerland/Zürich', '…and carries its id, so the map can draw the shape', canton[0]?.id);
check(canton[0]?.bbox?.length === 4, '…and its box, to frame it with', JSON.stringify(canton[0]?.bbox));
check(searchRegions('quebec', 1)[0]?.name === 'Québec', 'and so does Québec', searchRegions('quebec', 1)[0]?.name);
check(searchCountries('curacao', 1)[0]?.id === 'Curaçao', 'countries fold too', searchCountries('curacao', 1)[0]?.id);
check(searchRegions('z', 3).length === 0, 'one letter is not a search');

// The scan used to stop at 400 hits *before* sorting, which answered a broad
// query with the first 400 rows of the file rather than the best matches in it.
const BROAD = 'al';
const regionData = JSON.parse(await readFile(path.join(ROOT, 'src', 'regions.json'), 'utf8'));
const starts = regionData.filter((r) => fold(r.name).startsWith(BROAD));
const shortest = Math.min(...starts.map((r) => r.name.length));
const best = new Set(starts.filter((r) => r.name.length === shortest).map((r) => r.name));
check(starts.length > 3 && best.has(searchRegions(BROAD, 1)[0]?.name),
  'a broad query is ranked over every match, not over the first few hundred',
  `${searchRegions(BROAD, 1)[0]?.name} vs ${[...best].join('/')}`);

console.log('\nwhich trip a query means');
// The case this exists for: a fortnight actually spent in Zürich came out below
// a weekend in St. Moritz that had merely driven through it, because matches
// were sorted by date and nothing else.
const zh = { name: 'Zürich, Switzerland', place: 'Zürich', region: 'Zürich', country: 'Switzerland', tags: ['Zürich'] };
const sm = { name: 'St. Moritz, Switzerland', place: 'St. Moritz', region: 'Graubünden', country: 'Switzerland', tags: ['Zürich', 'Chur'] };
const wi = { name: 'Winterthur, Switzerland', place: 'Winterthur', region: 'Zürich', country: 'Switzerland', tags: [] };
const zq = fold('zurich');
check(tripRelevance(zh, zq) < tripRelevance(wi, zq), 'named for the place beats merely being in it',
  `${tripRelevance(zh, zq)} vs ${tripRelevance(wi, zq)}`);
check(tripRelevance(wi, zq) < tripRelevance(sm, zq), '…and being in it beats having passed through',
  `${tripRelevance(wi, zq)} vs ${tripRelevance(sm, zq)}`);
check(tripRelevance(sm, fold('reykjavik')) === Infinity, 'and no match is no match');
check(tripRelevance(zh, '') === 0 && tripRelevance(sm, '') === 0,
  'nothing typed ranks nothing — the list keeps the sort you chose');

// A typed month or year answers with the trips inside it, and a trip is a span
// rather than a date — so the question is whether the two overlap. The case
// that decides it is the fortnight that starts in one month and ends in the
// next: it belongs to both, because you were away in both.
console.log('\nthe trips a month or a year contains');
{
  const at = (s) => Math.floor(new Date(`${s}T12:00:00`).getTime() / 1000);
  const trip = (a, b) => ({ start: at(a), end: at(b) });
  const august = trip('2023-08-03', '2023-08-11');
  const across = trip('2023-08-28', '2023-09-09');
  const later = trip('2024-02-01', '2024-02-05');

  check(tripInPeriod(august, '2023-08'), 'a fortnight inside the month is in it');
  check(!tripInPeriod(august, '2023-09'), '…and not in the next one');
  check(tripInPeriod(across, '2023-08') && tripInPeriod(across, '2023-09'),
    'one that runs from one month into the next is in both');
  check(tripInPeriod(august, '2023') && tripInPeriod(across, '2023'),
    'a bare year holds every month of it');
  check(!tripInPeriod(later, '2023') && tripInPeriod(later, '2024'),
    'and holds nothing from another year');
  // The boundary the string comparison has to get right: December against the
  // year it is in, and January against the year before it.
  check(tripInPeriod(trip('2023-12-30', '2024-01-02'), '2023')
    && tripInPeriod(trip('2023-12-30', '2024-01-02'), '2024'),
    'new year at midnight is in both years');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
