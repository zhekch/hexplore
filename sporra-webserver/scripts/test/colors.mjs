// The colour maths behind the picker, now that a colour can carry an opacity.
//
// Eight-digit hex is the kind of change that breaks things a long way from
// where it was made: everything that takes a colour *apart* — the blob
// painter's fill style, the route line mixes, the region outline — reads three
// channels out of a string, and a fourth pair silently shifts every one of them
// by eight bits. Blue becomes green and nobody's test says so.
//
// So the contract is pinned here: reading a colour never sees its opacity,
// reading an opacity defaults to opaque, and a colour that is fully opaque is
// still written the way every stored value already is.
//
//   node scripts/test/colors.mjs

import { hexToRgb, hexAlpha, hexOpaque, rgbToHex, rgbToHsv, hsvToRgb } from '../../src/color-picker.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nreading a colour');
check(same(hexToRgb('#60acff'), [96, 172, 255]), 'six digits', JSON.stringify(hexToRgb('#60acff')));
// The one that matters: the same colour with an opacity on it is the same
// colour. Parsing eight digits as one number and shifting by 16 would answer
// [172, 255, 128] here — a different colour entirely.
check(same(hexToRgb('#60acff80'), [96, 172, 255]), 'eight digits are the same colour',
  JSON.stringify(hexToRgb('#60acff80')));
check(same(hexToRgb('#60acff00'), [96, 172, 255]), 'even at zero opacity',
  JSON.stringify(hexToRgb('#60acff00')));
check(same(hexToRgb('6ac'), [102, 170, 204]), 'shorthand is expanded', JSON.stringify(hexToRgb('6ac')));
check(same(hexToRgb('6ac8'), [102, 170, 204]), 'and four-digit shorthand', JSON.stringify(hexToRgb('6ac8')));
check(hexToRgb('#60acf') === null, 'five digits is not a colour');
check(hexToRgb('#60acff8') === null, 'nor is seven');
check(hexToRgb('#60acff800') === null, 'nor nine');
check(hexToRgb('rebeccapurple') === null && hexToRgb('') === null && hexToRgb(null) === null,
  'nor anything that is not hex');

console.log('\nreading an opacity');
check(hexAlpha('#60acff') === 1, 'a colour without one is opaque', String(hexAlpha('#60acff')));
check(hexAlpha('#60acff00') === 0, 'and one written as zero is not', String(hexAlpha('#60acff00')));
check(hexAlpha('#60acffff') === 1, 'ff is full');
check(Math.abs(hexAlpha('#60acff80') - 128 / 255) < 1e-9, 'half is half', String(hexAlpha('#60acff80')));
check(hexAlpha('#6ac8') === hexAlpha('#66aacc88'), 'shorthand means the same as the long form',
  `${hexAlpha('#6ac8')} vs ${hexAlpha('#66aacc88')}`);
// Everything stored before this feature existed is six digits, and every caller
// that hasn't been taught about opacity must keep seeing "fully there".
check(hexAlpha('') === 1 && hexAlpha(null) === 1 && hexAlpha(undefined) === 1,
  'and nothing at all is opaque, not invisible');

console.log('\ntaking the opacity off');
check(hexOpaque('#60acff80') === '#60acff', 'an opacity is dropped', hexOpaque('#60acff80'));
check(hexOpaque('#60acff') === '#60acff', 'a colour without one is unchanged');
check(hexOpaque('6ac') === '#66aacc', 'and shorthand comes back long', hexOpaque('6ac'));
// It is handed to MapLibre as a paint colour, so it must never come back as
// "undefined" or "" — a layer with an unparseable colour throws on addLayer.
check(hexOpaque('not a colour') === 'not a colour', 'nonsense is passed through, not turned into undefined',
  String(hexOpaque('not a colour')));

console.log('\nround trips');
for (const hex of ['#60acff', '#ff9147', '#000000', '#ffffff', '#7ee0a0']) {
  const rgb = hexToRgb(hex);
  check(rgbToHex(rgb) === hex, `${hex} survives rgb`, rgbToHex(rgb));
  const back = rgbToHex(hsvToRgb(rgbToHsv(rgb)));
  check(back === hex, `${hex} survives hsv`, back);
}
// Grey has no hue and full black has no saturation either; both used to be the
// shapes that broke a naive conversion.
check(same(rgbToHsv([0, 0, 0]).slice(0, 2), [0, 0]), 'black has no hue and no saturation');
check(rgbToHex(hsvToRgb([210, 0, 1])) === '#ffffff', 'and no saturation at full value is white',
  rgbToHex(hsvToRgb([210, 0, 1])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
