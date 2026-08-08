// The introduction — which host it thinks it is on, what it offers there, and
// whether it should run at all.
//
// Five decisions are pinned here, and every one of them is a thing that would
// otherwise be discovered by somebody being asked a question they had already
// answered:
//
//   - **the Mac is identified by its geolocation shim, not by its User-Agent.**
//     The server only rewrites index.html for the iPhone, so `data-client` is
//     the wrong thing to look for and there is nothing else on the page that
//     says "Mac" — except the one message handler only that app registers.
//   - **a browser is offered one permission and an iPhone three.** A row that
//     cannot raise a prompt is not a control, and there is no HealthKit on a
//     Mac at all.
//   - **either copy of "seen" is enough.** A browser that finished the deck
//     offline and an account that finished it on another machine must both be
//     able to say no, and the higher number wins.
//   - **evidence beats memory.** A source on the map is proof the permission
//     was granted and then used; a remembered "yes" is only as true as the last
//     time this browser asked.
//   - **the last card shows nothing rather than zeroes.** A new account has
//     nothing, and a grid of noughts is a demoralising answer to "what are you
//     starting with".
//
//   node scripts/test/intro.mjs

const {
  INTRO_PAGES, INTRO_VERSION, IOS, MAC, WEB,
  alreadyGranted, hostKindOf, introNumbers, isApple, permissionsFor, seenVersion, shouldIntro,
} = await import('../../src/intro.js');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};
const same = (got, want, label) =>
  check(JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}`);

// --- Which host ------------------------------------------------------------------

console.log('\nWhich host the page is running in');
{
  check(hostKindOf({ client: 'ios' }) === IOS, 'data-client="ios" is the iPhone app');
  check(
    hostKindOf({ handlers: { hexploreLocation: {}, hexplorePhotos: {} } }) === MAC,
    'the geolocation shim is the Mac app, which the server does not mark',
  );
  check(hostKindOf({}) === WEB, 'and anything else is a browser');
  check(hostKindOf() === WEB, 'including one that offers no evidence at all');

  // The iPhone registers `hexplorePhotos` too, so a check that looked for a
  // photo bridge alone would call the phone a Mac. The client attribute has to
  // win, and this is the case that proves it does.
  check(
    hostKindOf({ client: 'ios', handlers: { hexplorePhotos: {} } }) === IOS,
    'a photo bridge on its own does not make something a Mac',
  );

  check(isApple(IOS) && isApple(MAC) && !isApple(WEB), 'both apps are Apple; the browser is not');
}

// --- What each host is offered ---------------------------------------------------

console.log('\nWhat can actually be asked for, per host');
{
  same(permissionsFor(IOS), ['photos', 'location', 'health'], 'the iPhone has all three');
  same(permissionsFor(MAC), ['photos', 'location'], 'a Mac has no HealthKit, so it has two');
  same(permissionsFor(WEB), ['location'], 'a browser can only ask where you are');
  check(
    permissionsFor(WEB).every((k) => permissionsFor(IOS).includes(k)),
    'and nothing is offered in a browser that the phone does not also offer',
  );
}

// --- The deck itself -------------------------------------------------------------

console.log('\nThe deck');
{
  check(INTRO_PAGES.length === 7, `seven cards (${INTRO_PAGES.length})`);
  check(new Set(INTRO_PAGES).size === INTRO_PAGES.length, 'and no page appears twice');
  // The order is the argument: what it is, what it reads, where that comes
  // from, whose machine it is on — and only then does it ask for anything.
  check(
    INTRO_PAGES.indexOf('privacy') < INTRO_PAGES.indexOf('permissions'),
    'whose machine this is, before it asks for a permission',
  );
  check(
    INTRO_PAGES.indexOf('permissions') < INTRO_PAGES.indexOf('done'),
    'and the numbers come last, when there is something to count',
  );
}

// --- Whether it runs at all ------------------------------------------------------

console.log('\nWhether it should run');
{
  check(seenVersion({}) === 0, 'nobody has seen anything by default');
  check(seenVersion({ remote: { intro: 1 } }) === 1, "the account's copy counts");
  check(seenVersion({ local: 1 }) === 1, "and so does the browser's");
  // The two disagree in both directions — a push that never landed, and a
  // second browser that has never seen anything — so the higher one wins.
  check(seenVersion({ remote: { intro: 0 }, local: 3 }) === 3, 'the higher of the two wins');
  check(seenVersion({ remote: { intro: 4 }, local: 1 }) === 4, 'in either direction');
  check(seenVersion({ remote: null, local: 'nonsense' }) === 0, 'and rubbish reads as never');

  check(shouldIntro({}) === true, 'a brand new account is shown it');
  check(shouldIntro({ remote: { intro: INTRO_VERSION } }) === false, 'and then never again');
  check(
    shouldIntro({ remote: { intro: INTRO_VERSION - 1 } }) === true,
    'until the deck is rewritten and the version moves',
  );
}

// --- What is already answered ----------------------------------------------------

console.log('\nWhat a replay already knows');
{
  check(alreadyGranted('photos', {}) === false, 'nothing is assumed granted');
  check(
    alreadyGranted('photos', { asked: { photos: 'granted' } }) === true,
    'a remembered yes counts',
  );
  // The better evidence: a source on the map is the permission having already
  // produced the thing it was asked for.
  check(
    alreadyGranted('photos', { sources: ['apple-photos', 'gpx'] }) === true,
    'and so does a photo library that has already put cells on the map',
  );
  check(
    alreadyGranted('health', { sources: new Set(['apple-health']) }) === true,
    'the same for workouts, whether the sources arrive as a Set',
  );
  check(
    alreadyGranted('health', { sources: ['apple-photos'] }) === false,
    'and one source does not vouch for another',
  );
  check(
    alreadyGranted('location', { geolocation: 'granted' }) === true,
    'location has a real answer available, and it is used',
  );
  check(
    alreadyGranted('location', { geolocation: 'prompt', asked: { location: 'granted' } }) === true,
    'falling back to memory where the browser will not say',
  );
  check(
    alreadyGranted('location', { geolocation: 'denied' }) === false,
    'a refusal is not a grant',
  );
  check(alreadyGranted('nonsense', { asked: { nonsense: 'granted' } }) === false,
    'and a permission nobody has heard of is never granted');
}

// --- The closing numbers ---------------------------------------------------------

console.log('\nThe numbers on the last card');
{
  same(introNumbers(null, null, null), [], 'an empty account gets an empty grid, not zeroes');
  same(introNumbers({ cells: 0, km2: 0, countries: [] }, [], []), [],
    'and so does one whose readings all came back empty');

  const tiles = introNumbers(
    { cells: 1200, km2: 480.5, countries: ['CH', 'FR'] },
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ id: 'trip-1' }],
  );
  same(tiles.map((t) => t.key), ['cells', 'km2', 'countries', 'workouts', 'trips'],
    'everything that has a number gets a tile');
  check(tiles.find((t) => t.key === 'km2')?.kind === 'area',
    'and ground covered is marked as an area, because it is spelled differently');
  check(tiles.find((t) => t.key === 'countries')?.value === 2,
    'countries is the length of the list, not the list');

  // A map with cells and no routes should not be told it has no cells either.
  const partial = introNumbers({ cells: 40, km2: 12, countries: [] }, [], null);
  same(partial.map((t) => t.key), ['cells', 'km2'], 'and the empty readings simply drop out');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
