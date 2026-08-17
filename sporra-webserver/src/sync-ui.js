// The Sync pane of Settings: the three things that keep the map current on
// their own, each a heading that opens downwards into its own form.
//
// ## What it stopped being
//
// It was "Import & sync", a door off the menu, and its first row was a file
// picker. That pairing was argued for on the grounds that from the outside they
// answer one question — *how does my history get in?* — and whether you pick a
// file or the server fetches it on a timer is an implementation detail. It is
// not a detail from where you are standing: a file you have is something you
// *do*, once, and then go and look at the result of; Home Assistant, Strava and
// a phone are things you set up once and then only ever come back to in order to
// ask whether they are still working.
//
// So the importer became a tab (src/import.js) and this became the tab next to
// it. And then the three rows in it stopped being doors.
//
// ## Why they fold rather than open
//
// Each was a modal of its own, reached by a row with a chevron on it. Three
// dialogs, three Back buttons, and a hub in front of them whose entire content
// was a list of their names — which is the same shape the whole of Settings has
// just stopped being, one floor further down. A row that only says *the thing
// you want is elsewhere* is a row you press to find out you have to press again.
//
// Folding costs nothing that arrangement was buying. The heading keeps its
// status line, so the pane closed is exactly the overview the hub was; opening
// one puts the form under the words that named it, with the other two still
// visible above and below; and there is no Back, because you never left.
//
// **One at a time.** Not to save room — a pane scrolls — but because these are
// three answers to one question, and two forms open at once turns a comparison
// into a search. It is also what makes the pane's shape predictable: exactly one
// thing is ever expanded, and it is the one you pressed.
//
// ## It still owns nothing
//
// The forms belong to src/home-assistant-ui.js, src/strava-ui.js and
// src/device-ui.js, which kept every element id through the move; what each of
// them lost is a dialog, not a control. Each gets `draw()` when its fold opens
// and `reset()` when it closes — the second one matters, because two of these
// hold a password field and a Disconnect button that has been armed once.

/**
 * @param {object} opts
 * @param {{draw:Function, reset?:Function}} opts.homeAssistant
 * @param {{draw:Function, reset?:Function}} opts.strava
 * @param {{draw:Function, reset?:Function}} opts.device
 * @param {() => void} [opts.onDraw] re-read all three, because "is it still
 *   working" is the question this tab exists to answer
 */
export function mountSync({ homeAssistant, strava, device, onDraw }) {
  const $ = (id) => document.getElementById(id);
  const pane = $('pane-sync');
  const haNote = $('sync-ha-note');
  const stravaNote = $('sync-strava-note');
  const deviceNote = $('sync-device-note');

  // Komoot isn't a fold here: it imports once from a pasted link rather than
  // staying connected, so it sits inside the importer, one step into
  // Settings → Import.
  //
  // Your phone leads, in the markup and here. It is the one most people have,
  // the only one that needs nothing typed into it — it is set up on the phone —
  // and therefore the only one whose fold is purely an answer rather than a
  // form. The two that ask you for a token come after it, hardest last.
  const forms = { device, ha: homeAssistant, strava };

  /** Which fold is open, or null. */
  let open = null;

  const foldEl = (key) => $(`fold-${key}`);
  const bodyEl = (key) => $(`fold-${key}-body`);
  const headEl = (key) => pane?.querySelector(`[data-fold="${key}"]`);

  /**
   * Open one fold and shut the rest.
   *
   * `null` shuts all three. Awaitable, because opening one loads what is behind
   * it and the one caller that needs to say something afterwards — Strava,
   * coming back from its round trip — has to land its message *after* that
   * answer rather than under it.
   */
  async function expand(key) {
    const want = key && forms[key] ? key : null;
    if (want === open) return;
    const leaving = open;
    open = want;
    for (const k of Object.keys(forms)) {
      const on = k === want;
      foldEl(k)?.classList.toggle('on', on);
      headEl(k)?.setAttribute('aria-expanded', on ? 'true' : 'false');
      const body = bodyEl(k);
      if (body) body.hidden = !on;
    }
    // Told after the class has moved, so a form that redraws itself measures the
    // box it is actually in.
    if (leaving) forms[leaving]?.reset?.();
    if (want) {
      // Scrolled to, rather than trusted to be in view: opening the third fold
      // on a short window puts its form entirely below the fold it grew out of.
      headEl(want)?.scrollIntoView({ block: 'nearest' });
      await forms[want]?.draw?.();
    }
  }

  for (const btn of pane?.querySelectorAll('[data-fold]') ?? []) {
    // A second press on the open one shuts it. The heading is the control both
    // ways, which is the whole reason it is a heading and not a door.
    btn.addEventListener('click', () => expand(btn.dataset.fold === open ? null : btn.dataset.fold));
  }

  return {
    /**
     * Ask all three again.
     *
     * The lines are already right — each form pushes its own up here whenever it
     * learns something, so they are filled in before this tab has ever been
     * looked at. But the three things they describe run on the *server*, on
     * timers, while nobody is watching: a poll that started failing an hour ago
     * is exactly what somebody opening this tab is here to find, and a line last
     * written when the page loaded would not say so.
     */
    draw() {
      onDraw?.();
    },
    /**
     * Everything folds away on the way out of the tab.
     *
     * Two of these hold a password field, and one holds a Disconnect that has
     * been armed by a first press. Leaving a tab and coming back is one press,
     * unlike the dialogs this replaced, which were closed and reopened around
     * their own state.
     */
    leave() {
      expand(null);
    },
    /** Open one from outside — Strava's OAuth round trip lands here. */
    expand,
    // Each heading doubles as its own status line, so you can see what is
    // running without opening any of them.
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
