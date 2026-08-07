// The "Import & sync" dialog: one door in front of everything that puts where
// you've been onto the map.
//
// Both halves of that are here because from the outside they are one question —
// *how does my history get in?* — and the answer differing in whether you pick
// a file or the server fetches it on a timer is an implementation detail you
// shouldn't have to know before you can find the button. Files and links do it
// once; Home Assistant and Strava are set up once and then keep doing it.
//
// What goes the other way lives in its own dialog (src/settings-ui.js).
//
// It owns nothing itself — each entry hands off to its own dialog and comes
// back here when that one is dismissed with Back, so the two read as one flow.

import { onBackdropClick } from './dismiss.js';

/**
 * @param {object} opts
 * @param {{open:Function}} opts.homeAssistant the Home Assistant dialog
 * @param {{open:Function}} opts.strava        the Strava dialog
 * @param {{open:Function}} opts.device        the phones-reporting-in dialog
 * @param {{open:Function}} opts.files         the file importer
 */
export function mountSync({ homeAssistant, strava, device, files }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('sync-overlay');
  const haNote = $('sync-ha-note');
  const stravaNote = $('sync-strava-note');
  const deviceNote = $('sync-device-note');

  // Komoot isn't a row of its own: it imports once from a pasted link rather
  // than staying connected, so it sits inside the file importer, one step in.
  const targets = { files, ha: homeAssistant, strava, device };

  const open = () => {
    overlay.hidden = false;
  };
  const close = () => {
    overlay.hidden = true;
  };

  // Choosing a source swaps this dialog for that one; its Back button brings
  // the picker back (see the onClose each dialog is mounted with).
  for (const btn of overlay.querySelectorAll('[data-sync]')) {
    btn.addEventListener('click', () => {
      const target = targets[btn.dataset.sync];
      if (!target) return;
      close();
      target.open();
    });
  }

  $('sync-close').addEventListener('click', close);
  $('sync-done').addEventListener('click', close);
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    // Each row doubles as its own status line, so you can see what's running
    // without opening anything.
    setHaStatus: (text) => {
      haNote.textContent = text;
    },
    setStravaStatus: (text) => {
      stravaNote.textContent = text;
    },
    setDeviceStatus: (text) => {
      deviceNote.textContent = text;
    },
  };
}
