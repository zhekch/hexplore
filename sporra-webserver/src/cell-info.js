// The view-mode info card: tap a colored area and this says when you were
// there and how much of it you have covered. Pure DOM rendering — main.js
// gathers the numbers (it owns the grid state) and hands over a plain object.
//
// Which apps put those cells on the map is deliberately not here: it is a fact
// about the recording, not about the place, and it is answered in one place
// that can act on it — Settings → Sources, which can also rename or remove one.

import { formatTime } from './clock.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);

// "3 Sep 2023" for a single day, "3 Sep 2023 – 12 Jul 2026" for a span.
function range(first, last) {
  const a = day(first);
  const b = day(last);
  if (!a && !b) return null;
  if (!a || !b || a === b) return a ?? b;
  return `${a} – ${b}`;
}

const coord = (lat, lng) => `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;

export const km2 = (v) =>
  v >= 1000 ? `${Math.round(v).toLocaleString()} km²`
  : v >= 10 ? `${v.toFixed(0)} km²`
  : `${v.toFixed(1)} km²`;

// A country you have crossed once is a fraction of a percent of itself, and "0%"
// is a wrong answer rather than a small one — so the scale keeps adding decimals
// until it runs out, and then says so rather than rounding the answer away.
export const pct = (v) =>
  v >= 1 ? `${v.toFixed(0)}%`
  : v >= 0.1 ? `${v.toFixed(1)}%`
  : v >= 0.005 ? `${v.toFixed(2)}%`
  : '<0.01%';

/**
 * Wires the card (markup lives in index.html).
 * @returns {{show:(info:object)=>void, hide:()=>void, visible:()=>boolean}}
 */
export function mountCellInfo({ onClose } = {}) {
  const $ = (id) => document.getElementById(id);
  const card = $('cell-info');
  const titleEl = $('cell-info-title');
  const closeBtn = $('cell-info-close');
  const coordEl = $('cell-info-coord');
  const rowsEl = $('cell-info-rows');

  const hide = () => {
    card.hidden = true;
  };

  closeBtn.addEventListener('click', () => {
    hide();
    onClose?.();
  });

  function row(label, value, sub) {
    const el = document.createElement('div');
    el.className = 'cell-info-row';
    el.innerHTML = '<span></span><b></b>';
    el.firstChild.textContent = label;
    el.lastChild.textContent = value;
    if (sub) el.lastChild.title = sub;
    rowsEl.append(el);
  }

  function show(info) {
    // A cell is a place on the map, so it is named by its coordinates; a region
    // has a name of its own and the coordinates of one point inside it would be
    // noise.
    titleEl.textContent = info.title ?? 'Visited';
    coordEl.textContent = info.title
      ? info.sizeLabel
      : `${coord(info.lat, info.lng)} · ${info.sizeLabel}`;
    rowsEl.replaceChildren();

    const seen = range(info.firstAt, info.lastAt);
    if (seen) {
      row(info.firstAt && info.lastAt && day(info.firstAt) !== day(info.lastAt) ? 'Seen' : 'Seen on', seen);
      // A single fix is worth a clock reading; a multi-year span isn't.
      if (info.firstAt && info.firstAt === info.lastAt) {
        row('Time', formatTime(info.firstAt * 1000));
      }
    }
    // "Added to map" is a fact about the import, not about the place — it says
    // when a file was dropped in, which is never the question anyone opened this
    // card to ask.
    //
    // Neither is a count of *cells*, which this card used to lead with. A cell
    // is the unit the storage happens to keep ground in, and "1,284 cells
    // inside" asks the reader to know what one is before it tells them
    // anything — and then tells them nothing, because whether that is a corner
    // of France or most of it depends on a number the card never showed. Every
    // question it was standing in for is answered better below: how much
    // ground, what share of the place, how many of its own parts.
    //
    // How many of the smaller places inside it you have been to — countries in
    // a continent, regions in a country. It sits above the ground covered
    // because the two answer genuinely different questions and this is the one
    // that scales with a trip: crossing the top of Africa covers a rounding
    // error of its ground and four of its countries.
    if (info.inside) {
      row(
        info.inside.label,
        info.inside.of ? `${info.inside.n} of ${info.inside.of.toLocaleString()}` : info.inside.n.toLocaleString(),
      );
    }
    // How much of it you have actually been to. Only an area can answer this —
    // for a single cell the question is the cell, so `covered` is left undefined
    // there. Zero is still an answer, and an area card that has been opened on
    // somewhere you have never been is exactly where it has to be given: the
    // card would otherwise be a title and a size, which reads as a card that
    // failed to load.
    if (info.covered != null) {
      // The share is dropped only when there is nothing to compare against —
      // a region whose polygon area we don't have. Being a very small fraction
      // of France is a fact about France, not a reason to withhold it.
      row(
        'Ground covered',
        info.covered <= 0 ? 'None yet'
        : info.coveredPct > 0 ? `${km2(info.covered)} · ${pct(info.coveredPct)}`
        : km2(info.covered),
        info.covered > 0
          ? `${Math.round(info.covered).toLocaleString()} km² of ${info.coveredOf}`
          : `Nothing on the map in ${info.coveredOf} yet`,
      );
    }
    // Visits are the number the heat map reads, and the only count worth
    // showing. The raw fix count used to get a line of its own whenever it
    // disagreed, which was most of the time and never meant anything: it says
    // how often a recorder happened to sample, not how often you were here, so
    // an hour parked with a workout app running outranked a week somewhere.
    if (info.hits) row('Visits', info.hits.toLocaleString());

    card.hidden = false;
  }

  return { show, hide, visible: () => !card.hidden };
}
