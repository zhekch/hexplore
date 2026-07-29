// The card you get by tapping a saved route on the map: what it was, when, how
// far. Two ways on from here — zoom to it, or open it properly.
//
// It used to carry Edit and Remove as well, which made it a third place that
// knew how to change a route. Everything that *changes* one now lives in the
// routes dialog (Routes and statistics → a route), and "More info" is the door
// to it; this card stays a read-only glance at the line you just tapped.
//
// Same shape and language as the cell card (src/cell-info.js); main.js owns the
// route list and hands over one plain object.

import { sourceLabel } from './locations.js';
import { formatDistance, formatDuration } from './routes.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);
const clock = (sec) => (sec ? timeFmt.format(new Date(sec * 1000)) : null);

/**
 * Wires the card (markup lives in index.html).
 * @param {object} opts
 * @param {() => void} opts.onClose
 * @param {(route:object) => void} opts.onZoom
 * @param {(route:object) => void} opts.onMore  open it in the routes dialog
 * @param {(route:object) => void} [opts.onOnly] draw only this route (toggle)
 * @param {(route:object) => boolean} [opts.isSolo] is it the isolated one
 */
export function mountRouteInfo({ onClose, onZoom, onMore, onOnly, isSolo } = {}) {
  const $ = (id) => document.getElementById(id);
  const card = $('route-info');
  const nameEl = $('route-info-name');
  const subEl = $('route-info-sub');
  const rowsEl = $('route-info-rows');
  const closeBtn = $('route-info-close');
  const zoomBtn = $('route-zoom');
  const moreBtn = $('route-more');
  const onlyBtn = $('route-only');

  let route = null;

  // The button says what pressing it will do, so it has to flip once the route
  // is already the only one showing.
  function setSolo(on) {
    onlyBtn.textContent = on ? 'Show all' : 'Only this';
    onlyBtn.classList.toggle('active', !!on);
  }

  function hide() {
    card.hidden = true;
    route = null;
  }

  function row(label, value) {
    if (!value) return;
    const el = document.createElement('div');
    el.className = 'cell-info-row';
    el.innerHTML = '<span></span><b></b>';
    el.firstChild.textContent = label;
    el.lastChild.textContent = value;
    rowsEl.append(el);
  }

  function show(r) {
    route = r;
    setSolo(!!isSolo?.(r));
    nameEl.textContent = r.name || 'Route';
    const started = day(r.firstAt);
    // The place is the most useful thing to know at a glance, so it leads the
    // sub-line — unless it *is* the title, in which case repeating it is noise.
    const place = r.place && r.place !== r.name ? r.place : null;
    subEl.textContent = [place, sourceLabel(r.source), started ?? `added ${day(r.addedAt) ?? 'recently'}`]
      .filter(Boolean)
      .join(' · ');

    rowsEl.replaceChildren();
    // Same wording as the dialog: a worked-out activity says so.
    row('Activity', r.sport ? (r.sportGuessed ? `${r.sport} (estimated)` : r.sport) : '');
    row('Distance', formatDistance(r.lengthM));
    // Only shown when the file carried elevation at all — a flat 0 m would read
    // as a measurement rather than an absence.
    if (r.elevUp > 0) row('Climb', `${Math.round(r.elevUp).toLocaleString()} m`);
    // A track that ran past midnight is worth spelling out; one that didn't
    // reads better as a single day plus a start time.
    const ended = day(r.lastAt);
    if (started && ended && started !== ended) row('When', `${started} – ${ended}`);
    else if (started) row('When', started);
    if (started && ended && started === ended && r.lastAt > r.firstAt) {
      row('Started', clock(r.firstAt));
    }
    row('Duration', formatDuration(r.lastAt - r.firstAt));
    row('Shape', `${(r.points ?? 0).toLocaleString()} points`);

    card.hidden = false;
  }

  closeBtn.addEventListener('click', () => {
    hide();
    onClose?.();
  });

  zoomBtn.addEventListener('click', () => {
    if (route) onZoom?.(route);
  });

  moreBtn.addEventListener('click', () => {
    if (route) onMore?.(route);
  });

  onlyBtn.addEventListener('click', () => {
    if (route) onOnly?.(route);
  });

  return { show, hide, setSolo, visible: () => !card.hidden, current: () => route };
}
