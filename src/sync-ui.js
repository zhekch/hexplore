// The "Sync" dialog: one door in front of every app the map keeps *connected* —
// Home Assistant and Strava, both of which are set up once and then polled on a
// timer. A one-off paste-a-link import (Komoot) belongs with the files instead.
//
// It owns nothing itself — each entry hands off to its own dialog and comes
// back here when that one is dismissed with Back, so the two read as one flow.

/**
 * @param {object} opts
 * @param {{open:Function}} opts.homeAssistant the Home Assistant dialog
 * @param {{open:Function}} opts.strava        the Strava dialog
 */
export function mountSync({ homeAssistant, strava }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('sync-overlay');
  const haNote = $('sync-ha-note');
  const stravaNote = $('sync-strava-note');

  // Komoot isn't here: it imports once from a pasted link rather than staying
  // connected, so it sits with the file importer instead.
  const targets = { ha: homeAssistant, strava };

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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
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
  };
}
