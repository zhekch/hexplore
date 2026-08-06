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

import { formatTime } from './clock.js';
import { GROUP_MAX, canOpenPhotos, openPhotosApp, photoImage } from './photos.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);

// How big a picture to ask for, in CSS pixels of the card's own width — the
// bridge multiplies nothing and returns what it is asked for, so the device
// pixel ratio is applied here or the photograph is soft on every phone made
// since 2012.
const THUMB_PX = 120;

/** "12 photos", or the one thing it is. */
export function groupTitle(items) {
  return items.length === 1 ? 'Photo' : `${items.length.toLocaleString()} photos`;
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
  const openBtn = $('photo-info-open');

  let items = [];
  let chosen = 0;
  // "showing 48", for a group bigger than the strip. Kept apart from the line it
  // is appended to, because that line is rewritten every time you pick another
  // photograph and the caveat is still true afterwards.
  let capNote = '';
  // Which showing this is. The strip checks it on the far side of every await:
  // a card reopened on another point while thumbnails were arriving must not go
  // on being filled by the group that was on its way to the last one.
  let showing = 0;
  // And which *picture* is wanted, which is not the same question — picking a
  // second thumbnail while the first is still in flight happens inside one
  // showing, and without this the slower of the two wins whichever it was.
  let picking = 0;

  function hide() {
    card.hidden = true;
    // Bumped rather than left: whatever was in flight has nowhere to land now,
    // and a strip that goes on filling itself behind a closed card is a phone
    // decoding fifty JPEGs for nobody.
    showing++;
    picking++;
    items = [];
    imgEl.removeAttribute('src');
    stripEl.replaceChildren();
    stripEl.hidden = true;
  }

  /** The big one. */
  async function showChosen() {
    const mine = ++picking;
    const item = items[chosen];
    if (!item) return;
    noteEl.textContent = '';
    figure.classList.add('loading');
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
  }

  /**
   * The strip, filled one at a time.
   *
   * Sequential on purpose. Fifty parallel requests would each decode a JPEG on
   * the phone's main thread and arrive in a heap; in order, the ones you can see
   * arrive first, and closing the card stops the rest.
   */
  async function fillStrip(mine, buttons) {
    const px = Math.round(THUMB_PX * (globalThis.devicePixelRatio || 1));
    for (const [at, button] of buttons.entries()) {
      const reply = await photoImage(items[at].i, px);
      if (mine !== showing) return;
      if (!reply.ok) {
        button.classList.add('missing');
        continue;
      }
      const img = document.createElement('img');
      img.src = reply.src;
      img.alt = '';
      button.replaceChildren(img);
    }
  }

  const setWhen = (text) => {
    whenEl.textContent = capNote ? `${text} · ${capNote}` : text;
  };

  /**
   * Pick one out of the strip.
   *
   * The sub-line follows what you are looking at rather than staying on the
   * group's span: once you have chosen a picture, when *it* was taken is the
   * question, and the span is what the strip is showing you.
   */
  function choose(at) {
    if (at === chosen) return;
    chosen = at;
    for (const [n, b] of [...stripEl.children].entries()) b.classList.toggle('chosen', n === chosen);
    setWhen(groupWhen([items[chosen]]));
    showChosen();
  }

  function show(all) {
    // Capped rather than paged: past four dozen this stops being a glance at
    // what is here, and the way through to the whole lot is the Photos app.
    items = all.slice(0, GROUP_MAX);
    chosen = 0;
    const mine = ++showing;

    titleEl.textContent = groupTitle(all);
    // Said only when there is something the count does not cover: a group of
    // sixty says which forty-eight of them you are looking at.
    capNote = all.length > items.length ? `showing ${items.length}` : '';
    // The whole span on opening, from every photograph in the group and not just
    // the ones the strip kept.
    setWhen(groupWhen(all));
    noteEl.textContent = '';
    openBtn.hidden = !canOpenPhotos();

    stripEl.replaceChildren();
    stripEl.hidden = items.length < 2;
    if (items.length > 1) {
      const buttons = items.map((item, at) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = at === 0 ? 'photo-thumb chosen' : 'photo-thumb';
        b.title = groupWhen([item]);
        b.addEventListener('click', () => choose(at));
        stripEl.append(b);
        return b;
      });
      fillStrip(mine, buttons);
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

  openBtn.addEventListener('click', async () => {
    const reply = await openPhotosApp();
    if (!reply.ok) noteEl.textContent = 'The Photos app could not be opened.';
  });

  return { show, hide, visible: () => !card.hidden };
}
