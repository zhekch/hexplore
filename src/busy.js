// The spinner at the top of the map.
//
// It exists for one thing: the detailed region boundaries, which arrive one
// country at a time and can take a second on a first look. Without it, a zoom
// that is about to sharpen looks like a zoom that isn't going to.
//
// Reference-counted, because several countries can be in flight at once — the
// ring goes when the last of them lands, not when the first does.

let el = null;
let textEl = null;
let count = 0;
let hideTimer = null;

function node() {
  if (!el) {
    el = document.getElementById('busy');
    textEl = document.getElementById('busy-text');
  }
  return el;
}

/**
 * Mark one thing as in flight. Returns the function that marks it done — call it
 * exactly once, in a `finally`, or the ring never goes away.
 *
 * @param {string} [label] what is loading, in a couple of words
 */
export function busy(label = 'Loading…') {
  const box = node();
  count++;
  if (box) {
    clearTimeout(hideTimer);
    if (textEl) textEl.textContent = label;
    box.hidden = false;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count = Math.max(0, count - 1);
    if (count === 0 && box) {
      // A beat of delay: two fetches back to back should read as one wait
      // rather than a ring that blinks off and on again.
      hideTimer = setTimeout(() => {
        if (count === 0) box.hidden = true;
      }, 180);
    }
  };
}
