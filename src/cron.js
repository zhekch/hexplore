// A five-field cron parser, in local time, with no dependencies.
//
// In src/ rather than server/ because both ends read it: the server to know
// when the next backup is due, the dialog to say "Every day at 04:00" under the
// field while you're still choosing. One parser, one meaning.
//
// The backup schedule is offered two ways — a picker ("every day at 04:00") and
// a typed expression — and both have to mean the same thing, so the picker
// composes an expression and this file is the only thing that reads one. There
// is exactly one schedule format in the database and exactly one place that
// knows what it means.
//
//   ┌─ minute (0–59)
//   │ ┌─ hour (0–23)
//   │ │ ┌─ day of month (1–31)
//   │ │ │ ┌─ month (1–12, or JAN–DEC)
//   │ │ │ │ ┌─ day of week (0–7, 0 and 7 are both Sunday, or SUN–SAT)
//   0 4 * * *      → every day at 04:00
//   */15 * * * *   → every quarter of an hour
//   0 3 * * mon    → Mondays at 03:00
//
// Each field takes `*`, a number, `a-b`, a `,`-separated list of either, and a
// `/step` on any of those. The `@daily`-style macros are accepted too, because
// they're what people type first.
//
// Local time, not UTC: "back up at 4am" means 4am where the machine is. That
// makes the twice-yearly clock change a real edge — see next() for what it does
// about it.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of the week', min: 0, max: 7 },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** Longest a search for the next firing is allowed to run before giving up. */
const MAX_DAYS_AHEAD = 366 * 5;

function fieldValue(token, field) {
  const t = token.toLowerCase();
  if (field.name === 'month') {
    const i = MONTHS.indexOf(t);
    if (i >= 0) return i + 1;
  }
  if (field.name === 'day of the week') {
    const i = DAYS.indexOf(t);
    if (i >= 0) return i;
  }
  if (!/^\d+$/.test(t)) throw new Error(`"${token}" is not a ${field.name}`);
  const n = Number(t);
  if (n < field.min || n > field.max) {
    throw new Error(`${field.name} must be ${field.min}–${field.max}, not ${n}`);
  }
  return n;
}

// One field → the sorted set of values it allows. Kept as a Set because that's
// what next() asks it, one candidate at a time.
function parseField(spec, field) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`empty ${field.name}`);
    const [range, stepText, ...rest] = piece.split('/');
    if (rest.length) throw new Error(`"${piece}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`"${stepText}" is not a step`);
      }
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (range === '*') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = fieldValue(a, field);
      hi = fieldValue(b, field);
      if (hi < lo) throw new Error(`${field.name} range ${range} runs backwards`);
    } else {
      lo = fieldValue(range, field);
      // A bare number with a step means "from here on", which is how `0/6`
      // reads everywhere else cron is written.
      hi = stepText === undefined ? lo : field.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error(`nothing matches in the ${field.name}`);
  return out;
}

/**
 * Parse a cron expression. Throws with a readable message if it can't — that
 * message goes straight into the dialog, so it's written for a person.
 *
 * @param {string} expr
 * @returns {{expr:string, minute:Set<number>, hour:Set<number>, dom:Set<number>,
 *            month:Set<number>, dow:Set<number>, domRestricted:boolean, dowRestricted:boolean}}
 */
export function parseCron(expr) {
  const text = String(expr ?? '').trim().toLowerCase();
  if (!text) throw new Error('A schedule is needed.');
  const expanded = MACROS[text] ?? text;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`A schedule has five fields (minute hour day month weekday) — this has ${parts.length}.`);
  }
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]));
  // 7 and 0 are both Sunday. Fold them together so the rest of the file only
  // ever sees 0–6.
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    expr: parts.join(' '),
    minute,
    hour,
    dom,
    month,
    dow,
    // Cron's one genuinely strange rule: when *both* day fields are narrowed,
    // a day matching either one fires. `0 0 13 * fri` is the 13th and every
    // Friday, not only Friday the 13th.
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** True if the expression is one this file can read. */
export function isValidCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c, date) {
  if (!c.month.has(date.getMonth() + 1)) return false;
  const dom = c.dom.has(date.getDate());
  const dow = c.dow.has(date.getDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

/**
 * The first firing strictly after `from`, or null if the expression describes
 * something that never comes round again (29 February in a month that isn't).
 *
 * Days are walked one at a time and only the matching ones have their minutes
 * looked at, so a once-a-year schedule costs a few hundred cheap comparisons
 * rather than half a million.
 *
 * @param {string|object} expr an expression or an already-parsed one
 * @param {Date} [from]
 * @returns {Date|null}
 */
export function nextRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  // Cron fires on the minute, and "next" means the next one after this — a
  // schedule due at 04:00 asked at 04:00:30 answers tomorrow, not thirty
  // seconds ago.
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const minutes = [...c.minute].sort((a, b) => a - b);
  const hours = [...c.hour].sort((a, b) => a - b);

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    if (dayMatches(c, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
          if (at.getTime() < start.getTime()) continue;
          // The hour the clocks skip doesn't exist, and Date lands on the one
          // after it. Taking that is the right answer for a backup: the job
          // runs on the day it was asked to, a little later than usual, rather
          // than being silently dropped once a year.
          return at;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/**
 * The most recent firing at or before `from` — how the scheduler works out, on
 * startup, whether it slept through one.
 *
 * @param {string|object} expr
 * @param {Date} [from]
 * @returns {Date|null}
 */
export function previousRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);

  const minutes = [...c.minute].sort((a, b) => b - a);
  const hours = [...c.hour].sort((a, b) => b - a);

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    if (dayMatches(c, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
          if (at.getTime() > start.getTime()) continue;
          return at;
        }
      }
    }
    day.setDate(day.getDate() - 1);
  }
  return null;
}

const two = (n) => String(n).padStart(2, '0');

// "1, 2 and 5" — used by describeCron, which is prose, so it reads like prose.
function list(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][n % 100] ?? 'th';
  return `${n}${s}`;
};

/**
 * A plain-English reading of an expression, for the line under the field. It
 * covers the shapes the picker can produce and the ones people actually type;
 * anything more exotic gets the expression back, which is honest — a wrong
 * description is worse than none.
 *
 * @param {string} expr
 * @returns {string}
 */
export function describeCron(expr) {
  let c;
  try {
    c = parseCron(expr);
  } catch {
    return String(expr ?? '');
  }
  const [minSpec, hourSpec, domSpec, monthSpec, dowSpec] = c.expr.split(' ');
  const everyMinute = c.minute.size === 60;
  const everyHour = c.hour.size === 24;

  // Where in the day: "at 04:00", "at 04:00 and 16:00", "every 15 minutes".
  let time;
  if (everyMinute && everyHour) time = 'Every minute';
  else if (everyMinute) time = `Every minute of ${list([...c.hour].map((h) => `${two(h)}:00`))}`;
  else if (/^\*\/\d+$/.test(minSpec) && everyHour) time = `Every ${Number(minSpec.slice(2))} minutes`;
  else if (everyHour && c.minute.size === 1) time = `Every hour at :${two([...c.minute][0])}`;
  else if (/^\*\/\d+$/.test(hourSpec) && c.minute.size === 1) {
    const step = Number(hourSpec.slice(2));
    const at = two([...c.minute][0]);
    time = step === 1 ? `Every hour at :${at}` : `Every ${step} hours, at :${at}`;
  } else if (c.minute.size * c.hour.size <= 6) {
    const times = [];
    for (const h of [...c.hour].sort((a, b) => a - b)) {
      for (const m of [...c.minute].sort((a, b) => a - b)) times.push(`${two(h)}:${two(m)}`);
    }
    time = `At ${list(times)}`;
  } else return c.expr;

  // Which days: the default is every one, and saying so adds nothing.
  const parts = [];
  if (c.dowRestricted) {
    parts.push(`on ${list([...c.dow].sort((a, b) => a - b).map((d) => `${DAY_NAMES[d]}s`))}`);
  }
  if (c.domRestricted) {
    parts.push(`on the ${list([...c.dom].sort((a, b) => a - b).map(ordinal))}`);
  }
  if (monthSpec !== '*') {
    parts.push(`in ${list([...c.month].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]))}`);
  }
  if (!parts.length && !everyMinute && !/^\*\/\d+$/.test(hourSpec) && !everyHour) {
    parts.push('every day');
  }
  // "on Mondays and on the 1st" is the OR rule above, said out loud.
  return [time, parts.join(' and ')].filter(Boolean).join(' ');
}
