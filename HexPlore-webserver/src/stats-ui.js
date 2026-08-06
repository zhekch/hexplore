// The statistics dialog: two tabs over the same data you already have on the
// map. **Cells** measures the ground covered (src/stats.js); **Routes** is the
// list of saved tracks, and the only place to browse them without hunting for
// their lines on the map. main.js owns both sets and passes them in.

import { EARTH_LAND_KM2, formatKm2, formatPct } from './stats.js';
import { sourceLabel, IMPORT_SOURCES } from './locations.js';
import { formatDistance, formatDuration, totalLength, thumbSegments, recordedSeconds } from './routes.js';
import { auth } from './auth.js';
import { derived } from './derived.js';
import { isKomootTourUrl } from './komoot.js';
import { formatTime } from './clock.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);
const clock = (sec) => (sec ? formatTime(sec * 1000) : null);
// A "YYYY-MM-DD" day key, read as a local day. Midday, not midnight: a date
// parsed at midnight and then formatted lands on the day before in any timezone
// west of UTC.
const dayOf = (key) => (key ? dayFmt.format(new Date(`${key}T12:00:00`)) : '');

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// Spelled in src/stats.js, so the image export says the same thing about the
// same ground.
const km2 = formatKm2;
const pct = formatPct;

/**
 * The cells themselves are deliberately not a parameter any more. This dialog
 * used to be handed the visited set and the provenance map so it could run the
 * coverage sweep itself; it now reads the answer from the server (src/derived.js),
 * and asking for inputs it no longer computes from would be an invitation to
 * start computing again.
 *
 * @param {() => Array<object>} opts.routes saved routes (newest first)
 * @param {(route:object) => void} opts.onShowRoute  take me to this one
 * @param {(route:object, before:object) => void} [opts.onRouteEdited] after a successful
 *   save, with the values it had before it — that's what Undo needs
 * @param {(route:object) => Promise<void>} [opts.onRouteDeleted] remove it everywhere
 * @param {() => string[]} [opts.knownSources] apps already used, for the picker
 */
export function mountStats({
  routes = () => [],
  onShowRoute,
  onRouteEdited,
  onRouteDeleted,
  knownSources,
  foldedRoutes = () => 0,
  showFolded = () => false,
  onShowFolded,
  isFolded = () => false,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('stats-overlay');
  const body = $('stats-body');
  const tabs = $('stats-tabs');

  // "Which country have I covered most of" and "where have I covered the most
  // ground" are different questions — the list answers whichever you pick.
  //
  // Only the *order* changes. The bar is always the share of that country or
  // region, because a bar that meant "the most ground of anything on this list"
  // told you nothing about the place it was next to: the leader's bar was full
  // whether you had covered 7% of it or 90%, which read as done.
  const SORTS = {
    area: { label: 'Area', sort: (a, b) => b.km2 - a.km2 || b.pct - a.pct },
    share: { label: 'Share', sort: (a, b) => b.pct - a.pct || b.km2 - a.km2 },
  };
  // Ground covered is the answer to "where have I been", which is the question
  // people open this panel with; share is the answer to "how much of it is
  // left", which is the one they ask second.
  let sortBy = 'area';
  let last = null; // the most recent stats, for re-sorting without recomputing
  // A map of one country can have a hundred regions in it, which is a scroll
  // nobody asked for on the way to the rest of the panel.
  const REGION_PREVIEW = 8;
  // Countries opened up to show their regions, and the ones showing all of them
  // rather than the leaders. Kept out here so re-sorting the list — which
  // re-renders it — doesn't close everything you opened.
  const opened = new Set();
  const showingAll = new Set();

  // "What did I do most recently" and "what was the big one" are both fair
  // questions to open the list with.
  //
  // Sorting and grouping are two controls, not one. They used to share a single
  // segmented control, which quietly made them exclusive: picking "By app" threw
  // away whatever order you had, and there was no way to ask for the longest
  // ride *of each activity* — which is the question a grouped list is usually
  // opened with.
  const ROUTE_SORTS = {
    recent: {
      label: 'Newest',
      sort: (a, b) => (b.firstAt || b.addedAt) - (a.firstAt || a.addedAt) || b.id - a.id,
    },
    distance: { label: 'Longest', sort: (a, b) => b.lengthM - a.lengthM },
  };
  const ROUTE_GROUPS = {
    none: { label: 'Flat' },
    // How you usually remember one: "that Komoot ride".
    app: { label: 'By app', of: (r) => r.source || 'unknown' },
    // "Show me the rides" is as natural a question as "show me the Komoot
    // ones", and now that the activity is worked out for almost everything it
    // can actually be answered.
    activity: { label: 'By activity', of: (r) => r.sport || '' },
  };

  // Sources that say nothing about which app a route came from belong at the
  // bottom, whatever their distance.
  const VAGUE_SOURCES = new Set(['unknown', 'other', 'gpx', 'kml', 'geojson', 'csv', 'manual']);
  // Routes is what this dialog is mostly used for, so it opens there.
  let tab = 'routes';
  let routeSort = 'recent';
  let routeGroup = 'none';

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

  /**
   * One place, its share of itself as a bar, and the numbers either side.
   *
   * @param {object} o
   * @param {string} o.label   the place
   * @param {string} o.value   the number you sorted by, in full
   * @param {string} [o.aside] the other number, dimmed beside it — both are
   *   always shown, so the order of the list is never unexplained
   * @param {number} o.fraction 0–1, always the share of this place
   * @param {string} [o.note]  what it adds up to, under the bar
   * @param {string} [o.right] a note on the right of that line (the region count)
   * @param {boolean} [o.button] make the whole row pressable (it expands)
   * @param {boolean} [o.open]   … and currently open
   * @param {boolean} [o.sub]    a region inside a country, not a country
   */
  function bar({ label, value, aside, fraction, note, right, button, open, sub }) {
    const el = document.createElement(button ? 'button' : 'div');
    el.className = `stats-bar-row${sub ? ' stats-bar-sub' : ''}${button ? ' stats-bar-btn' : ''}`;
    if (button) {
      el.type = 'button';
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    el.innerHTML =
      '<div class="stats-bar-head"><span class="bar-name"></span>'
      + '<b><span class="bar-value"></span><em class="bar-aside"></em></b></div>'
      + '<div class="stats-bar"><i></i></div>'
      + '<div class="stats-bar-note"><span class="bar-note"></span><em class="bar-right"></em></div>';
    el.querySelector('.bar-name').textContent = label;
    el.querySelector('.bar-value').textContent = value;
    el.querySelector('.bar-aside').textContent = aside ? ` · ${aside}` : '';
    // Tiny slivers still deserve a visible sliver.
    el.querySelector('.stats-bar i').style.width =
      `${Math.max(1.5, Math.min(100, fraction * 100))}%`;
    el.querySelector('.bar-note').textContent = note ?? '';
    el.querySelector('.bar-right').textContent = right ?? '';
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
  //
  // `current` is only read to light one up. It used to *also* short-circuit a
  // press on the option already chosen — which is only true for as long as the
  // control lives, and made a caller that rebuilt the list without rebuilding
  // its heading stop responding after one press. Picking the option you already
  // have is a harmless re-render, so it is left to happen.
  function sortSeg(options, current, onPick) {
    const seg = document.createElement('div');
    seg.className = 'seg seg-mini';
    for (const [key, opt] of Object.entries(options)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${key === current ? ' active' : ''}`;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => onPick(key));
      seg.append(btn);
    }
    return seg;
  }

  // Both controls on one line, under the heading: what order, and whether to
  // break it into blocks. Two questions, so two controls — see ROUTE_SORTS.
  function sortAndGroup(sorts, sort, groups, group, onSort, onGroup) {
    const wrap = document.createElement('div');
    wrap.className = 'stats-controls';
    wrap.append(sortSeg(sorts, sort, onSort), sortSeg(groups, group, onGroup));
    return wrap;
  }

  /**
   * A list, optionally broken into blocks.
   *
   * Grouping is orthogonal to ordering: within each block the rows keep
   * whatever sort is selected, and the blocks themselves are ordered by how
   * much is in them. Entries that say nothing — an activity that was never
   * worked out, a trip with no country under it — sink to the bottom rather
   * than leading the list.
   *
   * @param {Array} items
   * @param {{of?:(item:any)=>string}} group
   * @param {(a:any,b:any)=>number} sort
   * @param {(item:any, opts:object)=>Node} rowOf
   * @param {(key:string, group:Array)=>{label:string, note:string, vague?:boolean}} describe
   */
  function groupedList(items, group, sort, rowOf, describe) {
    const out = [];
    const ordered = (list) => [...list].sort(sort);
    if (!group?.of) {
      const listEl = document.createElement('div');
      listEl.className = 'stats-list';
      for (const item of ordered(items)) listEl.append(rowOf(item, {}));
      return [listEl];
    }
    const buckets = new Map();
    for (const item of items) {
      const key = group.of(item);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }
    const described = [...buckets.entries()].map(([key, list]) => ({ key, list, ...describe(key, list) }));
    described.sort((a, b) => !!a.vague - !!b.vague || b.list.length - a.list.length || a.label.localeCompare(b.label));
    for (const g of described) {
      const head = document.createElement('div');
      head.className = 'stats-group';
      const name = document.createElement('span');
      name.textContent = g.label;
      const note = document.createElement('i');
      note.textContent = g.note;
      head.append(name, note);
      const listEl = document.createElement('div');
      listEl.className = 'stats-list';
      for (const item of ordered(g.list)) listEl.append(rowOf(item, { group: g.key }));
      out.push(head, listEl);
    }
    return out;
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
    const duration = formatDuration(recordedSeconds(r));
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
    // The mark hangs off the row's right edge, so it needs a lane kept clear of
    // it or it lands on top of the distance. The lane goes on every row while
    // the fold is open, not only the marked ones: the distances are a column of
    // right-aligned numbers, and one that stepped left for the two marked rows
    // would read as a fault of its own.
    el.classList.toggle('dupe-lane', showFolded() && foldedRoutes() > 0);
    // Only visible while the fold is open, because that is the only time one of
    // these is in the list — and then it has to be obvious which rows are the
    // second copy, or "show them" just makes the list longer for no reason.
    if (isFolded(r)) {
      el.classList.add('is-dupe');
      const dot = document.createElement('span');
      dot.className = 'stats-route-dupe';
      dot.title = 'The same outing as the row above — folded away unless you ask for it';
      el.append(dot);
    }
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
    // when half of them are undated would be a made-up number. A recording that
    // was never stopped is thrown out for the same reason — see
    // recordedSeconds. Two of them were contributing 759 of 956 hours.
    const timed = list.filter((r) => recordedSeconds(r) > 0);
    const seconds = timed.reduce((n, r) => n + recordedSeconds(r), 0);
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

    const redraw = () => {
      const at = body.scrollTop;
      renderRoutes();
      body.scrollTop = at;
    };
    body.append(
      headRow(
        'Your routes',
        sortAndGroup(
          ROUTE_SORTS, routeSort, ROUTE_GROUPS, routeGroup,
          (key) => { routeSort = key; redraw(); },
          (key) => { routeGroup = key; redraw(); },
        ),
      ),
    );
    body.append(...groupedList(
      list,
      ROUTE_GROUPS[routeGroup],
      ROUTE_SORTS[routeSort].sort,
      // The heading already says the thing the list is grouped by, so the row
      // stops repeating it.
      (r) => routeRow(r, { showApp: routeGroup !== 'app', showSport: routeGroup !== 'activity' }),
      (key, group) => ({
        label: routeGroup === 'activity' ? key || 'Activity not set' : sourceLabel(key),
        note: `${plural(group.length, 'route')} · ${formatDistance(totalLength(group))}`,
        vague: key === '' || VAGUE_SOURCES.has(key),
      }),
    ));

    // Under the list, not over it. Silently dropping a route somebody remembers
    // importing is the failure this dialog exists to avoid, so the count has to
    // be said — but it is a footnote about the list, and a footnote goes at the
    // end. Above the routes it was the first thing read in a tab that is
    // supposed to open on your routes.
    const folded = foldedRoutes();
    if (folded || showFolded()) {
      const el = document.createElement('div');
      el.className = 'route-fold';
      const text = document.createElement('span');
      text.textContent = showFolded()
        ? `${plural(folded, 'route')} marked above ${folded === 1 ? 'is' : 'are'} the same routes recorded multiple times.`
        : `${plural(folded, 'route')} ${folded === 1 ? 'is duplicate' : 'are duplicates'} and are hidden.`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'home-set';
      btn.textContent = showFolded() ? 'Fold them' : 'Show them';
      btn.addEventListener('click', () => {
        onShowFolded?.(!showFolded());
        redraw();
      });
      el.append(text, btn);
      body.append(el);
    }
  }

  // Every control in this tab redraws the list it is in, so they all need the
  // reader to stay where they were rather than being thrown back to the top.
  const reRender = () => {
    const at = body.scrollTop;
    render(last);
    body.scrollTop = at;
  };

  /**
   * Coverage, as one list.
   *
   * It used to be two: every country, then every region, ranked across the whole
   * world. A region only means something inside the country it belongs to,
   * though — "Valais 22%" sandwiched between two other countries' provinces is a
   * row you have to decode — and the question people actually have after seeing
   * Switzerland at 7% is *which parts*. So the regions live under their country
   * and open with it.
   */
  function coverageList(s) {
    const opt = SORTS[sortBy];
    const inCountry = new Map(); // country name → its visited regions
    for (const r of s.regions ?? []) {
      const seen = inCountry.get(r.country);
      if (seen) seen.push(r);
      else inCountry.set(r.country, [r]);
    }
    const value = (p) => (sortBy === 'area' ? km2(p.km2) : pct(p.pct));
    const aside = (p) => (sortBy === 'area' ? pct(p.pct) : km2(p.km2));
    const note = (p) => `of ${km2(p.totalKm2)} · ${plural(p.cells, 'cell')}`;

    const list = document.createElement('div');
    list.className = 'stats-list';
    for (const c of [...s.countries].sort(opt.sort)) {
      const regions = (inCountry.get(c.id) ?? []).sort(opt.sort);
      const open = opened.has(c.id);
      const row = bar({
        label: c.id,
        value: value(c),
        aside: aside(c),
        fraction: c.pct / 100,
        note: note(c),
        right: regions.length
          ? `${regions.length} of ${Math.max(regions.length, c.regionsTotal)} regions`
          : '',
        button: regions.length > 0,
        open,
      });
      list.append(row);
      if (!regions.length) continue; // nothing to open: not every country is divided
      row.addEventListener('click', () => {
        if (open) {
          opened.delete(c.id);
          showingAll.delete(c.id); // closing it forgets how far it was unrolled
        } else {
          opened.add(c.id);
        }
        reRender();
      });
      if (!open) continue;

      const subs = document.createElement('div');
      subs.className = 'stats-subs';
      const all = showingAll.has(c.id);
      for (const r of all ? regions : regions.slice(0, REGION_PREVIEW)) {
        subs.append(bar({
          label: r.name,
          value: value(r),
          aside: aside(r),
          fraction: r.pct / 100,
          note: note(r),
          sub: true,
        }));
      }
      if (regions.length > REGION_PREVIEW) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'stats-more';
        more.textContent = all ? 'Show fewer' : `Show all ${regions.length} regions`;
        more.addEventListener('click', () => {
          if (all) showingAll.delete(c.id);
          else showingAll.add(c.id);
          reRender();
        });
        subs.append(more);
      }
      list.append(subs);
    }
    return list;
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
    if (s.days) {
      // How much of that span the map actually knows about. A history spanning
      // eight years made of two holidays is a different map from one with a
      // phone logging every day, and the span alone can't tell them apart.
      body.append(row('Days recorded', s.days.toLocaleString(), 'days the history has evidence for'));
      if (s.streakDays > 1) {
        body.append(row('Longest streak', plural(s.streakDays, 'day'), `up to ${dayOf(s.streakEnd)}`));
      }
    }

    if (s.countries.length) {
      body.append(
        headRow(
          'Coverage',
          sortSeg(SORTS, sortBy, (key) => {
            sortBy = key;
            reRender();
          }),
        ),
      );
      body.append(coverageList(s));
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

  // --- Trips and coverage ------------------------------------------------------
  // Both are readings of the rows rather than rows themselves, and both are
  // read from the server — see src/derived.js. This dialog used to work them
  // out itself, which meant downloading the towns, the regions and the
  // countries (about 1.7 MB gzipped) to find out how much of Switzerland you
  // have walked across.

  async function showCells() {
    // Already read for this opening: re-render straight from the numbers, which
    // is what re-sorting the coverage list does.
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
      const s = await derived.loadStats();
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
     * Redraw whatever is on screen, for a change that alters how things read
     * rather than what they say — currently only the 12/24-hour clock. A no-op
     * when the panel is shut, because every tab rebuilds itself on the way in.
     */
    redraw: () => {
      if (overlay.hidden) return;
      last = null; // the cached reading is fine; the *rendering* of it is not
      showTab(tab);
    },
    /**
     * The trips as last read, or null if they never have been. The search
     * palette asks for these rather than deriving its own — one reading of the
     * data, so a trip has the same name in both places.
     */
    trips: () => derived.trips(),
    /**
     * Read them now (for the search palette on a cold start, and for this
     * dialog's own Trips tab).
     *
     * Asked every time rather than only when nothing is held: a repeat that
     * nothing has changed under is a 304, so keeping the list current costs
     * less than the bookkeeping to know when it isn't. It used to be derived
     * once per page and then kept for good, which meant importing a file left
     * the trip list showing the map from before it.
     */
    ensureTrips: () => derived.loadTrips(),
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
