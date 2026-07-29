// The statistics dialog: two tabs over the same data you already have on the
// map. **Cells** measures the ground covered (src/stats.js); **Routes** is the
// list of saved tracks, and the only place to browse them without hunting for
// their lines on the map. main.js owns both sets and passes them in.

import { computeStats, EARTH_LAND_KM2 } from './stats.js';
import { sourceLabel, IMPORT_SOURCES } from './locations.js';
import { formatDistance, formatDuration, totalLength, thumbSegments } from './routes.js';
import { auth } from './auth.js';
import { buildTrips, nameTrips, findHome, dayKey } from './trips.js';
import { loadPlaces, nearestTown } from './places.js';
import { loadCountries, countryAt } from './countries.js';
import { loadRegions, regionAt } from './regions.js';
import { isKomootTourUrl } from './komoot.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);
const clock = (sec) => (sec ? timeFmt.format(new Date(sec * 1000)) : null);

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const km2 = (v) =>
  v >= 1000 ? `${Math.round(v).toLocaleString()} km²`
  : v >= 10 ? `${v.toFixed(0)} km²`
  : `${v.toFixed(1)} km²`;

// Coverage numbers span orders of magnitude — 7 % of Switzerland next to
// 0.005 % of the planet — so keep enough digits for the small end to survive.
const pct = (v) =>
  v >= 10 ? `${v.toFixed(0)}%`
  : v >= 1 ? `${v.toFixed(1)}%`
  : v >= 0.01 ? `${v.toFixed(2)}%`
  : v >= 0.001 ? `${v.toFixed(3)}%`
  : v > 0 ? '<0.001%' // a single cell in a big country rounds to nothing
  : '0%';

/**
 * @param {object} opts
 * @param {() => Set<string>} opts.cells    visited cell ids
 * @param {() => Map<string, Array>} opts.meta provenance by cell id
 * @param {() => Array<object>} opts.routes saved routes (newest first)
 * @param {(route:object) => void} opts.onShowRoute  take me to this one
 * @param {(trip:object) => void} [opts.onShowTrip]   take me to this trip
 * @param {() => ({lng:number,lat:number,name:string}|null)} [opts.home] the
 *   home you confirmed, or null to use the one worked out from the cells
 * @param {(home:object|null) => Promise<void>} [opts.onSetHome] change it
 * @param {(route:object, before:object) => void} [opts.onRouteEdited] after a successful
 *   save, with the values it had before it — that's what Undo needs
 * @param {(route:object) => Promise<void>} [opts.onRouteDeleted] remove it everywhere
 * @param {() => string[]} [opts.knownSources] apps already used, for the picker
 */
export function mountStats({
  cells,
  meta,
  routes = () => [],
  onShowRoute,
  onShowTrip,
  home = () => null,
  onSetHome,
  onRouteEdited,
  onRouteDeleted,
  knownSources,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('stats-overlay');
  const body = $('stats-body');
  const tabs = $('stats-tabs');

  // "Which country have I covered most of" and "where have I covered the most
  // ground" are different questions — the list answers whichever you pick.
  const SORTS = {
    share: { label: 'Share', sort: (a, b) => b.pct - a.pct || b.km2 - a.km2, of: (c) => c.pct / 100 },
    area: { label: 'Area', sort: (a, b) => b.km2 - a.km2, of: (c, max) => c.km2 / max },
  };
  let sortBy = 'share';
  let last = null; // the most recent stats, for re-sorting without recomputing
  // A map of one country can have a hundred regions in it, which is a scroll
  // nobody asked for on the way to the rest of the panel.
  const REGION_PREVIEW = 8;
  let regionsExpanded = false;
  let lastTrips = null; // the last derivation, so the search palette can reuse it

  // "What did I do most recently" and "what was the big one" are both fair
  // questions to open the list with.
  const ROUTE_SORTS = {
    recent: {
      label: 'Newest',
      sort: (a, b) => (b.firstAt || b.addedAt) - (a.firstAt || a.addedAt) || b.id - a.id,
    },
    distance: { label: 'Longest', sort: (a, b) => b.lengthM - a.lengthM },
    // Not a sort so much as a grouping: routes stay together by the app they
    // came out of, which is usually how you remember them ("that Komoot ride").
    app: {
      label: 'By app',
      group: true,
      of: (r) => r.source || 'unknown',
      sort: (a, b) => (b.firstAt || b.addedAt) - (a.firstAt || a.addedAt),
    },
    // "Show me the rides" is as natural a question as "show me the Komoot ones",
    // and now that the activity is worked out for almost everything it can
    // actually be answered.
    activity: {
      label: 'By activity',
      group: true,
      of: (r) => r.sport || '',
      sort: (a, b) => (b.firstAt || b.addedAt) - (a.firstAt || a.addedAt),
    },
  };
  // Sources that say nothing about which app a route came from belong at the
  // bottom, whatever their distance.
  const VAGUE_SOURCES = new Set(['unknown', 'other', 'gpx', 'kml', 'geojson', 'csv', 'manual']);
  // Routes is what this dialog is mostly used for, so it opens there.
  let tab = 'routes';
  let routeSort = 'recent';

  const close = () => {
    overlay.hidden = true;
  };

  function row(label, value, sub) {
    const el = document.createElement('div');
    el.className = 'stats-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    el.append(l, v);
    if (sub) v.title = sub;
    return el;
  }

  function bar(label, value, fraction, note) {
    const el = document.createElement('div');
    el.className = 'stats-bar-row';
    el.innerHTML =
      '<div class="stats-bar-head"><span></span><b></b></div>' +
      '<div class="stats-bar"><i></i></div>' +
      '<div class="stats-bar-note"></div>';
    el.querySelector('span').textContent = label;
    el.querySelector('b').textContent = value;
    // Tiny slivers still deserve a visible sliver.
    el.querySelector('i').style.width = `${Math.max(1.5, Math.min(100, fraction * 100))}%`;
    el.querySelector('.stats-bar-note').textContent = note ?? '';
    return el;
  }

  function headRow(title, seg) {
    const head = document.createElement('div');
    head.className = seg ? 'stats-head stats-head-row' : 'stats-head';
    const label = document.createElement('span');
    label.textContent = title;
    head.append(label);
    if (seg) head.append(seg);
    return head;
  }

  // A segmented control that re-renders the current tab when you pick a side.
  function sortSeg(options, current, onPick) {
    const seg = document.createElement('div');
    seg.className = 'seg seg-mini';
    for (const [key, opt] of Object.entries(options)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${key === current ? ' active' : ''}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        if (current === key) return;
        onPick(key);
      });
      seg.append(btn);
    }
    return seg;
  }

  // --- One route ---------------------------------------------------------------
  // Tapping a route used to close the dialog and fly the map to it, which is a
  // lot to happen at once when the question was usually "what was this one?".
  // Now it opens the activity here — everything the route knows, and the three
  // things you might want to change about it — and going to the map is a button.
  let shownRoute = null;
  let editing = false;
  let saving = false;
  let armed = false; // Delete asks twice
  let armTimer = null;

  const disarm = () => {
    clearTimeout(armTimer);
    armed = false;
  };

  function detailRow(label, value) {
    const el = document.createElement('div');
    el.className = 'stats-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    el.append(l, v);
    return el;
  }

  function labelledInput(labelText, hint, build) {
    const label = document.createElement('label');
    label.className = 'ha-label';
    label.append(labelText);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      label.append(small);
    }
    const field = build();
    label.htmlFor = field.id;
    return [label, field];
  }

  function renderRouteDetail() {
    const r = shownRoute;
    body.replaceChildren();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'stats-back';
    back.textContent = '‹ All routes';
    back.addEventListener('click', () => {
      shownRoute = null;
      editing = false;
      disarm();
      renderRoutes();
    });
    body.append(back);

    const title = document.createElement('div');
    title.className = 'stats-detail-title';
    title.textContent = r.name || 'Route';
    const sub = document.createElement('div');
    sub.className = 'stats-detail-sub';
    const place = r.place && r.place !== r.name ? r.place : null;
    sub.textContent = [place, sourceLabel(r.source), r.firstAt ? day(r.firstAt) : `added ${day(r.addedAt) ?? 'recently'}`]
      .filter(Boolean)
      .join(' · ');
    body.append(title, sub);

    if (editing) {
      const box = document.createElement('div');
      box.className = 'route-edit';

      const [nameLabel, nameInput] = labelledInput('Name', null, () => {
        const i = document.createElement('input');
        i.className = 'auth-input';
        i.id = 'stats-edit-name';
        i.type = 'text';
        i.maxLength = 120;
        i.value = r.name ?? '';
        i.autocomplete = 'off';
        return i;
      });
      const [sportLabel, sportInput] = labelledInput(
        'Activity',
        'Cycling, Hiking, Running — blank if you’d rather not say',
        () => {
          const i = document.createElement('input');
          i.className = 'auth-input';
          i.id = 'stats-edit-sport';
          i.type = 'text';
          i.maxLength = 40;
          // Same suggestions the map card offers; the datalist is in index.html.
          i.setAttribute('list', 'route-sports');
          i.placeholder = 'Not set';
          i.value = r.sport ?? '';
          i.autocomplete = 'off';
          return i;
        },
      );
      const [sourceLabelEl, sourceSelect] = labelledInput('App', null, () => {
        const s = document.createElement('select');
        s.id = 'stats-edit-source';
        const known = [...new Set([...(knownSources?.() ?? []), ...IMPORT_SOURCES, r.source])].filter(Boolean);
        for (const key of known) {
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = sourceLabel(key);
          if (key === r.source) opt.selected = true;
          s.append(opt);
        }
        return s;
      });

      const err = document.createElement('div');
      err.className = 'import-error';
      err.hidden = true;
      box.append(nameLabel, nameInput, sportLabel, sportInput, sourceLabelEl, sourceSelect, err);
      body.append(box);

      const actions = document.createElement('div');
      actions.className = 'route-info-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'modal-btn primary';
      save.textContent = saving ? 'Saving…' : 'Save';
      save.disabled = saving;
      save.addEventListener('click', async () => {
        if (saving) return;
        const name = nameInput.value.trim();
        if (!name) {
          err.textContent = 'A route needs a name.';
          err.hidden = false;
          return;
        }
        saving = true;
        save.textContent = 'Saving…';
        save.disabled = true;
        try {
          const patch = { name, sport: sportInput.value.trim(), source: sourceSelect.value };
          // What it was, so this edit can be undone. Captured before the write
          // rather than diffed afterwards — by then the old values are gone.
          const before = { name: r.name, sport: r.sport, source: r.source, sportGuessed: r.sportGuessed };
          await auth.updateRoute(r.id, patch);
          // The list main.js draws from holds these same objects, so writing
          // back here is what the rest of the app sees.
          Object.assign(r, patch);
          // Typing it in makes it a fact rather than something we worked out.
          if (patch.sport) r.sportGuessed = false;
          editing = false;
          onRouteEdited?.(r, before);
        } catch (e) {
          err.textContent = e.message || 'Could not save that.';
          err.hidden = false;
        } finally {
          saving = false;
          renderRouteDetail();
        }
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'modal-btn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        editing = false;
        renderRouteDetail();
      });
      actions.append(save, cancel);
      body.append(actions);
      setTimeout(() => nameInput.focus(), 30);
      return;
    }

    // What it knows about itself.
    if (r.sport) {
      body.append(
        detailRow('Activity', r.sportGuessed ? `${r.sport} (estimated)` : r.sport),
      );
    }
    body.append(detailRow('Distance', formatDistance(r.lengthM)));
    // Only when the file carried elevation — a flat 0 m would read as a
    // measurement rather than an absence.
    if (r.elevUp > 0) body.append(detailRow('Climb', `${Math.round(r.elevUp).toLocaleString()} m`));
    const started = day(r.firstAt);
    const ended = day(r.lastAt);
    if (started && ended && started !== ended) body.append(detailRow('When', `${started} – ${ended}`));
    else if (started) body.append(detailRow('When', started));
    if (started && ended && started === ended && r.lastAt > r.firstAt) {
      body.append(detailRow('Started', clock(r.firstAt)));
    }
    const duration = formatDuration(r.lastAt - r.firstAt);
    if (duration) body.append(detailRow('Duration', duration));
    if (r.firstAt && r.lastAt > r.firstAt && r.lengthM > 0) {
      const kmh = (r.lengthM / 1000) / ((r.lastAt - r.firstAt) / 3600);
      if (Number.isFinite(kmh) && kmh > 0) body.append(detailRow('Average speed', `${kmh.toFixed(1)} km/h`));
    }
    if (r.place) body.append(detailRow('Where', r.place));
    body.append(detailRow('App', sourceLabel(r.source)));
    // The way back to the tour it came from. Checked again here rather than
    // trusted from storage: this is the one place a stored string becomes an
    // href, and `javascript:` in an href runs.
    if (isKomootTourUrl(r.link)) {
      const row = document.createElement('div');
      row.className = 'stats-row';
      const label = document.createElement('span');
      label.textContent = 'Link';
      const a = document.createElement('a');
      a.className = 'stats-link';
      a.href = r.link;
      a.target = '_blank';
      // noopener so the opened tab can't reach back through window.opener.
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open on Komoot';
      a.title = r.link;
      row.append(label, a);
      body.append(row);
    }
    body.append(detailRow('Shape', `${(r.points ?? 0).toLocaleString()} points`));

    const actions = document.createElement('div');
    actions.className = 'route-info-actions';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'modal-btn primary';
    show.textContent = 'Show on map';
    show.addEventListener('click', () => onShowRoute?.(r));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'modal-btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editing = true;
      disarm();
      renderRouteDetail();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = `modal-btn${armed ? ' danger' : ''}`;
    del.textContent = armed ? 'Sure?' : 'Delete';
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        renderRouteDetail();
        // Not a decision to leave armed indefinitely.
        armTimer = setTimeout(() => {
          armed = false;
          if (shownRoute === r && !editing) renderRouteDetail();
        }, 4000);
        return;
      }
      disarm();
      try {
        await onRouteDeleted?.(r);
      } catch (e) {
        console.warn('Deleting the route failed:', e);
        return;
      }
      shownRoute = null;
      renderRoutes();
    });
    actions.append(show, edit, del);
    body.append(actions);
  }

  // --- Routes tab ------------------------------------------------------------
  function routeRow(r, { showApp = true, showSport = true } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'stats-route';
    el.innerHTML =
      '<span class="stats-route-main"><b></b><i></i></span><span class="stats-route-far"></span>';

    // The shape, drawn from the outline cached when the route was saved. You
    // recognise "the Frutigen loop" by its shape long before you read its name.
    const segs = thumbSegments(r.thumb);
    if (segs.length) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'stats-route-thumb');
      // A little padding so a stroke on the very edge isn't sliced in half.
      svg.setAttribute('viewBox', '-6 -6 112 112');
      svg.setAttribute('aria-hidden', 'true');
      for (const points of segs) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', points);
        svg.append(line);
      }
      el.prepend(svg);
    }
    el.querySelector('b').textContent = r.name || 'Route';
    // Where, when, and what it came out of, on one line — never the place twice
    // when it is also the title, and never the app when it's the heading above.
    const place = r.place && r.place !== r.name ? r.place : null;
    const when = r.firstAt ? day(r.firstAt) : `added ${day(r.addedAt) ?? 'recently'}`;
    const app = showApp && r.source && !VAGUE_SOURCES.has(r.source) ? sourceLabel(r.source) : null;
    // What it was reads ahead of when it was — it's the thing you scan for.
    // Not repeated when the list is already grouped by activity.
    const what = showSport && r.sport ? r.sport : null;
    el.querySelector('i').textContent = [place, what, when, app].filter(Boolean).join(' · ');
    el.querySelector('.stats-route-far').textContent = formatDistance(r.lengthM);
    el.title = 'Open this route';
    el.addEventListener('click', () => {
      shownRoute = r;
      editing = false;
      disarm();
      body.scrollTop = 0;
      renderRouteDetail();
    });
    return el;
  }

  function renderRoutes() {
    const list = routes();
    // A route that was open but has since gone (deleted elsewhere) falls back
    // to the list rather than showing a stale card.
    if (shownRoute && list.some((r) => r.id === shownRoute.id)) {
      renderRouteDetail();
      return;
    }
    shownRoute = null;
    body.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'stats-loading';
      empty.textContent =
        'No saved routes yet — import a GPX or KML track with “Save routes” ticked, or pull a tour in from Komoot under Sync.';
      body.append(empty);
      return;
    }

    const metres = totalLength(list);
    const longest = list.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
    // Only routes that carry both ends of a clock can be timed; saying "3 h"
    // when half of them are undated would be a made-up number.
    const timed = list.filter((r) => r.firstAt && r.lastAt > r.firstAt);
    const seconds = timed.reduce((n, r) => n + (r.lastAt - r.firstAt), 0);
    const dated = list.filter((r) => r.firstAt).map((r) => r.firstAt);

    body.append(
      row('Routes', list.length.toLocaleString()),
      row('Total distance', formatDistance(metres), `${Math.round(metres).toLocaleString()} m`),
      row('Longest', formatDistance(longest.lengthM), longest.name),
    );
    if (seconds > 0) {
      body.append(
        row(
          'Time recorded',
          formatDuration(seconds) ?? '–',
          timed.length < list.length ? `${timed.length} of ${list.length} routes carry times` : undefined,
        ),
      );
    }
    if (dated.length) {
      const from = day(Math.min(...dated));
      const to = day(Math.max(...dated));
      body.append(row('Span', from === to ? from : `${from} – ${to}`));
    }

    // Distance per year, on the same chart the cells tab uses for new ground.
    const byYear = new Map();
    for (const r of list) {
      if (!r.firstAt) continue;
      const y = new Date(r.firstAt * 1000).getFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + r.lengthM);
    }
    if (byYear.size > 1) {
      body.append(headRow('Distance by year'));
      const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]);
      const max = Math.max(...years.map(([, m]) => m));
      const chart = document.createElement('div');
      chart.className = 'stats-years';
      for (const [year, m] of years) {
        const col = document.createElement('div');
        col.className = 'stats-year';
        col.title = `${formatDistance(m)} in ${year}`;
        col.innerHTML = '<i></i><span></span>';
        col.querySelector('i').style.height = `${Math.max(3, (m / max) * 100)}%`;
        col.querySelector('span').textContent = String(year).slice(2);
        chart.append(col);
      }
      body.append(chart);
    }

    body.append(
      headRow(
        'Your routes',
        sortSeg(ROUTE_SORTS, routeSort, (key) => {
          routeSort = key;
          const at = body.scrollTop;
          renderRoutes();
          body.scrollTop = at;
        }),
      ),
    );
    const opt = ROUTE_SORTS[routeSort];
    if (!opt.group) {
      const listEl = document.createElement('div');
      listEl.className = 'stats-list';
      for (const r of [...list].sort(opt.sort)) listEl.append(routeRow(r));
      body.append(listEl);
      return;
    }

    // One block per group, biggest first. Whatever the grouping is, the entries
    // that say nothing — "GPX track" as an app, a route whose activity was never
    // worked out — sink to the bottom rather than leading the list.
    const vague = (key) => key === '' || VAGUE_SOURCES.has(key);
    const buckets = new Map();
    for (const r of list) {
      const key = opt.of(r);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    const groups = [...buckets.entries()].sort(
      (a, b) =>
        vague(a[0]) - vague(b[0]) ||
        totalLength(b[1]) - totalLength(a[1]) ||
        a[0].localeCompare(b[0]),
    );
    const label = routeSort === 'activity'
      ? (key) => key || 'Activity not set'
      : (key) => sourceLabel(key);
    for (const [key, group] of groups) {
      const head = document.createElement('div');
      head.className = 'stats-group';
      const name = document.createElement('span');
      name.textContent = label(key);
      const note = document.createElement('i');
      note.textContent = `${plural(group.length, 'route')} · ${formatDistance(totalLength(group))}`;
      head.append(name, note);
      const listEl = document.createElement('div');
      listEl.className = 'stats-list';
      for (const r of [...group].sort(opt.sort)) {
        listEl.append(routeRow(r, {
          showApp: routeSort !== 'app',
          showSport: routeSort !== 'activity',
        }));
      }
      body.append(head, listEl);
    }
  }

  function render(s) {
    last = s;
    body.replaceChildren();
    if (!s.cells) {
      const empty = document.createElement('div');
      empty.className = 'stats-loading';
      empty.textContent = 'Nothing on the map yet — import a location export or mark a few cells.';
      body.append(empty);
      return;
    }

    const seen = [day(s.firstAt), day(s.lastAt)].filter(Boolean);
    body.append(
      row('Cells', s.cells.toLocaleString()),
      row('Ground covered', km2(s.km2), `${Math.round(s.km2).toLocaleString()} km²`),
      row('Share of Earth’s land', pct(s.worldPct), `${EARTH_LAND_KM2.toLocaleString()} km² total`),
      row('Countries', `${s.countries.length} of ${s.countryTotal}`),
    );
    if (s.regions?.length) {
      // Counted against the countries you have been to rather than against the
      // world: "12 of 4,553" is a number nobody can feel, and every region in a
      // country you've already visited is one you could plausibly go and see.
      body.append(row('Regions', `${s.regions.length} of ${s.regionsReachable}`, 'states, provinces, cantons'));
    }
    if (seen.length) {
      body.append(
        row('History spans', seen.length === 2 && seen[0] !== seen[1] ? `${seen[0]} – ${seen[1]}` : seen[0]),
      );
    }

    if (s.countries.length) {
      body.append(
        headRow(
          'Coverage by country',
          sortSeg(SORTS, sortBy, (key) => {
            sortBy = key;
            // Re-rendering replaces the list; keep the reader where they were.
            const at = body.scrollTop;
            render(last);
            body.scrollTop = at;
          }),
        ),
      );

      const opt = SORTS[sortBy];
      const ranked = [...s.countries].sort(opt.sort);
      const maxKm2 = ranked[0]?.km2 || 1;
      const list = document.createElement('div');
      list.className = 'stats-list';
      for (const c of ranked) {
        list.append(
          bar(
            c.id,
            sortBy === 'area' ? km2(c.km2) : pct(c.pct),
            opt.of(c, maxKm2),
            sortBy === 'area'
              ? `${pct(c.pct)} of ${km2(c.totalKm2)} · ${plural(c.cells, 'cell')}`
              : `${km2(c.km2)} of ${km2(c.totalKm2)} · ${plural(c.cells, 'cell')}`,
          ),
        );
      }
      body.append(list);
    }

    if (s.regions.length) {
      body.append(
        headRow(
          'Coverage by region',
          sortSeg(SORTS, sortBy, (key) => {
            sortBy = key;
            const at = body.scrollTop;
            render(last);
            body.scrollTop = at;
          }),
        ),
      );
      const optR = SORTS[sortBy];
      const rankedR = [...s.regions].sort(optR.sort);
      const maxKm2R = rankedR[0]?.km2 || 1;
      const listR = document.createElement('div');
      listR.className = 'stats-list';
      // Long enough to be its own panel on a well-travelled map, so it opens on
      // the leaders and says how many more there are.
      const shown = regionsExpanded ? rankedR : rankedR.slice(0, REGION_PREVIEW);
      for (const r of shown) {
        listR.append(
          bar(
            r.name,
            sortBy === 'area' ? km2(r.km2) : pct(r.pct),
            optR.of(r, maxKm2R),
            // The country is the sub-line, not the title: you know you were in
            // Valais, and two countries can both have a Córdoba.
            sortBy === 'area'
              ? `${r.country} · ${pct(r.pct)} of ${km2(r.totalKm2)}`
              : `${r.country} · ${km2(r.km2)} of ${km2(r.totalKm2)}`,
          ),
        );
      }
      body.append(listR);
      if (rankedR.length > REGION_PREVIEW) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'stats-more';
        more.textContent = regionsExpanded
          ? 'Show fewer'
          : `Show all ${rankedR.length} regions`;
        more.addEventListener('click', () => {
          regionsExpanded = !regionsExpanded;
          const at = body.scrollTop;
          render(last);
          body.scrollTop = at;
        });
        body.append(more);
      }
    }

    if (s.sources.length) {
      body.append(headRow('Where the cells came from'));
      for (const src of s.sources) {
        body.append(row(sourceLabel(src.key), plural(src.cells, 'cell')));
      }
    }

    if (s.years.length > 1) {
      body.append(headRow('New ground by year'));
      const max = Math.max(...s.years.map(([, n]) => n));
      const chart = document.createElement('div');
      chart.className = 'stats-years';
      for (const [year, n] of s.years) {
        const col = document.createElement('div');
        col.className = 'stats-year';
        col.title = `${plural(n, 'cell')} first seen in ${year}`;
        col.innerHTML = '<i></i><span></span>';
        col.querySelector('i').style.height = `${Math.max(3, (n / max) * 100)}%`;
        col.querySelector('span').textContent = String(year).slice(2);
        chart.append(col);
      }
      body.append(chart);
    }
  }

  // --- Trips ------------------------------------------------------------------
  // Derived, not stored (see src/trips.js): the list is worked out from the
  // dates the cells and routes already carry, every time the tab is opened. It
  // costs a sweep of the map and buys a view of it organised the way anyone
  // actually remembers going places.
  async function renderTrips() {
    body.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'stats-loading';
    loading.textContent = 'Working out where you went…';
    body.append(loading);
    await new Promise((r) => setTimeout(r, 20)); // let the dialog paint first

    const set = home();
    const list = buildTrips(meta(), routes(), set ? { home: set } : {});
    try {
      await nameThem(list);
    } catch {
      for (const t of list) t.name = t.name || 'Somewhere';
    }
    lastTrips = list;

    body.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'stats-loading';
      empty.textContent = meta().size
        ? 'No trips yet — a trip is a run of days spent well away from where you usually are. Import some dated history and they appear here.'
        : 'Nothing on the map yet.';
      body.append(empty);
      return;
    }

    const away = list.reduce((n, t) => n + t.days, 0);
    body.append(
      row('Trips', String(list.length)),
      row('Days away', away.toLocaleString()),
      row('Furthest', `${Math.max(...list.map((t) => t.farKm)).toLocaleString()} km`, 'from home'),
    );
    body.append(homeRow(list));
    body.append(headRow('Every trip'));

    const wrap = document.createElement('div');
    wrap.className = 'stats-list';
    for (const t of list) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'trip-row';
      el.innerHTML =
        '<span class="trip-main"><b></b><small></small></span><span class="trip-side"><b></b><small></small></span>';
      el.querySelector('.trip-main b').textContent = t.name;
      el.querySelector('.trip-main small').textContent = tripWhen(t);
      el.querySelector('.trip-side b').textContent = `${t.cells.length.toLocaleString()} cells`;
      el.querySelector('.trip-side small').textContent = [
        t.routes.length ? `${t.routes.length} route${t.routes.length === 1 ? '' : 's'}` : '',
        t.lengthM ? formatDistance(t.lengthM) : '',
      ].filter(Boolean).join(' · ') || `${t.farKm} km away`;
      el.addEventListener('click', () => {
        close();
        onShowTrip?.(t);
      });
      wrap.append(el);
    }
    body.append(wrap);
  }

  // Everything in this tab is measured from home: what counts as away, how far
  // each trip went, and therefore what is a trip at all. A guess about
  // something that personal has to be visible and correctable, so it says which
  // it is and offers the change.
  function homeRow(list) {
    const set = home();
    const el = document.createElement('div');
    el.className = 'home-row';
    el.innerHTML = '<span class="home-text"><b></b><small></small></span>';
    el.querySelector('b').textContent = set?.name || guessedHomeName || 'Not worked out yet';
    el.querySelector('small').textContent = set
      ? 'Home, as you set it'
      : 'Home, guessed from the cells you visit most';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-set';
    btn.textContent = set ? 'Change' : 'Set home';
    btn.addEventListener('click', () => {
      close();
      onSetHome?.(set);
    });
    el.append(btn);
    return el;
  }

  let guessedHomeName = '';

  // Town, then region, then country — the three datasets that already ship, each
  // a lazy chunk. Loaded together because a trip name wants all three and the
  // first one to answer wins.
  async function nameThem(list) {
    await Promise.all([loadPlaces(), loadCountries(), loadRegions()]);
    const at = (lng, lat) => {
      const at = countryAt(lng, lat);
      return {
        town: nearestTown(lng, lat)?.name,
        region: at ? regionAt(lng, lat, at.iso)?.name : undefined,
        country: at?.id ?? undefined,
      };
    };
    nameTrips(list, at);
    // The row above the list says where home came out, which is the only way to
    // notice that it is wrong.
    const guess = home() ?? findHome(meta());
    if (guess) {
      const p = at(guess.lng, guess.lat);
      guessedHomeName = p.town || p.region || p.country || '';
    }
  }

  function tripWhen(t) {
    const a = new Date(t.start * 1000);
    const b = new Date(t.end * 1000);
    const one = dayKey(t.start) === dayKey(t.end);
    const long = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const short = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
    return one
      ? long.format(a)
      : `${short.format(a)} – ${long.format(b)} · ${t.days} day${t.days === 1 ? '' : 's'}`;
  }

  // --- Tabs -------------------------------------------------------------------
  async function showCells() {
    // Already worked out for this opening: re-render straight from the numbers.
    if (last) {
      render(last);
      return;
    }
    body.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'stats-loading';
    loading.textContent = 'Crunching your cells…';
    body.append(loading);
    try {
      // Country boundaries are a lazy chunk and the sweep is ~20k
      // point-in-country tests; yield first so the dialog paints.
      await new Promise((r) => setTimeout(r, 30));
      const s = await computeStats(cells(), meta());
      if (tab === 'cells') render(s);
      else last = s;
    } catch (e) {
      body.replaceChildren();
      const err = document.createElement('div');
      err.className = 'stats-loading';
      err.textContent = `Could not work that out: ${e.message}`;
      body.append(err);
    }
  }

  function showTab(next) {
    if (next !== tab) {
      shownRoute = null;
      editing = false;
      disarm();
    }
    tab = next;
    for (const btn of tabs.querySelectorAll('[data-tab]')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    body.scrollTop = 0;
    if (tab === 'routes') renderRoutes();
    else if (tab === 'trips') renderTrips();
    else showCells();
  }

  async function open(which = 'routes') {
    overlay.hidden = false;
    last = null; // the map may have changed since the last look
    showTab(which);
  }

  for (const btn of tabs.querySelectorAll('[data-tab]')) {
    btn.addEventListener('click', () => {
      if (tab !== btn.dataset.tab) showTab(btn.dataset.tab);
    });
  }
  $('stats-close').addEventListener('click', close);
  $('stats-done').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    /**
     * The trips as last derived, or null if the tab has never been opened.
     * The search palette asks for these rather than deriving its own — one
     * reading of the data, so a trip has the same name in both places.
     */
    trips: () => lastTrips,
    /** Derive them now (for the search palette on a cold start). */
    async ensureTrips() {
      if (!lastTrips) {
        const set = home();
        const list = buildTrips(meta(), routes(), set ? { home: set } : {});
        try {
          await nameThem(list);
        } catch {
          for (const t of list) t.name = t.name || 'Somewhere';
        }
        lastTrips = list;
      }
      return lastTrips;
    },
    // Straight to one route, from the card on the map: open the dialog on the
    // Routes tab with that route already showing.
    openRoute(route) {
      overlay.hidden = false;
      last = null;
      shownRoute = route;
      editing = false;
      disarm();
      tab = 'routes';
      for (const btn of tabs.querySelectorAll('[data-tab]')) {
        btn.classList.toggle('active', btn.dataset.tab === 'routes');
      }
      body.scrollTop = 0;
      renderRouteDetail();
    },
  };
}
