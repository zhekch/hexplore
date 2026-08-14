// The Sync pane of Settings: the three things that keep the map current on
// their own.
//
// ## What it stopped being
//
// It was "Import & sync", a door off the menu, and its first row was a file
// picker. That pairing was argued for on the grounds that from the outside they
// answer one question — *how does my history get in?* — and whether you pick a
// file or the server fetches it on a timer is an implementation detail. It is
// not a detail from where you are standing, which is the part that reading got
// wrong: a file you have is something you *do*, once, and then go and look at
// the result of; Home Assistant, Strava and a phone are things you set up once
// and then only ever come back to in order to ask whether they are still
// working.
//
// So the importer became a tab (src/import.js) and this became the tab next to
// it — near enough that the two halves of one question are one press apart, and
// separate because the errands are wanted at different times.
//
// ## It owns nothing
//
// Three rows, three status lines, and each row hands off to a dialog of its own.
// Those stayed dialogs rather than becoming panes because each is a *form* — an
// address and a long-lived token, an OAuth round trip, a phone's status — and
// they are opened to be filled in and left, which is the one shape a tab is
// worse at than a modal. Settings gets out of the way for them and they come
// back here, the same hand-off Komoot does from Import.
//
// The status lines are the reason this is worth a tab at all: whether anything
// is still arriving is readable without opening any of them.

/**
 * @param {object} opts
 * @param {{open:Function}} opts.homeAssistant the Home Assistant dialog
 * @param {{open:Function}} opts.strava        the Strava dialog
 * @param {{open:Function}} opts.device        the phones-reporting-in dialog
 * @param {() => void} [opts.onLeave] shut Settings, so the dialog a row opens is
 *   not stacked on top of it
 * @param {() => void} [opts.onDraw] re-read all three, because "is it still
 *   working" is the question this tab exists to answer
 */
export function mountSync({ homeAssistant, strava, device, onLeave, onDraw }) {
  const $ = (id) => document.getElementById(id);
  const pane = $('pane-sync');
  const haNote = $('sync-ha-note');
  const stravaNote = $('sync-strava-note');
  const deviceNote = $('sync-device-note');

  // Komoot isn't a row here: it imports once from a pasted link rather than
  // staying connected, so it sits inside the importer, one step into
  // Settings → Import.
  const targets = { ha: homeAssistant, strava, device };

  for (const btn of pane?.querySelectorAll('[data-sync]') ?? []) {
    btn.addEventListener('click', () => {
      const target = targets[btn.dataset.sync];
      if (!target) return;
      onLeave?.();
      target.open();
    });
  }

  return {
    /**
     * Ask all three again.
     *
     * The lines are already right — each dialog pushes its own up here whenever
     * it learns something, so they are filled in before this tab has ever been
     * looked at. But the three things they describe run on the *server*, on
     * timers, while nobody is watching: a poll that started failing an hour ago
     * is exactly what somebody opening this tab is here to find, and a line last
     * written when the page loaded would not say so.
     *
     * Deliberately no `leave()`: there is nothing here to fold away.
     */
    draw() {
      onDraw?.();
    },
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
