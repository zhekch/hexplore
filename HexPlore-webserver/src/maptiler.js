// The MapTiler key: where it is kept, and what is known about it before it is
// used.
//
// The second thing in this app that is somebody's account with a third party,
// after the Mapbox token, and it is deliberately the same shape — stored here,
// synced onto the account by src/prefs.js, entered in a dialog that checks it
// before saving. Read the head of src/mapbox-ui.js for why the check is not
// decoration; every word of it is true here too.
//
// **One thing is not the same, and it is the important one.** A Mapbox token is
// handed to Mapbox GL JS and used *from the page*, because that library will not
// take a map any other way. This key is never given to the renderer and never
// leaves this origin: the tiles are fetched by this app's own server, which
// reads the key off the account. So the browser holds a copy in order to show it
// in a settings box and to know whether the provider can be offered at all —
// and MapTiler never sees the browser, the IP address, or which square of the
// world somebody is looking at. See server/maptiler-tiles.js.

const KEY_KEY = 'visited-map:maptiler-key:v1';

/** The viewer's MapTiler key, or '' if they have not given one. */
export function maptilerKey() {
  try {
    return localStorage.getItem(KEY_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Store it, or forget it when given nothing. Returns what is now stored. */
export function setMaptilerKey(key) {
  const clean = String(key ?? '').trim();
  try {
    if (clean) localStorage.setItem(KEY_KEY, clean);
    else localStorage.removeItem(KEY_KEY);
  } catch {
    /* a browser refusing localStorage still gets a map, just not this provider */
  }
  return clean;
}

/** Is there a key to try at all? */
export const hasMaptilerKey = () => !!maptilerKey();

/**
 * What is wrong with this key on the face of it, or null if nothing is.
 *
 * Every complaint here is about a *shape*, because that is all that can be known
 * without asking MapTiler. It exists to catch the mistake people actually make,
 * which is not typing a key wrong: it is pasting the wrong string entirely — a
 * whole tile URL copied out of the dashboard, a Mapbox token that happened to be
 * on the clipboard, or the account id printed next to the key.
 *
 * The messages name what was pasted rather than saying "invalid", because
 * "invalid key" in front of a box holding a perfectly good *URL* is the least
 * useful sentence a dialog can produce.
 */
export function keyComplaint(key) {
  const clean = String(key ?? '').trim();
  if (!clean) return 'Paste the key from your MapTiler account.';
  if (/^pk\.|^sk\./.test(clean)) return 'That looks like a Mapbox token — this box wants a MapTiler key.';
  if (/^https?:\/\//i.test(clean) || clean.includes('/')) {
    return 'That looks like a URL. Paste just the key — the part after "key=".';
  }
  if (clean.includes('key=')) return 'Paste just the key itself, without "key=".';
  if (!/^[A-Za-z0-9]+$/.test(clean)) return 'A MapTiler key is letters and digits only.';
  if (clean.length < 8) return 'That is too short to be a MapTiler key.';
  if (clean.length > 64) return 'That is too long to be a MapTiler key.';
  return null;
}

/**
 * Does MapTiler answer for this key?
 *
 * **Asked through this app's own server**, which is the one thing in this file
 * that would be simpler done directly and is not. Two reasons, and the second is
 * the one that matters: the server is where the key is going to be used from, so
 * this checks the path that will actually be taken — a key that works from a
 * browser and not from the server, because of a URL restriction on the account,
 * is exactly the failure this is for. And a direct check would hand MapTiler the
 * viewer's address a moment before the whole design stops doing that.
 *
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function checkMaptilerKey(key) {
  const complaint = keyComplaint(key);
  if (complaint) return { ok: false, why: complaint };
  try {
    const res = await fetch('/api/trails/mt/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ key: String(key).trim() }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.ok) return { ok: true };
      return { ok: false, why: whyFrom(body?.why, body?.status) };
    }
    if (res.status === 401) return { ok: false, why: 'Sign in again — the session has expired.' };
    return { ok: false, why: `This server answered ${res.status}.` };
  } catch {
    return { ok: false, why: 'Could not reach this server — check the connection.' };
  }
}

/**
 * Their refusal, as a sentence somebody can act on.
 *
 * A 403 from MapTiler is four different problems wearing the same number — a
 * wrong key, a revoked one, one restricted to other origins, and the free tier's
 * monthly quota spent — and this cannot tell them apart. So it says all four
 * rather than picking one, which is the honest version and also the one that
 * gets the person to the right page of their dashboard.
 */
function whyFrom(why, status) {
  if (why === 'rejected') {
    return 'MapTiler would not accept that key. It may be wrong or revoked, restricted to other addresses, or this month\'s free requests may be used up.';
  }
  if (why === 'unreachable') return 'Could not reach MapTiler — check the connection.';
  if (why === 'not-a-key') return 'A MapTiler key is letters and digits only.';
  return `MapTiler answered ${status ?? 'something unexpected'}.`;
}
