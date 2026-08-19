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

/** The longest name a home is allowed to carry. */
const HOME_NAME_MAX = 80;

/**
 * Where a stored blob says home is, or null if it does not say.
 *
 * Here rather than inline in main.js because *two* places read it and they have
 * to read it the same way: the account's copy when a sync lands, and this
 * browser's own copy on the way up from localStorage. A home that survives one
 * of those and not the other is a home that resets on some loads and not
 * others, which is exactly the bug this pair exists to end.
 *
 * Every field is re-checked because both sources are outside the program — one
 * is the network, the other is a string a person could have edited.
 *
 * @param {object|null} value  `{ lng, lat, name }`, from anywhere
 * @returns {{lng:number, lat:number, name:string}|null}
 */
export function readHome(value) {
  const lng = Number(value?.lng);
  const lat = Number(value?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // A home outside the world is not a home. `wrapLng` is not used: this is a
  // stored answer rather than a computed one, and a longitude that has left the
  // planet is corrupt, not wound round.
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat, name: String(value?.name ?? '').slice(0, HOME_NAME_MAX) };
}
