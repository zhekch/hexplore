// The little line that says what just happened.
//
// It exists for Undo. Ctrl-Z on a map is not like Ctrl-Z in a document: what
// changed may be off screen, under the cursor, or a cell so small you can't see
// it move — so an undo that says nothing looks exactly like an undo that did
// nothing, and the natural response is to press it again. Saying *what* was
// undone is the whole feature.
//
// One slot, not a stack: holding Ctrl-Z down should read as one message
// counting backwards, not as twelve notifications piling up. Each new message
// replaces the last and restarts its clock.

const SHOW_MS = 2600;

let el = null;
let hideTimer = null;
let clearTimer = null;

function element() {
  if (el) return el;
  el = document.getElementById('toast');
  return el;
}

/**
 * Say something, briefly.
 *
 * @param {string} text the message — past tense, and specific: "Undid clearing 12 cells"
 * @param {{tone?: 'plain'|'quiet'}} [opts] `quiet` is for "there was nothing to undo",
 *   which is an answer rather than an event and shouldn't shout.
 */
export function showToast(text, { tone = 'plain' } = {}) {
  const node = element();
  if (!node) return;
  clearTimeout(hideTimer);
  clearTimeout(clearTimer);
  node.textContent = text;
  node.classList.toggle('toast-quiet', tone === 'quiet');
  node.hidden = false;
  // Two frames: the element has to be laid out as hidden-then-shown for the
  // transition to run at all, and a message replacing another must not restart
  // the slide — only the fade of the text it already carries.
  requestAnimationFrame(() => {
    node.classList.add('toast-in');
  });
  hideTimer = setTimeout(() => {
    node.classList.remove('toast-in');
    // Kept in the DOM until the fade finishes, or the text vanishes mid-fade.
    clearTimer = setTimeout(() => {
      node.hidden = true;
      node.textContent = '';
    }, 220);
  }, SHOW_MS);
}

/** Take it away now — used when something bigger takes over the screen. */
export function hideToast() {
  const node = element();
  if (!node) return;
  clearTimeout(hideTimer);
  clearTimeout(clearTimer);
  node.classList.remove('toast-in');
  node.hidden = true;
  node.textContent = '';
}
