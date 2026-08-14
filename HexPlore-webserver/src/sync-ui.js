// The "Sync" dialog: the three things that keep the map current on their own.
//
// It was "Import & sync", and its first row was a file picker. That pairing was
// argued for on the grounds that from the outside they answer one question —
// *how does my history get in?* — and whether you pick a file or the server
// fetches it on a timer is an implementation detail. It is not a detail from
// where you are standing, which is the part that reading got wrong: a file you
// have is something you *do*, once, and then go and look at the result of; Home
// Assistant, Strava and a phone are things you set up once and then only ever
// come back to in order to ask whether they are still working. Those are two
// different errands, and they are wanted at two different times.
//
// So the importer is a tab in Settings (src/import.js) and this is what is left:
// three connections and their status lines. The row that used to open the
// importer is gone rather than turned into a shortcut into Settings — a hub with
// one entry that leaves for a different dialog is a hub that lies about where
// its content is. The subtitle says where it went, which is what somebody
// arriving here out of habit actually needs.
//
// It owns nothing itself — each entry hands off to its own dialog and comes
// back here when that one is dismissed with Back, so the two read as one flow.

import { onBackdropClick } from './dismiss.js';

/**
 * @param {object} opts
 * @param {{open:Function}} opts.homeAssistant the Home Assistant dialog
 * @param {{open:Function}} opts.strava        the Strava dialog
 * @param {{open:Function}} opts.device        the phones-reporting-in dialog
 */
export function mountSync({ homeAssistant, strava, device }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('sync-overlay');
  const haNote = $('sync-ha-note');
  const stravaNote = $('sync-strava-note');
  const deviceNote = $('sync-device-note');

  // Komoot isn't a row here either: it imports once from a pasted link rather
  // than staying connected, so it sits inside the importer, one step into
  // Settings → Import.
  const targets = { ha: homeAssistant, strava, device };

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
