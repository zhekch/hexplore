// Swiping along a series: the chip that names the day, and the month grid.
//
// Two places in this app show you one of a run of things — the day on the map
// and the month in the calendar — and in both the next question is always the
// one either side. Answering it used to mean the search palette, a grid, and a
// day picked out of it: four moves to step one day.
//
// So both take a horizontal swipe, which is what a series is for. It is the
// same gesture the photograph card takes (src/photo-info.js), deliberately:
// sideways over one of a series means *the next one* everywhere else on this
// device, and something that answered it differently would be a second thing to
// learn.
//
// **Three ways in, because there are three kinds of hand.** A finger drags it.
// A trackpad throws a stream of `wheel` events at it and no pointer events at
// all — the gesture anybody actually makes on a Mac, and the one that made this
// look broken there: the chip could be *dragged* with a mouse and could not be
// swiped. And a cursor has neither, so the arrows are buttons; see
// `.chip-arrow` in src/style.css and the calendar's own two.
//
// It is a gesture rather than two invisible buttons. The thing follows the
// finger, resists where there is nothing further to go, and can be changed its
// mind about by putting it back — a swipe that only reacts on release is one
// you cannot tell has been noticed, which is how you end up swiping twice and
// skipping one.

/** How far it has to be pulled, in CSS pixels, before letting go means "next". */
export const SWIPE_COMMIT = 48;

/**
 * Or how fast, in pixels per millisecond. Either will do: a slow deliberate
 * pull and a quick flick are the same instruction, and demanding both makes the
 * gesture feel like it is arguing with you.
 *
 * Both numbers are smaller than the photograph card's, because the things being
 * dragged are smaller. 56px is a third of the way across a chip and most of the
 * way across a photograph, and a gesture measured in absolute pixels on an
 * element this size has to be started nearer its edge than a thumb usually
 * lands.
 */
export const SWIPE_FLICK = 0.4;

/**
 * How far before the gesture is ours at all, and the thing starts moving. Below
 * this a press that drifts is still a press — the chip carries buttons and the
 * grid is thirty of them, and a tap that slides the month two pixels and
 * selects nothing is a broken tap.
 */
export const SWIPE_CLAIM = 8;

/** How far it can be pulled towards something that isn't there. */
const SWIPE_STUCK = 0.25;

/** How far the new one slides in from, and for how long. */
const ENTER_PX = 18;
const ENTER_MS = 180;

// --- …and the same gesture on a trackpad -----------------------------------------
//
// A two-finger swipe is not a pointer gesture. It arrives as a stream of
// `wheel` events, and the numbers below are the photograph card's, for the same
// reason the pointer ones are: one gesture on this device should not mean two
// different amounts depending on which part of the app it is over. The
// difficulty is the same too — a `wheel` event does not say which part of a
// gesture it is, so a firm flick and its second of coasting afterwards are one
// indistinguishable stream, and counting the coasting turns one swipe into
// thirty. See the long note by `WHEEL_LULL` in src/photo-info.js; this is that
// state machine with the comments left there.

/** How much sideways travel is one step. */
export const WHEEL_STEP = 40;
/** Silence: the fingers are up and the coasting has finished. */
export const WHEEL_GAP_MS = 120;
/** …or the stream winding down and then picking up again, which coasting cannot do. */
export const WHEEL_LULL = 6;
export const WHEEL_WAKE = 12;

/**
 * How long a silence has to be before it ends a gesture *whatever* comes next.
 *
 * The gap rule above is not enough on its own, and the way it fails is the
 * complaint this exists to answer — one swipe, five months. A tail decays into
 * events a frame or two apart, then further apart, and a gap between two of
 * them can be longer than `WHEEL_GAP_MS` while the fingers have been off the
 * glass for half a second: the gesture is declared over, the coasting that
 * follows is read as a fresh push, and 40px of tail is another month.
 *
 * So a short silence only starts a new gesture if what breaks it is a *hand* —
 * above `WHEEL_WAKE`, which coasting at that point never is. A long one starts
 * a new gesture whatever its first event looks like, because a slow deliberate
 * push does begin below the wake threshold and must not be swallowed for as
 * long as anybody keeps swiping.
 */
export const WHEEL_DONE_MS = 400;

/**
 * The trackpad's own state machine, as a function of the stream.
 *
 * Separated from the listener because it is the part that is *decided* rather
 * than plumbed, and because none of it can be seen: what arrives is a hundred
 * events a second with no beginning and no end marked on any of them, and every
 * rule for cutting them into gestures is a number nobody can check by reading.
 * `scripts/test/swipe.mjs` feeds it a real flick — a burst that accelerates,
 * then a long decaying tail — and insists on exactly one step.
 *
 * @returns {{feed:(deltaX:number, at:number) => number}} the step this event
 *   completes, or 0
 */
export function wheelStepper() {
  let last = -Infinity;
  let sum = 0;
  let spent = false;
  let lulled = false;
  return {
    feed(deltaX, at) {
      const speed = Math.abs(deltaX);
      const gap = at - last;
      if (gap > WHEEL_DONE_MS || (gap > WHEEL_GAP_MS && (!spent || speed > WHEEL_WAKE))) {
        // Silence, and long enough to mean it.
        sum = 0;
        spent = false;
      } else if (spent && lulled && speed > WHEEL_WAKE) {
        // Or the stream wound down and then picked up, which coasting cannot do
        // — a second swipe thrown while the first is still travelling.
        sum = 0;
        spent = false;
      }
      last = at;
      if (spent) {
        // Only while spent, so the acceleration of the swipe *being* answered
        // cannot arm the thing that ends it.
        if (speed <= WHEEL_LULL) lulled = true;
        return 0;
      }
      sum += deltaX;
      if (Math.abs(sum) < WHEEL_STEP) return 0;
      spent = true;
      lulled = false;
      // Pushing the content left brings in what is to the right of it, which is
      // the next one — the same direction the drag runs.
      return sum > 0 ? 1 : -1;
    },
  };
}

/**
 * A finished drag → which way to step, if at all.
 *
 * Pulled out of the DOM on purpose: everything that makes a gesture feel right
 * or wrong is arithmetic — how far is far enough, how fast counts as a flick,
 * what happens where there is nothing further to go — and none of it is visible
 * in the review that breaks it. `scripts/test/swipe.mjs` is that arithmetic,
 * without a browser.
 *
 * Positive is a step *forward* through the series, whichever axis it came from:
 * pulling the content left, or up, brings in what was after it.
 *
 * @param {number} d how far the finger travelled, positive right or down
 * @param {number} ms how long it took
 * @returns {-1|0|1}
 */
export function swipeStep(d, ms) {
  // Below the claim distance nothing is a swipe, however fast it happened. The
  // handler below never gets that far — it hasn't claimed the gesture yet — but
  // the speed rule divides by a duration, and two pointer events in the same
  // frame make a 1px twitch look like the fastest flick ever thrown.
  if (!Number.isFinite(d) || Math.abs(d) < SWIPE_CLAIM) return 0;
  // Milliseconds, floored at one, for the same division.
  const speed = Math.abs(d) / Math.max(1, ms || 0);
  if (Math.abs(d) < SWIPE_COMMIT && speed < SWIPE_FLICK) return 0;
  // Pulling it left brings the next one in from the right, which is the
  // direction time runs in every calendar this app draws.
  return d < 0 ? 1 : -1;
}

/**
 * Let an element be swiped along a series.
 *
 * @param {HTMLElement} el the thing that moves and takes the gesture
 * @param {object} opts
 * @param {(step:number, axis:string) => boolean} opts.can is there anything
 *   that way? Asked per direction and per axis, and asked again on every drag
 *   rather than once, because what is being shown changes underneath it — the
 *   first day of a history resists backwards and moves forwards, and a chip
 *   showing a trip answers for the vertical axis and not the horizontal one
 * @param {(step:number, axis:string) => void} opts.onStep
 * @param {boolean} [opts.wheel] take the trackpad's horizontal swipe as well
 * @param {HTMLElement} [opts.slides] what actually moves, if it is not `el` —
 *   the calendar takes the gesture on its panel and moves the grid inside it,
 *   but the chip moves the whole of itself
 * @returns {{step:(step:number, axis?:string) => void, can:(step:number,
 *   axis?:string) => boolean}} the same step a swipe makes, for the buttons and
 *   the arrow keys that stand in for one, and the same question it asks first.
 *   A click, a key and a swipe should not be three implementations of one
 *   movement — the arrows would be the ones that quietly stopped animating.
 */
export function mountSwipe(el, { can, onStep, wheel = true, slides = null }) {
  if (!el) return { step: () => {}, can: () => false };
  const moving = slides ?? el;
  let drag = null;
  // A drag that ends where it began still dispatches a click, so a swipe that
  // starts on the Stop button would also press it — the map would stop showing
  // the day you had just asked for the next one of. Cleared on the next press
  // rather than only where it is read, or a gesture the system cancels leaves
  // it standing to swallow a real tap later.
  let swallowTap = false;

  const slide = (d, axis) => {
    moving.style.translate = d ? (axis === 'y' ? `0 ${d}px` : `${d}px 0`) : '';
    moving.classList.toggle('swiping', !!d);
  };

  /**
   * The new one, arriving from the side it was asked for from.
   *
   * `transform` rather than the `translate` the drag uses, so the two cannot
   * fight over one property: this runs on top of wherever the drag left things,
   * which is home by the time it is called.
   */
  const enter = (step, axis) => {
    const from = step > 0 ? ENTER_PX : -ENTER_PX;
    moving.animate?.(
      [
        { transform: axis === 'y' ? `translateY(${from}px)` : `translateX(${from}px)`, opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: ENTER_MS, easing: 'ease-out' },
    );
  };

  const take = (step, axis = 'x') => {
    if (!step || !can(step, axis)) return;
    onStep(step, axis);
    enter(step, axis);
  };

  el.addEventListener('pointerdown', (e) => {
    swallowTap = false;
    if (e.button > 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, d: 0, axis: '', own: false };
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.own) {
      // Claimed once, and only when the movement is plainly along one axis: the
      // chip sits over a map that is panned with the same finger and the grid
      // is inside a panel that scrolls, so anything that grabbed every drag
      // would be a hole in the thing behind it.
      const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const d = axis === 'x' ? dx : dy;
      if (Math.abs(d) < SWIPE_CLAIM || Math.abs(d) <= Math.abs(axis === 'x' ? dy : dx)) return;
      // And only when there is something that way at all — otherwise a chip
      // showing a trip would follow a sideways drag along a series it is not in.
      if (!can(1, axis) && !can(-1, axis)) return;
      drag.own = true;
      drag.axis = axis;
      swallowTap = true;
      el.setPointerCapture?.(drag.id);
    }
    drag.d = drag.axis === 'x' ? dx : dy;
    // Resisted rather than refused where there is nothing further: a thing that
    // will not move at all is indistinguishable from one that has stopped
    // responding, and a quarter of the movement says "there is no such day" in
    // the language the gesture is already speaking.
    const step = drag.d < 0 ? 1 : -1;
    slide(can(step, drag.axis) ? drag.d : drag.d * SWIPE_STUCK, drag.axis);
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { d, own, at, axis } = drag;
    drag = null;
    if (!own) return;
    // Released before the movement is undone, or it springs back from wherever
    // the capture happened to end rather than from where it is.
    el.releasePointerCapture?.(e.pointerId);
    slide(0, axis);
    take(swipeStep(d, e.timeStamp - at), axis);
  };

  el.addEventListener('pointerup', endDrag);
  // A pointer the system takes away — a phone that decides the gesture was a
  // pan of the map, a mouse that leaves the window — has to put it back, or it
  // stays where the finger left it for ever.
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('click', (ev) => {
    if (!swallowTap) return;
    swallowTap = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  const handle = { step: take, can: (step, axis = 'x') => !!can(step, axis) };
  if (!wheel) return handle;

  // One stepper per axis, because a gesture belongs to an axis: a sideways
  // flick and a downward one are two gestures and must not spend each other's
  // step, and a stream that drifts across both is answered by whichever axis it
  // is plainly on.
  const wheels = { x: wheelStepper(), y: wheelStepper() };

  el.addEventListener('wheel', (e) => {
    // Plainly along one axis. A two-finger scroll down a trackpad drifts left
    // and right by a few pixels the whole way, and a month that changes because
    // of that is unusable — and the same in reverse for a sideways swipe with a
    // little vertical wobble in it.
    const axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 'x' : 'y';
    const delta = axis === 'x' ? e.deltaX : e.deltaY;
    if (!delta || Math.abs(delta) <= Math.abs(axis === 'x' ? e.deltaY : e.deltaX)) return;
    if (!can(1, axis) && !can(-1, axis)) return;
    // Ours from here, spent or not. The tail of a flick has to be swallowed as
    // well as the flick, or a swipe this has already answered goes on to scroll
    // whatever is underneath — one gesture, two answers. It is also what stops
    // the browser reading a sideways swipe as *go back a page*: the gesture is
    // claimed from its first event, which is before that decision is made.
    e.preventDefault();
    take(wheels[axis].feed(delta, e.timeStamp), axis);
  }, { passive: false });

  return handle;
}
