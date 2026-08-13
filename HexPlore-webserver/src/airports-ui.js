// The Airports section of the Map layers page: which of them are drawn.
//
// The same shape as the Train tracks dialog and for the same reason — these are
// settings, which is to say things you set once and then read the map, rather
// than something you flick while looking at it. The overlay's own switch stays
// in the layers menu, beside the other "is this layer drawn" questions.
//
// It differs from the railway's in one way worth saying out loud: each group here
// is also a **download**, so the row carries how many airports it would add. The
// railway's groups are filters over tiles that arrive anyway and cost nothing to
// switch on; these are 250 KB against 4.5 MB, and a switch whose cost is
// invisible is a switch somebody flips once and then wonders about.

import { AIRPORT_GROUPS, airportGroupOn } from './airports.js';
// Four numbers, written by the build so they cannot drift from the files they
// describe. Statically imported — unlike the group data itself, which is the
// whole point of splitting it up.
import GROUP_COUNTS from './airports-counts.json';

const NUM = new Intl.NumberFormat();

/**
 * @param {object} opts
 * @param {() => void} [opts.onGrew] the rows landed, so the page can re-measure
 * @param {() => Record<string, boolean>} opts.groups what has been chosen so far
 * @param {(key: string, on: boolean) => void} opts.onGroup
 */
export function mountAirports({ onGrew, groups, onGroup }) {
  const $ = (id) => document.getElementById(id);
  const list = $('airports-groups');

  function draw() {
    const chosen = groups?.() ?? {};
    list.replaceChildren(...AIRPORT_GROUPS.map((group) => {
      const row = document.createElement('label');
      row.className = 'import-row';
      const text = document.createElement('span');
      text.textContent = group.label;
      const small = document.createElement('small');
      const count = GROUP_COUNTS[group.key];
      small.textContent = count ? `${group.note} — ${NUM.format(count)}` : group.note;
      text.append(small);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = airportGroupOn(chosen, group.key);
      // Deliberately does not redraw the list it was called from: re-rendering
      // would replace the checkbox whose own change event we are inside, which
      // works and throws away the focus a keyboard user was holding.
      input.addEventListener('change', () => onGroup?.(group.key, input.checked));
      row.append(text, input);
      return row;
    }));
    // Until these rows land there is nothing to overflow with, so the page
    // around this is told to re-measure rather than measuring once on open.
    onGrew?.();
  }

  return { draw };
}
