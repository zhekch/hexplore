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
import { searchCountries, countryIdAt } from './countries.js';
import { dayKey, dayDetail } from './trips.js';
import { mountCalendar, MONTHS } from './calendar.js';
import { formatDistance } from './routes.js';


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
 * @param {() => Set<string>} [opts.hiddenTrips] ids of trips put away
 * @param {(id:string|null, hide:boolean) => Promise<void>} [opts.onHideTrip]
 * @param {() => ({name?:string}|null)} [opts.home] the home trips are measured from
 * @param {() => void} [opts.onSetHome] open the home picker
 * @param {() => boolean} [opts.homeShown] is it drawn on the map
 * @param {(on:boolean) => void} [opts.onShowHome] draw it, or don't
 * @param {() => void} [opts.onOpen] called every time it opens, however it was
 *   opened — the trips it lists are derived lazily and this is what starts that
 */
export function mountSearch({
  trips, routes, days, meta, onPlace, onTrip, onRoute, onDay,
  hiddenTrips = () => new Set(), onHideTrip, home = () => null, onSetHome,
  homeShown = () => false, onShowHome, onOpen,
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

  // Trips live here rather than in a tab of their own. They used to be in both
  // — this palette listed them, and Routes and statistics listed them again
  // with its own field and its own calendar — which is two menus doing one
  // thing. This is the one, because it is the one you can reach with ⌘K.
  const TRIP_SORTS = {
    recent: { label: 'Newest', sort: (a, b) => b.start - a.start },
    days: { label: 'Longest', sort: (a, b) => b.days - a.days || b.start - a.start },
    far: { label: 'Furthest', sort: (a, b) => b.farKm - a.farKm || b.start - a.start },
  };
  const TRIP_GROUPS = {
    none: { label: 'Flat' },
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

  function tripControls() {
    const wrap = document.createElement('div');
    wrap.className = 'stats-controls';
    wrap.append(
      seg(TRIP_SORTS, tripSort, (k) => { tripSort = k; render(input.value); }),
      seg(TRIP_GROUPS, tripGroup, (k) => { tripGroup = k; render(input.value); }),
    );
    return wrap;
  }

  /** Everything a trip is findable by, not just what it ended up called. */
  const tripMatches = (t, q) =>
    !q || `${t.name} ${t.place ?? ''} ${t.region ?? ''} ${t.country ?? ''} ${(t.tags ?? []).join(' ')}`
      .toLowerCase().includes(q);

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

  /** The list, optionally in blocks. The sort holds inside each one. */
  function tripList(list) {
    const out = [];
    const ordered = (l) => [...l].sort(TRIP_SORTS[tripSort].sort);
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
    const blocks = [...buckets.entries()]
      .sort((a, b) => !a[0] - !b[0] || b[1].length - a[1].length || a[0].localeCompare(b[0]));
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

  /**
   * Where the trips are measured from, the way to correct it, and the switch
   * that puts it on the map. All three belong together: "is this the right
   * home" is a question you answer by looking at where it is, and the switch
   * used to be four sections away in the appearance menu.
   */
  function homeRow() {
    const set = home();
    const el = document.createElement('div');
    el.className = 'home-row';
    el.innerHTML = '<span class="home-text"><b></b><small></small></span>';
    el.querySelector('b').textContent = set?.name || 'Worked out from the cells you visit most';
    el.querySelector('small').textContent = 'Home — everything here is measured from it';

    const show = document.createElement('button');
    show.type = 'button';
    show.className = `home-set home-eye${homeShown() ? ' active' : ''}`;
    show.title = homeShown() ? 'Stop showing it on the map' : 'Show it on the map';
    show.setAttribute('aria-pressed', String(!!homeShown()));
    show.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/></svg>'
      + '<span>Map</span>';
    show.addEventListener('click', () => {
      onShowHome?.(!homeShown());
      render(input.value);
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-set';
    btn.textContent = set ? 'Change' : 'Set home';
    btn.addEventListener('click', () => {
      close();
      onSetHome?.();
    });
    el.append(show, btn);
    return el;
  }

  function hiddenRow(put) {
    const el = document.createElement('div');
    el.className = 'home-row';
    el.innerHTML = '<span class="home-text"><b></b><small></small></span>';
    el.querySelector('b').textContent = `${put.size} trip${put.size === 1 ? '' : 's'} hidden`;
    el.querySelector('small').textContent = 'Runs you told the list to forget';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-set';
    btn.textContent = 'Show them';
    btn.addEventListener('click', async () => {
      await onHideTrip?.(null, false);
      render(input.value);
    });
    el.append(btn);
    return el;
  }

  /** The trips section: all of them when nothing is typed, matches when it is. */
  function addTrips(q) {
    const put = hiddenTrips();
    const all = trips().filter((t) => !put.has(t.id));
    const hits = all.filter((t) => tripMatches(t, q));
    if (!hits.length) return false;
    resultsEl.append(section(q ? 'Trips' : 'Your trips', q ? null : tripControls()));
    if (!q) resultsEl.append(homeRow());
    resultsEl.append(...tripList(hits));
    if (!q && put.size) resultsEl.append(hiddenRow(put));
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
    if (asDate) {
      const [y, mo, d] = asDate.split('-');
      cal.show(new Date(+y, mo ? +mo - 1 : 0, 1));
      openCalendar(true);
      if (d) selectDay(asDate);
      else {
        renderCalendar();
        resultsEl.replaceChildren(note(`${mo ? MONTHS[+mo - 1] + ' ' : ''}${y} — pick a day below.`));
      }
      return;
    }

    const lower = q.toLowerCase();

    // Nothing typed: the whole trip list, with its own ordering and grouping —
    // this is the trips browser, not a preview of one. Typing narrows it, on
    // everything a trip is called *and* everywhere it went, so "valais" finds
    // the week in Zermatt and so does the name of a town it merely drove
    // through.
    const anyTrips = addTrips(lower);
    if (!q) {
      if (!anyTrips) {
        resultsEl.append(note('Search for a place, a route, or a date — or pick a day from the calendar.'));
      }
      return;
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
    cal.select(null);
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
  calPrev.addEventListener('click', () => cal.step(-1));
  calNext.addEventListener('click', () => cal.step(1));
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
      else if (cal.selected()) selectDay(cal.selected());
      else renderCalendar();
    },
  };
}
