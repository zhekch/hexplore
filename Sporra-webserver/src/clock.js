// What time it says, everywhere it says one.
//
// Eight modules used to hold their own `new Intl.DateTimeFormat(undefined, …)`,
// and `undefined` means "whatever locale this browser is set to". That is a good
// default and a bad only-option: it is right for most people without being asked,
// and there is no way to disagree with it. A phone set to US English shows a
// 09:09 walk as "09:09 AM" whichever country it is standing in.
//
// So the locale is still the default — that is the `auto` setting, and it is
// what "read it from the browser" means — but the answer can be overridden, and
// the override lives in the account's preferences rather than in this browser.
// A clock is a thing about *you*, not about the machine you happen to be on, so
// picking 24-hour on the laptop should mean the phone agrees without being told.
//
// Formatters are rebuilt on change rather than constructed per call: `Intl`
// objects are expensive to make and these are used per row of a list.

const DAY = { day: 'numeric', month: 'short' };
const TIME = { hour: '2-digit', minute: '2-digit' };

/** 'auto' follows the device; '24' and '12' override it. */
export const CLOCK_MODES = ['auto', '24', '12'];

// --- What the device actually says ---------------------------------------------
//
// **A browser cannot read the 24-hour switch on the phone it is running on.**
// The only thing `Intl` knows is the locale, and a locale is a language and a
// region — `en-US` is 12-hour and `en-GB` is 24-hour and neither of them is the
// toggle in Settings. WebKit folds that toggle into the locale it hands out, so
// on mobile Safari `auto` is genuinely automatic; inside the app's web view the
// locale is the *app's*, which is English, so a phone that has said 24-hour
// everywhere else for years is told 09:09 AM by this one screen. That is the
// complaint, and no amount of asking `Intl` more carefully answers it.
//
// So it is a thing the host is asked to say, exactly like the safe-area insets:
// a fact about the device that the page has no other way to learn.
// `pushClock()` in Sporra-IOS/Sporra/WebPanel.swift writes the answer onto
// the root element, before the page runs and again when it has loaded, and
// fires `sporra:clock` so anything already built can catch up. In a browser
// nothing writes it and the locale stands, which is the behaviour this has
// always had.
const HOUR_CYCLES = ['h11', 'h12', 'h23', 'h24'];
const DATA_KEY = 'hourCycle'; // data-hour-cycle on <html>

/** The hour cycle the host said this device uses, or null if nothing said. */
function deviceCycle() {
  if (typeof document === 'undefined') return null; // tests, and the service worker
  const said = document.documentElement?.dataset?.[DATA_KEY];
  return HOUR_CYCLES.includes(said) ? said : null;
}

let mode = 'auto';
let heard = null; // the device answer the current formatters were built against
let time;
let dayTime;
let full;

function build() {
  heard = deviceCycle();
  // On `auto` the device's own answer wins where there is one. Failing that,
  // `hour12` is left *absent* rather than set to a guess: absent is the only
  // value that means "use the locale's own convention", which is not the same as
  // either true or false — some locales are neither, and a few write 24-hour
  // clocks with an h24 cycle this would otherwise flatten.
  let h;
  if (mode !== 'auto') h = { hour12: mode === '12' };
  else if (heard) h = { hourCycle: heard };
  else h = {};
  time = new Intl.DateTimeFormat(undefined, { ...TIME, ...h });
  dayTime = new Intl.DateTimeFormat(undefined, { ...DAY, ...TIME, ...h });
  full = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', ...DAY, year: 'numeric', ...TIME, ...h,
  });
}
build();

/** The account's choice. Anything unrecognised falls back to following the device. */
export function setClock(next) {
  const wanted = CLOCK_MODES.includes(next) ? next : 'auto';
  if (wanted === mode) return false;
  mode = wanted;
  build();
  return true;
}

export const clockMode = () => mode;

/**
 * Re-read what the host said, for the push that arrives after the page has
 * booted. Rebuilds only if the answer actually moved, since every list showing a
 * time has to be drawn again to pick it up.
 *
 * @returns {boolean} whether anything changed
 */
export function refreshClock() {
  if (deviceCycle() === heard) return false;
  build();
  return true;
}

/**
 * What `auto` is actually going to give — used to label the option with its own
 * answer, because "Automatic" alone tells you nothing about which of the two you
 * are getting.
 */
export function localIs24Hour() {
  const said = deviceCycle();
  if (said) return said === 'h23' || said === 'h24';
  return !new Intl.DateTimeFormat(undefined, TIME)
    .formatToParts(new Date(2020, 0, 1, 13))
    .some((p) => p.type === 'dayPeriod');
}

/**
 * Where that answer came from, so the note under the picker can say. "Automatic"
 * being wrong is a great deal easier to understand when the screen admits it is
 * reading the browser's language rather than the phone.
 */
export const clockSource = () => (deviceCycle() ? 'device' : 'browser');

const at = (value) => (value instanceof Date ? value : new Date(value));

/** "14:20" or "02:20 PM". */
export const formatTime = (value) => time.format(at(value));
/** "3 Jun, 14:20". */
export const formatDayTime = (value) => dayTime.format(at(value));
/** "Wed, 3 Jun 2026, 14:20". */
export const formatFull = (value) => full.format(at(value));
