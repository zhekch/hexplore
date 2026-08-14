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

// --- Picking a set out of it --------------------------------------------------
//
// Distinct is not the same as *far apart*, and the difference is the whole of
// what this section is for. Handing out the palette by walking it at a fixed
// step gives fifty different answers and no promise about any of them: step by
// 13 and each entry lands 13 × 137.5° = 347.6° along, which is twelve degrees of
// hue from where it started. Two routes under one tap came out as two shades of
// blue, both technically different colours, and that is not what a colour is
// being asked to say here.
//
// So a set is chosen by *hue*: n entries as near as this palette can get to
// 360/n apart. Two things get opposites, three get a triangle, twelve get every
// thirtieth degree — and nothing has to be true of the palette's order for that
// to hold.
const HUES = ROUTE_PALETTE.map((hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
});

/** How far apart two hues are, the short way round. */
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * `n` colours whose hues are as evenly spread around the wheel as this palette
 * allows, starting from `startHue`.
 *
 * Greedy and tiny — fifty entries against at most fifty targets — and it takes
 * the *nearest unused* entry to each target rather than the nearest, so a hue
 * the palette is thin around cannot be handed out twice while its neighbour goes
 * unused.
 */
function spreadOfHues(n, startHue) {
  const want = Math.max(0, Math.min(n, ROUTE_PALETTE.length));
  const taken = new Set();
  const out = [];
  for (let k = 0; k < want; k++) {
    const target = (((startHue + (k * 360) / want) % 360) + 360) % 360;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < HUES.length; i++) {
      if (taken.has(i)) continue;
      const gap = hueGap(HUES[i], target);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    taken.add(best);
    out.push(ROUTE_PALETTE[best]);
  }
  return out;
}

/**
 * The order to hand a spread out in, so that *neighbours* are far apart too.
 *
 * A set spread evenly by hue and handed out in hue order is a rainbow ramp: item
 * one and item two are 360/n apart, which for a stack of twelve is thirty
 * degrees and reads as "two blues" all over again — while item one and item
 * seven, which nobody is comparing, are opposites.
 *
 * A fixed step through the ring is the obvious answer and it is not enough: the
 * step has to be coprime with n or it does not visit everything, and for n = 6
 * the only coprime steps are 1 and 5, which are the rainbow ramp forwards and
 * backwards. What works for every n is placing them one at a time, each time
 * taking the position furthest from everything placed so far — and, where
 * several are equally far, the one furthest from the one just placed. That
 * second rule is not a tie-break for tidiness: without it n = 6 comes out as
 * 0,3,1,2,… and two of the six sit next to each other on the wheel *and* in the
 * list, which is the whole fault this is here to avoid.
 */
function weaveOrder(m) {
  const ring = (a, b) => {
    const d = Math.abs(a - b) % m;
    return Math.min(d, m - d);
  };
  const order = [0];
  const left = new Set(Array.from({ length: m - 1 }, (_, i) => i + 1));
  while (left.size) {
    let best = -1;
    let bestNear = -1;
    let bestLast = -1;
    for (const i of left) {
      const near = Math.min(...order.map((p) => ring(i, p)));
      const last = ring(i, order[order.length - 1]);
      if (near > bestNear || (near === bestNear && last > bestLast)) {
        best = i;
        bestNear = near;
        bestLast = last;
      }
    }
    left.delete(best);
    order.push(best);
  }
  return order;
}

/** `n` colours, spread by hue and ordered so that neighbours are far apart. */
function pickColors(n, startHue) {
  const want = Math.max(0, n);
  const m = Math.min(want, ROUTE_PALETTE.length);
  if (!m) return [];
  const spread = spreadOfHues(m, startHue);
  const order = weaveOrder(m);
  // Past fifty it wraps rather than running out of answers: the fifty-first
  // route sharing with the first is a far better answer than no colour at all,
  // and it is still never the same as its neighbour.
  return Array.from({ length: want }, (_, i) => spread[order[i % m]]);
}

/**
 * A colour each for a set of things that already have identities — the routes
 * under one tap, or every route on the map.
 *
 * **Stable, and different for different sets.** Only where on the wheel the
 * spread begins is derived from the keys, so the same stack of eleven runs comes
 * up in the same eleven colours every time you tap it (a menu that reshuffled
 * itself on reopening would be worse than one colour for all of them), and the
 * same map comes up the same way on the phone and on the laptop with nothing
 * synced but a switch — while a different stack elsewhere on the map gets a
 * different set. What does *not* vary is how far apart they are: that is the
 * point of them.
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
  const colors = pickColors(list.length, seed % 360);
  return new Map(list.map((k, i) => [k, colors[i]]));
}

/**
 * A colour each, deliberately different from last time — what *Random colors*
 * hands out to the activities.
 *
 * Random where `paletteFor` is stable, and for the opposite reason: this one is
 * pressed *again* when the answer was not liked, so giving back the same answer
 * would make the button look broken. What is random is only where on the wheel
 * the spread starts — six activities are six hues sixty degrees apart either
 * way, just a different six.
 *
 * @param {number} n
 * @param {() => number} [rng] injectable for the tests
 */
export function randomPalette(n, rng = Math.random) {
  return pickColors(n, rng() * 360);
}

