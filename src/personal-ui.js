// The "Personal" dialog: the settings that are about you rather than about the
// data — where the map is measured from, what a clock says, and whether a tap
// on it edits.
//
// It used to be a block sitting on top of the export list in src/settings-ui.js,
// which put two unrelated kinds of thing in one dialog and made the list below
// read as a continuation of it. It is an entry of its own now, alongside Export
// and Backups, so the hub is a list of doors and nothing else.

import { localIs24Hour } from './clock.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]   called when the dialog is dismissed with Back
 * @param {() => ({name?:string}|null)} opts.home where the map is measured from
 * @param {() => void} opts.onSetHome   hand the map over to the home picker
 * @param {() => boolean} opts.homeShown whether the marker is drawn
 * @param {(on:boolean) => void} opts.onShowHome
 * @param {() => string} opts.clock      the account's clock preference
 * @param {(mode:string) => void} opts.onClock
 */
export function mountPersonal({ onClose, home, onSetHome, homeShown, onShowHome, clock, onClock }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('personal-overlay');
  const homeName = $('settings-home-name');
  const homeSet = $('settings-home-set');
  const homeBox = $('settings-home-shown');
  const clockSel = $('settings-clock');
  const clockNote = $('settings-clock-note');

  // Read on every opening rather than wired once: home can be changed from the
  // picker this dialog opens, and the answer has to be current when you come
  // back to it.
  function draw() {
    const set = home?.();
    homeName.textContent = set?.name || 'Worked out from the cells you visit most';
    homeSet.textContent = set ? 'Change' : 'Set home';
    homeBox.checked = !!homeShown?.();
    clockSel.value = clock?.() ?? 'auto';
    // Naming what "follow this device" is actually going to do. On its own the
    // word tells you nothing about which of the two you are being given, and
    // the whole reason anyone opens this row is that they disagree with it.
    clockNote.textContent = clockSel.value === 'auto'
      ? `Times follow this device — right now that is ${localIs24Hour() ? '24-hour' : '12-hour'}`
      : 'Kept with your account, so every device you sign in on agrees';
  }

  const open = () => {
    draw();
    overlay.hidden = false;
  };
  const close = () => {
    overlay.hidden = true;
  };

  // Picking a home needs the map, so this dialog gets out of the way entirely
  // rather than returning to the hub behind it.
  homeSet.addEventListener('click', () => {
    close();
    onSetHome?.();
  });
  homeBox.addEventListener('change', () => onShowHome?.(homeBox.checked));
  clockSel.addEventListener('change', () => {
    onClock?.(clockSel.value);
    draw();
  });

  $('personal-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('personal-done').addEventListener('click', close);
  $('personal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    // The hub's row doubles as its own status line, so where home is can be
    // read without opening this.
    summary: () => {
      const set = home?.();
      return set?.name ? `Home is ${set.name}` : 'Home worked out from where you go most';
    },
  };
}
