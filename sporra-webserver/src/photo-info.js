// The card you get by tapping a photograph on the map: when it was taken, and
// the photograph.
//
// Same glass and same language as the cell and route cards (src/cell-info.js,
// src/route-info.js), with one thing neither of them has to do — it fetches. A
// picture lives on the phone and crosses the bridge one at a time, so this card
// has states the others do not: waiting, arrived, and "that original is in
// iCloud and could not be had just now".
//
// It shows a **group** as readily as a single photo, because that is what a tap
// usually lands on: forty pictures of one dinner are one point on the map at
// every zoom there is. The strip along the bottom is the group, newest first,
// and picking one swaps the picture above it — so the card opens on the most
// recent, which for a place you have been back to is almost always the one you
// meant.
//
// ## The whole group, however big it is
//
// The strip used to stop at 48 and that was a card lying about what you had
// tapped. It now holds all of them, and pays for that in two ways rather than
// one, because a group of four thousand is two different problems:
//
// - **Elements.** Buttons are appended `STRIP_CHUNK` at a time, when a sentinel
//   at the end of the strip scrolls into view. Nothing below the fold exists.
// - **Requests.** A thumbnail is fetched when its button appears, not when it is
//   created. Scrolling the strip is what asks for pictures; a group you open and
//   glance at costs the dozen you can see.
//
// Both hang off one `IntersectionObserver` rooted on the strip, which is also
// what makes them stop: closing the card disconnects it, and whatever was
// queued simply never happens.

import { formatTime } from './clock.js';
import { STRIP_CHUNK, photoImage, playVideo, viewPhoto } from './photos.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);

// Asked once and re-read on every use: `matches` is live, so somebody who turns
// the setting on mid-session is obeyed without a reload.
const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

// How big a thumbnail to ask for, in CSS pixels of the square it goes in. The
// device pixel ratio is applied on top, or the strip is soft on every phone made
// since 2012.
const THUMB_PX = 120;

// --- Swiping from one to the next ------------------------------------------------
//
// The strip is a complete answer to "which one" and a poor answer to "the next
// one". Forty pictures of a dinner are forty 54px squares, and picking your way
// along them with a thumb is not how anybody looks at photographs — you swipe,
// because that is what every other photograph on the device does.
//
// It is a *gesture*, not a pair of buttons that happen to be invisible: the
// picture follows the finger, resists at the ends of the group, and can be
// changed its mind about by putting it back. Nothing about that is decoration —
// a swipe that only reacts on release is one you cannot tell has been noticed,
// which is how you end up swiping twice and skipping one.

// How far it has to be pulled, in CSS pixels, before letting go means "the next
// one" rather than "put it back".
const SWIPE_COMMIT = 56;

// Or how fast, in pixels per millisecond. Either will do: a slow deliberate pull
// and a quick flick are the same instruction, and demanding both makes the
// gesture feel like it is arguing with you.
const SWIPE_FLICK = 0.5;

// How far sideways before the gesture is ours at all, and the picture starts
// moving. Below this a press that drifts is still a press — the figure is also
// the way to the full-screen viewer, and a tap that scrolls the photograph a
// pixel and then opens nothing is a broken tap.
const SWIPE_CLAIM = 10;

// How far the new photograph slides in from. Small on purpose: this is the
// arrival of a picture that has just been fetched, not a page turn, and a long
// travel makes the card look like it is rebuilding itself every time.
const SWIPE_ENTER = 22;

// --- …and the same gesture on a trackpad -----------------------------------------
//
// A two-finger swipe on a trackpad is not a pointer gesture. It arrives as a
// stream of `wheel` events, which is why the swipe above worked on a phone and
// did nothing on a Mac — and why what it *did* do was worse than nothing: the
// strip is the only sideways scroller on the card, so the browser handed the
// swipe to that and one flick flew past thirty thumbnails without changing the
// picture at all.
//
// So the card takes the horizontal wheel itself, and answers it the way the Mac
// app answers the same gesture over its own gallery (`GalleryView.scrollWheel`
// in sporra-macos): accumulate, and step **once**.

/** How much sideways travel is one photograph. */
const WHEEL_STEP = 40;

// --- Where one swipe ends and the next begins -------------------------------------
//
// This is the whole difficulty, and the platform is no help: a `wheel` event
// does not say which part of a gesture it is. AppKit has `momentumPhase` and
// the web has nothing, so a firm flick and its second of coasting afterwards
// are the same stream of events — and counting the coasting is what turns one
// swipe into thirty.
//
// Spending the step once per gesture fixes that and introduces the opposite
// complaint, which is the one this is the second attempt at: if the *only* way
// to begin a new gesture is silence, then a second swipe made while the first
// is still coasting is swallowed, and the card feels as though it is on a
// cooldown. It was, effectively, for as long as the momentum lasted.
//
// So there are two ways back in, and the second is the useful one.

/** Silence. The fingers are up and the coasting has finished. */
const WHEEL_GAP_MS = 120;

/**
 * …or the stream winding down and then picking up again.
 *
 * Two thresholds and not one, and the first attempt at this had only the
 * second. "Faster than the slowest event since the last photograph" sounds like
 * it identifies a fresh push, and it identifies a *hard flick* just as well: a
 * swipe accelerates while the fingers are still on the glass, so the photograph
 * is spent a frame or two in and everything after it is faster than that. A
 * firm flick came out as three or four pictures.
 *
 * So the stream has to go quiet first. Below `WHEEL_LULL` it has wound down —
 * coasting decays towards nothing and cannot come back — and only then does
 * anything above `WHEEL_WAKE` mean a hand. Absolute rather than relative to the
 * peak, because a flick and a nudge decay to the same place and it is the place
 * that matters, not the distance travelled to it.
 */
const WHEEL_LULL = 6;
const WHEEL_WAKE = 12;

// How many are fetched without being asked for.
//
// The observer below is what fills the strip, and it is the right mechanism for
// everything past the fold. It is the wrong thing to depend on for the pictures
// that are already on screen: it cannot fire until the page has been laid out
// and painted, so a card opened in a tab that is not being rendered — or on any
// browser that decides the strip's scroller has no size yet — is a row of empty
// boxes with nothing to nudge it. A screenful, fetched outright, means the strip
// is never blank; scrolling does the rest.
const EAGER_THUMBS = 12;

/**
 * "12 photos", or the one thing it is — and it says "video" when it is one.
 *
 * A group that is half videos is called neither, because calling forty videos
 * "40 photos" is the small lie that made them feel broken in the first place.
 */
export function groupTitle(items) {
  const videos = items.reduce((n, item) => n + (item.v ? 1 : 0), 0);
  if (items.length === 1) return videos ? 'Video' : 'Photo';
  const n = items.length.toLocaleString();
  if (!videos) return `${n} photos`;
  if (videos === items.length) return `${n} videos`;
  return `${n} photos and videos`;
}

/**
 * When they were taken: a day, a day and a time, or a span.
 *
 * A single photograph gets its clock reading, because that is the whole of what
 * this card knows and "3 Sep 2023" alone reads as a card that failed to load the
 * rest. A group that happened on one day says the day once rather than twice.
 *
 * The ends are the smallest and largest rather than the first and last, so this
 * reads a group the same way whichever order the list is in — the strip is
 * newest first, and a span written backwards is a typo everybody sees.
 */
export function groupWhen(items) {
  if (!items.length) return '';
  // Folded rather than spread: `Math.min(...times)` on a group of four thousand
  // is four thousand arguments, and that is how you overflow a stack.
  let first = items[0].t;
  let last = items[0].t;
  for (const item of items) {
    if (item.t < first) first = item.t;
    if (item.t > last) last = item.t;
  }
  if (items.length === 1) return [day(first), formatTime(first * 1000)].filter(Boolean).join(' · ');
  const a = day(first);
  const b = day(last);
  return a === b ? a : `${a} – ${b}`;
}

// How long the spinner stays on after the app says yes.
//
// The app answers at the moment it *presents* the player, and a presentation is
// an animation — for a third of a second the card is still the thing on screen,
// and putting the play triangle back the instant the reply lands made it flash
// once just before the player covered it. There is nothing to detect here: a
// native view going up over the web view is not an event the page receives. So
// the spinner outlives the reply by about as long as the animation takes, and
// what you see is a spinner until there is a player.
const SETTLE_MS = 500;

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/** What a failure means, in a sentence somebody can act on. */
function trouble(error) {
  switch (error) {
    case 'unavailable':
      return 'This one is still in iCloud and could not be fetched just now.';
    case 'noplayer':
      return 'This video could not be played.';
    case 'stale':
      return 'The library changed. Switch Photos off and on again to catch up.';
    case 'denied':
    case 'unasked':
      return 'Sporra has not been given access to your photos.';
    default:
      return 'This photo could not be opened.';
  }
}

/**
 * Wires the card (markup lives in index.html).
 *
 * The chrome that has to move out of this card's way is not told about it from
 * here — src/card-lift.js watches all three cards instead, which is what keeps
 * the three of them behaving the same.
 *
 * @param {object} opts
 * @param {() => void} [opts.onClose]
 * @returns {{show:(items:{i:number,t:number}[])=>void, hide:()=>void, visible:()=>boolean}}
 */
export function mountPhotoInfo({ onClose } = {}) {
  const $ = (id) => document.getElementById(id);
  const card = $('photo-info');
  const titleEl = $('photo-info-title');
  const whenEl = $('photo-info-when');
  const closeBtn = $('photo-info-close');
  const figure = $('photo-info-figure');
  const imgEl = $('photo-info-img');
  const noteEl = $('photo-info-note');
  const stripEl = $('photo-info-strip');
  const sentinel = $('photo-info-more');
  const playBtn = $('photo-info-play');

  let items = [];
  let chosen = 0;
  // How many of them have buttons so far.
  let rendered = 0;
  // Which showing this is. The strip checks it on the far side of every await:
  // a card reopened on another point while thumbnails were arriving must not go
  // on being filled by the group that was on its way to the last one.
  let showing = 0;
  // And which *picture* is wanted, which is not the same question — picking a
  // second thumbnail while the first is still in flight happens inside one
  // showing, and without this the slower of the two wins whichever it was.
  let picking = 0;
  let watcher = null;
  // A hand-off to the app is in flight. One at a time, or a second tap while an
  // iCloud original is still downloading opens a second viewer over the first.
  let busy = false;
  // The button currently outlined, held rather than searched for: a group can
  // have thousands and only one of them changes.
  let chosenBtn = null;
  // Which side the next picture is arriving from: 1 from the right, -1 from the
  // left, 0 for the one the card opened on. Set by `select`, spent by
  // `showChosen` when the bytes turn up.
  let entering = 0;
  // The swipe in progress, or null. Held whole rather than as four variables
  // because every one of them is meaningless without the others.
  let drag = null;
  // A drag that moved is not also a tap. The click fires anyway — the pointer
  // went down and up on the same element — and without this, swiping to the
  // next photograph also opened the one you swiped away from, full screen.
  let swallowTap = false;

  const setWhen = (text) => {
    whenEl.textContent = text;
  };

  /** How far the picture is currently pulled aside, in CSS pixels. */
  const setSwipe = (px) => {
    figure.style.setProperty('--photo-swipe', `${px}px`);
  };

  /**
   * What was tapped, for the app's viewer — which is a gallery, not a frame.
   *
   * The whole group in the strip's own order, so swiping in the native viewer
   * and swiping in this card walk the same list the same way. Built at the
   * moment of the hand-off rather than held: it is one array per tap, and a copy
   * kept up to date would be a second version of `items` to get wrong.
   */
  const groupIndices = () => items.map((item) => item.i);

  function hide() {
    card.hidden = true;
    drag = null;
    entering = 0;
    setSwipe(0);
    figure.classList.remove('dragging');
    // Bumped rather than left: whatever was in flight has nowhere to land now,
    // and a strip that goes on filling itself behind a closed card is a phone
    // decoding JPEGs for nobody.
    showing++;
    picking++;
    watcher?.disconnect();
    watcher = null;
    chosenBtn = null;
    items = [];
    rendered = 0;
    imgEl.removeAttribute('src');
    imgEl.style.aspectRatio = '';
    figure.classList.remove('loaded');
    playBtn.hidden = true;
    stripEl.replaceChildren(sentinel);
    stripEl.hidden = true;
  }

  /** The big one. */
  async function showChosen() {
    const mine = ++picking;
    const item = items[chosen];
    if (!item) return;
    noteEl.textContent = '';
    playBtn.hidden = true;
    // Whatever the drag left behind. The picture it was moving is the one being
    // replaced, and a new one that arrives already pushed to one side reads as a
    // layout fault rather than as a gesture.
    setSwipe(0);
    figure.classList.add('loading');
    // `loaded` is what takes the waiting panel away, so it goes now rather than
    // when the next picture arrives — otherwise the old photograph's frame sits
    // behind the new one's loading state.
    figure.classList.remove('loaded');
    imgEl.removeAttribute('src');
    // Cleared rather than left to be overwritten: a reply that carries no
    // dimensions would otherwise leave the last photograph's shape around this
    // one, which is a letterbox with nothing in it.
    imgEl.style.aspectRatio = '';
    // The card's own width, in real pixels. Asked for at the moment of use
    // rather than once at mount: a phone rotates, and the card is a percentage
    // of the viewport.
    const px = Math.round(figure.clientWidth * (globalThis.devicePixelRatio || 1)) || 640;
    const reply = await photoImage(item.i, px);
    if (mine !== picking) return;
    figure.classList.remove('loading');
    if (!reply.ok) {
      noteEl.textContent = trouble(reply.error);
      return;
    }
    // The shape before the bytes decode, so the card does not resize under the
    // finger that opened it.
    if (reply.w && reply.h) imgEl.style.aspectRatio = `${reply.w} / ${reply.h}`;
    imgEl.src = reply.src;
    figure.classList.add('loaded');
    // A video's picture is its poster frame, so without the button it is a
    // photograph that happens to be of the first moment of something. The button
    // is what says otherwise, and pressing it hands over to the app.
    playBtn.hidden = !item.v;
    slideIn();
  }

  /**
   * The new photograph, arriving from the side it was asked for from.
   *
   * A fetch takes as long as it takes, so the swipe and the arrival cannot be
   * one continuous movement however much they should be — this is the second
   * half, played when the bytes are there. Without it a swipe ends with the old
   * picture snapping back to centre and then being silently replaced, which
   * reads as the gesture having failed and something else having happened.
   *
   * `transform` rather than the `translate` the drag uses, so the two cannot
   * fight over one property: the animation runs on top of wherever the drag
   * left things, which is centre by the time this is called.
   */
  function slideIn() {
    const from = entering;
    entering = 0;
    if (!from || reduceMotion?.matches) return;
    imgEl.animate?.(
      [
        { transform: `translateX(${from * SWIPE_ENTER}px)`, opacity: 0 },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  }

  /** One thumbnail, once its button is somewhere you could see it. */
  async function fillThumb(button, at, mine) {
    if (button.dataset.filled) return;
    button.dataset.filled = '1';
    const px = Math.round(THUMB_PX * (globalThis.devicePixelRatio || 1));
    const reply = await photoImage(items[at].i, px);
    if (mine !== showing) return;
    if (!reply.ok) {
      button.classList.add('missing');
      return;
    }
    const img = document.createElement('img');
    img.src = reply.src;
    img.alt = '';
    button.replaceChildren(img);
  }

  /** The next `STRIP_CHUNK` buttons, empty — the observer fills them. */
  function renderChunk() {
    const upto = Math.min(items.length, rendered + STRIP_CHUNK);
    for (; rendered < upto; rendered++) {
      const at = rendered;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = at === chosen ? 'photo-thumb chosen' : 'photo-thumb';
      // Marked in the strip as well as in the figure: picking through a holiday
      // you should be able to see which of them move before you pick one.
      if (items[at].v) b.classList.add('video');
      b.title = groupWhen([items[at]]);
      // Its own index, on the element. The observer needs it per callback, and
      // reading it back out of the DOM order would be a walk over every button
      // in the strip each time one scrolls into view — which for a group of four
      // thousand is the whole cost this chunking exists to avoid.
      b.dataset.at = String(at);
      if (at === chosen) chosenBtn = b;
      b.addEventListener('click', () => select(at));
      // Before the sentinel, which has to stay at the end for the next chunk.
      stripEl.insertBefore(b, sentinel);
      watcher?.observe(b);
    }
    // Nothing left to append: stop watching for the end of the strip, or the
    // observer goes on firing on a sentinel that can never load anything.
    if (rendered >= items.length) watcher?.unobserve(sentinel);
  }

  /**
   * Pick one, by number.
   *
   * The sub-line follows what you are looking at rather than staying on the
   * group's span: once you have chosen a picture, when *it* was taken is the
   * question, and the span is what the strip is showing you.
   *
   * Taking a number rather than a button is what lets the swipe and the strip
   * share this. A click already has its button — it is the thing that was
   * pressed — but a swipe can ask for a photograph four hundred along, whose
   * button has not been rendered yet and whose thumbnail is nowhere near the
   * visible part of the strip. So this renders as far as it needs to and then
   * brings the thumbnail into view: a strip left where it was would be showing
   * a selection that had visibly left the screen.
   */
  function select(at) {
    if (at < 0 || at >= items.length || at === chosen) return;
    // Which side the new one is arriving from, for the animation in
    // `showChosen`. Read before `chosen` moves, and only ever ±1 — a jump of
    // four hundred is still, visually, "the one after this".
    entering = at > chosen ? 1 : -1;
    chosenBtn?.classList.remove('chosen');
    chosen = at;
    // Everything up to it, because a swipe can outrun the chunking. The loop
    // terminates: `renderChunk` always adds `STRIP_CHUNK` or stops at the end.
    while (rendered <= at && rendered < items.length) renderChunk();
    chosenBtn = stripEl.querySelector(`.photo-thumb[data-at="${at}"]`);
    chosenBtn?.classList.add('chosen');
    // `nearest` vertically so this cannot scroll the page around the card, which
    // is fixed to the bottom of it.
    chosenBtn?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    setWhen(groupWhen([items[chosen]]));
    showChosen();
  }

  function show(all) {
    items = all;
    chosen = 0;
    rendered = 0;
    const mine = ++showing;

    titleEl.textContent = groupTitle(items);
    // The whole span on opening; picking one narrows it to that photograph.
    setWhen(groupWhen(items));
    noteEl.textContent = '';

    watcher?.disconnect();
    stripEl.replaceChildren(sentinel);
    stripEl.hidden = items.length < 2;
    if (items.length > 1) {
      // Rooted on the strip and generous about "nearly visible", so a thumbnail
      // is usually there by the time it is scrolled to rather than starting to
      // load once it arrives.
      watcher = new IntersectionObserver((entries) => {
        if (mine !== showing) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === sentinel) renderChunk();
          else fillThumb(entry.target, Number(entry.target.dataset.at), mine);
        }
      }, { root: stripEl, rootMargin: '0px 240px' });
      watcher.observe(sentinel);
      renderChunk();
      // The first screenful, without waiting to be told they are visible.
      for (const b of [...stripEl.querySelectorAll('.photo-thumb')].slice(0, EAGER_THUMBS)) {
        fillThumb(b, Number(b.dataset.at), mine);
      }
    }

    // Shown before the picture is asked for, and that order matters: the size to
    // ask for is measured off the figure, and a hidden element is 0 px wide.
    card.hidden = false;
    showChosen();
  }

  closeBtn.addEventListener('click', () => {
    hide();
    onClose?.();
  });

  // Handing over to the app. The card stays exactly as it is behind the player,
  // because dismissing the player should put you back where you were rather than
  // somewhere you have to find again.
  //
  // `busy` does two jobs and both were learned the hard way. A video that has
  // been offloaded to iCloud takes as long as its download takes, and until it
  // arrives the button looked like it had ignored the tap — so it spins. And a
  // second tap while the first is still fetching presented a *second* player on
  // top of the first, which then had to be dismissed twice.
  playBtn.addEventListener('click', async () => {
    // The button sits in the middle of the picture, which is also the middle of
    // the swipe. Dragging across it has to be a swipe rather than a press, or a
    // group of videos is a group you cannot swipe through.
    if (swallowTap) {
      swallowTap = false;
      return;
    }
    const item = items[chosen];
    if (!item || busy) return;
    busy = true;
    playBtn.classList.add('fetching');
    try {
      const reply = await playVideo(item.i, groupIndices());
      if (!reply.ok) {
        noteEl.textContent = trouble(reply.error);
        return;
      }
      await settle();
    } finally {
      busy = false;
      playBtn.classList.remove('fetching');
    }
  });

  // --- The swipe ----------------------------------------------------------------
  //
  // Pointer events rather than touch events, so this is one gesture on a phone,
  // a trackpad and a mouse instead of three implementations of it. The figure
  // captures the pointer once the gesture is plainly sideways, which is what
  // keeps a swipe that runs off the edge of the card from being dropped
  // half-way — and, on a desktop, what stops the drag turning into a text
  // selection of everything under it.

  figure.addEventListener('pointerdown', (e) => {
    // Cleared here rather than only where it is read, so it cannot outlive the
    // gesture that set it: a drag the system cancels produces no click, and a
    // flag left standing would swallow whatever tap came next instead.
    swallowTap = false;
    // A secondary button is a context menu, and `busy` means the app is already
    // fetching something for this card — a swipe would be asking it for a
    // second picture while it is presenting the first.
    if (items.length < 2 || busy || e.button > 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, dx: 0, own: false };
  });

  figure.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.own) {
      // Claimed once, and only when the movement is plainly sideways. The
      // alternative — claim on any movement — steals the vertical drag that
      // dismisses the card and makes the picture impossible to press.
      if (Math.abs(dx) < SWIPE_CLAIM || Math.abs(dx) <= Math.abs(dy)) return;
      drag.own = true;
      swallowTap = true;
      figure.setPointerCapture?.(drag.id);
      figure.classList.add('dragging');
    }
    drag.dx = dx;
    // Resisted rather than refused at the ends of the group: a first photograph
    // that will not move at all is indistinguishable from a card that has
    // stopped responding, and a quarter of the movement says "there is nothing
    // that way" in the language the gesture is already speaking.
    const stuck = (chosen === 0 && dx > 0) || (chosen === items.length - 1 && dx < 0);
    setSwipe(stuck ? dx / 4 : dx);
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx, own, at } = drag;
    drag = null;
    if (!own) return;
    figure.classList.remove('dragging');
    // Released before the movement is undone, or the picture springs back from
    // wherever the capture happened to end rather than from where it is.
    figure.releasePointerCapture?.(e.pointerId);
    setSwipe(0);
    // Milliseconds, floored at one: two events in the same frame would divide
    // by zero and make every twitch a flick.
    const speed = Math.abs(dx) / Math.max(1, e.timeStamp - at);
    if (Math.abs(dx) < SWIPE_COMMIT && speed < SWIPE_FLICK) return;
    // Pulling the picture left brings the next one in from the right, which is
    // the direction every strip of photographs on this device runs.
    select(chosen + (dx < 0 ? 1 : -1));
  };

  figure.addEventListener('pointerup', endDrag);
  // A pointer the system takes away — a phone that decides the gesture was a
  // scroll, a mouse that leaves the window — has to put the picture back, or it
  // stays where the finger left it for ever.
  figure.addEventListener('pointercancel', endDrag);

  // --- The trackpad ---------------------------------------------------------------
  //
  // On the **picture**, and only on the picture. The strip below it is a
  // scroller and swiping it is how you get along a group of four thousand
  // without pressing four thousand times — taking that gesture and turning it
  // into one photograph at a time makes the strip useless for the one thing it
  // is better at than the picture is.
  //
  // So the two halves of the card answer a sideways swipe differently, and that
  // is the point rather than an inconsistency: over the picture it means *the
  // next one*, and over the strip it means *along*. See the note by
  // `WHEEL_STEP`.

  // When the last wheel event arrived, how far this gesture has travelled,
  // whether it has already been spent on a photograph, and whether the stream
  // has gone quiet since — which is what tells coasting from a fresh push.
  let wheelAt = 0;
  let wheelSum = 0;
  let wheelSpent = false;
  let wheelLulled = false;

  figure.addEventListener('wheel', (e) => {
    if (card.hidden || items.length < 2 || busy) return;
    // Sideways only, and only when it is plainly sideways. A two-finger scroll
    // down a trackpad drifts left and right by a few pixels the whole way, and a
    // card that changes picture because of that is unusable.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    // Ours from here, spent or not. The tail of a flick has to be swallowed as
    // well as the flick, or a swipe the picture has already answered goes on to
    // scroll the strip underneath it — one gesture, two answers.
    e.preventDefault();
    const speed = Math.abs(e.deltaX);
    if (e.timeStamp - wheelAt > WHEEL_GAP_MS) {
      // Silence: whatever comes next is a new swipe, wherever it starts from.
      wheelSum = 0;
      wheelSpent = false;
    } else if (wheelSpent && wheelLulled && speed > WHEEL_WAKE) {
      // Or it wound down and then picked up, which coasting cannot do — see the
      // note by WHEEL_LULL.
      wheelSum = 0;
      wheelSpent = false;
    }
    wheelAt = e.timeStamp;
    if (wheelSpent) {
      // Only while spent, so the acceleration of the swipe *being* answered
      // cannot arm the thing that ends it.
      if (speed <= WHEEL_LULL) wheelLulled = true;
      return;
    }
    wheelSum += e.deltaX;
    if (Math.abs(wheelSum) < WHEEL_STEP) return;
    wheelSpent = true;
    wheelLulled = false;
    // Pushing the content left brings in what is to the right of it, which is
    // the next one — the same direction the finger drag above runs, and the same
    // one the Mac app's own gallery runs.
    select(chosen + (wheelSum > 0 ? 1 : -1));
  }, { passive: false });

  // The same movement without a finger.
  //
  // **In the capture phase, on the window**, which is the whole of the fix for
  // arrows that stepped the photograph *and* panned the map underneath it.
  // MapLibre listens on the map's own container, and the container is where the
  // keyboard focus is after the tap that opened this card — so by the time a
  // listener on the document heard the key, the map had already moved and
  // `preventDefault` was a sentence too late. Capturing at the window is the
  // one place that runs before the container does, and the propagation is
  // stopped rather than merely defaulted, so nothing below is asked at all.
  //
  // All four arrows, not the two that mean something here. Up and down have no
  // photograph to move to and panning the map out from under an open card is
  // not what they should do instead: while this is up, the arrows are the
  // card's.
  window.addEventListener('keydown', (e) => {
    if (card.hidden || busy) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Not while somebody is typing into something — the search field, a route's
    // name — even though neither is open at the same time as this today.
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (items.length < 2) return;
    if (e.key === 'ArrowRight') select(chosen + 1);
    else if (e.key === 'ArrowLeft') select(chosen - 1);
  }, true);

  // The picture itself, full size, in the app's own viewer — the same bargain as
  // the video: shown natively rather than sent, so what you get is the original
  // rather than the card-sized copy the card is already showing you.
  //
  // Videos go through here too now, and did not before. The viewer they used to
  // reach was one photograph, so a video had nothing to open and only the play
  // button meant anything; it is a gallery now, and a tap on the poster frame
  // beside the button means what it means everywhere else — open this, here, in
  // the rest of them.
  figure.addEventListener('click', async (e) => {
    // A drag that moved the picture is not also a tap on it, however much the
    // browser insists on dispatching one.
    if (swallowTap) {
      swallowTap = false;
      return;
    }
    // The play button is inside the figure and has its own job.
    if (e.target.closest('.photo-play')) return;
    const item = items[chosen];
    if (!item || busy || !imgEl.src) return;
    busy = true;
    figure.classList.add('fetching');
    try {
      const reply = await viewPhoto(item.i, groupIndices());
      if (!reply.ok) {
        noteEl.textContent = trouble(reply.error);
        return;
      }
      await settle();
    } finally {
      busy = false;
      figure.classList.remove('fetching');
    }
  });

  return { show, hide, visible: () => !card.hidden };
}
