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

/**
 * The Mapbox token the account holds, or null if the account has no opinion.
 *
 * Presence of the key is the whole signal, and it has to be, because `''` is a
 * real answer: it is what emptying the box and pressing Done leaves behind, and
 * a device syncing afterwards has to hear *that* rather than go on drawing with
 * a token the person has taken off their account.
 *
 * An account whose preferences were written before the token was synced at all
 * has no key, and that must not read as an instruction to wipe the token off a
 * device that has one — on those devices the local copy is the only copy there
 * is, and it goes up on the next push instead.
 *
 * @param {object|null} prefs the account's stored blob
 * @returns {string|null}
 */
export function remoteToken(prefs) {
  return typeof prefs?.mapboxToken === 'string' ? prefs.mapboxToken.trim() : null;
}

/**
 * The MapTiler key the account holds, or null if the account has no opinion.
 *
 * Every word of the note above applies here — presence of the key is the whole
 * signal, `''` is a real answer, and an account written before this was synced
 * must not read as an instruction to wipe a device that has one.
 *
 * **And this one has a second reader.** The Mapbox token is synced so that a new
 * device does not have to be told it again; this is synced for that *and*
 * because the server reads it to fetch tiles at all — see `accountMaptilerKey`
 * in server/index.js. So a key that has been typed into a device and not yet
 * pushed is a key the map cannot use yet, which is why the settings dialog
 * pushes on save rather than waiting for the next sync.
 */
export function remoteMaptilerKey(prefs) {
  return typeof prefs?.maptilerKey === 'string' ? prefs.maptilerKey.trim() : null;
}
