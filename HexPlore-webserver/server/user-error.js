// Which failures may be repeated back to the account, and which may not.
//
// The sync and probe routes report why they failed, and that is most of what
// makes them usable: "Home Assistant rejected the access token." tells you to
// go and paste a new one, where "something went wrong" starts a guessing game.
// So every failure this server raises on purpose carries a sentence written to
// be read by the person who caused it.
//
// The problem is that a `catch` cannot tell those apart from the rest. A SQLite
// constraint violation, an ENOENT quoting the database's path on disk, a
// TypeError naming a field of an internal row — all of them are an Error with a
// `message` too, and `String(e.message ?? e)` handed every one of them to the
// browser. That is what CodeQL's js/stack-trace-exposure was pointing at, and
// the leak was wider than the three routes it could see: the same string was
// also written to `last_error`, which every later GET of the link hands back as
// `lastError`.
//
// So the intent is recorded where it exists — at the throw — rather than
// guessed at where it doesn't. A message reaches the browser only if it was
// written for one. Everything else becomes a flat sentence, and the real error
// goes to the console, which is where a detail like that belongs.

/**
 * An error whose `message` was written for the account to read, and is
 * therefore safe to send back.
 *
 * Everything in home-assistant.js, strava.js and net-guard.js throws this:
 * those modules exist to talk to somebody else's server on your behalf, and
 * every way that can fail is something you can act on.
 */
export class UserError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UserError';
  }
}

/**
 * What to tell the browser about `e`.
 *
 * Anything not deliberately raised is reported as `fallback` and logged under
 * `where`, so the detail is still one `journalctl` away — just not one fetch
 * away.
 */
export function userMessage(e, fallback, where) {
  if (e instanceof UserError) return e.message;
  console.warn(`[visited-map] ${where}:`, e);
  return fallback;
}
