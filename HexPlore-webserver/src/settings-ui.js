// The Settings dialog: a rail of sections down the left, the one you picked
// filling everything to the right of it.
//
// ## What this replaces
//
// Six dialogs, four taps deep. "Export & settings" was a hub of three rows, one
// of which opened "Settings", which was a column of rows two of which opened
// "Map layers" and "Sources", and Map layers had itself only just stopped being
// a signpost. Every one of those pages was a phone-shaped column of full-width
// rows — which is the right shape for a phone and is a 400px ribbon down the
// middle of a desktop screen, with a scrollbar in it.
//
// Both problems have the same cause: a hub is a page whose entire content is a
// list of places the content is not. Take the hubs away and what is left is six
// sections, none of them big, none of them related to the next — which is a
// tabbed dialog. So: one door off the menu, one dialog, and nothing in it is
// more than one press from anything else in it.
//
// ## What this module owns, and what it does not
//
// The rail, the panes, and which one is showing. Nothing else. Every control in
// every pane still belongs to the module that always owned it — src/personal-ui,
// src/map-layers-ui, src/sources-ui, src/import, src/backup-ui, src/admin-ui —
// and every one of those kept its element ids through the move. What each of
// them lost is a dialog of its own, not a control.
//
// The contract between them is two optional methods per section:
//
//   - **`draw()`** — called when the section becomes visible, including the
//     first time. Sections that read the server (Sources, Backups, Admin) fetch
//     here; sections that read local state (Personal, Map layers) redraw here.
//     It is called on every visit, not once: the state behind these panes is
//     changed from other places, and a pane showing what was true when the
//     dialog opened is a pane that lies.
//   - **`leave()`** — called when the section stops being visible, whether that
//     is another tab, Done, Escape or the backdrop. Map layers commits the
//     Mapbox token here, which is the reason the hook exists: it is the one
//     control in the dialog that cannot apply itself as it is touched.
//
// A `leave()` that returns `false` **holds the tab**, and only then. It is for
// the one case where leaving would silently discard something — a token the
// server refused — and the pane has written the reason under the field. It is
// deliberately not a general "are you sure": Done must be able to close.
//
// ## Which tabs exist
//
// Backups and Admin are hidden until the server says this account administers
// it. Hidden rather than disabled: a greyed-out Admin tab on a map shared with a
// housemate is an invitation to ask about it, and there is nothing to say. The
// answer arrives with the session (see `/api/me`), so it is known before the
// dialog is ever opened — and it is only about what is *drawn*. Every route
// behind those two panes checks for itself.

import { onBackdropClick } from './dismiss.js';

/** The rail's order, top to bottom, and which ones are only for an admin. */
const TABS = [
  { key: 'personal' },
  { key: 'maplayers' },
  { key: 'sources' },
  // Import and Sync are adjacent because they are the two halves of one
  // question — how does where I have been get in — asked of a file you have and
  // of something that will keep answering on its own.
  { key: 'import' },
  { key: 'sync' },
  { key: 'backups', admin: true },
  { key: 'admin', admin: true },
  { key: 'other' },
];

/**
 * @param {object} opts
 * @param {Record<string, {draw?:Function, leave?:Function}>} opts.sections
 *   one entry per key in TABS; a missing one leaves the pane inert markup
 * @param {() => boolean} [opts.isAdmin] whether to draw the last two tabs
 * @param {() => string|null} [opts.username] whose account this is, for the head
 * @param {() => string|null} [opts.asAdmin] the admin wearing it, if any
 */
export function mountSettings({ sections = {}, isAdmin, username, asAdmin } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const railEl = $('settings-tabs');
  const whoEl = $('settings-who');
  const actionsSlot = $('settings-actions');
  const tabEl = (key) => $(`settings-tab-${key}`);
  const paneEl = (key) => $(`pane-${key}`);

  // Which section is showing. Kept across openings on purpose: somebody who
  // closed the dialog on Map layers and opens it again almost always means to
  // carry on there, and the alternative — always landing on Personal — makes
  // "change one thing, look at the map, change the next" three presses instead
  // of one.
  let current = TABS[0].key;

  const visible = (tab) => !tab.admin || !!isAdmin?.();

  /** Who this is, said once at the top rather than in each pane. */
  function drawWho() {
    if (!whoEl) return;
    const me = username?.();
    const wearing = asAdmin?.();
    whoEl.textContent = !me
      ? ''
      : wearing
        ? `${me} — opened by ${wearing}`
        : `Signed in as ${me}`;
    whoEl.classList.toggle('settings-who-as', !!wearing);
  }

  // Whose buttons are currently sitting in the footer, so they can be put back
  // in the pane they belong to before the next pane's are taken.
  let lent = null;

  // One tab change at a time. `leave()` can be a round trip — Map layers asks
  // Mapbox about the token before it will let go — and a second press landing
  // inside that would move the rail while the first was still deciding whether
  // it may.
  let switching = false;

  /**
   * Show one section.
   *
   * The outgoing pane is told first and may refuse — see `leave()` above. It is
   * refused *before* anything moves, so a held tab looks like nothing happened
   * rather than like a flicker.
   */
  async function show(key, { force = false } = {}) {
    if (switching) return false;
    if (key === current && !force) return true;
    const tab = TABS.find((t) => t.key === key);
    if (!tab || !visible(tab)) return false;
    if (key !== current) {
      switching = true;
      try {
        if (await sections[current]?.leave?.() === false) return false;
      } finally {
        switching = false;
      }
    }

    current = key;
    for (const t of TABS) {
      const on = t.key === key;
      const shown = visible(t);
      const b = tabEl(t.key);
      const p = paneEl(t.key);
      if (b) {
        b.hidden = !shown;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (p) p.hidden = !on;
    }
    // The showing pane's own buttons, moved into the card's one footer.
    //
    // Moved rather than copied or shown/hidden in place: it is the same element
    // the pane's module wired at mount, so every listener on it comes along and
    // no module has to know its buttons are not where it left them.
    //
    // **And handed back before the next one is taken**, which is the whole
    // reason `lent` exists. Emptying the slot instead would detach the outgoing
    // pane's row with nothing left holding it — so that pane would come back
    // with no buttons at all, and only on the *second* visit to it, which is
    // exactly the kind of bug a first look does not find.
    if (lent) {
      paneEl(lent.key)?.append(lent.el);
      lent = null;
    }
    const acts = paneEl(key)?.querySelector('.pane-actions');
    if (acts && actionsSlot) {
      actionsSlot.append(acts);
      lent = { key, el: acts };
    }
    // Scrolled back to the top, because the pane is reused rather than rebuilt:
    // leaving Backups half way down its file list and coming back to Personal
    // would otherwise open Personal in the middle.
    paneEl(key)?.querySelector('.pane-body')?.scrollTo({ top: 0 });
    tabEl(key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    sections[key]?.draw?.();
    return true;
  }

  /**
   * @param {string} [tab] which section to land on; the last one otherwise
   */
  function open(tab) {
    drawWho();
    // Re-resolved on every opening: an admin tab that appeared or disappeared
    // since last time must not leave the rail showing a pane nobody can reach.
    const want = TABS.find((t) => t.key === tab && visible(t))
      ?? TABS.find((t) => t.key === current && visible(t))
      ?? TABS[0];
    overlay.hidden = false;
    show(want.key, { force: true });
  }

  /**
   * Shut it, telling the section that is showing.
   *
   * `leave()` is called and its answer ignored, unlike a tab change: a pane
   * holding the *dialog* open is a pane you cannot get out of, and the one thing
   * `leave` guards — an unsaved Mapbox token — is recoverable by pasting it
   * again. It still runs, so a token that is good is still committed on the way
   * out.
   */
  function close() {
    // Not awaited, and the answer is not read. The token check behind it is a
    // round trip, and holding a dialog shut-in until Mapbox answers is a worse
    // failure than the one it would prevent.
    Promise.resolve(sections[current]?.leave?.()).catch(() => {});
    overlay.hidden = true;
  }

  for (const b of railEl?.querySelectorAll('[data-tab]') ?? []) {
    b.addEventListener('click', () => show(b.dataset.tab));
  }

  $('settings-close')?.addEventListener('click', close);
  $('settings-done')?.addEventListener('click', close);
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    /** Which section is showing — for the pane that wants to know if it is. */
    tab: () => current,
    /** Whether the dialog is up at all. */
    isOpen: () => !overlay.hidden,
    /** Redraw the head and the rail after the account, or its rights, changed. */
    refresh() {
      drawWho();
      if (!overlay.hidden) show(current, { force: true });
    },
  };
}
