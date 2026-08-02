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

/** 'auto' follows the browser; '12' and '24' override it. */
export const CLOCK_MODES = ['auto', '24', '12'];

let mode = 'auto';
let time;
let dayTime;
let full;

function build() {
  // `hour12` is left *absent* on auto rather than set to a guess. Absent is the
  // only value that means "use the locale's own convention", which is not the
  // same as either true or false — some locales are neither, and a few write
  // 24-hour clocks with an h24 cycle this would otherwise flatten.
  const h = mode === 'auto' ? {} : { hour12: mode === '12' };
  time = new Intl.DateTimeFormat(undefined, { ...TIME, ...h });
  dayTime = new Intl.DateTimeFormat(undefined, { ...DAY, ...TIME, ...h });
  full = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', ...DAY, year: 'numeric', ...TIME, ...h,
  });
}
build();

/** The account's choice. Anything unrecognised falls back to following the browser. */
export function setClock(next) {
  const wanted = CLOCK_MODES.includes(next) ? next : 'auto';
  if (wanted === mode) return false;
  mode = wanted;
  build();
  return true;
}

export const clockMode = () => mode;

/**
 * What the browser would say on its own — used to label the `auto` option with
 * the answer it is actually going to give, because "Automatic" alone tells you
 * nothing about which of the two you are getting.
 */
export const localIs24Hour = () => !new Intl.DateTimeFormat(undefined, TIME)
  .formatToParts(new Date(2020, 0, 1, 13))
  .some((p) => p.type === 'dayPeriod');

const at = (value) => (value instanceof Date ? value : new Date(value));

/** "14:20" or "02:20 PM". */
export const formatTime = (value) => time.format(at(value));
/** "3 Jun, 14:20". */
export const formatDayTime = (value) => dayTime.format(at(value));
/** "Wed, 3 Jun 2026, 14:20". */
export const formatFull = (value) => full.format(at(value));
