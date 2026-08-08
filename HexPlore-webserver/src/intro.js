// The first five minutes: what this is, and what to feed it.
//
// A map with nothing on it is the one screen in this app that cannot explain
// itself. Every other empty state has a heading above it saying what would be
// there — no routes yet, no trips yet — but the map's empty state *is the
// product*, a grey world you are apparently meant to know what to do with. The
// question people actually arrive with is not "how do I use this", it is "what
// is this for, and where does the data come from", and neither is answerable
// from a grid of hexagons.
//
// So it is answered once, in front of the map, and then never again.
//
// ## Why the arithmetic is in here and the cards are not
//
// The same split as `src/whats-new.js` and its `-ui`: everything that is a
// *decision* — whether to show it at all, which permissions this host can even
// offer, which of them are already answered, what the closing numbers say — is
// here, where it can be tested without a browser. `src/intro-ui.js` owns the
// deck, the swipe and the confetti, none of which a test can meaningfully
// assert about.
//
// ## It is not a tour
//
// Nothing here points at a button and says "this is the menu". Interface tours
// are read once and forgotten, and this interface is a map — you already know
// how a map works. What is worth saying is the part no amount of poking will
// tell you: that a *trip* is a derived thing with a definition, that workouts
// come from four different places, that the server this is talking to is yours.
// Five cards of that, and then it gets out of the way.

/**
 * Which introduction somebody has been shown.
 *
 * A version rather than a flag, because "have you seen it" and "have you seen
 * *this* one" are different questions and only the second one survives the
 * cards being rewritten. Bumping it shows the deck again to everybody, which is
 * a thing to do deliberately and rarely — it is the same trade the service
 * worker makes with its cache name.
 */
export const INTRO_VERSION = 1;

/**
 * Where this browser remembers having seen it — a map of account name to
 * version, not a flag.
 *
 * Belt and braces beside the account's own copy, and the braces matter: the
 * account's copy is pushed with the rest of the preferences and that push can
 * fail — no connection, a tab closed inside the debounce — and an introduction
 * that reappears because a *sync* did not land is exactly the nag this is
 * written to be the opposite of.
 *
 * Keyed by account because a browser is not a person. Two people share a laptop
 * and the second one to register has never been told anything; a single flag
 * here would decide otherwise on the strength of the first one's morning. See
 * `introSeenLocally` in src/main.js, which is what fills it in.
 */
export const INTRO_SEEN_KEY = 'visited-map:intro-seen:v1';

/**
 * What this device has already been asked, and what it said.
 *
 * Local on purpose, and it is one of the few things in this app that genuinely
 * is a fact about the machine rather than about the person: a permission is
 * granted to an installation. Saying yes to Photos on the phone tells you
 * nothing about the laptop, and an account-level copy would have the replay
 * cheerfully reporting a grant that does not exist here.
 */
export const INTRO_PERMS_KEY = 'visited-map:intro-perms:v1';

// --- Which host this is ---------------------------------------------------------
//
// Three answers, and the whole of the difference between them is what can be
// *asked for*. A browser cannot open a photo library or a health store, so the
// permissions card in a browser is one row rather than three and the import
// card suggests an app. Neither is a smaller version of the same screen; they
// are different screens, and pretending otherwise is how you get a button that
// does nothing.

export const IOS = 'ios';
export const MAC = 'mac';
export const WEB = 'web';

/**
 * The host, from evidence rather than from a user-agent string.
 *
 * Both signals are ones the app already had for other reasons, which is why
 * this needs no new plumbing on either side:
 *
 *   - `data-client="ios"` is stamped on the document by the server, for a
 *     request whose User-Agent carries `HexploreiOS` (see `indexForClient` in
 *     server/index.js). It exists so the chrome is laid out for a native tab
 *     bar on the *first* paint.
 *   - `hexploreLocation` is the macOS app's geolocation shim, and it is only
 *     ever registered there — the iPhone's WebKit delivers positions perfectly
 *     well and needs none of it (see `LocationBridge` in the macOS sources).
 *
 * The Mac app is therefore identified by the one handler that is unique to it,
 * rather than by the User-Agent tag it also sets: the server does not rewrite
 * the document for `HexploreMac`, so there is nothing on the page to read.
 *
 * @param {{client?: string|null, handlers?: object|null}} evidence
 */
export function hostKindOf({ client, handlers } = {}) {
  if (client === IOS) return IOS;
  if (handlers && 'hexploreLocation' in handlers) return MAC;
  return WEB;
}

/** The same question, asked of the page this is actually running in. */
export const hostKind = () =>
  hostKindOf({
    client: globalThis.document?.documentElement?.dataset?.client ?? null,
    handlers: globalThis.webkit?.messageHandlers ?? null,
  });

/** Whether this is one of the two native apps — which is what Photos hangs on. */
export const isApple = (host) => host === IOS || host === MAC;

// --- The cards ------------------------------------------------------------------

/**
 * The deck, in order. Every host gets all seven; what changes is what is *on*
 * two of them, not how many there are.
 *
 * Same count everywhere because the progress dots are a promise about how much
 * is left, and a deck that is five on a laptop and seven on a phone makes that
 * promise twice with two different answers — which matters the moment somebody
 * has both.
 */
export const INTRO_PAGES = [
  'what', // a map of where you have been
  'trips', // …which it reads trips and workouts out of
  'import', // …fed from your phone, or from an export
  'privacy', // …and it is all on your own server
  'permissions', // so: may it look?
  'sources', // the exports it cannot ask for, and where home is
  'done', // what you are starting with
];

/**
 * Which permissions this host can actually raise a prompt for.
 *
 * Location is on every one of them because it is the only one a browser can
 * ask — and because the home step two cards later flies the map to where you
 * are, which is a much better question than "find your house on this globe".
 *
 * Health is iPhone-only rather than Apple-only: there is no HealthKit on a Mac
 * at all, so the row would be an apology rather than a control.
 *
 * @param {string} host
 * @returns {string[]}
 */
export function permissionsFor(host) {
  if (host === IOS) return ['photos', 'location', 'health'];
  if (host === MAC) return ['photos', 'location'];
  return ['location'];
}

// --- Whether to show it at all --------------------------------------------------

/**
 * The highest version of the introduction this person has been through.
 *
 * Either copy counts, and the newer answer wins, because the two disagree in
 * both directions: a browser that has seen it and could not push says so
 * locally, and a *second* browser that has never seen anything hears it from
 * the account. Taking the maximum is what makes both of those a "no".
 *
 * @param {{remote?: object|null, local?: unknown}} where
 */
export function seenVersion({ remote, local } = {}) {
  const fromAccount = Number(remote?.intro) || 0;
  const fromBrowser = Number(local) || 0;
  return Math.max(fromAccount, fromBrowser);
}

/**
 * Should the deck come up on this load?
 *
 * Deliberately not conditioned on the map being empty. An account that arrives
 * with history — restored from a backup, or synced from a phone that was
 * logging before the laptop ever signed in — has had no more explanation than
 * an empty one, and hiding the introduction from it would mean the people with
 * the *most* on the map are the ones who never find out what a trip is.
 */
export const shouldIntro = (where) => seenVersion(where) < INTRO_VERSION;

// --- What is already answered ---------------------------------------------------
//
// The replay is the reason this exists. Somebody who opens the introduction
// again from Settings has, by definition, already been through it once, and a
// screen that asks them for photo access they granted a month ago is a screen
// that has not been paying attention. So every actionable row reads the world
// before it offers to do anything.

/**
 * Has this permission already been dealt with, and how do we know?
 *
 * Two kinds of evidence, and the second is the better one:
 *
 *   - **what we remember asking.** Cheap, and only ever as true as the last
 *     time this browser asked — a permission revoked in Settings afterwards
 *     still reads as granted here.
 *   - **what is on the map.** A source named `apple-photos` means photographs
 *     have been read off this library and turned into cells; `apple-health`
 *     means workouts have. That is not a permission check, it is better than
 *     one: it is the permission having already produced the thing it was for.
 *
 * Location is the odd one out and the only one with a real answer available —
 * the Permissions API knows, so it is asked, and the remembered copy is the
 * fallback for the browsers that do not implement it.
 *
 * @param {string} key photos | location | health
 * @param {object} evidence
 * @param {Record<string,string>} [evidence.asked] what this device answered last time
 * @param {Set<string>|string[]} [evidence.sources] source keys present in the account
 * @param {string|null} [evidence.geolocation] the Permissions API's state, if it has one
 * @returns {boolean}
 */
export function alreadyGranted(key, { asked = {}, sources = [], geolocation = null } = {}) {
  const has = (s) => (sources instanceof Set ? sources.has(s) : sources.includes(s));
  if (key === 'photos') return asked.photos === 'granted' || has('apple-photos');
  if (key === 'health') return asked.health === 'granted' || has('apple-health');
  if (key === 'location') return geolocation === 'granted' || asked.location === 'granted';
  return false;
}

// --- The closing numbers --------------------------------------------------------

/**
 * What somebody is starting with, as the tiles the last card counts up.
 *
 * Only the ones that are not zero. A new account has nothing yet and a wall of
 * four zeroes is a worse ending than a sentence — so an empty answer is a
 * legitimate one here, and `src/intro-ui.js` says something human instead of
 * drawing an empty grid.
 *
 * Ground covered is left as a raw km² and formatted by the caller, which owns
 * `formatKm2` and its rules about when a number becomes "1.2 million".
 *
 * @param {object|null} stats  the coverage answer from /api/stats
 * @param {Array|null} routes  the saved routes
 * @param {Array|null} trips   the derived trips
 * @returns {Array<{key: string, value: number, kind: 'count'|'area'}>}
 */
export function introNumbers(stats, routes, trips) {
  const tiles = [
    { key: 'cells', value: Number(stats?.cells) || 0, kind: 'count' },
    { key: 'km2', value: Number(stats?.km2) || 0, kind: 'area' },
    { key: 'countries', value: stats?.countries?.length ?? 0, kind: 'count' },
    { key: 'workouts', value: routes?.length ?? 0, kind: 'count' },
    { key: 'trips', value: trips?.length ?? 0, kind: 'count' },
  ];
  return tiles.filter((t) => t.value > 0);
}

/**
 * How long to hold each number's count-up, in milliseconds.
 *
 * Fixed rather than proportional to the number. A count-up is a flourish, and a
 * flourish that runs for eleven seconds because somebody has a large map is not
 * a flourish, it is a wait — the person has already seen the total by then and
 * is watching the animation finish out of politeness.
 */
export const COUNT_MS = 900;

/**
 * How long the first card waits before admitting there is a gesture.
 *
 * Long enough to have read the card, because a hint that arrives with the text
 * is answering a question nobody has asked yet and reads as clutter; short
 * enough that nobody concludes the app has stopped. It is only ever shown once,
 * on the first card — by the second one the gesture is known, and a permanent
 * "swipe left" is a caption on your own hands.
 */
export const HINT_MS = 2600;
