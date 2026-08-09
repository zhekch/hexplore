// The introduction, as a deck of cards you throw over your shoulder.
//
// Everything that is a *decision* — whether this runs at all, which permissions
// this host can offer, which of them are already answered, what the closing
// numbers say — is in `src/intro.js`, where it is tested. This is the part that
// has to know about elements, gestures and a canvas full of confetti.
//
// ## Why a deck rather than a carousel
//
// A carousel is a filmstrip: the cards are all still there, off to one side,
// and the gesture is *scrolling*. A deck is a pile you are working through, and
// the gesture is *finishing with something*. The second one is the truer
// description of an introduction — five of these cards you read once and never
// again — and it is also the one that makes the progress dots honest, because
// there genuinely is a bottom of the pile to reach.
//
// The cards are all in the markup from the start and none of them is ever
// destroyed. Swiping back has to bring the *same* card home, with whatever was
// on it: the permissions card in particular has three rows of state that took a
// system prompt each to arrive at, and rebuilding it would silently ask for
// them all again.
//
// ## The one card that leaves the screen
//
// Choosing home needs the map, and the map is behind all this. So the curtain
// lifts — the whole introduction scales up and out, which reads as the map
// arriving rather than the cards leaving — `src/main.js` runs the pick with the
// map's own chrome hidden, and the curtain comes back down on the answer. See
// `beginIntroHomePick` there.

import { t } from './i18n.js';
import { formatKm2 } from './stats.js';
import {
  COUNT_MS, HINT_MS, INTRO_PAGES, INTRO_PERMS_KEY,
  alreadyGranted, introNumbers, permissionsFor,
} from './intro.js';

// How far a card has to be dragged before letting go finishes it, as a fraction
// of the deck's width. A quarter is short enough that a flick works and long
// enough that a scroll which drifted sideways does not throw the card away.
const COMMIT_FRACTION = 0.25;
// …or how fast. A short, quick flick is a complete gesture and it never travels
// a quarter of anything; without this the deck felt like it needed a shove.
// Pixels per millisecond.
const COMMIT_VELOCITY = 0.55;
// How far even a fast one has to get. Velocity alone will throw a card on a
// twitch — thirty pixels in forty milliseconds is a hand adjusting its grip,
// not an instruction — and the whole point of the flick rule is to catch a
// *short* gesture, not a non-existent one.
const COMMIT_FLICK_PX = 40;
// How much horizontal movement it takes to decide a drag is a drag rather than
// a scroll. Below this the axis is still undecided and neither happens.
const AXIS_LOCK_PX = 8;
// One notch of a trackpad's horizontal scroll, accumulated. Trackpads report a
// continuous stream of small deltas, so this is a distance rather than an
// event count — and it is reset the moment the stream pauses.
const WHEEL_COMMIT = 110;
const WHEEL_IDLE_MS = 220;
// How long a card takes to fly, in step with the transition in style.css. Used
// to know when a card dragged back and let go has finished going home.
const CARD_MS = 520;
// How long after a turn the deck refuses another one. Shorter than the flight,
// so a deliberate second swipe still lands while a stream of momentum does not.
const TURN_LOCK_MS = 300;
// Where a discarded card is parked, as a fraction of the deck's width, and how
// far it is turned. Both have to agree with `[data-state='done']` in style.css:
// this is the point a card being dragged back is being dragged back *from*.
const RETURN_X = 1.35;
const RETURN_DEG = -9;

const reducedMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

// Which of the two scenes the curtain is painted in. Not `data-theme`, which
// describes the *basemap* and is hidden behind the curtain anyway — see the
// note at the top of the introduction's section in style.css.
const lightScene = () =>
  globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches ?? false;

/** What each tile on the last card is called. Spelled out, so the lint sees them. */
const TILE_LABEL = {
  cells: () => t('intro.tile.cells'),
  km2: () => t('intro.tile.km2'),
  countries: () => t('intro.tile.countries'),
  workouts: () => t('intro.tile.workouts'),
  trips: () => t('intro.tile.trips'),
};

/**
 * Everything a permission row can say, per permission.
 *
 * Three of the four are per-key rather than shared, and that is the point. One
 * "Already done" against all three rows is the sentence a form writes; this
 * screen is trying to sound like something that was paying attention while you
 * used it, and the honest version of that is different for a library it has
 * already read, a map that already knows where you are, and a ride that turned
 * up on its own.
 *
 * `why` is the row's own resting sentence, restated rather than remembered:
 * `drawPerms` overwrites the note when a row settles, and a replay has to be
 * able to put it back.
 */
const PERM_COPY = {
  photos: {
    why: () => t('intro.perm.photos.body'),
    already: () => t('intro.perm.already-photos'),
    kept: () => t('intro.perm.kept-photos'),
    blocked: () => t('intro.perm.blocked-photos'),
  },
  location: {
    why: () => t('intro.perm.location.body'),
    already: () => t('intro.perm.already-location'),
    kept: () => t('intro.perm.kept-location'),
    blocked: () => t('intro.perm.blocked-location'),
  },
  health: {
    why: () => t('intro.perm.health.body'),
    already: () => t('intro.perm.already-health'),
    kept: () => t('intro.perm.kept-health'),
    blocked: () => t('intro.perm.blocked-health'),
  },
};

/**
 * @param {object} opts
 * @param {() => string} opts.host  ios | mac | web, from src/intro.js
 * @param {(reason: 'done'|'skipped') => void} opts.onFinish  the deck is closing;
 *   the caller records that it has been seen and puts the map back
 * @param {(done: (home: object|null) => void) => void} opts.onPickHome  hand the
 *   map the question, with the curtain already up
 * @param {() => object|null} opts.home  where the map is measured from now
 * @param {() => string[]} opts.sources  which sources have put something on the map
 * @param {() => Promise<{ok: boolean, count?: number, error?: string}>} opts.askPhotos
 * @param {() => Promise<{ok: boolean, error?: string}>} opts.askLocation
 * @param {() => Promise<{ok: boolean, error?: string}>} opts.askHealth
 * @param {() => Promise<string|null>} opts.geolocationState  the Permissions API's
 *   answer for geolocation, or null where there is no such API
 * @param {() => Promise<boolean|null>} [opts.healthState] whether the iPhone app's
 *   workout sync is already on, or null anywhere that cannot say
 * @param {() => Promise<object|null>} opts.loadStats  the coverage reading
 * @param {() => Promise<Array|null>} opts.loadTrips
 * @param {() => Array} opts.routes
 */
export function mountIntro({
  host, onFinish, onPickHome, home, sources,
  askPhotos, askLocation, askHealth, geolocationState, healthState,
  loadStats, loadTrips, routes,
}) {
  const $ = (id) => document.getElementById(id);
  const root = $('intro');
  if (!root) return { open: () => {}, close: () => {}, isOpen: () => false };

  const deck = $('intro-deck');
  const dotsEl = $('intro-dots');
  const nextBtn = $('intro-next');
  const skipBtn = $('intro-skip');
  const hintEl = $('intro-hint');
  const canvas = $('intro-confetti');
  const cards = [...deck.querySelectorAll('.intro-card')];

  // The markup is the deck and `INTRO_PAGES` is what the test pins, so the two
  // can drift — a card reordered in index.html and not here, or the other way
  // about. Nothing breaks visibly when they do: the deck still runs, and the
  // per-card hooks below simply stop firing on the cards they were written for,
  // which shows up as a permissions screen that never reads its own state.
  const order = cards.map((c) => c.dataset.page).join();
  if (order !== INTRO_PAGES.join()) {
    console.warn(`The introduction's markup and INTRO_PAGES disagree: ${order}`);
  }

  // Focusable so that opening it can take the focus off whatever is behind, and
  // -1 so it is never a tab stop of its own.
  root.tabIndex = -1;

  let at = 0;
  let open = false;
  let hintTimer = null;
  // Set while a card is mid-flight or the curtain is moving. Every way of
  // advancing checks it, because two gestures landing inside one animation is
  // how a deck skips a card without anybody seeing it happen.
  let busy = false;
  let turnTimer = null;

  // --- What this device has already been asked ---------------------------------

  const readPerms = () => {
    try {
      return JSON.parse(localStorage.getItem(INTRO_PERMS_KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  let perms = readPerms();

  const rememberPerm = (key, answer) => {
    perms = { ...perms, [key]: answer };
    try {
      localStorage.setItem(INTRO_PERMS_KEY, JSON.stringify(perms));
    } catch {
      /* private mode: the row is still right for this sitting, which is enough */
    }
  };

  // --- The deck ----------------------------------------------------------------

  function render() {
    for (const [i, card] of cards.entries()) {
      const state =
        i < at ? 'done'
        : i === at ? 'live'
        : i === at + 1 ? 'next'
        : 'deep';
      card.dataset.state = state;
      card.style.transform = '';
      // Whatever a gesture was doing to this card, the deck is doing it now.
      // Taking `intro-dragging` off in the same breath as the transform is what
      // makes a card that was under a finger a moment ago *animate* into place
      // rather than jump there.
      card.classList.remove('intro-returning', 'intro-dragging');
      // Not `hidden`: these have to keep their layout so the one behind the
      // front card peeks out from under it. `inert` is what takes the buttons
      // on a card nobody can see out of the tab order — and where it is not
      // implemented the cards are still visually gone, which is the lesser
      // fault of the two.
      if (state === 'live') card.removeAttribute('inert');
      else card.setAttribute('inert', '');
    }

    dotsEl.replaceChildren();
    for (let i = 0; i < cards.length; i++) {
      const dot = document.createElement('span');
      dot.className = `intro-dot${i === at ? ' is-here' : i < at ? ' is-past' : ''}`;
      dotsEl.append(dot);
    }

    // The last card has its own button, and it is the whole point of that card.
    // A chevron beside it would be a second way to do the same thing, one of
    // which is unlabelled.
    nextBtn.hidden = at >= cards.length - 1;
    skipBtn.hidden = at >= cards.length - 1;

    enter(cards[at]?.dataset.page);
  }

  /** Called whenever a card comes to the front, including on the way back. */
  function enter(page) {
    clearTimeout(hintTimer);
    // The gesture is only ever explained on the first card, and only if
    // somebody has sat on it long enough to have finished reading.
    hintEl.hidden = true;
    if (page === 'what' && at === 0) {
      hintTimer = setTimeout(() => {
        if (open && at === 0) hintEl.hidden = false;
      }, HINT_MS);
    }
    if (page === 'permissions') drawPerms();
    if (page === 'sources') drawHome();
    if (page === 'done') finishCard();
  }

  function go(to) {
    const next = Math.max(0, Math.min(cards.length - 1, to));
    if (next === at) return;
    at = next;
    render();
    // One gesture, one card.
    //
    // A trackpad does not stop sending events when the fingers leave it: the
    // kinetic tail of a single flick is a hundred more of them, and a deck that
    // acted on each one went from the first card to the last in one shove. The
    // wheel handler has a lock of its own for that; this is the same rule for
    // every other way in, and for the flick that arrives while a card is still
    // in the air.
    busy = true;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      busy = false;
    }, TURN_LOCK_MS);
  }

  const forward = () => go(at + 1);
  const back = () => go(at - 1);

  // --- Dragging ----------------------------------------------------------------
  //
  // Pointer events rather than touch: one code path for a finger, a trackpad
  // and a mouse, and `setPointerCapture` means a drag that leaves the card
  // still ends on the card that started it.

  let drag = null;
  // The discarded card currently being pulled back by a finger, if any. See
  // `paint`: swiping right does not move the card you are looking at.
  let returning = null;

  const liveCard = () => cards[at];

  /**
   * Give up whatever `paint` was doing to the previous card.
   *
   * `animate: false` hands it straight back to the stylesheet, which is what a
   * committed swipe wants — `render` is about to give the card a new state and
   * the transition should run from wherever the finger left it. `true` is the
   * gesture being abandoned: the card slides back onto the pile, and it has to
   * keep `intro-returning` for the whole journey, because the `done` state it
   * is travelling towards is `visibility: hidden` and losing the class early
   * would make it vanish halfway.
   */
  function clearReturn({ animate }) {
    const card = returning;
    if (!card) return;
    returning = null;
    card.classList.remove('intro-dragging');
    card.style.transform = '';
    if (!animate) {
      card.classList.remove('intro-returning');
      return;
    }
    setTimeout(() => {
      // Unless a second gesture has picked the same card up again in the
      // meantime, in which case it is not this timer's card any more.
      if (returning !== card) card.classList.remove('intro-returning');
    }, CARD_MS);
  }

  /**
   * Follow the finger — with whichever card the *direction* says is moving.
   *
   * Leftwards is the live card being thrown away, and it moves. Rightwards is
   * not the live card sliding back to the right: it is the card before it
   * coming back over the top, which is what putting one down on a pile looks
   * like from above. Dragging the front card rightwards instead would be a
   * carousel — the same picture the deck was chosen over — and it also puts the
   * card you are trying to get back *further* behind the one covering it.
   */
  function paint(dx) {
    const width = deck.getBoundingClientRect().width || 1;
    const prev = cards[at - 1];
    const live = liveCard();

    if (dx > 0 && prev) {
      if (live) {
        live.classList.remove('intro-dragging');
        live.style.transform = '';
      }
      if (returning !== prev) {
        clearReturn({ animate: false });
        returning = prev;
        prev.classList.add('intro-returning', 'intro-dragging');
      }
      // It is parked off to the left and turned; the drag walks both back to
      // nothing together, so it arrives square rather than straightening at the
      // end.
      const parked = RETURN_X * width;
      const x = Math.min(0, dx - parked);
      const home = 1 - Math.min(1, -x / parked);
      prev.style.transform = `translate3d(${x}px, 0, 0) rotate(${RETURN_DEG * (1 - home)}deg)`;
      return;
    }

    clearReturn({ animate: true });
    if (!live) return;
    live.classList.add('intro-dragging');
    // Nothing that way: on the first card there is no card behind to bring
    // back, and on the last there is nothing left to throw. Rubber-banded
    // rather than refused outright — the card gives a little and comes back,
    // which says "there is nothing that way" without a message.
    const wall = dx > 0 || (dx < 0 && at === cards.length - 1);
    const d = wall ? dx * 0.28 : dx;
    live.style.transform = `translate3d(${d}px, 0, 0) rotate(${d * 0.022}deg)`;
  }

  deck.addEventListener('pointerdown', (e) => {
    if (busy || e.button != null && e.button !== 0) return;
    const card = liveCard();
    if (!card || !card.contains(e.target)) return;
    // A press on something that does something is not the start of a swipe.
    if (e.target.closest('button, a, input, select, textarea')) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, axis: null, t0: performance.now() };
  });

  deck.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;

    if (!drag.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      // Vertical wins ties, because two of these cards scroll and a scroll that
      // gets stolen by a card is much worse than a swipe that has to be
      // repeated. Once decided, the axis is not revisited for this gesture.
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'y') {
        drag = null;
        return;
      }
      // Captured on the *live* card whichever card ends up moving: this is
      // about not losing the pointer, and the live card is the one the gesture
      // started on.
      try {
        // Throws `NotFoundError` if the pointer is already gone — a finger
        // lifted between this move and the last one, which is rare and real.
        // The drag still works without capture; it just stops tracking if it
        // leaves the card, which is a far better outcome than the exception
        // taking the rest of this handler with it.
        liveCard()?.setPointerCapture?.(e.pointerId);
      } catch {
        /* no capture, and the gesture carries on */
      }
    }

    // Raw, not rubber-banded. What the finger did is what decides whether the
    // gesture counts; `paint` is where a drag against a wall gets damped, and
    // damping the number *here* would quietly move the commit threshold too.
    drag.dx = dx;
    paint(dx);
    e.preventDefault();
  });

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { dx, t0 } = drag;
    const axis = drag.axis;
    drag = null;
    const card = liveCard();
    card?.classList.remove('intro-dragging');
    if (card) card.style.transform = '';
    if (axis !== 'x') {
      clearReturn({ animate: true });
      return;
    }

    const width = deck.getBoundingClientRect().width || 1;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
    const enough =
      Math.abs(dx) > width * COMMIT_FRACTION
      || (speed > COMMIT_VELOCITY && Math.abs(dx) > COMMIT_FLICK_PX);
    if (!enough) {
      clearReturn({ animate: true });
      return;
    }
    // Committed. The returning card is handed back without an animation of its
    // own so that `render`, one line later, is what moves it — from exactly
    // where the finger let go, into its new place in the deck.
    clearReturn({ animate: false });
    if (dx < 0) forward();
    else back();
  }

  deck.addEventListener('pointerup', endDrag);
  deck.addEventListener('pointercancel', endDrag);

  // --- A trackpad, which is the same gesture with no finger --------------------

  let wheelAt = 0;
  let wheelIdle = null;
  // Set the moment a scroll turns a card, and cleared only by the stream going
  // quiet. Without it one two-finger flick ran the whole deck out: a trackpad
  // keeps delivering deltas long after the fingers have lifted, so resetting
  // the accumulator on commit simply let the momentum earn the next hundred and
  // ten pixels, and the next, until there were no cards left. A gesture is the
  // events *and* their tail; this is what treats it as one thing.
  let wheelLocked = false;

  deck.addEventListener(
    'wheel',
    (e) => {
      // Vertical wheeling is a scroll, and two of these cards have something to
      // scroll. Only a clearly horizontal one is this deck's business.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      // Pushed on every event, including the ones being ignored below: the
      // gesture ends when the events stop, not when one of them was last acted
      // on.
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => {
        wheelAt = 0;
        wheelLocked = false;
      }, WHEEL_IDLE_MS);
      if (wheelLocked || busy) return;
      wheelAt += e.deltaX;
      if (Math.abs(wheelAt) < WHEEL_COMMIT) return;
      wheelLocked = true;
      // Scrolling right — content moving left — is the same direction as
      // throwing the card left, which is what the hint says to do.
      const onwards = wheelAt > 0;
      wheelAt = 0;
      if (onwards) forward();
      else back();
    },
    { passive: false },
  );

  // --- And a keyboard ----------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      forward();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      back();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close('skipped');
    }
  });

  nextBtn.addEventListener('click', forward);
  skipBtn.addEventListener('click', () => close('skipped'));
  $('intro-done').addEventListener('click', () => close('done'));

  // --- Permissions -------------------------------------------------------------

  const permRow = (key) => $(`intro-perm-${key}`);

  /**
   * Draw the three rows against the world as it currently is.
   *
   * Run every time the card comes forward rather than once, because it is
   * reachable by swiping back — and because on a replay the answers are months
   * old and read off evidence rather than memory. See `alreadyGranted`.
   */
  async function drawPerms() {
    let geolocation = null;
    let healthOn = null;
    try {
      // Awaited rather than chained off `?.()`: a browser with no Permissions
      // API hands back `undefined`, and `.catch` on that is a throw inside the
      // one function whose whole job is to survive not knowing.
      geolocation = (await geolocationState?.()) ?? null;
    } catch {
      /* no answer is the same as "we cannot tell", which is what null means */
    }
    try {
      healthOn = (await healthState?.()) ?? null;
    } catch {
      /* likewise — only the iPhone app can answer this one at all */
    }
    const known = sources?.() ?? [];
    for (const key of permissionsFor(host())) {
      const row = permRow(key);
      if (!row) continue;
      const btn = row.querySelector('.intro-perm-btn');
      const note = row.querySelector('.intro-perm-text small');
      if (row.dataset.settled === 'yes') continue; // answered in this sitting
      if (alreadyGranted(key, { asked: perms, sources: known, geolocation, healthOn })) {
        settle(row, btn, true, PERM_COPY[key].already());
        if (note) note.textContent = PERM_COPY[key].kept();
      } else {
        row.className = 'intro-perm';
        btn.disabled = false;
        btn.textContent = t('intro.perm.allow');
        // Put back, not left alone: a replay of a replay reaches this row after
        // a previous pass had already rewritten the note to say the answer was
        // in. If the answer has since been taken away in iOS Settings, the row
        // has to go back to explaining itself.
        if (note) note.textContent = PERM_COPY[key].why();
      }
    }
  }

  function settle(row, btn, granted, label) {
    row.dataset.settled = 'yes';
    row.className = `intro-perm ${granted ? 'is-done' : 'is-refused'}`;
    btn.disabled = true;
    btn.textContent = label;
  }

  const ASK = { photos: () => askPhotos?.(), location: () => askLocation?.(), health: () => askHealth?.() };

  for (const key of ['photos', 'location', 'health']) {
    const row = permRow(key);
    row?.querySelector('.intro-perm-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      row.classList.add('is-busy');
      btn.disabled = true;
      btn.textContent = t('intro.perm.asking');
      const reply = (await ASK[key]?.()) ?? { ok: false };
      row.classList.remove('is-busy');
      rememberPerm(key, reply.ok ? 'granted' : 'refused');
      if (reply.ok) {
        // Photos is the one that can say something back worth reading: how many
        // of them turned out to know where they were. It is the first evidence
        // anybody gets that this whole idea works.
        const found = Number(reply.count);
        settle(row, btn, true, t('intro.perm.granted'));
        if (key === 'photos' && found > 0) {
          const note = row.querySelector('.intro-perm-text small');
          if (note) note.textContent = t('intro.perm.photos-found', { count: found.toLocaleString() });
        }
      } else {
        // "Not now" is what a refusal is called, and one of these is not a
        // refusal: Apple Health cannot be asked from a page at all, so pressing
        // Allow on that row is answered with directions rather than a sheet.
        // Labelling that "Not now" would be reporting somebody's yes as a no.
        settle(row, btn, false, t(reply.error === 'settings' ? 'intro.perm.in-app' : 'intro.perm.not-now'));
        const note = row.querySelector('.intro-perm-text small');
        if (note) note.textContent = PERM_COPY[key].blocked();
      }
    });
  }

  // --- Home --------------------------------------------------------------------

  const homeKnown = $('intro-home-known');
  const homeNote = $('intro-home-note');
  const homeSet = $('intro-home-set');
  const homeTitle = $('intro-home-title');
  const homeBody = $('intro-home-body');

  /**
   * Ask, or acknowledge.
   *
   * The whole block changes, not just a line added underneath it. Somebody
   * replaying this has already answered the question in the heading, and a
   * screen that asks it again and then admits underneath that it knows the
   * answer is a screen that was not reading its own state — it was reciting.
   */
  function drawHome() {
    const set = home?.();
    homeKnown.hidden = !set;
    if (set) {
      homeTitle.textContent = t('intro.home.title-set');
      homeBody.textContent = t('intro.home.body-set');
      homeKnown.textContent = set.name
        ? t('intro.home.known', { name: set.name })
        : t('intro.home.known-unnamed');
      homeSet.textContent = t('intro.home.change');
    } else {
      homeTitle.textContent = t('intro.home.title');
      homeBody.textContent = t('intro.home.body');
      homeSet.textContent = t('intro.home.set');
    }
  }

  homeSet.addEventListener('click', async () => {
    if (busy) return;
    homeNote.hidden = true;
    await curtain(false);
    onPickHome?.(async (picked) => {
      await curtain(true);
      // Cancelling is a whole answer, and it is not a failure — the guess off
      // the cells you visit most is a real default and this is an optional
      // correction to it. So it is acknowledged rather than argued with.
      homeNote.textContent = picked ? t('intro.home.saved', { name: picked.name || t('intro.home.there') })
        : t('intro.home.later');
      homeNote.hidden = false;
      drawHome();
    });
  });

  // --- The last card -----------------------------------------------------------

  const tilesEl = $('intro-tiles');
  const doneLine = $('intro-done-line');
  let counted = false;

  /**
   * The numbers, and then the confetti.
   *
   * Both readings are asked for here rather than waited on earlier: this card
   * is six swipes into the deck, so by the time anybody arrives the requests
   * have long since been made by the rest of the app and this is a cache hit.
   * Asking anyway costs one conditional request and means the card is right
   * even when somebody skipped straight to it.
   */
  async function finishCard() {
    if (counted) return;
    counted = true;
    const [stats, trips] = await Promise.all([
      loadStats?.().catch(() => null),
      loadTrips?.().catch(() => null),
    ]);
    if (!open || cards[at]?.dataset.page !== 'done') return;

    const tiles = introNumbers(stats, routes?.(), trips);
    tilesEl.replaceChildren();
    // An account with nothing on it yet gets a sentence rather than a grid of
    // zeroes. Four noughts is a true and thoroughly demoralising answer to
    // "what are you starting with".
    doneLine.textContent = tiles.length ? t('intro.done.body') : t('intro.done.empty');

    for (const tile of tiles) {
      const el = document.createElement('div');
      el.className = 'intro-tile';
      const value = document.createElement('b');
      const label = document.createElement('small');
      label.textContent = TILE_LABEL[tile.key]?.() ?? tile.key;
      el.append(value, label);
      tilesEl.append(el);
      countUp(value, tile.value, tile.kind);
    }
    confetti();
  }

  // Past this many characters a number stops fitting a tile at full size. It is
  // the string that decides, not the kind: "412 km²" is short and "1,204,880"
  // is not, and both can turn up in either column.
  const LONG_VALUE = 8;

  function countUp(el, to, kind) {
    const write = (v) => {
      const text = kind === 'area' ? formatKm2(v) : Math.round(v).toLocaleString();
      el.textContent = text;
      el.classList.toggle('is-long', text.length > LONG_VALUE);
    };
    if (reducedMotion()) {
      write(to);
      return;
    }
    // Start at nought rather than empty, and guarantee the end.
    //
    // `requestAnimationFrame` does not run in a hidden tab — not throttled,
    // *stopped* — so a card reached just before switching away leaves a tile
    // with nothing in it, and the number is the entire point of the tile. The
    // opening write means it always says something; the timer means it always
    // ends up saying the right thing, whether or not a single frame was drawn.
    write(0);
    const settle = setTimeout(() => write(to), COUNT_MS + 250);
    const started = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - started) / COUNT_MS);
      // Out-cubic: quick off the mark and settling, rather than a linear tally
      // that looks like a progress bar for a number that is already known.
      write(to * (1 - (1 - p) ** 3));
      if (p < 1) {
        requestAnimationFrame(step);
        return;
      }
      clearTimeout(settle);
      write(to);
    };
    requestAnimationFrame(step);
  }

  // --- Confetti ----------------------------------------------------------------
  //
  // A canvas rather than a hundred elements: this runs on the phone, at the end
  // of a screen that is already several backdrop-filters deep, and animating a
  // hundred DOM nodes there is the one thing guaranteed to drop frames.

  // Two palettes, because this is the one thing on the screen that is *not*
  // drawn in `currentColor` and so cannot follow the theme for free. White
  // paper on a white curtain is an empty celebration.
  const CONFETTI_DARK = ['#86dfcd', '#c07bff', '#ffb26b', '#ffffff'];
  const CONFETTI_LIGHT = ['#12806a', '#7d3fc9', '#d97317', '#1d1d29'];

  function confetti() {
    if (!canvas || reducedMotion()) return;
    const colors = lightScene() ? CONFETTI_LIGHT : CONFETTI_DARK;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = root.clientWidth;
    const h = root.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.hidden = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bits = Array.from({ length: 130 }, () => ({
      x: w * (0.5 + (Math.random() - 0.5) * 0.5),
      y: h * 0.42 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 9,
      vy: -6 - Math.random() * 9,
      spin: (Math.random() - 0.5) * 0.34,
      a: Math.random() * Math.PI,
      size: 4 + Math.random() * 6,
      color: colors[(Math.random() * colors.length) | 0],
    }));

    const started = performance.now();
    const LIFE = 2600;
    // The same backstop the count-up needs, for the same reason and with a
    // worse failure: a tab switched away from mid-fall stops getting frames,
    // and coming back to a canvas of motionless paper is precisely the "frozen
    // heap" the fade below exists to avoid.
    const stop = setTimeout(() => {
      canvas.hidden = true;
    }, LIFE + 400);
    const tick = (now) => {
      const age = now - started;
      ctx.clearRect(0, 0, w, h);
      if (age > LIFE || !open) {
        clearTimeout(stop);
        canvas.hidden = true;
        return;
      }
      // Fading the whole fall out at the end rather than letting the pieces
      // leave the bottom of the screen: on a short window most of them never
      // would, and a frozen heap of confetti is a bug that looks like a bug.
      ctx.globalAlpha = age > LIFE - 700 ? Math.max(0, (LIFE - age) / 700) : 1;
      for (const b of bits) {
        b.vy += 0.34; // gravity
        b.vx *= 0.995;
        b.x += b.vx;
        b.y += b.vy;
        b.a += b.spin;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.a);
        ctx.fillStyle = b.color;
        // Squashed on one axis by its own rotation, which is what makes a flat
        // rectangle read as a piece of paper turning over.
        ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
        ctx.restore();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // --- The curtain -------------------------------------------------------------

  /**
   * Up (false) or down (true), and resolve when it has finished moving.
   *
   * A timer rather than `animationend`, because the animation is `none` under
   * reduced motion and a promise that waits for an event which will never fire
   * is a home picker that never opens.
   */
  function curtain(down) {
    busy = true;
    const ms = reducedMotion() ? 0 : down ? 500 : 420;
    root.classList.remove('intro-in', 'intro-out');
    if (down) {
      root.hidden = false;
      // Reading a layout property between removing the class and adding it is
      // what makes the animation restart rather than being coalesced away.
      void root.offsetWidth;
      root.classList.add('intro-in');
    } else {
      root.classList.add('intro-out');
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!down) {
          root.hidden = true;
          root.classList.remove('intro-out');
        }
        busy = false;
        resolve();
      }, ms);
    });
  }

  // --- Opening and closing -----------------------------------------------------

  function close(reason) {
    if (!open) return;
    open = false;
    clearTimeout(hintTimer);
    hintEl.hidden = true;
    canvas.hidden = true;
    curtain(false).then(() => onFinish?.(reason));
  }

  return {
    isOpen: () => open,
    /**
     * Take it off the screen without recording anything.
     *
     * Not the same as skipping, and the difference is the whole reason this
     * exists: skipping is an answer, and it is remembered against the account
     * that gave it. This is what a *sign-out* does — the person being
     * introduced has left, and the deck goes with them rather than being marked
     * as read on their way out of the door.
     */
    dismiss() {
      if (!open) return;
      open = false;
      clearTimeout(hintTimer);
      hintEl.hidden = true;
      canvas.hidden = true;
      root.hidden = true;
      root.classList.remove('intro-in', 'intro-out');
      busy = false;
    },
    /**
     * Show it from the top.
     *
     * State that describes the *world* is re-read (permissions, home, the
     * numbers); state that describes this sitting is thrown away. That is what
     * makes the Settings replay a fresh reading rather than a recording of the
     * first one.
     */
    open() {
      if (open) return;
      open = true;
      at = 0;
      counted = false;
      perms = readPerms();
      for (const key of ['photos', 'location', 'health']) {
        const row = permRow(key);
        if (row) delete row.dataset.settled;
      }
      homeNote.hidden = true;
      root.dataset.host = host();
      render();
      curtain(true).then(() => {
        // After the curtain, not before: focusing a hidden element does
        // nothing, and the point of this is to take the keyboard away from the
        // map underneath rather than to put it anywhere in particular.
        if (open) root.focus({ preventScroll: true });
      });
    },
  };
}
