// Where the sun is, which the 3D basemap's Auto light preset is chosen from.
//
// Three things here can be wrong in ways nobody would notice for months, and
// they are what this checks:
//
//   - the astronomy. It is forty lines of trigonometry copied from an almanac,
//     and a sign error in it produces answers that are plausible all day and
//     wrong by an hour. The two solstices are the check that needs no second
//     source: at noon the sun stands at 90° − |latitude| ± 23.44°, on paper,
//     for every place on Earth.
//   - dawn against dusk. They are the same elevation on opposite sides of noon,
//     so a comparison written the wrong way round is right twice a day and
//     looks right whenever you happen to test it.
//   - the fallback. Somebody with no stored position and a browser that has
//     never been asked gets the sun put over the equator at their own time
//     zone's longitude, which has to come out as the plain answer — light
//     between six and six — rather than as a guess that happens to run.
//
//   node scripts/test/sun.mjs

let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

const {
  DAY_ABOVE, NIGHT_BELOW, rememberSunSite, solarElevation, sunPhase, sunSite, timeOfDay,
} = await import('../../src/sun.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const eq = (got, want, label) => check(
  JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`,
);
const near = (got, want, tol, label) => check(
  Math.abs(got - want) <= tol, label, `got ${got.toFixed(3)}, wanted ${want} ± ${tol}`,
);

const BERN = [46.95, 7.45];
const TROMSO = [69.65, 18.96];
const SINGAPORE = [1.35, 103.8];
const SYDNEY = [-33.87, 151.21];

/** The highest the sun gets on a given day, and when — a minute at a time. */
function noonAt([lat, lon], day) {
  let best = -90;
  let at = null;
  for (let m = 0; m < 24 * 60; m += 1) {
    const when = new Date(`${day}T00:00:00Z`);
    when.setUTCMinutes(m);
    const elevation = solarElevation(lat, lon, when);
    if (elevation > best) { best = elevation; at = when; }
  }
  return { elevation: best, at };
}

console.log('\nThe solstices, which can be worked out on paper');
{
  // 23.44° is the tilt of the Earth's axis; at the solstice the sun is directly
  // over a tropic, so noon elevation is 90° − |latitude − declination|.
  const TILT = 23.44;
  for (const [name, site] of [['Bern', BERN], ['Tromsø', TROMSO], ['Sydney', SYDNEY]]) {
    const june = noonAt(site, '2026-06-21');
    const december = noonAt(site, '2026-12-21');
    near(june.elevation, 90 - Math.abs(site[0] - TILT), 0.2, `${name} at midsummer noon`);
    near(december.elevation, 90 - Math.abs(site[0] + TILT), 0.2, `${name} at midwinter noon`);
  }
  // Bern is 7.45° east, which is half an hour of the Earth's turn ahead of
  // Greenwich; the remaining minute or two is the equation of time.
  const { at } = noonAt(BERN, '2026-06-21');
  eq(at.toISOString().slice(11, 16), '11:32', 'and noon in Bern is half an hour before noon in London');
}

console.log('\nNight where there is no night, and none where there is nothing else');
{
  // Tromsø is inside the Arctic circle: the sun does not set in June and does
  // not rise in December. Both are facts a rule made of clock hours gets wrong.
  let lowest = 90;
  let highest = -90;
  for (let h = 0; h < 24; h += 1) {
    lowest = Math.min(lowest, solarElevation(...TROMSO, new Date(`2026-06-21T${String(h).padStart(2, '0')}:00:00Z`)));
    highest = Math.max(highest, solarElevation(...TROMSO, new Date(`2026-12-21T${String(h).padStart(2, '0')}:00:00Z`)));
  }
  check(lowest > 0, 'the midnight sun never sets in Tromsø in June', `lowest ${lowest.toFixed(1)}°`);
  check(highest < 0, 'and never rises there in December', `highest ${highest.toFixed(1)}°`);
  check(sunPhase(...TROMSO, new Date('2026-06-21T23:00:00Z')) !== 'night',
    'so midnight in June is not Night there, whatever the clock says');
  check(sunPhase(...TROMSO, new Date('2026-12-21T12:00:00Z')) !== 'day',
    'and noon in December is not Day');
}

console.log('\nDawn and dusk are not each other');
{
  // Bern in June: sunrise about 05:33 and sunset about 21:23, local. Both of
  // these are inside the low-sun band, on opposite sides of noon.
  eq(sunPhase(...BERN, new Date('2026-06-21T03:45:00Z')), 'dawn', 'just after sunrise is Dawn');
  eq(sunPhase(...BERN, new Date('2026-06-21T19:30:00Z')), 'dusk', 'and just before sunset is Dusk');
  eq(sunPhase(...BERN, new Date('2026-06-21T10:00:00Z')), 'day', 'the middle of the day is Day');
  eq(sunPhase(...BERN, new Date('2026-06-21T23:00:00Z')), 'night', 'and the middle of the night is Night');

  // The southern hemisphere gets the opposite half of the year, and the same
  // half of the day — which is the sanity check that "rising" was answered from
  // the hour angle rather than from a month.
  eq(sunPhase(...SYDNEY, new Date('2026-06-21T20:45:00Z')), 'dawn',
    'a quarter to seven in Sydney is Dawn in June too');
}

console.log('\nThe bands themselves');
{
  check(DAY_ABOVE > 0 && NIGHT_BELOW < 0, 'day is above the horizon and night is under it');
  // Walk a Bern day minute by minute and check the phases arrive in order and
  // once each: night, dawn, day, dusk, night. A boundary written the wrong way
  // round shows up here as an extra crossing.
  const seen = [];
  for (let m = 0; m < 24 * 60; m += 1) {
    const when = new Date('2026-06-21T00:00:00Z');
    when.setUTCMinutes(m);
    const phase = sunPhase(...BERN, when);
    if (phase !== seen.at(-1)) seen.push(phase);
  }
  eq(seen, ['night', 'dawn', 'day', 'dusk', 'night'], 'a June day in Bern passes through each phase once');
}

console.log('\nThe place the sun is put over');
{
  stored = {};
  // No stored site: the time zone stands in, as a longitude on the equator. The
  // test process runs in whatever zone this machine is in, so what is checked
  // is the shape of the answer and the property that makes it usable — that the
  // day runs from about six to about six on the local clock.
  const [lat, lon] = sunSite();
  eq(lat, 0, 'with nothing known the sun is put over the equator');
  check(Math.abs(lon) <= 180, 'at a longitude derived from the time zone', `got ${lon}`);

  const localNoon = new Date('2026-03-20T12:00:00'); // local, deliberately
  const localMidnight = new Date('2026-03-20T00:00:00');
  eq(timeOfDay(localNoon), 'day', 'midday on the local clock is Day, in any time zone');
  eq(timeOfDay(localMidnight), 'night', 'and midnight is Night');

  check(rememberSunSite(46.9482, 7.4474), 'a real position can be written down');
  eq(sunSite(), [46.9, 7.4], 'coarsely — a tenth of a degree moves sunrise by seconds');
  check(!rememberSunSite(NaN, 7.4), 'a fix with no numbers in it is refused');
  check(!rememberSunSite(120, 7.4), 'and so is a latitude off the ends of the Earth');
  eq(sunSite(), [46.9, 7.4], 'neither of which disturbs what was already known');

  stored['visited-map:sun-site:v1'] = '"nonsense"';
  eq(sunSite()[0], 0, 'a stored value that is not a position falls back to the time zone');
}

console.log('\nWhat cannot be answered at all');
{
  eq(sunPhase(NaN, 7.4, new Date()), 'day', 'a position with no numbers in it is lit as daylight');
  eq(sunPhase(46.9, undefined, new Date()), 'day', 'rather than throwing on the way to a basemap');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
