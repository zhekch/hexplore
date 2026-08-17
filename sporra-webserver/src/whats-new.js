// What changed while you were not looking.
//
// The map is filled in by things that are not you: a phone in your pocket, a
// watch that saved a ride, Home Assistant noticing you came home, a Strava sync
// at four in the morning. So the interesting moment is *opening it* — the ground
// has moved since last time and nothing on screen says so, because a map that
// has grown looks exactly like a map that has not.
//
// This is the arithmetic behind the line that says it. The DOM is in
// `src/whats-new-ui.js`; everything here is pure, which is what lets the
// thresholds below be argued about in a test rather than by opening the app
// eleven times.
//
// ## Since when
//
// Since the last time a banner was shown — **not** since the last time the app
// was opened, and the difference is the whole of why "after substantial changes"
// works. If the baseline moved on every open, then four days of one cell each
// would each be too small to mention and the fifth would report one cell, and
// the week would pass without a word. Holding the baseline until something is
// actually said means small changes accumulate until they are worth saying.
//
// Two consequences, both deliberate:
//
//   - **The first open ever shows nothing.** There is no baseline, so there is no
//     change; a banner announcing that you have 12,000 places is not news, it is
//     the map. The baseline is recorded and the next visit is the first that can
//     have anything to report.
//   - **`never` moves the baseline anyway.** Otherwise switching it on after a
//     year would open on "+38,000 places", which is a number nobody can feel and
//     not what anybody meant by turning the setting on.
//
// ## The baseline belongs to the account, not to the device
//
// It used to be this browser's alone, on the argument that the laptop and the
// phone have seen different banners at different times. What that produced was
// the same ride announced twice — once when you picked up the phone and again
// when you opened the laptop — and news you have already had is not news. So
// the snapshot rides in the account preferences with everything else.
//
// Merged rather than reconciled, field by field, taking the **larger** of the
// two. A snapshot is a set of counters that only grow, so the higher number is
// the one that has already been reported, and the merge cannot make a device
// announce something the other one has said. A timestamp comparison would: a
// phone that had shown the banner while the laptop was asleep would still lose
// to the laptop's older, lower baseline the moment the laptop pushed anything
// at all.
//
// ## Workouts are not subject to the setting
//
// A new workout out of Apple Health is the one change here that arrived from
// something you *did* — you went for a ride, and a watch and two syncs later it
// is on the map. That is worth saying whatever the frequency is set to, so it is
// counted separately and reported unconditionally. The setting governs the
// coverage numbers, which are the part that is genuinely ambient.

import { activeLocale, plural, t } from './i18n.js';

// --- Tuning -------------------------------------------------------------------
//
// What "substantial" means, for the middle setting. Any one of these is enough.
//
// The two count thresholds are deliberately different in kind: a country or a
// region is *categorical* — there is no such thing as a slightly new country —
// so one of either is always worth a line. Ground is continuous, and needs a
// threshold that is large enough not to fire on a walk to the shops and small
// enough to fire on a day out.

/** A single new country or region is always worth mentioning. */
const SUBSTANTIAL_AREAS = 1;

/** Otherwise: this many new cells… */
const SUBSTANTIAL_CELLS = 20;

/** …or this much new ground, whichever happens first. A day's cycling is more
 *  than this; a commute is not. */
const SUBSTANTIAL_KM2 = 400;

/** A record streak is news at any length — it is the one number that can only
 *  be beaten, never accumulated. */
const SUBSTANTIAL_STREAK = 1;

/** The source key Apple Health workouts arrive under (see src/locations.js). */
export const HEALTH_SOURCE = 'apple-health';

/**
 * How often to say anything. `substantial` is the default because it is the
 * only one of the three that stays interesting: `always` becomes wallpaper
 * within a week, and `never` is for people who find the whole idea intrusive.
 */
export const BANNER_MODES = [
  { key: 'never', label: t('whatsNew.never') },
  { key: 'substantial', label: t('whatsNew.substantial') },
  { key: 'always', label: t('whatsNew.always') },
];

const DEFAULT_MODE = 'substantial';
const MODE_KEY = 'visited-map:whats-new-mode:v1';
const SNAPSHOT_KEY = 'visited-map:whats-new:v1';

/** Is this a mode we know? Used by the prefs adopter, which is fed by the network. */
export const isBannerMode = (key) => BANNER_MODES.some((m) => m.key === key);

/** Which mode is chosen, falling back to the default for anything odd. */
export function bannerMode() {
  let held;
  try {
    held = localStorage.getItem(MODE_KEY);
  } catch {
    held = null;
  }
  return isBannerMode(held) ? held : DEFAULT_MODE;
}

/** Choose one. Returns what is now stored. */
export function setBannerMode(key) {
  const clean = isBannerMode(key) ? key : DEFAULT_MODE;
  try {
    localStorage.setItem(MODE_KEY, clean);
  } catch {
    /* a preference that will not persist is still a preference */
  }
  return clean;
}

// --- The snapshot ---------------------------------------------------------------

/**
 * The few numbers worth comparing, out of the coverage answer and the routes.
 *
 * Deliberately small. The full stats payload is a hundred kilobytes of
 * per-country and per-region breakdown, and none of it belongs in localStorage
 * under a key that is written on every visit — what a banner can say is one
 * short sentence, so what it needs to remember is seven numbers.
 *
 * @param {object|null} stats  the answer from /api/stats
 * @param {Array|null}  routes the route list
 */
export function snapshotOf(stats, routes) {
  if (!stats) return null;
  return {
    cells: Number(stats.cells) || 0,
    km2: Number(stats.km2) || 0,
    countries: stats.countries?.length ?? 0,
    regions: stats.regions?.length ?? 0,
    days: Number(stats.days) || 0,
    streakDays: Number(stats.streakDays) || 0,
    workouts: (routes ?? []).filter((r) => r?.source === HEALTH_SOURCE).length,
  };
}

/** The fields a snapshot has, so reading one back cannot invent or drop any. */
const FIELDS = ['cells', 'km2', 'countries', 'regions', 'days', 'streakDays', 'workouts'];

/**
 * A snapshot out of somewhere untrusted — this browser's storage, or the
 * account's preferences blob, which is fed by the network.
 *
 * Every field through Number, so an entry written by an older build, truncated
 * by a full disk or edited by hand degrades to zeroes rather than to NaN —
 * which would otherwise propagate into every delta and print "NaN new places"
 * over a perfectly good map.
 *
 * @returns {object|null} null for anything that is not a snapshot at all
 */
export function readSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const held = {};
  for (const key of FIELDS) held[key] = Number(raw[key]) || 0;
  return held;
}

/**
 * The two copies of the baseline, as one.
 *
 * Field by field, the larger — see the note at the top. Either side may be
 * missing: a device that has never shown a banner has none of its own, and an
 * account written before this was synced carries none either.
 */
export function mergeSnapshots(a, b) {
  const mine = readSnapshot(a);
  const theirs = readSnapshot(b);
  if (!mine || !theirs) return mine ?? theirs;
  const held = {};
  for (const key of FIELDS) held[key] = Math.max(mine[key], theirs[key]);
  return held;
}

/** Read the stored baseline, or null if there has never been one. */
export function lastSnapshot() {
  try {
    return readSnapshot(JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

/** Write the baseline. Called when something has been said, and never otherwise. */
export function rememberSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* private mode: the banner is a nicety, and it will simply not appear */
  }
}

/** Signing out must not leave the next account measuring against this one's map. */
export function forgetSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* fine */
  }
}

// --- The difference -------------------------------------------------------------

/**
 * What has changed between two snapshots.
 *
 * Only growth is reported, and that is not laziness. Cells go *down* when you
 * take a source off the map or undo an import — both of which are things you
 * just did on purpose, and being told about them on the next open is the app
 * reading your own action back to you. There is no honest "you lost 300 km²"
 * that is also welcome.
 *
 * @param {object|null} before the stored baseline, or null for a first visit
 * @param {object|null} after  now
 * @returns {{lines: string[], workouts: number, substantial: boolean}}
 */
export function changesSince(before, after) {
  const none = { lines: [], workouts: 0, substantial: false };
  if (!after) return none;
  // No baseline is not "everything is new" — see the note at the top.
  if (!before) return none;

  const up = (key) => Math.max(0, (after[key] ?? 0) - (before[key] ?? 0));

  const cells = up('cells');
  const km2 = up('km2');
  const countries = up('countries');
  const regions = up('regions');
  const days = up('days');
  const workouts = up('workouts');
  // A streak is a record rather than a total: what is news is that it is longer
  // than it has ever been, not that some days have passed.
  const streak = up('streakDays');

  const lines = [];
  // Ordered by how much a person would care, which is not the order they are
  // computed in: a new country is the headline of any week it happens in.
  if (countries) lines.push(plural(countries, 'whatsNew.countries'));
  if (regions) lines.push(plural(regions, 'whatsNew.regions'));
  if (cells) lines.push(plural(cells, 'whatsNew.places'));
  // Rounded to whole kilometres: the coverage sweep answers in fractions and a
  // banner reading "+412.7 km²" claims a precision the cell grid does not have.
  if (km2 >= 1) lines.push(t('whatsNew.ground', { km: Math.round(km2).toLocaleString(activeLocale()) }));
  if (streak) lines.push(t('whatsNew.streak', { days: after.streakDays }));
  else if (days) lines.push(plural(days, 'whatsNew.days'));

  const substantial = countries >= SUBSTANTIAL_AREAS
    || regions >= SUBSTANTIAL_AREAS
    || cells >= SUBSTANTIAL_CELLS
    || km2 >= SUBSTANTIAL_KM2
    || streak >= SUBSTANTIAL_STREAK;

  return { lines, workouts, substantial };
}

/**
 * Should the banner appear, and what should it say?
 *
 * The one place the setting is applied, so the rule that workouts ignore it
 * lives beside the rule they are an exception to.
 *
 * @param {object} change the answer from changesSince
 * @param {string} mode   one of BANNER_MODES
 * @returns {{show: boolean, title: string, detail: string}}
 */
export function bannerFor(change, mode) {
  const quiet = { show: false, title: '', detail: '' };
  if (!change) return quiet;

  const wantsStats = change.lines.length > 0
    && (mode === 'always' || (mode === 'substantial' && change.substantial));
  const hasWorkouts = change.workouts > 0;
  if (!wantsStats && !hasWorkouts) return quiet;

  // The workout is the headline when there is one: it is the change that came
  // from something the person did, and the coverage is the consequence of it.
  const title = hasWorkouts
    ? plural(change.workouts, 'whatsNew.workouts')
    : t('whatsNew.title');

  // With a workout headline the coverage becomes the supporting detail — but
  // only if the setting asked for it. A person on `never` who has just been
  // for a ride gets the workout and nothing else, which is what `never` means.
  const detail = wantsStats ? sentence(change.lines) : t('whatsNew.workouts.detail');

  return { show: true, title, detail };
}

/**
 * "a, b and c".
 *
 * Both joiners come from the locale rather than being punctuation in the code:
 * the separator carries its own spacing (a French locale wants a space before
 * some marks, a Chinese one wants a different comma entirely) and the final
 * conjunction is a word.
 */
function sentence(parts) {
  if (parts.length === 1) return capitalise(parts[0]);
  const head = parts.slice(0, -1).join(t('whatsNew.listSeparator'));
  return capitalise(`${head}${t('whatsNew.listAnd')}${parts.at(-1)}`);
}

/**
 * Upper-case the first letter, in the locale's own way.
 *
 * `toLocaleUpperCase` rather than `toUpperCase` because Turkish disagrees about
 * what the capital of `i` is, and getting that wrong is the canonical example
 * of a program that assumed everybody's alphabet was its own. Languages with no
 * case at all are unaffected: it returns the character it was given.
 */
const capitalise = (s) =>
  (s ? s[0].toLocaleUpperCase(activeLocale()) + s.slice(1) : s);
