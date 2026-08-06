// Undo and redo for things you did to the map.
//
// An action records how to take itself back and how to do itself again, and
// says — in words, past tense — what it was: "clearing 12 cells", "deleting
// “Thunersee loop”". That phrase is what the toast shows, which is why it lives
// with the action rather than being worked out afterwards from a diff.
//
// Both directions go through the server. Undoing a clear is not "re-add these
// ids" but "put these rows back", dates and sources and all (see
// POST /api/cells/restore) — a cell that comes back as a bare manual mark has
// lost the very thing the map is for.
//
// The stack is in memory and belongs to this page and this account: signing out
// or reloading starts again with nothing to undo. That's deliberate. A stack
// that outlived the page would be offering to undo an edit against a map that
// may have been changed on your phone since, and "undo" has to mean the thing
// it says.

/** How far back it goes. A sweep of paint is one entry, so this is a lot of map. */
const LIMIT = 80;

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onChange] called whenever the stacks change
 */
export function createHistory({ onChange = () => {} } = {}) {
  /** @type {Array<{label:string, undo:Function, redo:Function}>} */
  const past = [];
  /** @type {Array<{label:string, undo:Function, redo:Function}>} */
  const future = [];
  let busy = false;

  /**
   * Record something that has *already* happened.
   *
   * @param {string} label what it was, as a phrase: "clearing 12 cells"
   * @param {() => any} undo puts the world back
   * @param {() => any} redo does it again
   */
  function push(label, undo, redo) {
    past.push({ label, undo, redo });
    // Doing something new is what makes the redo branch unreachable — this is
    // the moment it stops being a possible future.
    future.length = 0;
    if (past.length > LIMIT) past.shift();
    onChange();
  }

  // Undo and redo are the same shape in opposite directions: take the top of
  // one stack, run the right half of it, and hand it to the other. If it throws
  // (the server is unreachable, most likely) it goes back where it was —
  // dropping it would leave the map changed with no way back.
  async function step(from, to, run) {
    if (busy || !from.length) return null;
    busy = true;
    const entry = from.pop();
    try {
      await run(entry);
      to.push(entry);
      return entry.label;
    } catch (e) {
      from.push(entry);
      throw e;
    } finally {
      busy = false;
      onChange();
    }
  }

  return {
    push,
    undo: () => step(past, future, (e) => e.undo()),
    redo: () => step(future, past, (e) => e.redo()),
    canUndo: () => !busy && past.length > 0,
    canRedo: () => !busy && future.length > 0,
    /** What the next undo would take back, for a menu label or a tooltip. */
    nextUndo: () => past[past.length - 1]?.label ?? '',
    nextRedo: () => future[future.length - 1]?.label ?? '',
    clear() {
      past.length = 0;
      future.length = 0;
      onChange();
    },
    depth: () => ({ undo: past.length, redo: future.length }),
  };
}

/** "1 cell" / "12 cells" — the phrases in labels are counted often enough to share. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
