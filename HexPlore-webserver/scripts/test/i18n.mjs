// Every string the app can ask for, against every string it has.
//
// This is the test that makes the whole arrangement safe to extend. Keys are
// referred to by name from two places that no compiler checks — a `data-i18n`
// attribute in the markup and a `t('…')` call in a module — so the failure mode
// is a key rendering as itself, in one dialog, on one screen somebody may not
// open for a month. Every mistake this catches is invisible until it is
// embarrassing:
//
//   - markup asking for a key nobody defined (a typo, or a row copied from
//     another dialog and not re-keyed)
//   - a key defined and no longer used (the row was deleted; the string stays
//     forever, and a translator pays for it in every language)
//   - a translation missing keys English has — which is the normal state of a
//     language that is one release behind, and must degrade to English rather
//     than to raw keys
//   - a `{placeholder}` that exists in English and not in a translation, which
//     is a sentence with a hole in it
//
//   node scripts/test/i18n.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const en = (await import(path.join(ROOT, 'src/locales/en.js'))).default;
const defined = new Set(Object.keys(en));

// --- What the markup asks for ---------------------------------------------------

const html = read('index.html');
const fromHtml = new Set(
  [...html.matchAll(/data-i18n(?:-text|-placeholder|-aria-label|-title)?="([^"]+)"/g)].map((m) => m[1]),
);

console.log('\nThe markup and the locale agree');
{
  check(fromHtml.size > 300, `the markup is actually keyed (${fromHtml.size} keys)`);
  const missing = [...fromHtml].filter((k) => !defined.has(k));
  check(missing.length === 0, 'every key the markup asks for exists', missing.slice(0, 5).join(', '));
}

// --- What the source asks for ---------------------------------------------------
//
// Only literal `t('…')` calls. A key built at runtime — `t(\`snow.${mode}\`)` —
// cannot be checked from here, so the convention is not to build them: every
// such site spells the alternatives out, and this is the check that keeps that
// convention honest by simply not seeing anything else.

const srcFiles = readdirSync(path.join(ROOT, 'src'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `src/${f}`);

const fromSource = new Set(); // keys a t() call names outright — these must exist
const literals = new Set(); // every quoted string in the source, for the orphan check
let dynamic = 0;
for (const file of srcFiles) {
  const text = read(file);
  for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) fromSource.add(m[1]);
  for (const m of text.matchAll(/'([A-Za-z][\w-]*(?:\.[\w-]+)+)'/g)) literals.add(m[1]);
  for (const m of text.matchAll(/\bt\(\s*`/g)) { void m; dynamic++; }
}

console.log('\nThe source and the locale agree');
{
  const missing = [...fromSource].filter((k) => !defined.has(k));
  check(missing.length === 0, 'every key a t() call asks for exists', missing.slice(0, 5).join(', '));
  check(dynamic === 0, 'and no key is assembled from a template literal', `${dynamic} found`);
}

// --- Nothing defined and forgotten ----------------------------------------------

console.log('\nAnd nothing is defined that nobody wants');
{
  // Two ways a key is legitimately reached without being written inside `t(…)`:
  //
  //   - a ternary — `t(ok ? 'a.on' : 'a.off')` — where the literal is in the
  //     source but not in the call's first position
  //   - a plural stem. `plural(n, 'whatsNew.places')` reaches
  //     `whatsNew.places.one` and `.other`, and which of them depends on the
  //     number and the language, so neither is ever written out.
  //
  // Both are found by looking for the literal anywhere in the source rather
  // than only where a call would put it. Looser than the check above, and it
  // has to be: this one is only asking whether somebody would miss the key.
  const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const reached = (key) => {
    if (fromHtml.has(key) || literals.has(key)) return true;
    const cut = key.lastIndexOf('.');
    if (cut < 0) return false;
    const [stem, form] = [key.slice(0, cut), key.slice(cut + 1)];
    return PLURAL_FORMS.includes(form) && literals.has(stem);
  };
  const orphans = [...defined].filter((k) => !reached(k));
  check(orphans.length === 0, 'every key in the locale is used somewhere',
    `${orphans.length}: ${orphans.slice(0, 6).join(', ')}`);
}

// --- The strings themselves -----------------------------------------------------

console.log('\nThe strings are strings');
{
  const notString = Object.entries(en).filter(([, v]) => typeof v !== 'string');
  check(notString.length === 0, 'every value is a string', notString.slice(0, 3).map(([k]) => k).join(', '));

  const empty = Object.entries(en).filter(([, v]) => !v.trim());
  check(empty.length === 0, 'and none of them is empty', empty.slice(0, 3).map(([k]) => k).join(', '));

  // These are set with textContent, so a tag would be shown rather than parsed.
  const markup = Object.entries(en).filter(([, v]) => /<[a-z/][^>]*>/i.test(v));
  check(markup.length === 0, 'and none of them contains markup', markup.slice(0, 3).map(([k]) => k).join(', '));

  // A stray entity would be printed literally for the same reason.
  const entities = Object.entries(en).filter(([, v]) => /&(?:nbsp|amp|lt|gt|quot|#\d+);/.test(v));
  check(entities.length === 0, 'nor an HTML entity, which textContent would print as itself',
    entities.slice(0, 3).map(([k]) => k).join(', '));
}

// --- Every other language, against English --------------------------------------
//
// Vacuous today — English is the only file — and that is exactly why it is
// written now. The first translation to land gets checked by a test that already
// existed, rather than by somebody noticing a raw key in a screenshot.

const localeFiles = readdirSync(path.join(ROOT, 'src/locales')).filter((f) => f.endsWith('.js'));

console.log('\nEvery translation against English');
{
  check(localeFiles.includes('en.js'), 'English is there, and is the yardstick');
  const holes = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

  for (const file of localeFiles) {
    const key = file.replace(/\.js$/, '');
    if (key === 'en') continue;
    const other = (await import(path.join(ROOT, 'src/locales', file))).default;

    // Missing keys are allowed — they fall back to English, which is the whole
    // point of having a base locale. Extra ones are not: they are a key that was
    // renamed in English and not here, and they will never be read.
    const extra = Object.keys(other).filter((k) => !defined.has(k));
    check(extra.length === 0, `${key} defines nothing English has dropped`, extra.slice(0, 5).join(', '));

    const wrongHoles = Object.entries(other).filter(([k, v]) => {
      if (!defined.has(k)) return false;
      const mine = holes(v);
      const theirs = holes(en[k]);
      return mine.size !== theirs.size || [...theirs].some((h) => !mine.has(h));
    });
    check(wrongHoles.length === 0, `${key} keeps every {placeholder} English has`,
      wrongHoles.slice(0, 4).map(([k]) => k).join(', '));

    const notString = Object.entries(other).filter(([, v]) => typeof v !== 'string' || !v.trim());
    check(notString.length === 0, `${key} has no empty or non-string values`,
      notString.slice(0, 3).map(([k]) => k).join(', '));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
