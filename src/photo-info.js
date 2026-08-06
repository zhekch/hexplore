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
// every zoom there is. The strip along the bottom is the group, oldest first,
// and picking one swaps the picture above it.
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
import { STRIP_CHUNK, photoImage, playVideo } from './photos.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);

// How big a thumbnail to ask for, in CSS pixels of the square it goes in. The
// device pixel ratio is applied on top, or the strip is soft on every phone made
// since 2012.
const THUMB_PX = 120;

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
 */
export function groupWhen(items) {
  if (!items.length) return '';
  const first = items[0].t;
  const last = items[items.length - 1].t;
  if (items.length === 1) return [day(first), formatTime(first * 1000)].filter(Boolean).join(' · ');
  const a = day(first);
  const b = day(last);
  return a === b ? a : `${a} – ${b}`;
}

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
      return 'Hexplore has not been given access to your photos.';
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
  // The button currently outlined, held rather than searched for: a group can
  // have thousands and only one of them changes.
  let chosenBtn = null;

  const setWhen = (text) => {
    whenEl.textContent = text;
  };

  function hide() {
    card.hidden = true;
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
      b.addEventListener('click', () => choose(at, b));
      // Before the sentinel, which has to stay at the end for the next chunk.
      stripEl.insertBefore(b, sentinel);
      watcher?.observe(b);
    }
    // Nothing left to append: stop watching for the end of the strip, or the
    // observer goes on firing on a sentinel that can never load anything.
    if (rendered >= items.length) watcher?.unobserve(sentinel);
  }

  /**
   * Pick one out of the strip.
   *
   * The sub-line follows what you are looking at rather than staying on the
   * group's span: once you have chosen a picture, when *it* was taken is the
   * question, and the span is what the strip is showing you.
   */
  function choose(at, button) {
    if (at === chosen) return;
    chosen = at;
    chosenBtn?.classList.remove('chosen');
    chosenBtn = button;
    button.classList.add('chosen');
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
  playBtn.addEventListener('click', async () => {
    const item = items[chosen];
    if (!item) return;
    const reply = await playVideo(item.i);
    if (!reply.ok) noteEl.textContent = trouble(reply.error);
  });

  return { show, hide, visible: () => !card.hidden };
}
