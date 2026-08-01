// What one visit is.
//
// `hits` is the number the heat map ramps on and the number the card prints, and
// it is the easiest thing in this codebase to get quietly wrong, because every
// wrong answer is still a plausible integer. It used to count *arrivals* —
// fixes more than an hour apart — which meant a coffee run out and back counted
// twice and a week at home counted every time the phone woke up after an hour's
// silence. One cell of a real map held 1,837 of those against 103 actual stays.
//
// It now counts stays: fixes go on being one visit until a whole day passes with
// none (`VISIT_GAP_SEC`). The cases below pin that from both directions — what
// has to merge into one visit, and what has to stay separate — plus the
// fallback for files that carry no clock at all.
//
//   node scripts/test/visits.mjs

import { pointsToCells, VISIT_GAP_SEC } from '../../src/locations.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// One spot, so every fixture lands in a single cell and `hits` is the only
// thing under test. Somewhere unambiguous and inland.
const HERE = { lat: 47.3769, lng: 8.5417 }; // Zürich
const T = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const at = (...times) => times.map((t) => ({ ...HERE, t }));
const visits = (points) => {
  const cells = pointsToCells(points);
  return cells.length === 1 ? cells[0].hits : `${cells.length} cells`;
};

const HOUR = 3600;
const DAY = 86_400;

console.log('a visit is a stay, not an arrival');

check(VISIT_GAP_SEC === DAY, 'the gap that separates two visits is a day', String(VISIT_GAP_SEC));

{
  // The workout case: one point per second for ten minutes.
  const t0 = T('2026-03-01T09:00:00Z');
  const run = at(...Array.from({ length: 600 }, (_, i) => t0 + i));
  check(visits(run) === 1, 'ten minutes of 1 Hz recording is one visit', String(visits(run)));
}

{
  // The case that motivated the change: out in the morning, back in the evening.
  const t0 = T('2026-03-01T08:00:00Z');
  check(visits(at(t0, t0 + 10 * HOUR)) === 1, 'a morning and an evening in the same place is one visit');
}

{
  // A week living somewhere, sampled twice a day.
  const t0 = T('2026-03-01T08:00:00Z');
  const week = [];
  for (let d = 0; d < 7; d++) week.push(t0 + d * DAY, t0 + d * DAY + 11 * HOUR);
  check(visits(at(...week)) === 1, 'a week living there is one visit', String(visits(at(...week))));
}

{
  // …and going back later is a second one.
  const t0 = T('2026-03-01T08:00:00Z');
  check(visits(at(t0, t0 + 30 * DAY)) === 2, 'going back a month later is a second visit');
  check(visits(at(t0, t0 + 30 * DAY, t0 + 60 * DAY)) === 3, 'and again is a third');
}

console.log('\nthe boundary is exactly a day');

{
  const t0 = T('2026-03-01T08:00:00Z');
  check(visits(at(t0, t0 + DAY)) === 1, 'a gap of exactly a day is still one visit');
  check(visits(at(t0, t0 + DAY + 1)) === 2, 'a second more is two');
  check(visits(at(t0, t0 + DAY - 1)) === 1, 'a second less is one');
}

console.log('\nfixtures with no clock fall back to run length');

{
  // No timestamps at all: all we know is the order the file listed them, so an
  // unbroken run through the cell counts once. Two points elsewhere in between
  // make it two runs, and therefore two visits.
  const ELSEWHERE = { lat: 46.9, lng: 7.44, t: 0 }; // Bern, a different cell
  const noClock = [
    { ...HERE, t: 0 }, { ...HERE, t: 0 },
    ELSEWHERE,
    { ...HERE, t: 0 },
  ];
  const cells = pointsToCells(noClock);
  const here = cells.find((c) => c.fixes === 3);
  check(here?.hits === 2, 'two passes through a cell with no dates are two visits', String(here?.hits));
  check(cells.length === 2, 'and the fixtures really did land in two cells', String(cells.length));
}

console.log('\nfixes are counted separately, and are not visits');

{
  const t0 = T('2026-03-01T09:00:00Z');
  const [cell] = pointsToCells(at(t0, t0 + 1, t0 + 2, t0 + 30 * DAY));
  check(cell.fixes === 4, 'every raw point is a fix', String(cell.fixes));
  check(cell.hits === 2, 'but they are two visits', String(cell.hits));
  check(cell.first === t0 && cell.last === t0 + 30 * DAY, 'and the span covers both ends');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
