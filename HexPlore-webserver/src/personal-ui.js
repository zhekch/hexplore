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

import { clockSource, localIs24Hour } from './clock.js';
import { onBackdropClick } from './dismiss.js';
import { t } from './i18n.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]   called when the dialog is dismissed with Back
 * @param {() => ({name?:string}|null)} opts.home where the map is measured from
 * @param {() => void} opts.onSetHome   hand the map over to the home picker
 * @param {() => boolean} opts.homeShown whether the marker is drawn
 * @param {(on:boolean) => void} opts.onShowHome
 * @param {() => string} opts.clock      the account's clock preference
 * @param {(mode:string) => void} opts.onClock
 * @param {() => string} [opts.snow]     never / in winter / always
 * @param {(mode:string) => void} [opts.onSnow]
 * @param {() => boolean} [opts.snowPossible] whether the basemap on screen can
 *   show it at all — Mapbox can, the other four cannot
 * @param {() => string} [opts.whatsNew] how often to say what has changed
 * @param {(mode:string) => void} [opts.onWhatsNew]
 * @param {() => Array<{key:string,label:string}>} [opts.locales] the languages that exist
 * @param {() => string} [opts.locale] the one in force
 * @param {(key:string) => void} [opts.onLocale] picking one reloads the page
 * @param {{open:Function}} [opts.sources] the Sources dialog, opened from here
 * @param {{open:Function}} [opts.rail] the Train tracks dialog, likewise
 * @param {{open:Function}} [opts.airports] the Airports dialog, likewise
 * @param {{open:Function}} [opts.mapbox] the 3D basemap's token dialog, likewise
 * @param {() => void} [opts.onReplayIntro] show the introduction again
 * @param {() => Promise<boolean>} [opts.onClearCache] throw the offline copy away
 * @param {() => string|null} [opts.version] the build the server reports
 * @param {() => Promise<string|null>} [opts.currentVersion] the build it is
 *   running *now*, asked fresh — see the note on `drawVersion`
 * @param {() => void} [opts.onReload] fetch the app again from the server
 * @param {() => string|null} [opts.username] whose account this is
 * @param {(password:string) => Promise<object>} [opts.onDeleteAccount] close it
 */
export function mountPersonal({
  onClose, home, onSetHome, homeShown, onShowHome, clock, onClock, snow, onSnow, snowPossible,
  whatsNew, onWhatsNew, locales, locale, onLocale,
  sources, rail, airports, mapbox, onReplayIntro, onClearCache, version, currentVersion, onReload,
  username, onDeleteAccount,
}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('personal-overlay');
  const homeName = $('settings-home-name');
  const homeSet = $('settings-home-set');
  const homeBox = $('settings-home-shown');
  const clockSel = $('settings-clock');
  const clockNote = $('settings-clock-note');
  const snowSel = $('settings-snow');
  const snowNote = $('settings-snow-note');
  const whatsNewSel = $('settings-whats-new');
  const whatsNewNote = $('settings-whats-new-note');
  const localeSel = $('settings-locale');

  // Filled once from the registry — the list of languages cannot change while
  // the dialog is open, and rebuilding it on every `draw()` would throw away the
  // selection mid-change.
  for (const l of locales?.() ?? []) {
    const opt = document.createElement('option');
    opt.value = l.key;
    opt.textContent = l.label; // in its own language, never translated
    localeSel.append(opt);
  }
  // One language is not a choice. The row is hidden rather than shown as a
  // select with a single entry, which reads as a control that is broken.
  localeSel.closest('.import-row').hidden = (locales?.() ?? []).length < 2;
  const versionEl = $('settings-version');
  const versionText = $('settings-version-text');
  const reloadBtn = $('settings-version-reload');

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
    //
    // And *where it read that*, which is the other half of the same question. A
    // browser cannot see the 24-hour switch on the phone it runs on — only the
    // app can, and it says so (see src/clock.js). Where nothing said, this is
    // the browser's language talking, and a row admitting that is a row someone
    // can act on rather than argue with.
    clockNote.textContent = clockSel.value === 'auto'
      ? `${localIs24Hour() ? '24-hour' : '12-hour'}${clockSource() === 'device' ? '' : ", from your browser's language"}`
      : '';
    // Snow is Mapbox's own renderer pass and the other four basemaps have no
    // equivalent (see src/snow.js). The row is left working rather than disabled
    // — the setting is real and it will apply the moment you switch basemap —
    // but it says which of the two situations you are in, because a switch that
    // demonstrably does nothing is indistinguishable from a broken one.
    snowSel.value = snow?.() ?? 'off';
    snowNote.textContent = t(snowPossible?.() ? 'personal.snow.on' : 'personal.snow.off');
    // The note says what each answer actually means, because the words in the
    // list do not: "substantial" is a threshold somebody chose, and a person
    // deciding between three options deserves to know roughly where it sits.
    // The workouts sentence is on every one of them — including Never — because
    // that exception is exactly the thing somebody choosing Never would
    // otherwise be surprised by later.
    localeSel.value = locale?.() ?? 'en';
    whatsNewSel.value = whatsNew?.() ?? 'substantial';
    whatsNewNote.textContent = {
      never: t('personal.whatsNew.never'),
      substantial: t('personal.whatsNew.substantial'),
      always: t('personal.whatsNew.always'),
    }[whatsNewSel.value] ?? '';
    drawVersion();
    // Folded away again on every opening. A password field left standing from
    // the last visit is one Return key from doing the thing it asks about.
    closeDelete();
  }

  /**
   * Which build this is, and whether it is still the one the server has.
   *
   * The number itself is what the page was handed when it signed in, and a page
   * keeps that for as long as it is open — so a server updated underneath a tab
   * left on the map goes on reporting the build that tab started with. That is
   * the honest answer to "which build am I looking at" and a misleading answer
   * to "is this current", which are the same question ten seconds apart.
   *
   * So the second one is asked, once per opening, and only the *disagreement*
   * is shown. A check that cannot get through says nothing rather than claiming
   * the app is up to date: `currentVersion` answers null for that, and null is
   * not a version to compare against.
   *
   * Hidden rather than shown empty or as "unknown": the whole value of this line
   * is that it can be trusted, and a placeholder where a build number belongs is
   * the kind of thing someone reads out as if it meant something.
   */
  function drawVersion() {
    const build = version?.();
    if (!versionEl || !versionText) return;
    versionEl.hidden = !build;
    if (reloadBtn) reloadBtn.hidden = true;
    if (!build) return;
    versionText.textContent = `Server ${build}`;
    currentVersion?.().then((now) => {
      // Guarded on the build still being the one this ran for: the dialog can be
      // closed and reopened inside one slow request, and an answer about the
      // previous opening must not land on this one.
      if (!now || now === build || version?.() !== build) return;
      versionText.textContent = `Server ${build} · ${t('personal.update-available')}: ${now}`;
      if (reloadBtn) reloadBtn.hidden = false;
    }).catch(() => {
      /* no answer is not an answer of "up to date" */
    });
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
  snowSel.addEventListener('change', () => {
    onSnow?.(snowSel.value);
    draw();
  });
  whatsNewSel.addEventListener('change', () => {
    onWhatsNew?.(whatsNewSel.value);
    draw();
  });
  // No `draw()` after it: choosing a language reloads the page (see
  // src/i18n.js), so there is nothing left to redraw and the dialog is about to
  // be rebuilt from scratch in the language just chosen.
  localeSel.addEventListener('change', () => onLocale?.(localeSel.value));

  // Each of these needs the whole dialog, so this one gets out of the way rather
  // than stacking a second overlay on top of itself — the same hand-off the home
  // picker above does, and the same one the hub used to do to reach Sources.
  const doors = { sources, rail, airports, mapbox };
  for (const btn of overlay.querySelectorAll('[data-personal]')) {
    const door = doors[btn.dataset.personal];
    if (!door) continue;
    btn.addEventListener('click', () => {
      close();
      door.open();
    });
  }

  // Throw away everything cached and come back fresh. Nothing to confirm:
  // everything it drops is derived, so the cost is one slower load.
  // The introduction, on request. This dialog gets out of the way completely
  // rather than leaving itself open behind a full-screen takeover — the same
  // hand-off the home picker above does, and for a stronger version of the same
  // reason: the deck's home step needs the map, and the map is behind this.
  $('settings-intro')?.addEventListener('click', () => {
    close();
    onReplayIntro?.();
  });

  const clearCacheBtn = $('settings-clear-cache');
  const cacheNote = $('settings-cache-note');
  // The note is optional and the clearing is not. It used to be written to
  // without the `?`, and the line above the clearing at that: the markup had no
  // such element, so every press threw on the first statement and the button —
  // whose whole job is to get you out of a stale copy of the map — silently did
  // nothing, in the one place where nothing looks exactly like something.
  const say = (text) => { if (cacheNote) cacheNote.textContent = text; };
  clearCacheBtn?.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    say('Clearing…');
    const ok = await onClearCache?.();
    say(ok ? 'Cleared — reloading…' : 'Partly cleared — reloading…');
    // A plain reload: the caches are gone, so there is nothing left to bypass,
    // and the page has to come back to pick up whatever it was holding stale.
    setTimeout(() => location.reload(), 400);
  });

  // Getting the build the server actually has. A plain reload is enough and the
  // cache clearing above is not wanted: navigations are fetched network-first
  // (see public/sw.js) and everything else is under a hashed URL, so a new build
  // is a new set of URLs and the old ones are simply no longer asked for.
  // Throwing the offline copy away as well would cost a 3 MB gazetteer to solve
  // a problem this does not have.
  reloadBtn?.addEventListener('click', () => onReload?.());

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
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  // No `summary()` any more. The hub's row used to carry "Home is Zurich" as
  // its subtitle, which was true when the row was called Personal and is
  // misleading now that it is called Settings and holds four other things —
  // a subtitle should say what is behind the door, not report one item of it.
  return { open, close };
}
