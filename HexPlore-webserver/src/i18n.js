// Every word the app says, in one place per language.
//
// ## Why `t()` is synchronous, and how it can be
//
// A great many of the strings here are in module-level constants — the palette
// labels in `src/export-image.js`, the source names in `src/locations.js`, the
// cadence titles, the caption fields. Those are evaluated the moment their
// module is imported, which is long before any promise could resolve. So either
// every one of them becomes a lazy `labelKey` read at render time — a very large
// refactor of code that is not otherwise wrong — or `t()` has to be able to
// answer immediately.
//
// It answers immediately, and `src/boot.js` is what makes that safe. That module
// already exists to `await` something before importing `main.js` (the map
// library, for a reason of its own), so the locale is awaited in the same place
// and by the same trick. By the time any other module is evaluated, the strings
// are in hand. Nothing else in the app has to know this happened.
//
// ## Changing language reloads the page
//
// For the same reason: a constant read at import time cannot be re-read. Rather
// than pretend otherwise — half the app in the new language and half in the old
// is worse than a reload — `setLocale` stores the choice and reloads. There is
// precedent a few files over: switching to a basemap that needs the other map
// library reloads too (see `setStyleKey` in src/main.js), and for the same
// underlying reason, which is that some decisions are made before the app runs.
//
// ## English is always loaded
//
// It is the fallback, and it is the only file guaranteed to have every key: a
// translation that is behind by a release should show English for the handful of
// strings it has not caught up with, rather than the raw key. `t()` therefore
// looks in the chosen locale, then in English, and only then gives up and hands
// back the key itself — which is deliberately ugly, because a key on screen is a
// bug and should look like one.

const STORE_KEY = 'visited-map:locale:v1';

/**
 * The languages that exist, and how to fetch each one.
 *
 * A loader per entry rather than a static import, so a browser downloads the one
 * language it is going to use and not all of them. `label` is written in the
 * language itself — a list of languages is the one list nobody wants translated,
 * because the person reading it is by definition looking for the one they can
 * read.
 *
 * Adding a language is this list plus a file, and nothing else.
 */
export const LOCALES = [
  { key: 'en', label: 'English', load: () => import('./locales/en.js') },
];

/** The default, and the fallback every other locale is measured against. */
export const BASE_LOCALE = 'en';

export const isLocale = (key) => LOCALES.some((l) => l.key === key);

let strings = {}; // the chosen locale
let base = {}; // English, always
let active = BASE_LOCALE;

/**
 * Which language the app is in.
 *
 * A stored choice wins; otherwise the browser's own preference, if it names one
 * we have; otherwise English. `navigator.languages` is in the person's own order
 * of preference, so the first match is the right one — and the region is
 * dropped, because `de-AT` and `de-DE` are the same file here.
 */
export function locale() {
  let held;
  try {
    held = localStorage.getItem(STORE_KEY);
  } catch {
    held = null;
  }
  if (isLocale(held)) return held;
  // `globalThis.navigator` rather than the bare global: optional chaining does
  // not save an identifier that was never declared, and this module is imported
  // by the test suite, which runs in Node.
  for (const tag of globalThis.navigator?.languages ?? []) {
    const short = String(tag).toLowerCase().split('-')[0];
    if (isLocale(short)) return short;
  }
  return BASE_LOCALE;
}

/** The one in force right now, which is a fact rather than a preference. */
export const activeLocale = () => active;

/**
 * Choose a language. Reloads, because the strings are read at import time.
 *
 * @param {string} key
 * @param {boolean} [reload] false in tests, where there is no page to reload
 */
export function setLocale(key, reload = true) {
  const clean = isLocale(key) ? key : BASE_LOCALE;
  try {
    localStorage.setItem(STORE_KEY, clean);
  } catch {
    /* a preference that will not persist is still a preference for this visit */
  }
  if (reload && clean !== active && globalThis.location?.reload) globalThis.location.reload();
  return clean;
}

/**
 * Fetch the strings. Called once, from `src/boot.js`, before anything else is
 * imported.
 *
 * A locale that will not load is not a reason to have no app: English is already
 * there, and a page in the wrong language beats a page that never appeared.
 */
export async function loadLocale(key = locale()) {
  base = (await LOCALES.find((l) => l.key === BASE_LOCALE).load()).default ?? {};
  active = isLocale(key) ? key : BASE_LOCALE;
  if (active === BASE_LOCALE) {
    strings = base;
    return active;
  }
  try {
    strings = (await LOCALES.find((l) => l.key === active).load()).default ?? {};
  } catch {
    strings = base;
    active = BASE_LOCALE;
  }
  return active;
}

/**
 * One string, by key.
 *
 * `params` fills `{name}` placeholders. Named rather than positional, because a
 * translator moving them around is the entire point of having them — in German
 * the count and the noun are not in the order they are in English, and a `%s`
 * that has to stay put is a sentence the translation cannot fix.
 *
 * A missing key returns the key. That is on purpose: it is visible, it is
 * greppable, and `scripts/test/i18n.mjs` fails the build if the markup ever asks
 * for one that does not exist.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params) {
  const found = strings[key] ?? base[key] ?? key;
  if (!params) return found;
  return found.replace(/\{(\w+)\}/g, (whole, name) =>
    (name in params ? String(params[name]) : whole));
}

/** Is there a string for this key at all? For the tests, and for the lint. */
export const hasKey = (key) => key in strings || key in base;

/** Every key English defines — the set every other language is checked against. */
export const baseKeys = () => Object.keys(base);

/**
 * Fill in a tree of markup that carries `data-i18n` attributes.
 *
 * Five forms, because a string in HTML is not always a whole element's text:
 *
 *   data-i18n              the element's text, which is all it contains
 *   data-i18n-text         its *first text node*, leaving element children alone
 *   data-i18n-placeholder  an input's placeholder
 *   data-i18n-aria-label   its accessible name
 *   data-i18n-title        its tooltip
 *
 * The second one earns its existence. A great many rows here are shaped
 * `<span>Clock<small>Times follow this device</small></span>` — a label and its
 * own note, in one element, and `textContent` on that would delete the note.
 * The obvious alternative is to wrap the label in a `<span>`, and that breaks
 * the layout: `.import-row span` is a flex column, and a nested span inherits
 * the rule and stacks the label's own letters. Writing the text node in place
 * changes nothing about the tree.
 *
 * Text is set with `textContent` and `nodeValue`, never `innerHTML`. A
 * translation is a string in a file, and a file can be edited by somebody who is
 * not thinking about script tags; nothing here needs markup, so nothing here
 * accepts it.
 *
 * Idempotent, so it can be run again over a subtree that was just rebuilt.
 *
 * @param {ParentNode} [root]
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-text]')) {
    const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
    // No text node means the markup changed under a key that used to name one.
    // Skipped rather than invented: appending a stray node would put the label
    // in a place the stylesheet knows nothing about.
    if (text) text.nodeValue = t(el.dataset.i18nText);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  // The document's own language, which is not decoration: it is what a screen
  // reader picks a voice from, and what the browser hyphenates and spell-checks
  // by. Left wrong, an English-sounding voice reads out German.
  if (root === document) document.documentElement.lang = active;
}
