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
import { searchRegions } from './regions.js';
import { searchCountries } from './countries.js';
import { dayKey, dayDetail, tripDays } from './trips.js';
import { formatDistance } from './routes.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

// A typed date, in the forms people actually type. Returns "YYYY-MM-DD", a
// "YYYY-MM" month, or null. Deliberately strict about which number is the day:
// 3/4 is ambiguous in a way no amount of guessing fixes, so only the
// unambiguous separators and orders are read.
export function parseDateQuery(text) {
  const q = String(text ?? '').trim();
  if (!q) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = /^(\d{4})-(\d{1,2})$/.exec(q);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  // 12.08.2024 and 12/08/2024 — day first, as written everywhere this app is
  // likely to be read.
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(q);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  // "August 2024", "aug 2024"
  m = /^([a-zA-Z]{3,})\s+(\d{4})$/.exec(q);
  if (m) {
    const i = MONTHS.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase()));
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  // A bare year is a month query for January… but reading "2024" as a date at
  // all would swallow every text search for a number, so it stays a year.
  if (/^\d{4}$/.test(q) && +q >= 1990 && +q <= 2100) return q;
  return null;
}

/**
 * @param {object} opts
 * @param {() => Array<object>} opts.trips    derived trips, newest first
 * @param {() => Array<object>} opts.routes   saved routes
 * @param {() => Map<string, {cells:number, routes:number}>} opts.days  active days
 * @param {() => Map<string, Array>} opts.meta cell provenance, for a day's detail
 * @param {(lngLat:{lng:number, lat:number}, opts?:object) => void} opts.onPlace
 * @param {(trip:object) => void} opts.onTrip
 * @param {(route:object) => void} opts.onRoute
 * @param {(key:string, detail:object) => void} [opts.onDay] show one day's
 *   ground on the map
 * @param {() => void} [opts.onOpen] called every time it opens, however it was
 *   opened — the trips it lists are derived lazily and this is what starts that
 */
export function mountSearch({ trips, routes, days, meta, onPlace, onTrip, onRoute, onDay, onOpen }) {
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
  let month = new Date(); // which month the grid is showing
  let selectedDay = null; // "YYYY-MM-DD"
  let items = []; // what's currently listed, for keyboard selection
  let active = -1;

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

  function section(label) {
    const el = document.createElement('div');
    el.className = 'search-section';
    el.textContent = label;
    return el;
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
    if (asDate) {
      const [y, mo, d] = asDate.split('-');
      month = new Date(+y, mo ? +mo - 1 : 0, 1);
      openCalendar(true);
      if (d) selectDay(asDate);
      else {
        renderCalendar();
        resultsEl.replaceChildren(note(`${mo ? MONTHS[+mo - 1] + ' ' : ''}${y} — pick a day below.`));
      }
      return;
    }

    if (!q) {
      // Nothing typed: offer the most recent trips, which is what you'd have
      // scrolled to anyway.
      const recent = trips().slice(0, 5);
      if (!recent.length) {
        resultsEl.append(note('Search for a place, a route, or a date — or pick a day from the calendar.'));
        return;
      }
      resultsEl.append(section('Recent trips'));
      for (const t of recent) addTrip(t);
      return;
    }

    const lower = q.toLowerCase();

    // Match a trip on everything it is called *and* everything it is in: typing
    // "switzerland" should find the week in Zermatt, and typing "valais"
    // should too, even though neither word is in its name — naming works out
    // which region a trip mostly happened in, and it keeps the answer.
    const tripHits = trips()
      .filter((t) => `${t.name} ${t.place ?? ''} ${t.region ?? ''} ${t.country ?? ''}`.toLowerCase().includes(lower))
      .slice(0, 4);
    if (tripHits.length) {
      resultsEl.append(section('Trips'));
      for (const t of tripHits) addTrip(t);
    }

    const routeHits = routes()
      .filter((r) => `${r.name} ${r.place ?? ''} ${r.sport ?? ''}`.toLowerCase().includes(lower))
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

    // Whole regions and countries, when the boundary data is already in memory
    // (deriving the trips pulls it in). Framing a canton is a different request
    // from flying to a town in it, and both are things people type.
    const areaHits = [...searchRegions(q, 3), ...searchCountries(q, 2)];
    if (areaHits.length) {
      resultsEl.append(section('Regions and countries'));
      for (const a of areaHits) {
        const el = resultRow({
          icon: ICON.area,
          title: a.name,
          sub: a.kind === 'region' ? a.country : 'Country',
          onPick: () => {
            close();
            onPlace?.({ lng: (a.bbox[0] + a.bbox[2]) / 2, lat: (a.bbox[1] + a.bbox[3]) / 2 }, { bounds: a.bbox });
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
        const el = resultRow({
          icon: ICON.place,
          title: p.name,
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
          q.length < 2
            ? 'Keep typing…'
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
  // Its own grid rather than <input type="date">: the native one is an opaque
  // OS panel that can't show which days have anything on them, and that is the
  // entire reason to open a calendar here rather than type the date.

  function renderCalendar() {
    const y = month.getFullYear();
    const m = month.getMonth();
    calTitle.textContent = `${MONTHS[m]} ${y}`;
    calGrid.replaceChildren();
    for (const w of WEEKDAYS) {
      const el = document.createElement('div');
      el.className = 'cal-weekday';
      el.textContent = w;
      calGrid.append(el);
    }
    const first = new Date(y, m, 1);
    // Monday-first, which is what the rest of the app's dates assume.
    const lead = (first.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) {
      const el = document.createElement('div');
      el.className = 'cal-day cal-blank';
      calGrid.append(el);
    }
    const active = days();
    const onTrip = tripDays(trips());
    const todayKey = dayKey(Math.floor(Date.now() / 1000));
    const last = new Date(y, m + 1, 0).getDate();
    const keyOf = (d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    for (let d = 1; d <= last; d++) {
      const key = keyOf(d);
      const has = active.get(key);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cal-day';
      el.classList.toggle('has', !!has);
      el.classList.toggle('today', key === todayKey);
      el.classList.toggle('picked', key === selectedDay);
      el.innerHTML = `<span>${d}</span><i></i>`;
      if (has) {
        el.title = [
          has.cells ? `${has.cells} new cell${has.cells === 1 ? '' : 's'}` : '',
          has.routes ? `${has.routes} route${has.routes === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');
        // A day that only added ground and a day you recorded a ride on are
        // different kinds of day, and the dot says which.
        el.classList.toggle('has-route', !!has.routes);
      }
      // A trip is one journey, so it is drawn as one shape: the dots of the
      // days in it grow into a bar that runs between them. Loose dots said
      // "something happened on the 4th, the 5th and the 8th"; the pill says
      // you were away from the 4th to the 8th, which is the thing you are
      // actually looking for in a month grid. The days inside it with nothing
      // recorded stay dim — they are part of the journey, not evidence of it.
      const trip = onTrip.get(key);
      if (trip) {
        el.classList.add('trip');
        el.title = `${trip.name}${el.title ? ` · ${el.title}` : ''}`;
        // Reaching past the cell edge is how the bar crosses the grid gap, so
        // it must only reach towards a neighbour that is actually there: the
        // last day of a month has no next cell to meet, and a bar hanging off
        // the end of the row would be pointing at nothing.
        if (d > 1 && onTrip.get(keyOf(d - 1)) === trip) el.classList.add('trip-l');
        if (d < last && onTrip.get(keyOf(d + 1)) === trip) el.classList.add('trip-r');
        // …and a week ends at Sunday. The bar stops flush with the edge rather
        // than poking out of the grid; the run picks up again on the Monday.
        const col = (new Date(y, m, d).getDay() + 6) % 7;
        if (col === 0) el.classList.add('week-first');
        if (col === 6) el.classList.add('week-last');
      }
      el.addEventListener('click', () => selectDay(key));
      calGrid.append(el);
    }
  }

  function selectDay(key) {
    selectedDay = key;
    renderCalendar();
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

  function openCalendar(on) {
    calOpen = on;
    calEl.hidden = !on;
    calBtn.classList.toggle('on', on);
    if (on) renderCalendar();
  }

  // --- Opening and closing ----------------------------------------------------

  function open() {
    overlay.hidden = false;
    input.value = '';
    selectedDay = null;
    openCalendar(false);
    render('');
    input.focus();
    // The place dataset is a lazy 2 MB chunk; kick it off now so the first
    // keystroke doesn't wait for it.
    loadPlaces().then(() => {
      if (!overlay.hidden && input.value.trim()) render(input.value);
    });
    onOpen?.();
  }

  function close() {
    overlay.hidden = true;
  }

  input.addEventListener('input', () => render(input.value));
  calBtn.addEventListener('click', () => {
    openCalendar(!calOpen);
    if (!calOpen) render(input.value);
  });
  calPrev.addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    renderCalendar();
  });
  calNext.addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    renderCalendar();
  });
  $('search-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

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
      if (!calOpen) render(input.value);
      else if (selectedDay) selectDay(selectedDay);
      else renderCalendar();
    },
  };
}
