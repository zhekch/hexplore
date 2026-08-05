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
 */
export function mountSettings({ personal, backup }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const backupNote = $('settings-backup-note');

  // Export is listed and disabled rather than left out. There is nothing behind
  // it yet, and saying so is more honest than a menu that quietly grows an
  // entry later — the row points at where the way out currently is.
  //
  // Sources is no longer one of these. It is reached from inside Settings now,
  // because it is not a way of getting your map out — which is what this hub is.
  const targets = { personal, backup };

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
