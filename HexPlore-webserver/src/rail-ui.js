// The Train tracks section of the Map layers page: what the overlay draws, and
// whether it answers a tap.
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
//
// **It used to be a dialog of its own** and is now a section of one — see
// src/map-layers-ui.js for why the page of doors went away. Nothing about what
// is wired changed: the same three ids, the same three callbacks. What went is
// the overlay, its Back and Done, and the Escape handler, all of which now
// belong to the page this draws into.

import { loadRailStyle, railGroups, railGroupOn } from './rail.js';

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
 * @param {() => void} [opts.onGrew] the rows landed, so the page can re-measure
 * @param {() => Record<string, boolean>} opts.groups what has been chosen so far
 * @param {(key: string, on: boolean) => void} opts.onGroup
 * @param {() => boolean} opts.technical
 * @param {(on: boolean) => void} opts.onTechnical
 * @param {() => boolean} opts.interactive
 * @param {(on: boolean) => void} opts.onInteractive
 */
export function mountRail({
  onGrew, groups, onGroup, technical, onTechnical, interactive, onInteractive,
}) {
  const $ = (id) => document.getElementById(id);
  const list = $('rail-groups');
  const technicalBox = $('rail-technical');
  const interactiveBox = $('rail-interactive');

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
    // The page around this measures its own scroll, and until these rows
    // land there is nothing to overflow with — the style behind them is a
    // lazily imported chunk that may arrive well after the page is open.
    onGrew?.();
  }

  /**
   * Read the current state into the controls, and fill the group list.
   *
   * Called by the page when it opens rather than by an `open()` of this
   * module's own: there is no dialog here to open any more.
   */
  function draw() {
    technicalBox.checked = !!technical?.();
    interactiveBox.checked = !!interactive?.();
    drawGroups();
    // Never fatal, and never awaited: the two switches here are settings of ours
    // and work whether or not their style ever arrives. If it does, the list
    // fills in underneath.
    loadRailStyle().then(drawGroups).catch(() => {});
  }

  technicalBox.addEventListener('change', () => onTechnical?.(technicalBox.checked));
  interactiveBox.addEventListener('change', () => onInteractive?.(interactiveBox.checked));

  return { draw };
}
