// The Export dialog — the controls in front of src/export-image.js.
//
// Everything here is one shape: a control writes into `spec`, `spec` is
// remembered, and the preview is redrawn from it. There is no second copy of
// the state and nothing is read back off the DOM, which is what lets the same
// `spec` drive a 300 px preview and a 2160 px file with no chance of the two
// disagreeing about what you asked for.
//
// **The preview is the picture, not a picture of it.** It runs the same
// `renderExport` at a smaller size, so what you tune is what you get — the type
// scale, the blob level and the margins are all derived from the image's own
// height precisely so that this can be true. What the preview does *not* do is
// re-run the coverage sweep: that is `coverageOf`, held against the selection,
// because dragging a colour cannot change how much of Switzerland you have
// walked across.
//
// The lists are built from the constants in src/export-image.js rather than
// typed out in index.html, so a new caption line or a fifth palette is one
// entry in one array.

import {
  CAPTION_ANCHORS, CAPTION_FIELDS, CAPTION_FONTS, DEFAULT_SPEC, PALETTES, SCALES, SHAPES,
  coverageOf, ensureGeography, exportFilename, paletteOf, renderExport, sizeOf, visitedAreas,
} from './export-image.js';
import { HEAT_MODES } from './coloring.js';
import { showToast } from './toast.js';

const SPEC_KEY = 'visited-map:export:v1';

// What the four scope buttons say. "Everywhere" is not a kind of boundary, so
// it sits with them rather than being a checkbox somewhere else — it is the
// answer to the same question the other three answer.
const SCOPES = [
  { key: 'world', label: 'Everywhere' },
  { key: 'continent', label: 'Continents' },
  { key: 'country', label: 'Countries' },
  { key: 'region', label: 'Regions' },
];

const DETAILS = [
  { key: 'blob', label: 'Blobs' },
  { key: 'region', label: 'Regions' },
  { key: 'country', label: 'Countries' },
  { key: 'continent', label: 'Continents' },
];

const ALIGNS = [
  { key: 'left', label: 'Left' },
  { key: 'center', label: 'Center' },
  { key: 'right', label: 'Right' },
];

// How long a control waits before the picture is redrawn. Long enough that
// dragging a slider does not queue a repaint per pixel, short enough that
// letting go feels like it landed.
const REDRAW_MS = 90;

/** A deep-ish copy, so the defaults can never be written through. */
const freshSpec = () => ({
  ...DEFAULT_SPEC,
  scope: { ...DEFAULT_SPEC.scope, ids: [] },
  colors: {},
  caption: { ...DEFAULT_SPEC.caption, fields: [...DEFAULT_SPEC.caption.fields] },
});

/**
 * Read the remembered spec, field by field against the defaults.
 *
 * Not `{...DEFAULT_SPEC, ...stored}`: a spec written by an older build is
 * missing keys, and one written by a newer one may name a shape or a palette
 * this build does not have. Every value is checked against what exists now, so
 * a stale entry degrades to a default rather than to a blank canvas.
 */
function loadSpec() {
  const spec = freshSpec();
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(SPEC_KEY) ?? 'null');
  } catch {
    return spec;
  }
  if (!raw || typeof raw !== 'object') return spec;

  if (SHAPES[raw.shape]) spec.shape = raw.shape;
  if (raw.scale === 2) spec.scale = 2;
  if (DETAILS.some((d) => d.key === raw.detail)) spec.detail = raw.detail;
  if (HEAT_MODES[raw.colorBy]) spec.colorBy = raw.colorBy;
  if (PALETTES[raw.palette]) spec.palette = raw.palette;
  if (typeof raw.accent === 'string') spec.accent = raw.accent;
  if (Number.isFinite(raw.strength)) spec.strength = Math.min(1, Math.max(0.1, raw.strength));
  if (Number.isFinite(raw.cellSize)) spec.cellSize = Math.min(2, Math.max(0, Math.round(raw.cellSize)));
  if (typeof raw.outline === 'boolean') spec.outline = raw.outline;
  if (typeof raw.surroundings === 'boolean') spec.surroundings = raw.surroundings;
  if (raw.colors && typeof raw.colors === 'object') {
    for (const key of ['background', 'land', 'edge']) {
      if (typeof raw.colors[key] === 'string') spec.colors[key] = raw.colors[key];
    }
  }
  if (raw.scope && SCOPES.some((s) => s.key === raw.scope.kind)) {
    spec.scope.kind = raw.scope.kind;
    // The ids are *not* restored. They name places, and whether you have been
    // to one is a fact about the map that may have changed since — an id that
    // no longer has a cell under it would draw an empty shape with no way of
    // saying why. The kind is a preference; the places are a fresh choice.
  }
  const c = raw.caption;
  if (c && typeof c === 'object') {
    if (typeof c.on === 'boolean') spec.caption.on = c.on;
    if (CAPTION_ANCHORS.includes(c.anchor)) spec.caption.anchor = c.anchor;
    if (ALIGNS.some((a) => a.key === c.align)) spec.caption.align = c.align;
    if (CAPTION_FONTS[c.font]) spec.caption.font = c.font;
    if (Number.isFinite(c.size)) spec.caption.size = Math.min(1.8, Math.max(0.6, c.size));
    if (typeof c.title === 'string') spec.caption.title = c.title.slice(0, 120);
    if (typeof c.color === 'string') spec.caption.color = c.color;
    if (typeof c.shadow === 'boolean') spec.caption.shadow = c.shadow;
    if (Array.isArray(c.fields)) {
      const known = new Set(CAPTION_FIELDS.map((f) => f.key));
      spec.caption.fields = c.fields.filter((k) => known.has(k));
    }
  }
  return spec;
}

/**
 * @param {object} opts
 * @param {() => void} opts.onClose  where Back goes — the hub it was opened from
 * @param {object} opts.data  everything the renderer reads: the visited set, the
 *   provenance, the roll-ups and the area geometry, all owned by src/main.js
 */
export function mountExport({ onClose, data }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('export-overlay');
  const canvas = $('export-canvas');
  const frame = $('export-frame');
  const note = $('export-note');
  const errorBox = $('export-error');
  const picker = $('export-picker');
  const list = $('export-list');
  const filter = $('export-filter');

  let spec = loadSpec();
  let numbers = null; // the coverage answer for the current selection
  let coverageKey = ''; // what that answer was computed for
  let asking = 0; // generation counter, so a slow sweep can't land late
  let timer = null;
  let open_ = false;
  // The visited areas of each kind, worked out once per kind per opening. The
  // sweep behind it is 20k point-in-polygon tests; the list it produces does
  // not change while the dialog is up.
  const areaCache = new Map();

  const save = () => {
    try {
      localStorage.setItem(SPEC_KEY, JSON.stringify(spec));
    } catch {
      /* a preference that will not persist is still a preference */
    }
  };

  const fail = (message) => {
    errorBox.textContent = message ?? '';
    errorBox.hidden = !message;
  };

  // --- Small builders -----------------------------------------------------------

  /** A segmented control over a list, driven by a getter and a setter. */
  function segment(el, options, get, set) {
    el.textContent = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg-btn';
      btn.textContent = opt.label;
      btn.dataset.key = String(opt.key);
      btn.addEventListener('click', () => {
        set(opt.key);
        save();
        sync();
        schedule();
      });
      el.append(btn);
    }
    return () => {
      const now = String(get());
      for (const btn of el.children) btn.classList.toggle('active', btn.dataset.key === now);
    };
  }

  const syncers = [];
  const addSegment = (el, options, get, set) => syncers.push(segment(el, options, get, set));

  addSegment(
    $('export-shape'),
    Object.entries(SHAPES).map(([key, s]) => ({ key, label: s.label })),
    () => spec.shape,
    (key) => {
      spec.shape = key;
    },
  );

  addSegment(
    $('export-scope'),
    SCOPES,
    () => spec.scope.kind,
    (key) => {
      if (key === spec.scope.kind) return;
      spec.scope = { kind: key, ids: [] };
      filter.value = '';
      refreshList();
    },
  );

  addSegment(
    $('export-detail'),
    DETAILS,
    () => spec.detail,
    (key) => {
      spec.detail = key;
    },
  );

  addSegment(
    $('export-colorby'),
    Object.entries(HEAT_MODES).map(([key, m]) => ({ key, label: m.label })),
    () => spec.colorBy,
    (key) => {
      spec.colorBy = key;
    },
  );

  addSegment(
    $('export-palette'),
    Object.entries(PALETTES).map(([key, p]) => ({ key, label: p.label })),
    () => spec.palette,
    (key) => {
      spec.palette = key;
      // Picking a ready-made palette drops whatever was overridden on top of
      // the last one. Otherwise "Paper" would arrive still wearing the dark
      // land colour somebody nudged an hour ago, and look broken rather than
      // customised.
      spec.colors = {};
      if (spec.caption.color) spec.caption.color = '';
    },
  );

  addSegment(
    $('export-align'),
    ALIGNS,
    () => spec.caption.align,
    (key) => {
      spec.caption.align = key;
    },
  );

  // Nine cells, laid out the way they sit on the picture — the control is a
  // small map of the frame rather than a list of nine names.
  const anchorGrid = $('export-anchor');
  for (const anchor of CAPTION_ANCHORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-anchor-cell';
    btn.dataset.anchor = anchor;
    btn.setAttribute('aria-label', anchor.replace('-', ' '));
    btn.addEventListener('click', () => {
      spec.caption.anchor = anchor;
      save();
      sync();
      schedule();
    });
    anchorGrid.append(btn);
  }
  syncers.push(() => {
    for (const btn of anchorGrid.children) {
      btn.classList.toggle('active', btn.dataset.anchor === spec.caption.anchor);
    }
  });

  const fieldsBox = $('export-fields');
  for (const field of CAPTION_FIELDS) {
    const label = document.createElement('label');
    label.className = 'export-field';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => {
      const on = box.checked;
      const at = spec.caption.fields.indexOf(field.key);
      if (on && at < 0) {
        // Kept in the order the fields are declared, not the order they were
        // ticked: the caption reads top to bottom and the title belongs at the
        // top whenever it was chosen.
        spec.caption.fields.push(field.key);
        const order = CAPTION_FIELDS.map((f) => f.key);
        spec.caption.fields.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      } else if (!on && at >= 0) spec.caption.fields.splice(at, 1);
      save();
      schedule();
    });
    const text = document.createElement('span');
    text.textContent = field.label;
    label.append(box, text);
    label.dataset.key = field.key;
    fieldsBox.append(label);
  }
  syncers.push(() => {
    const on = new Set(spec.caption.fields);
    for (const label of fieldsBox.children) {
      label.querySelector('input').checked = on.has(label.dataset.key);
    }
  });

  const scaleSel = $('export-scale');
  for (const s of SCALES) {
    const opt = document.createElement('option');
    opt.value = String(s.key);
    opt.textContent = s.label;
    scaleSel.append(opt);
  }
  scaleSel.addEventListener('change', () => {
    spec.scale = Number(scaleSel.value) === 2 ? 2 : 1;
    save();
    sync();
    schedule();
  });

  const fontSel = $('export-font');
  for (const [key, f] of Object.entries(CAPTION_FONTS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = f.label;
    opt.style.fontFamily = f.stack;
    fontSel.append(opt);
  }
  fontSel.addEventListener('change', () => {
    spec.caption.font = fontSel.value;
    save();
    schedule();
  });

  // --- Plain controls -----------------------------------------------------------

  const bind = (el, event, apply) => {
    el.addEventListener(event, () => {
      apply();
      save();
      sync();
      schedule();
    });
  };

  const cellSize = $('export-cellsize');
  bind(cellSize, 'change', () => {
    spec.cellSize = Number(cellSize.value) || 0;
  });

  const accent = $('export-accent');
  bind(accent, 'input', () => {
    spec.accent = accent.value;
  });

  const strength = $('export-strength');
  bind(strength, 'input', () => {
    spec.strength = Number(strength.value) / 100;
  });

  for (const input of overlay.querySelectorAll('[data-color]')) {
    bind(input, 'input', () => {
      spec.colors[input.dataset.color] = input.value;
    });
  }

  const outline = $('export-outline');
  bind(outline, 'change', () => {
    spec.outline = outline.checked;
  });

  const surroundings = $('export-surroundings');
  bind(surroundings, 'change', () => {
    spec.surroundings = surroundings.checked;
  });

  const captionOn = $('export-caption-on');
  bind(captionOn, 'change', () => {
    spec.caption.on = captionOn.checked;
  });

  const title = $('export-title');
  bind(title, 'input', () => {
    spec.caption.title = title.value.slice(0, 120);
  });

  const textSize = $('export-textsize');
  bind(textSize, 'input', () => {
    spec.caption.size = Number(textSize.value) / 100;
  });

  const textColor = $('export-textcolor');
  bind(textColor, 'input', () => {
    spec.caption.color = textColor.value;
  });

  const shadow = $('export-shadow');
  bind(shadow, 'change', () => {
    spec.caption.shadow = shadow.checked;
  });

  filter.addEventListener('input', () => renderList());

  // --- The list of places ---------------------------------------------------------

  async function refreshList() {
    const kind = spec.scope.kind;
    picker.hidden = kind === 'world';
    if (kind === 'world') {
      sync();
      schedule();
      return;
    }
    if (!areaCache.has(kind)) {
      list.innerHTML = '<div class="export-list-note">Reading the boundaries…</div>';
      try {
        await ensureGeography({ scope: kind });
        areaCache.set(kind, visitedAreas(kind, data.cells(), data.areaOf));
      } catch {
        list.innerHTML = '<div class="export-list-note">The boundaries could not be read.</div>';
        return;
      }
    }
    renderList();
    sync();
    schedule();
  }

  function renderList() {
    const kind = spec.scope.kind;
    const all = areaCache.get(kind) ?? [];
    if (!all.length) {
      list.innerHTML = '<div class="export-list-note">Nothing here yet — no cells fall in any of these.</div>';
      return;
    }
    const q = filter.value.trim().toLowerCase();
    const shown = q
      ? all.filter((a) => a.name.toLowerCase().includes(q) || (a.country ?? '').toLowerCase().includes(q))
      : all;
    const chosen = new Set(spec.scope.ids);

    list.textContent = '';
    if (!shown.length) {
      list.innerHTML = '<div class="export-list-note">Nothing matches that.</div>';
      return;
    }
    for (const area of shown.slice(0, 400)) {
      const label = document.createElement('label');
      label.className = 'export-place';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.has(area.id);
      box.addEventListener('change', () => {
        const at = spec.scope.ids.indexOf(area.id);
        if (box.checked && at < 0) spec.scope.ids.push(area.id);
        else if (!box.checked && at >= 0) spec.scope.ids.splice(at, 1);
        save();
        sync();
        schedule();
      });
      const name = document.createElement('b');
      name.textContent = area.name;
      const sub = document.createElement('small');
      sub.textContent = area.country ?? '';
      label.append(box, name, sub);
      list.append(label);
    }
    if (shown.length > 400) {
      const more = document.createElement('div');
      more.className = 'export-list-note';
      more.textContent = `${(shown.length - 400).toLocaleString()} more — narrow the filter to reach them.`;
      list.append(more);
    }
  }

  // --- Keeping the controls and the spec in step ----------------------------------

  function sync() {
    for (const fn of syncers) fn();
    const size = sizeOf(spec);
    $('export-size-note').textContent = `${size.w} × ${size.h}`;
    scaleSel.value = String(spec.scale);
    $('export-cellsize-row').hidden = spec.detail !== 'blob';
    cellSize.value = String(spec.cellSize);
    $('export-accent-row').hidden = spec.colorBy !== 'flat';
    accent.value = (spec.accent || '#60acff').slice(0, 7);
    strength.value = String(Math.round(spec.strength * 100));

    const palette = paletteOf(spec);
    for (const input of overlay.querySelectorAll('[data-color]')) {
      const value = palette[input.dataset.color];
      // A transparent background has no swatch to show, so the control falls
      // back to the colour it would become if you touched it.
      input.value = /^#[0-9a-f]{6}/i.test(String(value)) ? String(value).slice(0, 7) : '#0b0d14';
    }
    outline.checked = spec.outline;
    surroundings.checked = spec.surroundings;

    captionOn.checked = spec.caption.on;
    $('export-caption-body').hidden = !spec.caption.on;
    title.value = spec.caption.title;
    fontSel.value = spec.caption.font;
    textSize.value = String(Math.round(spec.caption.size * 100));
    textColor.value = (spec.caption.color || palette.text || '#ffffff').slice(0, 7);
    shadow.checked = spec.caption.shadow;

    $('export-scope-hint').hidden = spec.scope.kind !== 'world';
    frame.style.aspectRatio = `${size.w} / ${size.h}`;
  }

  // --- Drawing --------------------------------------------------------------------

  /**
   * What the coverage answer currently on hand was computed for.
   *
   * An empty selection is everywhere whatever kind it nominally is (see
   * `settleScope`), so switching between Countries and Regions without ticking
   * anything must not throw the answer away and sweep 20k cells again.
   */
  const scopeKey = () =>
    (spec.scope.ids.length ? `${spec.scope.kind}:${[...spec.scope.ids].sort().join('|')}` : 'world');

  function schedule() {
    if (!open_) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, REDRAW_MS);
  }

  async function refresh() {
    if (!open_) return;
    fail(null);
    try {
      await ensureGeography({ scope: spec.scope.kind, detail: spec.detail });
    } catch {
      fail('The boundary data could not be loaded.');
      return;
    }

    const key = scopeKey();
    if (key !== coverageKey || !numbers) {
      const generation = ++asking;
      note.textContent = 'Measuring…';
      try {
        const answer = await coverageOf(spec.scope, data);
        // A slower sweep for a selection you have already moved on from must
        // not overwrite the one you are looking at.
        if (generation !== asking || !open_) return;
        numbers = answer;
        coverageKey = key;
      } catch {
        if (generation !== asking) return;
        fail('Those numbers could not be worked out.');
        note.textContent = '';
        return;
      }
    }
    draw();
  }

  function draw() {
    if (!numbers) return;
    const full = sizeOf(spec);
    // The preview is the same picture at the size it is being looked at, not a
    // 2160 px file scaled down in the browser — which would spend a quarter of
    // a second per keystroke to show something a third of the size.
    const box = frame.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.min(full.w, Math.round((box.width || 320) * dpr)));
    const size = { w, h: Math.round((w * full.h) / full.w) };
    try {
      renderExport(canvas, spec, data, numbers, size);
      note.textContent = describe();
    } catch (e) {
      fail(`The picture could not be drawn — ${e?.message ?? e}`);
    }
  }

  /** One line under the preview saying what is being looked at. */
  function describe() {
    if (spec.scope.kind === 'world') return 'Everywhere you have been';
    const n = spec.scope.ids.length;
    if (!n) return 'Nothing picked — showing everywhere you have been';
    if (n <= 3) return numbers.names.join(' · ');
    return `${n.toLocaleString()} places`;
  }

  // --- Saving the file --------------------------------------------------------------

  async function download() {
    if (!numbers) return;
    fail(null);
    const off = document.createElement('canvas');
    try {
      renderExport(off, spec, data, numbers);
    } catch (e) {
      fail(`The picture could not be drawn — ${e?.message ?? e}`);
      return;
    }
    const blob = await new Promise((resolve) => off.toBlob(resolve, 'image/png'));
    if (!blob) {
      fail('The image could not be encoded.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(spec, numbers);
    a.click();
    // Revoked on the next turn rather than immediately: Safari has not
    // necessarily started reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showToast(`Saved ${a.download}`);
  }

  // --- Wiring ---------------------------------------------------------------------

  function open() {
    open_ = true;
    overlay.hidden = false;
    fail(null);
    areaCache.clear();
    // The accent follows the map unless this dialog has been given one of its
    // own. A poster of a map you have coloured teal should not open blue.
    if (!localStorage.getItem(SPEC_KEY)) spec.accent = data.accent();
    numbers = null;
    coverageKey = '';
    sync();
    refreshList();
    schedule();
  }

  function close() {
    open_ = false;
    clearTimeout(timer);
    overlay.hidden = true;
  }

  $('export-close').addEventListener('click', close);
  $('export-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('export-save').addEventListener('click', download);
  $('export-reset').addEventListener('click', () => {
    const kind = spec.scope.kind;
    const ids = spec.scope.ids;
    spec = freshSpec();
    // The places you picked are the one thing a Reset should not throw away —
    // they are the work, and everything else is a look.
    spec.scope = { kind, ids };
    spec.accent = data.accent();
    save();
    sync();
    schedule();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
  // The preview is sized from the element it sits in, so it has to be redrawn
  // when that element changes size — a rotated phone otherwise keeps a picture
  // rendered for the width it used to have.
  window.addEventListener('resize', () => schedule());

  return { open, close };
}
