// Search: one field over the whole map, and a calendar beside it.
//
// The map holds three kinds of thing you might be looking for and, until now,
// no way to ask for any of them by name. A place you want to go and look at
// ("was I ever in Trondheim?"), a route you remember by what it was called, and
// a trip you remember by *when* — which is the one a text field is worst at.
// Hence the calendar: dates are the one query people know exactly and type
// badly, and a month grid with the days you were somewhere already dotted
// answers "what was that weekend in August" without anyone typing anything.
//
// Everything here is local. Place names come from the dataset already shipped
// for naming routes (src/places.js), so a search never sends a keystroke or a
// coordinate anywhere.

import { loadPlaces, searchPlaces } from './places.js';
import { loadRegions, searchRegions } from './regions.js';
import { loadCountries, searchCountries, countryIdAt } from './countries.js';
import { dayKey, dayDetail } from './trips.js';
import { mountCalendar, MONTHS } from './calendar.js';
import { formatDistance } from './routes.js';
import { onBackdropClick } from './dismiss.js';
import { fold, matchRank } from './fold.js';


const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const spanFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const fmtDay = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : '');

function tripDates(t) {
  if (!t) return '';
  const a = new Date(t.start * 1000);
  const b = new Date(t.end * 1000);
  const sameDay = dayKey(t.start) === dayKey(t.end);
  return sameDay ? dayFmt.format(a) : `${spanFmt.format(a)} – ${dayFmt.format(b)}`;
}

// A typed date, in the forms people actually type. Returns one of
//
//   "YYYY-MM-DD"  one day
//   "YYYY-MM"     one month
//   "YYYY"        one year
//   "--MM-DD"     that day in every year   (ISO 8601's own "date without year")
//   "--MM"        that month in every year
//
// or null. Deliberately strict about which number is the day: 3/4 is ambiguous
// in a way no amount of guessing fixes, so only the unambiguous separators and
// orders are read — which is also why a day without a year is only accepted
// when the month is spelled out. "10 15" could be anything; "15 october" and
// "october 15" could not.
const MONTH_AT = (word) => {
  const w = String(word).toLowerCase();
  // Whole names first, so "mar" can't be beaten by "March" losing to "May" —
  // and abbreviations only when exactly one month starts that way, so "ju" is
  // no month at all rather than quietly meaning June.
  const exact = MONTHS.findIndex((n) => n.toLowerCase() === w);
  if (exact >= 0) return exact;
  const hits = MONTHS.map((n, i) => [n, i]).filter(([n]) => n.toLowerCase().startsWith(w));
  return hits.length === 1 ? hits[0][1] : -1;
};
const pad = (n) => String(n).padStart(2, '0');
const dayOk = (mi, d) => d >= 1 && d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mi];

export function parseDateQuery(text) {
  const q = String(text ?? '').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!q) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{4})-(\d{1,2})$/.exec(q);
  if (m) return `${m[1]}-${pad(+m[2])}`;
  // 12.08.2024 and 12/08/2024 — day first, as written everywhere this app is
  // likely to be read.
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(q);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;

  // Everything with the month spelled out, in any order people write it:
  // "october 15", "15 october", "october 15 2025", "2025 october 15",
  // "october 2025", "2025 october", "october".
  const words = q.split(' ');
  const monthWord = words.findIndex((w) => /^[a-zA-Z]{3,}$/.test(w) && MONTH_AT(w) >= 0);
  if (monthWord >= 0 && words.every((w, i) => i === monthWord || /^\d{1,4}$/.test(w))) {
    const mi = MONTH_AT(words[monthWord]);
    const nums = words.filter((_, i) => i !== monthWord).map(Number);
    if (nums.length > 2) return null;
    const year = nums.find((n) => n >= 1000);
    const day = nums.find((n) => n < 1000);
    if (nums.some((n) => n >= 1000 && (n < 1990 || n > 2100))) return null;
    if (day !== undefined && !dayOk(mi, day)) return null;
    if (year !== undefined && day !== undefined) return `${year}-${pad(mi + 1)}-${pad(day)}`;
    if (year !== undefined) return `${year}-${pad(mi + 1)}`;
    if (day !== undefined) return `--${pad(mi + 1)}-${pad(day)}`;
    return `--${pad(mi + 1)}`;
  }

  // A bare year is a month query for January… but reading "2024" as a date at
  // all would swallow every text search for a number, so it stays a year.
  if (/^\d{4}$/.test(q) && +q >= 1990 && +q <= 2100) return q;
  return null;
}

// Everything a trip is findable by, in the order of how much each says about
// where the trip *was*. The name is what it is called; the tags are everywhere
// it merely went.
const TRIP_FIELDS = [(t) => t.name, (t) => t.place, (t) => t.region, (t) => t.country,
  (t) => (t.tags ?? []).join(' ')];

/**
 * How well a trip answers a typed query — lower is better, `Infinity` for no
 * match at all. Which field matched, and then how much of that field the query
 * was, so an exact name beats a name starting with it, which beats a name
 * containing it, which beats the same three on the canton underneath.
 *
 * Sorted on before anything else, because the alternative was sorting matches by
 * date: a fortnight actually spent in Zürich came out below a weekend in
 * St. Moritz that had merely driven through it, and the list gave no clue why.
 *
 * @param {object} t a derived trip
 * @param {string} q the query, already folded (src/fold.js)
 */
export function tripRelevance(t, q) {
  if (!q) return 0;
  let best = Infinity;
  for (let i = 0; i < TRIP_FIELDS.length; i++) {
    const rank = matchRank(fold(TRIP_FIELDS[i](t)), q);
    if (rank >= 0 && i * 3 + rank < best) best = i * 3 + rank;
  }
  return best;
}

/**
 * Was this trip happening during that month, or that year?
 *
 * A trip is a span, so this is an overlap and not a lookup: the fortnight that
 * started on the 28th of August belongs to September as much as to August, and
 * somebody typing "September 2023" is asking what they were doing then — not
 * which trips happened to begin in it.
 *
 * Compared on the *prefix* of each end's day key, which is the whole reason
 * dates are written biggest-part-first: `"2023-08" <= "2023-09"` is true and
 * `"2023-10" <= "2023-09"` is not, with no arithmetic and no month lengths. Both
 * ends are keyed by `dayKey`, the same function the calendar keys its days with,
 * so a trip cannot land in one and not the other.
 *
 * @param {{start:number, end:number}} t a derived trip
 * @param {string} period `YYYY` or `YYYY-MM`
 */
export function tripInPeriod(t, period) {
  const n = period.length;
  return dayKey(t.start).slice(0, n) <= period && dayKey(t.end).slice(0, n) >= period;
}

/**
 * @param {object} opts
 * @param {() => Array<object>} opts.trips    derived trips, newest first
 * @param {() => Array<object>} opts.routes   saved routes
 * @param {() => Map<string, {cells:number, routes:number}>} opts.days  active days
 * @param {() => Map<string, Array>} opts.meta cell provenance, for a day's detail
 * @param {(lngLat:{lng:number, lat:number}, opts?:object) => void} opts.onPlace
 * @param {(area:{kind:string, id:string, name:string, of:string|null,
 *   bbox:Array<number>}) => void} [opts.onArea] a whole region or country,
 *   which is a shape rather than a point — see the region section below
 * @param {(trip:object) => void} opts.onTrip
 * @param {(route:object) => void} opts.onRoute
 * @param {(key:string, detail:object) => void} [opts.onDay] show one day's
 *   ground on the map
 * @param {() => Set<string>} [opts.hiddenTrips] ids of trips put away
 * @param {(id:string|null, hide:boolean) => Promise<void>} [opts.onHideTrip]
 * @param {() => void} [opts.onOpen] called every time it opens, however it was
 *   opened — the trips it lists are derived lazily and this is what starts that
 */
export function mountSearch({
  trips, routes, days, meta, onPlace, onArea, onTrip, onRoute, onDay,
  hiddenTrips = () => new Set(), onHideTrip, onOpen,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('search-overlay');
  const input = $('search-input');
  const resultsEl = $('search-results');
  const calBtn = $('search-cal-btn');
  const calEl = $('search-calendar');
  const calTitle = $('search-cal-title');
  const calGrid = $('search-cal-grid');
  const calPrev = $('search-cal-prev');
  const calNext = $('search-cal-next');

  let calOpen = false;
  let items = []; // what's currently listed, for keyboard selection
  let active = -1;

  // On a screen wide enough to hold both, the calendar is not a panel you open
  // — it is the right-hand half of the palette, and it is simply always there.
  // The query has to match the one in src/style.css that lays the two out side
  // by side: the CSS decides where the grid goes and this decides whether it
  // exists, and a palette whose two halves disagree shows an empty column or a
  // grid nothing can reach.
  const twoColumn = window.matchMedia('(min-width: 720px) and (min-height: 560px)');
  const calPinned = () => twoColumn.matches;

  // Trips live here rather than in a tab of their own. They used to be in both
  // — this palette listed them, and Routes and statistics listed them again
  // with its own field and its own calendar — which is two menus doing one
  // thing. This is the one, because it is the one you can reach with ⌘K.
  const TRIP_SORTS = {
    recent: { label: 'Newest', sort: (a, b) => b.start - a.start },
    days: { label: 'Longest', sort: (a, b) => b.days - a.days || b.start - a.start },
    far: { label: 'Furthest', sort: (a, b) => b.farKm - a.farKm || b.start - a.start },
  };
  // Grouping is one thing you either want or don't, so it is one pill rather
  // than a pair — "Flat" was a name for the absence of the other side, and a
  // segmented control with an off-switch in it reads as two ways of grouping.
  const TRIP_GROUPS = {
    none: {},
    country: { label: 'By country', of: (t) => t.country || '' },
  };
  let tripSort = 'recent';
  let tripGroup = 'none';

  // The grid itself lives in src/calendar.js — the Trips tab shows the same one.
  const cal = mountCalendar({
    title: calTitle,
    grid: calGrid,
    days,
    trips,
    onPick: (key) => selectDay(key),
  });

  // --- Results ----------------------------------------------------------------

  function resultRow({ icon, title, sub, right, onPick }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'search-hit';
    el.innerHTML =
      `<span class="search-hit-icon">${icon}</span>`
      + '<span class="search-hit-text"><b></b><small></small></span>'
      + '<span class="search-hit-right"></span>';
    el.querySelector('b').textContent = title;
    el.querySelector('small').textContent = sub ?? '';
    el.querySelector('.search-hit-right').textContent = right ?? '';
    el.addEventListener('click', onPick);
    return el;
  }

  const ICON = {
    place: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
    trip: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19c4-1 6-9 9-9s4 4 9 3"/><circle cx="3" cy="19" r="1.6"/><circle cx="21" cy="13" r="1.6"/></svg>',
    route: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20c0-6 6-4 6-9a3 3 0 0 0-6 0"/><path d="M13 4h6v6"/><path d="M19 4l-6 6"/></svg>',
    area: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 9 5l6 2.5L21 5v11.5L15 19l-6-2.5L3 19Z"/><path d="M9 5v11.5M15 7.5V19"/></svg>',
    day: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  };

  function section(label, aside) {
    const el = document.createElement('div');
    el.className = 'search-section';
    const name = document.createElement('span');
    name.textContent = label;
    el.append(name);
    if (aside) el.append(aside);
    return el;
  }

  // --- The trips browser -------------------------------------------------------

  /** A segmented control that redraws the list when you pick a side. */
  function seg(options, current, onPick) {
    const el = document.createElement('div');
    el.className = 'seg seg-mini';
    for (const [key, opt] of Object.entries(options)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${key === current ? ' active' : ''}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => onPick(key));
      el.append(btn);
    }
    return el;
  }

  /** One pill that is either on or off — a segmented control with one side. */
  function segToggle(label, on, onPick) {
    const el = document.createElement('div');
    el.className = 'seg seg-mini';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `seg-btn${on ? ' active' : ''}`;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', () => onPick(!on));
    el.append(btn);
    return el;
  }

  /** A caption over a control, so a row of pills says what it is deciding. */
  function controlGroup(caption, control) {
    const el = document.createElement('div');
    el.className = 'control-group';
    const cap = document.createElement('span');
    cap.className = 'control-cap';
    cap.textContent = caption;
    el.append(cap, control);
    return el;
  }

  function tripControls() {
    const wrap = document.createElement('div');
    wrap.className = 'stats-controls';
    wrap.append(
      controlGroup('Sort by', seg(TRIP_SORTS, tripSort, (k) => {
        tripSort = k;
        render(input.value);
      })),
      controlGroup('Filter by', segToggle(TRIP_GROUPS.country.label, tripGroup === 'country', (on) => {
        tripGroup = on ? 'country' : 'none';
        render(input.value);
      })),
    );
    return wrap;
  }

  function tripRow(t) {
    const el = document.createElement('div');
    el.className = 'trip-row';
    const go = resultRow({
      icon: ICON.trip,
      title: t.name,
      sub: `${tripDates(t)} · ${t.cells.length.toLocaleString()} cells${t.routes.length ? ` · ${t.routes.length} route${t.routes.length === 1 ? '' : 's'}` : ''}`,
      right: t.farKm ? `${t.farKm} km away` : '',
      onPick: () => {
        close();
        onTrip?.(t);
      },
    });
    go.classList.add('trip-go');
    // Putting one away is one press, because it is completely reversible — the
    // trip is still derived, it is just skipped, and the row under the list
    // brings every one of them back.
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'trip-hide';
    hide.setAttribute('aria-label', `Hide ${t.name}`);
    hide.title = 'Hide this trip';
    hide.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    hide.addEventListener('click', async () => {
      await onHideTrip?.(t.id, true);
      render(input.value);
    });
    el.append(go, hide);
    items.push({ el: go, pick: () => go.click() });
    return el;
  }

  /**
   * The list, optionally in blocks. The sort holds inside each one — under the
   * relevance ranking, which is flat (every trip 0) when nothing is typed and
   * so decides nothing then.
   */
  function tripList(list, rank) {
    const out = [];
    const ordered = (l) =>
      [...l].sort((a, b) => rank.get(a) - rank.get(b) || TRIP_SORTS[tripSort].sort(a, b));
    const group = TRIP_GROUPS[tripGroup];
    if (!group.of) {
      for (const t of ordered(list)) out.push(tripRow(t));
      return out;
    }
    const buckets = new Map();
    for (const t of list) {
      const key = group.of(t);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    // Best answer first between the blocks too, on the block's best trip —
    // otherwise grouping by country buries the one trip you searched for under
    // whichever country you happen to have the most of. Flat with nothing typed,
    // where every trip scores 0.
    const bestOf = (l) => Math.min(...l.map((t) => rank.get(t)));
    const blocks = [...buckets.entries()]
      .sort((a, b) => !a[0] - !b[0] || bestOf(a[1]) - bestOf(b[1])
        || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [key, group2] of blocks) {
      const head = document.createElement('div');
      head.className = 'search-section search-subsection';
      const name = document.createElement('span');
      name.textContent = key || 'At sea or off the map';
      const note = document.createElement('i');
      const days = group2.reduce((n, t) => n + t.days, 0);
      note.textContent = `${group2.length} · ${days} day${days === 1 ? '' : 's'}`;
      head.append(name, note);
      out.push(head, ...ordered(group2).map(tripRow));
    }
    return out;
  }

  function hiddenRow(put) {
    const el = document.createElement('div');
    el.className = 'home-row';
    el.append(cardLine(
      `${put.size} trip${put.size === 1 ? '' : 's'} hidden`,
      'Runs you told the list to forget',
      'Show them',
      async () => {
        await onHideTrip?.(null, false);
        render(input.value);
      },
    ));
    return el;
  }

  /** "15 October" / "October", written out. */
  function recurringLabel(pattern) {
    // "--10-15" splits into four parts, not three: the leading "--" is two
    // empty ones. Slicing them off first is the whole of the difference.
    const [mo, d] = pattern.slice(2).split('-');
    return d ? `${+d} ${MONTHS[+mo - 1]}` : MONTHS[+mo - 1];
  }

  /**
   * Every year that has something on a date with no year in it. One row per
   * year, newest first, each opening that day the way the calendar does — the
   * question "what was I doing on my birthday" has as many answers as you have
   * birthdays, and picking between them is the point.
   */
  function addRecurring(pattern) {
    const [mo, dd] = pattern.slice(2).split('-');
    const hits = [...days().entries()]
      .filter(([key]) => (dd ? key.endsWith(`-${mo}-${dd}`) : key.slice(5, 7) === mo))
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));
    if (!hits.length) return false;
    // A whole month has as many days as it has; a single date has one per year.
    const byYear = new Map();
    for (const [key, has] of hits) {
      const y = key.slice(0, 4);
      const e = byYear.get(y) ?? { cells: 0, routes: 0, days: 0, first: key };
      e.cells += has.cells;
      e.routes += has.routes;
      e.days++;
      e.first = key; // the list is newest first, so this ends on the earliest
      byYear.set(y, e);
    }
    resultsEl.append(section(recurringLabel(pattern)));
    for (const [key, has] of dd ? hits : []) {
      addDayRow(key, has);
    }
    if (!dd) {
      for (const [y, e] of byYear) {
        const el = resultRow({
          icon: ICON.day,
          title: `${MONTHS[+mo - 1]} ${y}`,
          sub: [
            `${e.days} day${e.days === 1 ? '' : 's'} recorded`,
            e.cells ? `${e.cells.toLocaleString()} new cells` : '',
            e.routes ? `${e.routes} route${e.routes === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(' · '),
          onPick: () => {
            cal.show(new Date(+y, +mo - 1, 1));
            openCalendar(true);
            renderCalendar();
            input.value = `${MONTHS[+mo - 1]} ${y}`;
            render(input.value);
          },
        });
        resultsEl.append(el);
        items.push({ el, pick: () => el.click() });
      }
    }
    return true;
  }

  /** One day, as a row you can open — the same thing a calendar dot means. */
  function addDayRow(key, has) {
    const [y, m, d] = key.split('-').map(Number);
    const el = resultRow({
      icon: ICON.day,
      title: dayFmt.format(new Date(y, m - 1, d)),
      sub: [
        has.cells ? `${has.cells.toLocaleString()} new cell${has.cells === 1 ? '' : 's'}` : '',
        has.routes ? `${has.routes} route${has.routes === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ') || 'nothing new',
      onPick: () => {
        cal.show(new Date(y, m - 1, 1));
        openCalendar(true);
        selectDay(key);
      },
    });
    resultsEl.append(el);
    items.push({ el, pick: () => el.click() });
  }

  /**
   * A month or a year, answered with the trips inside it as well as the grid.
   *
   * Typing a date used to open the calendar and stop there, which is a complete
   * answer only if you already know which day you want. "2023" is not a day and
   * cannot become one by being shown January: the thing being asked for is the
   * year's trips, and a grid that can only stand on one month at a time is the
   * wrong shape to give them in.
   */
  function addPeriod(period) {
    const [y, mo] = period.split('-');
    const label = `${mo ? `${MONTHS[+mo - 1]} ` : ''}${y}`;
    const put = hiddenTrips();
    const list = trips().filter((t) => !put.has(t.id) && tripInPeriod(t, period));
    if (!list.length) {
      resultsEl.append(note(`No trips in ${label} — pick a day from the calendar for what else is on it.`));
      return;
    }
    resultsEl.append(section(`Trips in ${label}`));
    // The same controls the whole list carries, because this is the same list
    // narrowed to a span — and a year is exactly the width at which "longest"
    // and "furthest" start being the interesting questions.
    resultsEl.append(tripControls());
    // Every one of them is as good an answer as the others: nothing was typed
    // that one trip could match better than another, so the chosen sort decides
    // the order outright.
    resultsEl.append(...tripList(list, new Map(list.map((t) => [t, 0]))));
  }

  /** The trips section: all of them when nothing is typed, matches when it is. */
  function addTrips(q) {
    const put = hiddenTrips();
    // Scored once, here, rather than inside the comparator: the sort would ask
    // the same question of the same trip a dozen times over.
    const rank = new Map();
    for (const t of trips()) {
      if (put.has(t.id)) continue;
      const r = tripRelevance(t, q);
      if (r < Infinity) rank.set(t, r);
    }
    if (!rank.size) return false;
    resultsEl.append(section(q ? 'Trips' : 'Your trips'));
    // On their own line, centred. Beside the heading they had to share a row
    // barely wide enough for one of them, and "Your trips" wrapped to two lines
    // to make room.
    if (!q) resultsEl.append(tripControls());
    resultsEl.append(...tripList([...rank.keys()], rank));
    if (!q && put.size) resultsEl.append(hiddenRow(put));
    return true;
  }

  /**
   * Whole regions and countries, when the boundary data is already in memory
   * (deriving the trips pulls it in). Asking for a canton is a different request
   * from flying to a town in it, and both are things people type.
   *
   * **First, above everything else.** "Zürich" is a canton, a city, a lake and
   * an airport, and the four are indistinguishable in a list unless something
   * says which is which — so the row is titled *Canton Zürich*, with the word in
   * front of the name rather than in the grey line underneath it. That line is
   * still there and still says which country, but a caption you have to look
   * for cannot be what distinguishes two rows with the same word on them.
   *
   * Answered with the shape, not with a point in it. A pin needs a coordinate,
   * and the only one an area has for free is the middle of its bounding box —
   * which for anything that isn't a rectangle is not in the area at all: the
   * middle of the United States' box is in Puget Sound, and Hawaii's is open
   * ocean. See **Searching for a region** in ARCHITECTURE.md.
   */
  function addAreas(q) {
    const hits = [...searchRegions(q, 3), ...searchCountries(q, 2)];
    if (!hits.length) return false;
    resultsEl.append(section('Regions and countries'));
    for (const a of hits) {
      const el = resultRow({
        icon: ICON.area,
        title: a.kind === 'region' ? `${a.name} ${a.term}` : a.name,
        sub: a.kind === 'region' ? a.country : 'Country',
        onPick: () => {
          close();
          onArea?.({
            kind: a.kind, id: a.id, name: a.name,
            of: a.kind === 'region' ? a.country : null,
            bbox: a.bbox,
          });
        },
      });
      resultsEl.append(el);
      items.push({ el, pick: () => el.click() });
    }
    return true;
  }

  function note(text) {
    const el = document.createElement('div');
    el.className = 'search-note';
    el.textContent = text;
    return el;
  }

  function setActive(i) {
    active = i;
    for (let n = 0; n < items.length; n++) items[n].el.classList.toggle('active', n === i);
    items[i]?.el.scrollIntoView({ block: 'nearest' });
  }

  function render(query) {
    resultsEl.replaceChildren();
    items = [];
    active = -1;
    const q = query.trim();

    // A date typed into the box is a date, not a text search — and it opens the
    // calendar on that month rather than answering with a list, because the
    // next thing you want is the days around it.
    const asDate = parseDateQuery(q);
    // "October 15" and "October" name a date with no year in it, which is a
    // question about every year at once — the calendar can only stand on one
    // month, so this one is answered with a list instead.
    if (asDate?.startsWith('--')) {
      const anyYears = addRecurring(asDate);
      // A bare month is also a place: March is a town, and May is a name. A
      // day-and-month is neither, so only the month falls through to the rest
      // of the search.
      if (asDate.length > 4) {
        if (!anyYears) resultsEl.append(note(`Nothing recorded on ${recurringLabel(asDate)}, in any year.`));
        return;
      }
    } else if (asDate) {
      const [y, mo, d] = asDate.split('-');
      cal.show(new Date(+y, mo ? +mo - 1 : 0, 1));
      openCalendar(true);
      if (d) selectDay(asDate);
      else {
        renderCalendar();
        addPeriod(asDate);
      }
      return;
    }

    // Folded, once, for everything below: a query is typed on whatever keyboard
    // is to hand, and "zurich" has to reach Zürich whether it is a town, a
    // canton, a route or the fortnight you spent there.
    const lower = fold(q);

    // Regions and countries first, because they are the answers most easily
    // mistaken for something else in a list — and because they are the smallest
    // section, so putting them anywhere but the top buries them under a dozen
    // trips. Empty until two characters are typed, so this costs nothing on the
    // trip browser below.
    addAreas(q);

    // Then the trips. With nothing typed this is the whole list, with its own
    // ordering and grouping — the trips browser, not a preview of one. Typing
    // narrows it, on everything a trip is called *and* everywhere it went, so
    // "valais" finds the week in Zermatt and so does the name of a town it
    // merely drove through.
    const anyTrips = addTrips(lower);
    if (!q) {
      if (!anyTrips) {
        resultsEl.append(note('Search for a place, a route, or a date — or pick a day from the calendar.'));
      }
      return;
    }

    const routeHits = routes()
      .filter((r) => fold(`${r.name} ${r.place ?? ''} ${r.sport ?? ''}`).includes(lower))
      .slice(0, 5);
    if (routeHits.length) {
      resultsEl.append(section('Routes'));
      for (const r of routeHits) {
        const el = resultRow({
          icon: ICON.route,
          title: r.name,
          sub: [r.place, r.sport, fmtDay(r.firstAt)].filter(Boolean).join(' · '),
          right: r.lengthM ? formatDistance(r.lengthM) : '',
          onPick: () => {
            close();
            onRoute?.(r);
          },
        });
        resultsEl.append(el);
        items.push({ el, pick: () => el.click() });
      }
    }

    // Places last: they're the fallback when nothing of yours matched, and the
    // dataset is big enough to bury four real answers under eight villages.
    const placeHits = searchPlaces(q, 6);
    if (placeHits.length) {
      resultsEl.append(section('Places'));
      for (const p of placeHits) {
        // "Paris" is four towns and one of them is in Texas. The country is the
        // one word that tells them apart, and it belongs in the title rather
        // than the sub-line: it is part of the name of the place, not a fact
        // about it. Free, because the boundaries are already in memory — the
        // trips derivation pulls them in — and simply absent until they are.
        const country = countryIdAt(p.lng, p.lat);
        const el = resultRow({
          icon: ICON.place,
          title: country ? `${p.name}, ${country}` : p.name,
          sub: p.kind === 'lake' ? 'Lake' : p.pop ? `${p.pop.toLocaleString()},000 people` : 'Town',
          onPick: () => {
            close();
            onPlace?.({ lng: p.lng, lat: p.lat }, { bounds: p.bounds });
          },
        });
        resultsEl.append(el);
        items.push({ el, pick: () => el.click() });
      }
    }

    if (!items.length) {
      resultsEl.append(
        note(
          q.length < 2 ? 'Keep typing…'
          // Nothing found *yet* is not the same answer as nothing to find, and
          // the place data is a megabyte that starts arriving on the first
          // keystroke — long enough for "Nothing matches Bern" to appear and
          // then be replaced by Bern.
          : !ready ? 'Looking up places…'
          : `Nothing matches “${q}”. Try a town, a canton or country, a route name, an activity, or a date like 2024-08-12.`,
        ),
      );
    }
  }

  function addTrip(t) {
    const el = resultRow({
      icon: ICON.trip,
      title: t.name,
      sub: `${tripDates(t)} · ${t.cells.length.toLocaleString()} cells${t.routes.length ? ` · ${t.routes.length} route${t.routes.length === 1 ? '' : 's'}` : ''}`,
      right: t.farKm ? `${t.farKm} km away` : '',
      onPick: () => {
        close();
        onTrip?.(t);
      },
    });
    resultsEl.append(el);
    items.push({ el, pick: () => el.click() });
  }

  // --- The calendar -----------------------------------------------------------

  const renderCalendar = () => cal.render();

  function selectDay(key) {
    cal.select(key);
    const detail = dayDetail(key, trips(), routes(), meta());
    resultsEl.replaceChildren();
    items = [];
    const [y, m, d] = key.split('-').map(Number);
    const label = dayFmt.format(new Date(y, m - 1, d));
    resultsEl.append(section(label));
    if (!detail.routes.length && !detail.cells && !detail.trip) {
      resultsEl.append(note('Nothing recorded that day.'));
      return;
    }
    // The day itself, as somewhere to go. A dot in the grid used to be the end
    // of the road: it told you the day had ground on it and gave you no way to
    // look at it unless it happened to belong to a trip or carry a route.
    if (detail.cells) {
      const el = resultRow({
        icon: ICON.day,
        title: label,
        sub: `${detail.cells.toLocaleString()} cell${detail.cells === 1 ? '' : 's'}${
          detail.newCells ? `, ${detail.newCells.toLocaleString()} new` : ''
        }`,
        right: 'Show',
        onPick: () => {
          close();
          onDay?.(key, { ...detail, label });
        },
      });
      resultsEl.append(el);
      items.push({ el, pick: () => el.click() });
    }
    if (detail.trip) {
      addTrip(detail.trip);
    }
    for (const r of detail.routes) {
      const el = resultRow({
        icon: ICON.route,
        title: r.name,
        sub: [r.place, r.sport].filter(Boolean).join(' · '),
        right: r.lengthM ? formatDistance(r.lengthM) : '',
        onPick: () => {
          close();
          onRoute?.(r);
        },
      });
      resultsEl.append(el);
      items.push({ el, pick: () => el.click() });
    }
    // The counts live on the day's own row now — all this adds is whether the
    // ground was new, which is the one thing that row's sub-line can't say in
    // the space it has.
    if (detail.cells && detail.newCells === detail.cells) {
      resultsEl.append(note(`All of that ground was new that day.`));
    }
  }

  // --- The three datasets a typed search needs --------------------------------
  //
  // Towns, admin-1 regions and countries: 8.5 MB raw, about 1.7 MB gzipped,
  // each its own lazy chunk. Started on the **first keystroke** rather than
  // when the palette opens, because opening it with nothing typed is the trip
  // list — and the trips are named by the server now, so that view needs none
  // of them.
  //
  // Loading them on open used to be free in the sense that mattered: naming the
  // trips happened here and had pulled all three in anyway, so the prefetch
  // only moved the cost earlier. That is no longer true, and it left the panel
  // spending a couple of megabytes every time it was opened to look at a
  // holiday.
  //
  // All three, not just the places. Region and country search answer `[]` when
  // their dataset is unloaded rather than loading it themselves, so they were
  // quietly riding on the naming pass having happened first — searching for a
  // canton worked, and only because of something else entirely.
  let gazetteers = null;
  let ready = false;

  function warmGazetteers() {
    gazetteers ??= Promise.all([loadPlaces(), loadCountries(), loadRegions()])
      .then(() => {
        ready = true;
        // Whatever was typed while they were on their way has not been searched
        // against anything yet.
        if (!overlay.hidden && input.value.trim()) render(input.value);
      })
      .catch(() => {
        // A palette that can still find your routes, your trips and a date is
        // worth more than one that reports a failure and stops.
      });
    return gazetteers;
  }

  function openCalendar(on) {
    // Asking to close it is a request the wide layout does not take: there is a
    // column standing empty behind it.
    calOpen = on || calPinned();
    calEl.hidden = !calOpen;
    calBtn.classList.toggle('on', calOpen);
    if (calOpen) renderCalendar();
  }

  // A window dragged across the breakpoint changes the answer to "is there a
  // calendar", and the panel may well be open while it happens.
  twoColumn.addEventListener('change', () => {
    if (!overlay.hidden) openCalendar(calOpen);
  });

  // --- Opening and closing ----------------------------------------------------

  function open() {
    overlay.hidden = false;
    input.value = '';
    cal.select(null);
    openCalendar(false);
    render('');
    input.focus();
    onOpen?.();
  }

  function close() {
    overlay.hidden = true;
  }

  input.addEventListener('input', () => {
    warmGazetteers();
    render(input.value);
  });
  calBtn.addEventListener('click', () => {
    openCalendar(!calOpen);
    if (!calOpen) render(input.value);
  });
  calPrev.addEventListener('click', () => cal.step(-1));
  calNext.addEventListener('click', () => cal.step(1));
  $('search-close').addEventListener('click', close);
  onBackdropClick(overlay, close);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter with nothing highlighted takes the first answer, which is the
      // one the ranking put there on purpose.
      (items[active >= 0 ? active : 0])?.pick();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) {
      close();
      return;
    }
    // Cmd/Ctrl-K, the shortcut every search field has had for a decade.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.hidden) open();
      else close();
    }
  });

  return {
    open,
    close,
    isOpen: () => !overlay.hidden,
    /**
     * Re-run the current query. Trips are derived asynchronously (the place
     * dataset is a lazy chunk), so the palette opens on what it has and calls
     * this when the rest arrives rather than making you wait to type.
     */
    refresh() {
      if (overlay.hidden) return;
      // The calendar wants them as much as the list does — the pills that show
      // a trip as one journey can't be drawn until the trips exist, and a
      // month opened before they arrived would keep its loose dots.
      if (calOpen) renderCalendar();
      // A day picked out of the grid is not something the query can reproduce,
      // so it is re-read rather than re-searched. Everything else is, including
      // a typed month — which now lists trips, and so has to be re-run for the
      // same reason the grid does. This used to be an either/or on the calendar
      // being closed, which in the wide layout is never.
      if (cal.selected()) selectDay(cal.selected());
      else render(input.value);
    },
  };
}
