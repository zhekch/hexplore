// A sliding-window counter, for the endpoints where guessing is the attack.
//
// /api/login had nothing in front of it: the July 2026 review put eight wrong
// passwords through it in two seconds and every one was answered at full speed.
// scryptSync makes each guess cost CPU, which slows an attacker down but is
// also the reason unlimited guessing is a problem — it's the same cost to the
// Pi, so the guessing doubles as a way to tie up the event loop.
//
// Deliberately in-memory: this is one process on one machine, and a counter
// that survives a restart is worth less here than one that costs no
// dependency. A restart clears the windows; an attacker who can restart the
// server has already won.
//
// Windows are kept per key and swept lazily — a Map that only ever grew would
// be its own denial of service.

/**
 * @param {{windowMs: number, max: number}} opts
 * @returns {{take(key: string): {ok: boolean, retryAfter: number}, reset(key: string): void}}
 */
export function makeLimiter({ windowMs, max }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    // Only worth doing occasionally; every call would make the common case O(n).
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length) hits.set(key, live);
      else hits.delete(key);
    }
  }

  return {
    /** Count one attempt against `key`. */
    take(key) {
      const now = Date.now();
      sweep(now);
      const times = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (times.length >= max) {
        const retryAfter = Math.ceil((windowMs - (now - times[0])) / 1000);
        hits.set(key, times);
        return { ok: false, retryAfter: Math.max(1, retryAfter) };
      }
      times.push(now);
      hits.set(key, times);
      return { ok: true, retryAfter: 0 };
    },
    /** Forget a key — called after a successful sign-in. */
    reset(key) {
      hits.delete(key);
    },
  };
}

/**
 * Who is asking. Behind the Cloudflare tunnel every connection arrives from
 * localhost, so the socket address alone would put the whole internet in one
 * bucket; CF-Connecting-IP is the real client and cloudflared is the only thing
 * that can set it. Falling back to the socket keeps this honest when the server
 * is reached directly.
 */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
