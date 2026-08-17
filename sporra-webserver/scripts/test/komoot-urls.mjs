// Pulling tour links out of whatever gets pasted in.
//
// The field takes many links now, and "many links" in practice means a column
// copied out of a spreadsheet, a chat log with the links inside sentences, or
// a row of URLs separated by spaces. All three have to work, and none of them
// may invent a tour that wasn't there.
//
//   node scripts/test/komoot-urls.mjs

import { parseKomootUrls } from '../../src/komoot.js';

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ids = (text) => parseKomootUrls(text).map((r) => r.id);

const A = 'https://www.komoot.com/tour/2504447881';
const B = 'https://www.komoot.com/tour/1111111111';
const C = 'https://www.komoot.de/de-de/tour/2222222222';

eq(ids(A), ['2504447881'], 'a single link still works');
eq(ids(`${A}\n${B}\n${C}`), ['2504447881', '1111111111', '2222222222'], 'one per line');
eq(ids(`${A} ${B}`), ['2504447881', '1111111111'], 'separated by spaces');
eq(ids(`${A},${B}`), ['2504447881', '1111111111'], 'comma separated');
eq(
  ids(`did these two: ${A} and then ${B}. good day`),
  ['2504447881', '1111111111'],
  'links buried in a sentence, trailing full stop trimmed',
);
eq(ids(`${A}\n\n\n  ${B}   \n`), ['2504447881', '1111111111'], 'blank lines and stray whitespace');

// The share token is the only way a private tour can be fetched, so when the
// same tour appears both ways the tokened one has to survive.
const withToken = `${A}?share_token=aXo39MsKB9NEk118&ref=profile`;
eq(ids(`${A}\n${withToken}`), ['2504447881'], 'the same tour twice is one tour');
eq(
  parseKomootUrls(`${A}\n${withToken}`)[0].shareToken,
  'aXo39MsKB9NEk118',
  'the copy carrying a share token wins',
);
eq(
  parseKomootUrls(`${withToken}\n${A}`)[0].shareToken,
  'aXo39MsKB9NEk118',
  '…in either order',
);

// Nothing invented.
eq(ids(''), [], 'empty text');
eq(ids('just some notes about my weekend'), [], 'prose with no links');
eq(ids('https://www.strava.com/activities/123456789'), [], 'a Strava link is not a Komoot tour');
eq(ids('https://www.komoot.com/user/4003394184850'), [], 'a profile link is not a tour');
eq(ids(`${A}\nhttps://www.komoot.com/discover`), ['2504447881'], 'one good link among junk');

// A bare id is still accepted when that is all there is.
eq(ids('2504447881'), ['2504447881'], 'a bare tour id');
eq(ids('2504447881 1111111111'), ['2504447881', '1111111111'], 'bare ids, several');

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
