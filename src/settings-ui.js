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
 * @param {{open:Function}} opts.backup the Backups dialog
 * @param {() => ({name?:string}|null)} opts.home where the map is measured from
 * @param {() => void} opts.onSetHome hand the map over to the home picker
 * @param {() => boolean} opts.homeShown whether the marker is drawn
 * @param {(on:boolean) => void} opts.onShowHome
 */
export function mountSettings({ backup, home, onSetHome, homeShown, onShowHome }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const backupNote = $('settings-backup-note');
  const homeName = $('settings-home-name');
  const homeSet = $('settings-home-set');
  const homeBox = $('settings-home-shown');

  // Read on every opening rather than wired once: home can be changed from the
  // picker this dialog opens, and the answer has to be current when you come
  // back to it.
  function drawHome() {
    const set = home?.();
    homeName.textContent = set?.name || 'Worked out from the cells you visit most';
    homeSet.textContent = set ? 'Change' : 'Set home';
    homeBox.checked = !!homeShown?.();
  }

  homeSet.addEventListener('click', () => {
    close();
    onSetHome?.();
  });
  homeBox.addEventListener('change', () => onShowHome?.(homeBox.checked));

  // Export is listed and disabled rather than left out. There is nothing behind
  // it yet, and saying so is more honest than a menu that quietly grows an
  // entry later — the row points at where the way out currently is.
  const targets = { backup };

  const open = () => {
    drawHome();
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
