// Which copy of the account's preferences wins on load.
//
// Preferences live in two places at once: localStorage, so a colour applies the
// instant you pick it and survives being offline, and the account, so the phone
// and the laptop agree. That means every load has to decide between them, and
// the obvious rule — "the server is the source of truth" — is wrong here. It
// silently threw away any change whose push had not landed: a tab closed inside
// the debounce, a request that failed with nothing retrying it. The colour
// looked right, then vanished at the next reload, and nothing said a save had
// failed.
//
// So each copy carries when it was last touched and the newer one wins. This is
// the whole decision, kept separate from the DOM so it can be tested: main.js
// supplies the state and carries out the verdict.

/**
 * @param {object}  state
 * @param {number}  state.localStamp  epoch ms this browser last changed something (0 = never)
 * @param {boolean} state.dirty       a local change the server has not acknowledged
 * @param {object|null} state.remote  the account's stored blob, or null/{} if it has none
 * @returns {'adopt'|'push'|'idle'}
 *   adopt — take the account's copy;
 *   push  — this browser's copy is newer (or the account has none): send it;
 *   idle  — nothing to do.
 */
export function reconcilePrefs({ localStamp = 0, dirty = false, remote } = {}) {
  const hasRemote = !!remote && typeof remote === 'object' && Object.keys(remote).length > 0;
  const remoteStamp = Number(remote?.updatedAt) || 0;

  // Ties go to the account. That is what lets a browser which has never saved
  // anything (stamp 0) pick up the colours — including a copy saved before
  // preferences carried a stamp at all, which reads back as 0.
  if (hasRemote && remoteStamp >= localStamp) return 'adopt';

  // Ours is newer, or the account has nothing yet. This is the branch that
  // recovers a push that never landed: the local stamp outlives the failure, so
  // the next load notices and sends it again.
  if (dirty || localStamp > 0) return 'push';

  return 'idle';
}
