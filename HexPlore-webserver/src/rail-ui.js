// The "Train tracks" dialog: what the overlay draws, and whether it answers a
// tap.
//
// These used to be a disclosure inside the layers menu, folded under the switch
// that turns the overlay on. That was the right place for two checkboxes and the
// wrong one for eight: the layers menu is a thing you flick through while looking
// at the map, and a column of railway sub-options in the middle of it pushed
// everything below out of reach on a phone. They are settings — you set them once
// and then read the map — so they live where the settings are, and the layers
// menu keeps the one switch that is genuinely about the view.
//
// The switch itself deliberately stays behind: "is this layer drawn" is the same
// question as "is the heatmap drawn", and it belongs beside it.

import { loadRailStyle, railGroups, railGroupOn } from './rail.js';
import { onBackdropClick } from './dismiss.js';

/**
 * What each group is, in words that are about the map rather than about OSM.
 *
 * The labels come from the built style (one place decides what the groups are);
 * these are the sentence under each, and a group with nothing to add is simply
 * absent rather than carrying a restatement of its own name.
 */
const GROUP_NOTES = {
  linenumbers: 'The route shields along the line, and the track numbers in a station',
  tracks: 'Every line, siding and spur, drawn by what it is',
  stations: 'Stations, halts and their extent',
  symbols: 'Signals, level crossings, switches and station entrances',
  platforms: 'Platform edges and their numbers',
  milestones: 'The distance posts along the line',
};

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose] called when the dialog is dismissed with Back
 * @param {() => Record<string, boolean>} opts.groups what has been chosen so far
 * @param {(key: string, on: boolean) => void} opts.onGroup
 * @param {() => boolean} opts.technical
 * @param {(on: boolean) => void} opts.onTechnical
 * @param {() => boolean} opts.interactive
 * @param {(on: boolean) => void} opts.onInteractive
 */
export function mountRail({
  onClose, groups, onGroup, technical, onTechnical, interactive, onInteractive,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('rail-overlay');
  const scroller = overlay.querySelector('.ha-scroll');
  const list = $('rail-groups');
  const technicalBox = $('rail-technical');
  const interactiveBox = $('rail-interactive');

  /**
   * Fade the last few pixels once there is more below the fold, the same as the
   * other dialogs that outgrow a phone. CSS cannot tell whether a box overflows,
   * so the class is put on from here — and re-checked after the group rows land,
   * since until they do there is nothing to overflow with.
   */
  function markOverflow() {
    const over = scroller.scrollHeight - scroller.clientHeight;
    scroller.classList.toggle('more', over > 4);
    scroller.classList.toggle('at-end', scroller.scrollTop >= over - 4);
  }

  /**
   * The group checkboxes, once there is a style loaded to name the groups.
   *
   * The style is a 315 KB lazily-imported chunk and the overlay may never have
   * been switched on, in which case there is nothing yet to build a list from.
   * Opening this dialog is a clear enough statement of intent to fetch it —
   * offering an empty box until somebody switches the overlay on first would be
   * a dialog that appears broken for the one reason nobody could guess.
   */
  function drawGroups() {
    const found = railGroups();
    if (!found.length) return;
    const chosen = groups?.() ?? {};
    list.replaceChildren(...found.map((group) => {
      const row = document.createElement('label');
      row.className = 'import-row';
      const text = document.createElement('span');
      text.textContent = group.label;
      const note = GROUP_NOTES[group.key];
      if (note) {
        const small = document.createElement('small');
        small.textContent = note;
        text.append(small);
      }
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = railGroupOn(chosen, group.key);
      input.addEventListener('change', () => onGroup?.(group.key, input.checked));
      row.append(text, input);
      return row;
    }));
    markOverflow();
  }

  function draw() {
    technicalBox.checked = !!technical?.();
    interactiveBox.checked = !!interactive?.();
    drawGroups();
  }

  scroller.addEventListener('scroll', markOverflow, { passive: true });

  const open = () => {
    draw();
    overlay.hidden = false;
    markOverflow();
    // Never fatal, and never awaited before the dialog is up: the two switches
    // below are settings of ours and work whether or not their style ever
    // arrives. If it does, the list fills in underneath.
    loadRailStyle().then(drawGroups).catch(() => {});
  };
  const close = () => {
    overlay.hidden = true;
  };

  technicalBox.addEventListener('change', () => onTechnical?.(technicalBox.checked));
  interactiveBox.addEventListener('change', () => onInteractive?.(interactiveBox.checked));

  $('rail-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('rail-done').addEventListener('click', close);
  $('rail-close').addEventListener('click', close);
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
