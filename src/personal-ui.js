// The "Settings" dialog: everything about this instance and how it behaves —
// where the map is measured from, what a clock says, whether a tap edits, what
// the map is built out of, and what is cached.
//
// It used to be a block sitting on top of the export list in src/settings-ui.js,
// which put two unrelated kinds of thing in one dialog and made the list below
// read as a continuation of it. It is an entry of its own now, alongside Export
// and Backups, so the hub is a list of doors and nothing else.
//
// Sources and the cache escape hatch came here from that hub, where they were
// doors of their own. A hub of five entries, two of which were settings, is a
// list you have to read rather than scan — and neither of them is a way of
// getting your map *out*, which is what the hub is for.

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
 * @param {{open:Function}} [opts.sources] the Sources dialog, opened from here
 * @param {() => Promise<boolean>} [opts.onClearCache] throw the offline copy away
 * @param {() => string|null} [opts.version] the build the server reports
 * @param {() => string|null} [opts.username] whose account this is
 * @param {(password:string) => Promise<object>} [opts.onDeleteAccount] close it
 */
export function mountPersonal({
  onClose, home, onSetHome, homeShown, onShowHome, clock, onClock, sources, onClearCache, version,
  username, onDeleteAccount,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('personal-overlay');
  const homeName = $('settings-home-name');
  const homeSet = $('settings-home-set');
  const homeBox = $('settings-home-shown');
  const clockSel = $('settings-clock');
  const clockNote = $('settings-clock-note');
  const versionEl = $('settings-version');

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
    // Hidden rather than shown empty or as "unknown": the whole value of this
    // line is that it can be trusted, and a placeholder where a build number
    // belongs is the kind of thing someone reads out as if it meant something.
    const build = version?.();
    versionEl.hidden = !build;
    if (build) versionEl.textContent = `Server ${build}`;
    // Folded away again on every opening. A password field left standing from
    // the last visit is one Return key from doing the thing it asks about.
    closeDelete();
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

  // Sources needs the whole dialog, so this one gets out of the way rather than
  // stacking a second overlay on top of itself — the same hand-off the home
  // picker above does, and the same one the hub used to do to reach it.
  for (const btn of overlay.querySelectorAll('[data-personal="sources"]')) {
    btn.addEventListener('click', () => {
      close();
      sources?.open();
    });
  }

  // Throw away everything cached and come back fresh. Nothing to confirm:
  // everything it drops is derived, so the cost is one slower load.
  const clearCacheBtn = $('settings-clear-cache');
  const cacheNote = $('settings-cache-note');
  clearCacheBtn?.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    cacheNote.textContent = 'Clearing…';
    const ok = await onClearCache?.();
    cacheNote.textContent = ok ? 'Cleared — reloading…' : 'Partly cleared — reloading…';
    // A plain reload: the caches are gone, so there is nothing left to bypass,
    // and the page has to come back to pick up whatever it was holding stale.
    setTimeout(() => location.reload(), 400);
  });

  // --- Closing the account ----------------------------------------------------
  //
  // Two steps, and the second one is the password rather than a second press.
  // The two-press arming the Sources list uses is right for taking one source
  // off a map you still have; it is not enough for the map itself. A 90-day
  // session cookie is what would otherwise stand as consent here, and a cookie
  // is a fact about a browser, not about who is sitting at it.
  const deleteOpen = $('account-delete-open');
  const deleteForm = $('account-delete-form');
  const deleteWarning = $('account-delete-warning');
  const deletePassword = $('account-delete-password');
  const deleteError = $('account-delete-error');
  const deleteCancel = $('account-delete-cancel');
  const deleteConfirm = $('account-delete-confirm');
  let deleting = false;

  function closeDelete() {
    deleteForm.hidden = true;
    deleteOpen.hidden = false;
    deletePassword.value = '';
    deleteError.hidden = true;
  }

  deleteOpen?.addEventListener('click', () => {
    const who = username?.();
    // Named, because the account you are about to delete is not always the one
    // you think you are signed in as — this is a map several people share a
    // browser for.
    deleteWarning.textContent = who
      ? `Everything in ${who} goes: every cell on the map, every saved route, `
        + 'your preferences, and any Home Assistant or Strava connection. '
        + 'This cannot be undone.'
      : 'Every cell on the map, every saved route, your preferences, and any '
        + 'Home Assistant or Strava connection. This cannot be undone.';
    deleteOpen.hidden = true;
    deleteForm.hidden = false;
    setTimeout(() => deletePassword.focus(), 60);
  });

  deleteCancel?.addEventListener('click', closeDelete);

  deleteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (deleting) return;
    const pw = deletePassword.value;
    if (!pw) {
      deleteError.textContent = 'Enter your password.';
      deleteError.hidden = false;
      return;
    }
    deleting = true;
    deleteConfirm.disabled = true;
    deleteCancel.disabled = true;
    deleteError.hidden = true;
    try {
      await onDeleteAccount?.(pw);
      // Nothing to put back: the caller has taken the page to the signed-out
      // state, and this dialog is closed behind it.
      closeDelete();
      close();
    } catch (err) {
      deleteError.textContent = err?.message || 'Could not delete the account.';
      deleteError.hidden = false;
      deletePassword.value = '';
      deletePassword.focus();
    } finally {
      deleting = false;
      deleteConfirm.disabled = false;
      deleteCancel.disabled = false;
    }
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

  // No `summary()` any more. The hub's row used to carry "Home is Zurich" as
  // its subtitle, which was true when the row was called Personal and is
  // misleading now that it is called Settings and holds four other things —
  // a subtitle should say what is behind the door, not report one item of it.
  return { open, close };
}
