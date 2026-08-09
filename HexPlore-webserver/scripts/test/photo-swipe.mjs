// Swiping from one photograph to the next.
//
//   node scripts/test/photo-swipe.mjs
//
// A gesture is arithmetic wearing a coat. All of the things that make this one
// feel right or wrong — how far is far enough, how fast counts as a flick, when
// a drag stops being a tap, what happens at the two ends of a group — are
// numbers compared against numbers, and every one of them is invisible in the
// code review that breaks it.
//
// So the card is mounted against a stand-in DOM and the events are fired by
// hand. That is not a compromise for want of a browser: what a browser would add
// here is layout, and there is no layout in "a 60px pull with the finger moving
// slowly is the next photograph". What a browser would *not* add is the ability
// to fail these on purpose, which is how you find out a test is testing
// something.
//
// The bugs pinned here all happened:
//
//   - a swipe that also opened the photograph it had just swiped away from, full
//     screen, because a drag ending where it began dispatches a click;
//   - a swipe past the last photograph in a group that carried on and asked for
//     item -1;
//   - a swipe onto a picture four hundred along, whose thumbnail had no button
//     yet because the strip renders in chunks, leaving nothing outlined.

import { STRIP_CHUNK } from '../../src/photos.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// --- A DOM, in as much as this needs one -------------------------------------------
//
// Deliberately not a DOM implementation. It is a bag of properties with a
// working `classList`, a `querySelector` that understands the one selector the
// card actually writes, and event handling that is dispatch-to-a-list. Anything
// the card reaches for that is not here is a mistake worth a crash rather than a
// silent `undefined`.

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.classes = new Set();
    this.handlers = new Map();
    this.hidden = false;
    this.textContent = '';
    this.attributes = new Map();
    this.props = new Map();
    this.style = {
      setProperty: (name, value) => this.props.set(name, value),
      getPropertyValue: (name) => this.props.get(name) ?? '',
    };
    // The card reads and writes `clientWidth` to decide what size picture to
    // ask for. A number, because zero means "ask for the fallback".
    this.clientWidth = 320;
    this.captured = null;
    this.scrolledIntoView = 0;
    this.animations = [];
    this.parent = null;
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    return {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      contains: (n) => this.classes.has(n),
    };
  }

  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = undefined;
  }

  replaceChildren(...next) {
    this.children = next;
    for (const c of next) c.parent = this;
  }

  insertBefore(node, before) {
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parent = this;
    return node;
  }

  /**
   * Self or nearest ancestor matching a single class selector.
   *
   * The chain matters rather than just the element: a real click on the play
   * button lands on the `<svg>` inside it, and the card's whole reason for
   * asking is to recognise that as the button.
   */
  closest(selector) {
    const wanted = selector.replace('.', '');
    for (let node = this; node; node = node.parent) {
      if (node.classes?.has(wanted)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const wanted = selector.match(/\.photo-thumb/) ? 'photo-thumb' : null;
    return this.children.filter((c) => wanted && c.classes.has(wanted));
  }

  /** Only ever asked `.photo-thumb[data-at="N"]`, which is the whole grammar. */
  querySelector(selector) {
    const at = selector.match(/data-at="(\d+)"/)?.[1];
    return this.children.find((c) => c.classes.has('photo-thumb') && c.dataset.at === at) ?? null;
  }

  setPointerCapture(id) {
    this.captured = id;
  }

  releasePointerCapture() {
    this.captured = null;
  }

  scrollIntoView() {
    this.scrolledIntoView++;
  }

  animate(frames, options) {
    this.animations.push({ frames, options });
    return { finished: Promise.resolve() };
  }

  /** Fire everything registered for `type`, in order, as the browser would. */
  fire(type, event = {}) {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn({ type, ...event });
  }

  listens(type) {
    return (this.handlers.get(type) ?? []).length;
  }
}

const ids = [
  'photo-info', 'photo-info-title', 'photo-info-when', 'photo-info-close',
  'photo-info-figure', 'photo-info-img', 'photo-info-note', 'photo-info-strip',
  'photo-info-more', 'photo-info-play',
];

const dom = new Map(ids.map((id) => [id, new FakeElement()]));
const documentHandlers = new Map();

globalThis.HTMLElement = FakeElement;
globalThis.devicePixelRatio = 2;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.document = {
  getElementById: (id) => dom.get(id) ?? null,
  createElement: (tag) => new FakeElement(tag),
  addEventListener: (type, fn) => {
    if (!documentHandlers.has(type)) documentHandlers.set(type, []);
    documentHandlers.get(type).push(fn);
  },
};
const fireDocument = (type, event) => {
  for (const fn of [...(documentHandlers.get(type) ?? [])]) fn({ type, preventDefault() {}, ...event });
};

// The other side of the bridge. Every picture is the same one — what is under
// test is which index gets asked for, not what comes back.
const asked = [];
globalThis.webkit = {
  messageHandlers: {
    hexplorePhotos: {
      postMessage: async (body) => {
        asked.push(body);
        if (body.ask === 'photo') {
          return { ok: true, src: `data:,${body.i}`, w: 400, h: 300 };
        }
        return { ok: true };
      },
    },
  },
};

// Imported *after* the globals exist: `mountPhotoInfo` reads `document` when it
// is called rather than when it is loaded, but `src/photos.js` is entitled to
// look at `globalThis` on the way in and this costs nothing to get right.
const { mountPhotoInfo } = await import('../../src/photo-info.js');

const figure = dom.get('photo-info-figure');
const strip = dom.get('photo-info-strip');
const img = dom.get('photo-info-img');
const play = dom.get('photo-info-play');

const card = mountPhotoInfo({});

/** A group of `n`, newest first, the way `photoLeaves` hands them over. */
const group = (n, video = false) =>
  Array.from({ length: n }, (_, k) => ({ i: k, t: 1_700_000_000 - k * 3600, v: video }));

/** Which picture the card is showing, read off what it last asked the app for. */
const showing = () => {
  const last = [...asked].reverse().find((a) => a.ask === 'photo');
  return last ? last.i : null;
};

/** Let the card's own awaits settle — every reply above is already resolved. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * And the longer wait, after a hand-off to the app.
 *
 * The card holds itself busy for half a second after the app says yes, because
 * the app answers at the moment it *presents* a viewer and a presentation is an
 * animation — see `SETTLE_MS` in src/photo-info.js. Nothing is meant to happen
 * during it, which includes everything below.
 */
const rest = () => new Promise((r) => setTimeout(r, 560));

/**
 * One swipe: down, a move, and up.
 *
 * `ms` is how long the gesture took, which is the other half of whether it
 * counts — the card commits on distance *or* speed.
 */
function swipe(dx, { ms = 400, id = 1, dy = 0 } = {}) {
  figure.fire('pointerdown', { pointerId: id, button: 0, clientX: 0, clientY: 0, timeStamp: 0 });
  // Two moves, because the first is what claims the gesture and the second is
  // what the picture follows — one move would pass a test the card fails.
  figure.fire('pointermove', {
    pointerId: id, clientX: dx / 2, clientY: dy / 2, timeStamp: ms / 2,
  });
  figure.fire('pointermove', { pointerId: id, clientX: dx, clientY: dy, timeStamp: ms });
  figure.fire('pointerup', { pointerId: id, clientX: dx, clientY: dy, timeStamp: ms });
}

console.log('\nThe card is wired for a gesture at all');
{
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    check(figure.listens(type) === 1, `the figure listens for ${type}`);
  }
  check((documentHandlers.get('keydown') ?? []).length === 1,
    'and the arrow keys are the same movement without a finger');
}

console.log('\nA pull far enough is the next photograph');
{
  card.show(group(5));
  await settle();
  check(showing() === 0, 'it opens on the newest of them', String(showing()));

  swipe(-120);
  await settle();
  check(showing() === 1, 'pulling left brings in the one after it', String(showing()));

  swipe(120);
  await settle();
  check(showing() === 0, 'and pulling right puts it back', String(showing()));
}

console.log('\nA pull that is not far enough is not');
{
  card.show(group(5));
  await settle();
  swipe(-40);
  await settle();
  check(showing() === 0, 'a short slow drag springs back', String(showing()));
  check(figure.style.getPropertyValue('--photo-swipe') === '0px',
    'and the picture is put back where it was',
    figure.style.getPropertyValue('--photo-swipe'));

  // The same distance thrown rather than dragged. Either will do, or the
  // gesture feels like it is arguing with you.
  swipe(-40, { ms: 40 });
  await settle();
  check(showing() === 1, 'the same distance flicked is the next one', String(showing()));
}

console.log('\nSideways is a swipe and downwards is not');
{
  card.show(group(5));
  await settle();
  // Mostly vertical: the card is dismissed by dragging it, and a picture that
  // steals every downward movement is a card you cannot get rid of.
  swipe(-90, { dy: 200 });
  await settle();
  check(showing() === 0, 'a drag that is mostly downwards is left alone', String(showing()));
  check(figure.captured === null, 'and the pointer is never claimed');
}

console.log('\nThe ends of a group are ends');
{
  card.show(group(3));
  await settle();
  swipe(120);
  await settle();
  check(showing() === 0, 'there is nothing before the first one', String(showing()));
  // Resisted rather than refused: a picture that does not move at all is
  // indistinguishable from a card that has stopped responding.
  figure.fire('pointerdown', { pointerId: 9, button: 0, clientX: 0, clientY: 0, timeStamp: 0 });
  figure.fire('pointermove', { pointerId: 9, clientX: 40, clientY: 0, timeStamp: 30 });
  figure.fire('pointermove', { pointerId: 9, clientX: 80, clientY: 0, timeStamp: 60 });
  const pulled = parseFloat(figure.style.getPropertyValue('--photo-swipe'));
  check(pulled > 0 && pulled < 80, 'but it still moves, by less than the finger did', String(pulled));
  figure.fire('pointerup', { pointerId: 9, clientX: 80, clientY: 0, timeStamp: 60 });

  swipe(-200);
  swipe(-200);
  await settle();
  check(showing() === 2, 'and nothing after the last', String(showing()));
}

console.log('\nA swipe is not also a tap');
{
  card.show(group(4));
  await settle();
  const before = asked.filter((a) => a.ask === 'view').length;
  swipe(-120);
  // The click a browser dispatches anyway, because the pointer went down and up
  // on the same element. This is the whole of the bug: swiping to the next
  // photograph also opened the previous one full screen.
  figure.fire('click', { target: img });
  await settle();
  check(asked.filter((a) => a.ask === 'view').length === before,
    'the click a drag leaves behind opens nothing');

  // And a real tap still works, immediately afterwards.
  figure.fire('pointerdown', { pointerId: 4, button: 0, clientX: 0, clientY: 0, timeStamp: 0 });
  figure.fire('pointerup', { pointerId: 4, clientX: 0, clientY: 0, timeStamp: 10 });
  figure.fire('click', { target: img });
  await settle();
  check(asked.filter((a) => a.ask === 'view').length === before + 1,
    'and the next tap is a tap again');
  await rest();
}

console.log('\nThe play button is in the middle of the swipe, and survives it');
{
  card.show(group(4, true));
  await settle();
  const before = asked.filter((a) => a.ask === 'play').length;
  swipe(-120);
  // The button is centred on the picture, so a swipe across a video crosses it.
  play.fire('click', { target: play });
  await settle();
  check(asked.filter((a) => a.ask === 'play').length === before,
    'swiping across it does not press it');
  play.fire('click', { target: play });
  await settle();
  check(asked.filter((a) => a.ask === 'play').length === before + 1,
    'and pressing it still does');
  await rest();
}

console.log('\nThe strip keeps up, however long it is');
{
  // Longer than one chunk, so the thumbnail wanted has no button yet — the
  // strip renders `STRIP_CHUNK` at a time and a swipe can outrun it.
  const big = STRIP_CHUNK * 3;
  card.show(group(big));
  await settle();
  check(strip.querySelectorAll('.photo-thumb').length === STRIP_CHUNK,
    'it starts with one chunk of thumbnails',
    String(strip.querySelectorAll('.photo-thumb').length));

  // Arrow keys, which is the same `select` a swipe reaches — and the cheapest
  // way to walk a long way along the group.
  for (let n = 0; n < STRIP_CHUNK + 5; n++) fireDocument('keydown', { key: 'ArrowRight' });
  await settle();
  check(showing() === STRIP_CHUNK + 5, 'walking past the end of a chunk still shows a picture',
    String(showing()));
  const chosen = strip.querySelectorAll('.photo-thumb').filter((b) => b.classes.has('chosen'));
  check(chosen.length === 1 && chosen[0].dataset.at === String(STRIP_CHUNK + 5),
    'exactly one thumbnail is outlined, and it is that one',
    chosen.map((c) => c.dataset.at).join(','));
  check(chosen[0].scrolledIntoView > 0, 'and the strip has been scrolled to it');
}

console.log('\nThe arrow keys stop at the same places the finger does');
{
  card.show(group(2));
  await settle();
  fireDocument('keydown', { key: 'ArrowLeft' });
  await settle();
  check(showing() === 0, 'nothing before the first', String(showing()));
  fireDocument('keydown', { key: 'ArrowRight' });
  fireDocument('keydown', { key: 'ArrowRight' });
  await settle();
  check(showing() === 1, 'nothing after the last', String(showing()));

  // A modifier is somebody else's shortcut — back and forward, in every browser.
  const at = showing();
  fireDocument('keydown', { key: 'ArrowLeft', metaKey: true });
  await settle();
  check(showing() === at, 'and a modified arrow belongs to the browser', String(showing()));

  card.hide();
  fireDocument('keydown', { key: 'ArrowLeft' });
  await settle();
  check(showing() === at, 'a closed card does not hold the arrow keys', String(showing()));
}

console.log('\nA single photograph has nothing to swipe to');
{
  asked.length = 0;
  card.show(group(1));
  await settle();
  swipe(-200);
  await settle();
  check(asked.filter((a) => a.ask === 'photo').length === 1,
    'one photograph is asked for once, however much it is pulled',
    String(asked.filter((a) => a.ask === 'photo').length));
  check(figure.captured === null, 'and the gesture is never claimed');
}

console.log('\nThe new one arrives from the side it was called from');
{
  card.show(group(4));
  await settle();
  img.animations.length = 0;
  swipe(-120);
  await settle();
  const from = (a) => a?.frames?.[0]?.transform ?? '';
  check(img.animations.length === 1, 'an arriving picture is animated in, once',
    String(img.animations.length));
  check(/^translateX\(\d+px\)$/.test(from(img.animations[0])),
    'starting to the right of centre, because it came from the right',
    from(img.animations[0]));
  check(img.animations[0]?.frames?.[0]?.opacity === 0, 'and fades up rather than cutting in');

  img.animations.length = 0;
  swipe(120);
  await settle();
  check(/^translateX\(-\d+px\)$/.test(from(img.animations[0])),
    'and to the left of it coming back', from(img.animations[0]));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
