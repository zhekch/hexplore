// The "Export & settings" dialog — the door data leaves by.
//
// Its twin (src/sync-ui.js) is everything that brings where you've been *in*;
// this is everything that takes it back out, and the settings for doing it on a
// schedule. Splitting the two that way is the point of the menu having two
// buttons rather than four: you know which one you want before you know what's
// behind it.
//
// Like the other hub, it owns nothing itself — each entry hands off to its own
// dialog and comes back here when that one is dismissed with Back.

/**
 * @param {object} opts
 * @param {{open:Function}} opts.personal the Settings dialog
 * @param {{open:Function}} opts.backup the Backups dialog
 * @param {{open:Function}} opts.exportImage the image export
 */
export function mountSettings({ personal, backup, exportImage }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const backupNote = $('settings-backup-note');

  // Export used to be listed and disabled — a row pointing at where the way out
  // currently was, which was a database backup. It is a picture now, and a
  // picture is what people were asking that row for.
  //
  // Sources is no longer one of these. It is reached from inside Settings now,
  // because it is not a way of getting your map out — which is what this hub is.
  const targets = { personal, backup, export: exportImage };

  const open = () => {
    overlay.hidden = false;
  };
  const close = () => {
    overlay.hidden = true;
  };

  for (const btn of overlay.querySelectorAll('[data-settings]')) {
    btn.addEventListener('click', () => {
      const target = targets[btn.dataset.settings];
      if (!target) return;
      close();
      target.open();
    });
  }

  $('settings-close').addEventListener('click', close);
  $('settings-done').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    // The row doubles as its own status line, so the schedule is readable
    // without opening anything.
    setBackupStatus: (text) => {
      backupNote.textContent = text;
    },
  };
}
