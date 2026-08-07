// The "Airports" dialog: which of them are drawn.
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
import { onBackdropClick } from './dismiss.js';

const NUM = new Intl.NumberFormat();

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose] called when the dialog is dismissed with Back
 * @param {() => Record<string, boolean>} opts.groups what has been chosen so far
 * @param {(key: string, on: boolean) => void} opts.onGroup
 */
export function mountAirports({ onClose, groups, onGroup }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('airports-overlay');
  const scroller = overlay.querySelector('.ha-scroll');
  const list = $('airports-groups');

  /**
   * Fade the last few pixels once there is more below the fold, the same as the
   * other dialogs that outgrow a phone. CSS cannot tell whether a box overflows,
   * so the class is put on from here.
   */
  function markOverflow() {
    const over = scroller.scrollHeight - scroller.clientHeight;
    scroller.classList.toggle('more', over > 4);
    scroller.classList.toggle('at-end', scroller.scrollTop >= over - 4);
  }

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
    markOverflow();
  }

  scroller.addEventListener('scroll', markOverflow, { passive: true });

  const open = () => {
    draw();
    overlay.hidden = false;
    markOverflow();
  };
  const close = () => {
    overlay.hidden = true;
  };

  $('airports-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('airports-done').addEventListener('click', close);
  $('airports-close').addEventListener('click', close);
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
