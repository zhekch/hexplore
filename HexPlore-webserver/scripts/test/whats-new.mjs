// What changed while you were not looking — the arithmetic behind the banner.
//
// Four things here are worth pinning, and every one of them is a decision
// somebody would otherwise "fix" back:
//
//   - **the first open says nothing.** With no baseline the change is not "the
//     whole map"; it is nothing, and a banner announcing that you have 12,000
//     places is not news.
//   - **a change too small to mention does not move the baseline.** That is the
//     whole of why "after substantial changes" works: four quiet days have to be
//     able to add up to one worth a sentence.
//   - **workouts ignore the setting.** A ride you went on is not ambient, and
//     somebody on Never still hears about it.
//   - **only growth is reported.** Cells go down when you take a source off the
//     map, which is a thing you just did on purpose.
//
//   node scripts/test/whats-new.mjs

let stored = {};
globalThis.localStorage = {
  getItem: (k) => (k in stored ? stored[k] : null),
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
};

// The strings come from the locale, and `t()` answers with the key itself until
// one is loaded — so this has to happen before whats-new.js is imported, exactly
// as src/boot.js does it in the browser. Without it every assertion about a
// sentence below would be comparing against "whatsNew.places.other".
await (await import('../../src/i18n.js')).loadLocale('en');

const {
  BANNER_MODES, bannerFor, bannerMode, changesSince, forgetSnapshot, isBannerMode,
  lastSnapshot, rememberSnapshot, setBannerMode, snapshotOf,
} = await import('../../src/whats-new.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

/** A snapshot, with everything defaulting to zero. */
const snap = (over = {}) => ({
  cells: 0, km2: 0, countries: 0, regions: 0, days: 0, streakDays: 0, workouts: 0, ...over,
});

console.log('\nReading the coverage answer down to what a banner needs');
{
  const stats = {
    cells: 1200,
    km2: 4321.6,
    countries: [{ id: 'Switzerland' }, { id: 'Italy' }],
    regions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    days: 88,
    streakDays: 9,
    // The rest of the payload, which must not survive into localStorage.
    sources: [{ key: 'iphone', cells: 900 }],
    years: [[2025, 400]],
  };
  const routes = [
    { source: 'apple-health' }, { source: 'strava' }, { source: 'apple-health' },
  ];
  const s = snapshotOf(stats, routes);
  check(s.cells === 1200 && s.km2 === 4321.6, 'the counts come across');
  check(s.countries === 2 && s.regions === 3, 'countries and regions become counts, not lists');
  check(s.workouts === 2, 'and the workouts are the Apple Health routes', String(s.workouts));
  check(!('sources' in s) && !('years' in s), 'nothing else survives into the snapshot');
  check(snapshotOf(null, routes) === null, 'and no coverage answer is no snapshot at all');
}

console.log('\nThe first open has nothing to report');
{
  const now = snap({ cells: 12_000, km2: 90_000, countries: 14 });
  const change = changesSince(null, now);
  check(change.lines.length === 0, 'a map with no baseline reports no change');
  check(change.substantial === false, 'and is not substantial');
  check(bannerFor(change, 'always').show === false, 'so even Always says nothing');
}

console.log('\nWhat counts as a change');
{
  const before = snap({ cells: 1000, km2: 5000, countries: 3, regions: 8, days: 50, streakDays: 4 });

  const oneCell = changesSince(before, { ...before, cells: 1001 });
  check(oneCell.lines.length === 1, 'one new cell is a change');
  check(/1 new place/.test(oneCell.lines[0]), 'and is called a place, singular', oneCell.lines[0]);
  check(oneCell.substantial === false, 'but it is not a substantial one');

  const manyCells = changesSince(before, { ...before, cells: 1030 });
  check(manyCells.substantial === true, 'thirty of them is');
  check(/30 new places/.test(manyCells.lines[0]), 'and pluralises', manyCells.lines[0]);

  const country = changesSince(before, { ...before, countries: 4 });
  check(country.substantial === true, 'a single new country always is');
  check(/1 new country/.test(country.lines[0]), 'and leads the list', country.lines[0]);

  const region = changesSince(before, { ...before, regions: 9 });
  check(region.substantial === true, 'and so is a single new region');

  const ground = changesSince(before, { ...before, km2: 5500 });
  check(ground.substantial === true, 'five hundred square kilometres is substantial');
  check(ground.lines.some((l) => /500 km²/.test(l)), 'and is reported whole', ground.lines.join('; '));
  const rounding = changesSince(before, { ...before, km2: 5412.7 });
  check(rounding.lines.some((l) => /413 km²/.test(l)),
    'a fraction is rounded rather than claiming precision the grid has not',
    rounding.lines.join('; '));

  const streak = changesSince(before, { ...before, streakDays: 11 });
  check(streak.substantial === true, 'a longer streak than ever is always news');
  check(streak.lines.some((l) => /11-day streak/.test(l)), 'and says how long', streak.lines.join('; '));

  // The ordering that matters: a new country is the headline of any week.
  const lots = changesSince(before, { ...before, cells: 1200, countries: 4, regions: 10, km2: 6000 });
  check(/country/.test(lots.lines[0]), 'a new country leads over everything else', lots.lines[0]);
}

console.log('\nOnly growth');
{
  const before = snap({ cells: 1000, km2: 5000, countries: 5, regions: 9 });
  // Taking a source off the map. You just did this on purpose.
  const shrunk = changesSince(before, snap({ cells: 400, km2: 2000, countries: 2, regions: 3 }));
  check(shrunk.lines.length === 0, 'a map that shrank reports nothing');
  check(shrunk.substantial === false, 'and is not substantial');
  check(bannerFor(shrunk, 'always').show === false, 'so no banner appears at any setting');
}

console.log('\nThe setting decides the coverage, and never the workouts');
{
  const before = snap({ cells: 1000 });
  const small = changesSince(before, snap({ cells: 1002 }));
  const big = changesSince(before, snap({ cells: 1002, countries: 1 }));

  check(bannerFor(small, 'never').show === false, 'Never says nothing about two new cells');
  check(bannerFor(small, 'substantial').show === false, 'and nor does After substantial changes');
  check(bannerFor(small, 'always').show === true, 'Always does');
  check(bannerFor(big, 'substantial').show === true, 'a new country reaches the middle setting');
  check(bannerFor(big, 'never').show === false, 'and still not Never');

  // The exception, at every setting.
  const ride = changesSince(before, snap({ cells: 1002, workouts: 1 }));
  for (const mode of BANNER_MODES) {
    const b = bannerFor(ride, mode.key);
    check(b.show === true, `${mode.label} still mentions a new workout`);
    check(/1 new workout/.test(b.title), 'and puts it in the headline', b.title);
  }

  // Never gets the workout and none of the coverage, which is what Never means.
  const onNever = bannerFor(ride, 'never');
  check(!/new place/.test(onNever.detail), 'Never keeps the coverage out of the detail line', onNever.detail);
  const onAlways = bannerFor(ride, 'always');
  check(/new place/.test(onAlways.detail), 'and Always brings it in', onAlways.detail);

  // Plural, and the headline when there is no workout.
  const rides = bannerFor(changesSince(before, snap({ cells: 1400, workouts: 3 })), 'always');
  check(/3 new workouts/.test(rides.title), 'three of them pluralises', rides.title);
  const noRide = bannerFor(changesSince(before, snap({ cells: 1400 })), 'always');
  check(noRide.title === 'Your map has grown', 'and with no workout the map itself is the headline', noRide.title);
}

console.log('\nHolding the baseline');
{
  forgetSnapshot();
  check(lastSnapshot() === null, 'nothing stored is no baseline');

  const s = snap({ cells: 1000, km2: 5000, countries: 3, regions: 7, days: 40, streakDays: 5, workouts: 2 });
  rememberSnapshot(s);
  const read = lastSnapshot();
  check(read.cells === 1000 && read.workouts === 2, 'a stored baseline comes back as it went in');
  check(Object.keys(read).length === 7, 'with exactly the fields a snapshot has', String(Object.keys(read).length));

  // A truncated or hand-edited entry must not poison every delta with NaN.
  stored['visited-map:whats-new:v1'] = '{"cells":"nonsense","km2":null}';
  const bad = lastSnapshot();
  check(bad.cells === 0 && bad.km2 === 0, 'rubbish reads back as zero rather than NaN');
  check(changesSince(bad, snap({ cells: 5 })).lines.length === 1, 'and still produces a usable difference');

  stored['visited-map:whats-new:v1'] = 'not json at all';
  check(lastSnapshot() === null, 'and something that is not JSON is simply no baseline');

  forgetSnapshot();
  check(lastSnapshot() === null, 'signing out forgets it');
}

console.log('\nThe frequency survives a round trip');
{
  check(bannerMode() === 'substantial', 'the default is the middle one');
  for (const mode of BANNER_MODES) {
    setBannerMode(mode.key);
    check(bannerMode() === mode.key, `${mode.label} can be chosen`);
  }
  setBannerMode('hourly');
  check(bannerMode() === 'substantial', 'anything else falls back rather than being stored');
  stored['visited-map:whats-new-mode:v1'] = 'weekly';
  check(bannerMode() === 'substantial', 'as does a stored value this build has never heard of');
  check(isBannerMode('always') && !isBannerMode('alway'), 'and the prefs adopter agrees');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
