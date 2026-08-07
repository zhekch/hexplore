// One spelling of a name, for everything that has to match one against another.
//
// A search box is typed on whatever keyboard is to hand, and this map is full of
// names that want a keyboard nobody has: Zürich, Łódź, Tromsø, Ålesund,
// Weißenfels. So both sides of every comparison are folded to the same plain
// form before they meet — which is the difference between "zurich" finding the
// canton and "zurich" finding nothing but the town, because the town dataset
// happened to fold and the region dataset did not.
//
// Two steps, and the second is the one that is easy to leave out. NFD takes the
// accents off letters that *have* accents; it does nothing at all for the
// letters that are their own letter rather than a marked-up one — ø is not o
// with a stroke as far as Unicode is concerned, and ß is not ss. Those are
// spelled out by hand.

// What a keyboard without them types instead. Every one of these appears in the
// shipped gazetteers: ı and ə across Turkey and Azerbaijan, ł in Poland, ø and
// ð across the north, đ and ħ around the Adriatic and Malta.
const SPELLED = {
  ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', ð: 'd', þ: 'th',
  đ: 'd', ł: 'l', ı: 'i', ħ: 'h', ə: 'e', ŋ: 'n',
};

/**
 * Fold a name (or a query) to the form both sides are compared in.
 *
 * Deliberately not ASCII-only. A handful of gazetteer names are Cyrillic or
 * Arabic, and folding a script away entirely would make those places
 * unreachable rather than easier to type — so anything that is a letter or a
 * digit in *any* script survives, and only the punctuation between words goes.
 */
export const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßøæœðþđłıħəŋ]/g, (c) => SPELLED[c])
    // Whatever separates two words is one space, so "St.Moritz", "St. Moritz"
    // and "st moritz" are the same three syllables typed three ways.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * How well a folded name answers a folded query: 0 for the whole name, 1 for a
 * name that starts with it, 2 for one that merely contains it, and -1 for no
 * match at all. The one ordering every list of names here agrees on.
 */
export function matchRank(name, q) {
  const at = name.indexOf(q);
  if (at < 0) return -1;
  return name.length === q.length ? 0 : at === 0 ? 1 : 2;
}
