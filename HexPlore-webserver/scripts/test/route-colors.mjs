// The palette hands out colours that are actually different.
//
// The whole point of these is that no two rows in one menu — and no two
// activities on one map — share a colour, and that is a property nobody can see
// by reading the list. A stride that quietly shared a factor with fifty would
// hand out ten colours five times over and the code would look perfectly fine.
//
//   node scripts/test/route-colors.mjs

import { ROUTE_PALETTE, paletteFor, paletteRun } from '../../src/route-colors.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const distinct = (list) => new Set(list).size === list.length;

console.log('\nThe palette itself');
{
  check(ROUTE_PALETTE.length === 50, `fifty colours (${ROUTE_PALETTE.length})`);
  check(distinct(ROUTE_PALETTE), 'no colour is in it twice');
  check(ROUTE_PALETTE.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'every one is a six-digit hex');
}

console.log('\nA run of them');
{
  for (const stride of [3, 7, 9, 11, 13, 17, 19, 21, 23]) {
    const all = paletteRun(50, { start: 7, stride });
    check(distinct(all), `stride ${stride} walks all fifty before repeating`, `${new Set(all).size} distinct`);
  }
  check(paletteRun(0).length === 0, 'asking for none gives none');
  const over = paletteRun(53, { start: 3, stride: 7 });
  check(over.length === 53 && new Set(over).size === 50, 'past fifty it wraps rather than running out');
  check(paletteRun(4, { start: -1, stride: 7 }).every(Boolean), 'a negative start is still a colour');
}

console.log('\nOne colour each, for the routes under a tap');
{
  const ids = [4, 9, 11, 12, 40, 41, 42, 43, 44, 51, 77];
  const a = paletteFor(ids);
  check(a.size === ids.length, 'every route gets one');
  check(distinct([...a.values()]), 'and no two get the same');

  const again = paletteFor(ids);
  check(ids.every((id) => a.get(id) === again.get(id)), 'the same stack comes up in the same colours');

  // The one that matters for it reading as "these are different things": two
  // stacks that share their first route must not share their colours.
  const other = paletteFor([4, 9, 11, 12, 40, 41, 42, 43, 44, 51, 78]);
  check([...a.values()].join() !== [...other.values()].join(), 'a different stack gets a different set');

  const strings = paletteFor(['a', 'b', 'c']);
  check(strings.size === 3 && distinct([...strings.values()]), 'keys need not be numbers');
  check(paletteFor([]).size === 0, 'and no routes is no colours');
}

console.log('\nAnd a whole map of them, for "Color each route"');
{
  // What the switch actually asks for: a few hundred routes, all of them
  // coloured, nothing stored, and the same answer on the next device.
  const many = Array.from({ length: 320 }, (_, i) => i + 1);
  const all = paletteFor(many);
  check(all.size === many.length, 'every route on the map gets one');
  check(new Set([...all.values()]).size === 50, 'using the whole palette', `${new Set([...all.values()]).size} shades`);
  // Past fifty they must repeat, and the one thing that must not happen is two
  // routes *next to each other in the list* sharing — that is what makes a
  // braid of them readable.
  const run = many.map((id) => all.get(id));
  check(run.every((c, i) => i === 0 || c !== run[i - 1]), 'and never twice in a row');
  check([...all.values()].every((c) => ROUTE_PALETTE.includes(c)), 'nothing comes out that is not in the palette');
  check(many.every((id) => paletteFor(many).get(id) === all.get(id)), 'the same map comes up the same way twice');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
