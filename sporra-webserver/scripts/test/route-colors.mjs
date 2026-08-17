// The palette hands out colours that are actually far apart.
//
// *Different* was the first version of this test and it was the wrong property:
// two routes under one tap came back as two shades of blue, fifty distinct
// colours in the palette notwithstanding, because a fixed step through a
// golden-angle sweep can land twelve degrees from where it started. What has to
// hold is the separation — two things opposite, three a triangle, and no two
// neighbours in a list near each other — and none of that can be seen by reading
// the list of hexes.
//
//   node scripts/test/route-colors.mjs

import { ROUTE_PALETTE, paletteFor, randomPalette } from '../../src/route-colors.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const distinct = (list) => new Set(list).size === list.length;

// The same arithmetic the module does, written out again rather than imported:
// a test that shares its subject's maths cannot catch its subject's maths.
const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};
const gap = (a, b) => {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return d > 180 ? 360 - d : d;
};
const worstPair = (list) => {
  let worst = 360;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) worst = Math.min(worst, gap(list[i], list[j]));
  }
  return worst;
};
const worstNeighbour = (list) => Math.min(...list.slice(1).map((c, i) => gap(list[i], c)));

console.log('\nThe palette itself');
{
  check(ROUTE_PALETTE.length === 50, `fifty colours (${ROUTE_PALETTE.length})`);
  check(distinct(ROUTE_PALETTE), 'no colour is in it twice');
  check(ROUTE_PALETTE.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'every one is a six-digit hex');
  // Nothing below can hand out a spread the palette does not hold.
  const hues = ROUTE_PALETTE.map(hueOf).sort((a, b) => a - b);
  const widest = Math.max(...hues.map((h, i) => (i ? h - hues[i - 1] : h + 360 - hues[hues.length - 1])));
  check(widest < 20, `and no gap in the wheel wider than 20° (${widest.toFixed(1)}°)`);
}

console.log('\nTwo of anything are opposites');
{
  // The report this was written for: click two routes, get two blues.
  const pairs = [[1, 2], [7, 9], [104, 3005], ['a', 'b'], [42, 43]];
  for (const ids of pairs) {
    const two = [...paletteFor(ids).values()];
    check(gap(two[0], two[1]) > 150,
      `${JSON.stringify(ids)} → ${two.join(' and ')}`, `only ${gap(two[0], two[1]).toFixed(0)}° apart`);
  }
}

console.log('\nAnd more than two are spread around the wheel');
{
  for (const n of [3, 4, 5, 6, 8, 12]) {
    const ids = Array.from({ length: n }, (_, i) => i * 7 + 3);
    const set = [...paletteFor(ids).values()];
    // What a wheel divided n ways allows, less what the palette's own gaps cost.
    const want = 360 / n - 12;
    check(worstPair(set) >= want,
      `${n} routes sit at least ${want.toFixed(0)}° apart (${worstPair(set).toFixed(0)}°)`);
    // …and consecutive rows are not merely different but obviously so, which is
    // what a list read top to bottom needs and a spread in hue order does not
    // give: twelve of those would be thirty degrees a step.
    //
    // 80° rather than something rounder because four colours ninety degrees
    // apart cannot do better than ninety, whatever order they are handed out in
    // — one pair of neighbours has to be adjacent on the wheel.
    check(worstNeighbour(set) > 80,
      `and no two in a row are close (${worstNeighbour(set).toFixed(0)}°)`);
  }
}

console.log('\nOne colour each, for the routes under a tap');
{
  const ids = [4, 9, 11, 12, 40, 41, 42, 43, 44, 51, 77];
  const a = paletteFor(ids);
  check(a.size === ids.length, 'every route gets one');
  check(distinct([...a.values()]), 'and no two get the same');

  const again = paletteFor(ids);
  check(ids.every((id) => a.get(id) === again.get(id)), 'the same stack comes up in the same colours');

  // Different stacks often get different sets, and "often" is the honest word —
  // it used to be "always", and that was bought with the fault this palette was
  // rewritten for. All that varies between two stacks now is where on the wheel
  // their spread begins; the palette is about seven degrees coarse, so two
  // starts landing within that of each other choose the same eleven entries and
  // come out identical. Being spread as far apart as the wheel allows is what
  // anybody is actually looking at, and two stacks are never looked at together.
  const sets = new Set(Array.from({ length: 20 }, (_, i) =>
    [...paletteFor([4, 9, 11, 12, 40, 41, 42, 43, 44, 51, 78 + i]).values()].join()));
  check(sets.size >= 8, `twenty different stacks give ${sets.size} different sets`);

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

console.log('\nAnd the ones "Random colors" hands the activities');
{
  // A fixed sequence, so "random" can be checked at all.
  const feed = (...ns) => { let i = 0; return () => ns[i++ % ns.length]; };
  const six = randomPalette(6, feed(0.02, 0.61));
  check(six.length === 6 && distinct(six), 'six activities, six colours');

  const first = randomPalette(6, feed(0.1, 0.1));
  const second = randomPalette(6, feed(0.7, 0.8));
  check(first.join() !== second.join(), 'pressing it again gives a different set');

  check(randomPalette(1, feed(0.5, 0.5)).length === 1, 'one activity is still a colour');
  check(randomPalette(50, feed(0.33, 0.44)).every((c) => ROUTE_PALETTE.includes(c)),
    'and nothing comes out that is not in the palette');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
