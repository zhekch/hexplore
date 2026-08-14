// Fifty colours, and how to hand them out so that no two things next to each
// other get the same one.
//
// Three callers, one problem: things that ought to be told apart, drawn in one
// colour. A stack of eleven ski runs down one piste is eleven lines the menu
// listing them cannot point at except one at a time (see showRouteStack in
// src/main.js); **Color each route** is that same answer left on; and *Random
// colors* is it one level up, where a map of six activities is six shades of the
// same orange until somebody sets five of them by hand.
//
// It lives on its own rather than in main.js because handing out N distinct
// colours from a fixed list is the sort of thing that is worth a test: the
// property that matters — no repeats until the palette runs out, and neighbours
// far apart — is invisible by inspection and easy to break by tidying.
//
// ## Where the fifty come from
//
// A golden-angle hue sweep: entry `i` sits at `137.508 × i` degrees, which is
// the arrangement that keeps every prefix of the sequence as evenly spread
// around the wheel as a sequence can be. Take the first three and they are a
// third of the wheel apart; take the first twenty and they are still spread.
// That is exactly the shape of the problem here, because these are always handed
// out from the front.
//
// Under that, four characters of saturation and lightness cycling — clear,
// deeper, bright, muted — so two entries that do land near each other in hue
// (which after a full turn they must) still differ in something else.
//
// Then two corrections, both because HSL is not a perceptual space and a naïve
// sweep looks broken rather than varied:
//
//   · **Lightness by hue.** Yellow at L=60 reads far brighter than blue at the
//     same number. Yellows and greens come down by up to 12, blues and violets
//     go up by up to 9.
//   · **Saturation by hue.** Greens and yellows turn neon several steps before
//     any other hue does — the first cut of this had four highlighter greens in
//     it — so 45°–165° comes down by 12 to 16.
//
// Written out rather than computed at import: these are looked at, and a list
// you can read is a list somebody can replace one entry of without having to
// understand the generator.
export const ROUTE_PALETTE = [
  '#df4949', '#45a160', '#c180ef', '#a49737', '#51c0d6',
  '#cb488f', '#69d345', '#6f6adc', '#df7b49', '#49ab87',
  '#e680ef', '#8da437', '#63a3e3', '#c9405c', '#56d761',
  '#956adc', '#dda73c', '#40b5b1', '#ed6ecd', '#6ca43d',
  '#6378e3', '#c74a38', '#56d78c', '#b65ed9', '#c1c133',
  '#4299bd', '#ec659d', '#49a43d', '#8b79e7', '#c77a38',
  '#5ae2c1', '#d54dcf', '#93c039', '#507fce', '#ec656f',
  '#42b35a', '#a96ce5', '#938139', '#63d8e3', '#d54da2',
  '#66c039', '#5055ce', '#eb805c', '#49bc87', '#d16ce5',
  '#879339', '#5caeeb', '#d3456e', '#46c847', '#8564d3',
];

// Every step that walks the whole palette before repeating — that is, every
// number under half of 50 that shares no factor with it. Stepping by one of
// these from any start visits all fifty entries, so a run of colours can never
// repeat until the fiftieth, and *which* of them is used is what makes two
// draws from the same palette look like two different sets rather than one set
// rotated.
const STRIDES = [3, 7, 9, 11, 13, 17, 19, 21, 23];

/**
 * `n` colours from the palette, walking it by `stride` from `start`.
 *
 * Distinct until the palette runs out, and after that it wraps rather than
 * running out of answers: fifty-one routes under one tap is not a case worth a
 * different behaviour, and the fifty-first sharing with the first is a far
 * better answer than no colour at all.
 */
export function paletteRun(n, { start = 0, stride = 1 } = {}) {
  const size = ROUTE_PALETTE.length;
  const step = STRIDES.includes(stride) ? stride : 1;
  const from = ((start % size) + size) % size;
  return Array.from({ length: Math.max(0, n) }, (_, i) => ROUTE_PALETTE[(from + i * step) % size]);
}

/**
 * A colour each for a set of things that already have identities — the routes
 * under one tap, or every route on the map.
 *
 * **Stable, and different for different sets.** The start and the step are
 * derived from the keys themselves, so the same stack of eleven runs comes up
 * in the same eleven colours every time you tap it (a menu that reshuffled
 * itself on reopening would be worse than one colour for all of them), and the
 * same map comes up the same way on the phone and on the laptop with nothing
 * synced but a switch — while a different stack elsewhere on the map gets a
 * different set.
 *
 * @param {Array<number|string>} keys route ids, in the order they are listed
 * @returns {Map<number|string, string>} key → hex
 */
export function paletteFor(keys) {
  const list = [...keys];
  // A cheap spread of the whole set, not of its first member: two stacks that
  // happen to start with the same route should still look different, and two
  // taps on the same stack must not.
  let seed = list.length;
  for (const k of list) {
    const s = String(k);
    for (let i = 0; i < s.length; i++) seed = (Math.imul(seed, 31) + s.charCodeAt(i)) >>> 0;
  }
  const colors = paletteRun(list.length, {
    start: seed % ROUTE_PALETTE.length,
    stride: STRIDES[seed % STRIDES.length],
  });
  return new Map(list.map((k, i) => [k, colors[i]]));
}

/**
 * A colour each, deliberately different from last time — what *Random colors*
 * hands out to the activities.
 *
 * Random where `paletteFor` is stable, and for the opposite reason: this one is
 * pressed *again* when the answer was not liked, so giving back the same answer
 * would make the button look broken. Only the start and the step are random —
 * the colours themselves still come out of the palette in its own order, so a
 * random set is still a spread one rather than three greens and a mustard.
 *
 * @param {number} n
 * @param {() => number} [rng] injectable for the tests
 */
export function randomPalette(n, rng = Math.random) {
  return paletteRun(n, {
    start: Math.floor(rng() * ROUTE_PALETTE.length),
    stride: STRIDES[Math.floor(rng() * STRIDES.length)],
  });
}

