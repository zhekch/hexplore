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
  CAPTION_ANCHORS, CAPTION_FIELDS, CAPTION_FONTS, DEFAULT_SPEC, MAX_SIDE_PX, PALETTES, SCALES,
  SHAPES, cameraFor, coverageOf, ensureGeography, ensureSharpBoundaries, exportFilename, fitCamera,
  frameOf, isLightColor, lngLatAt, paletteOf, pickAt, presetOf, renderExport, scopeCountryOf,
  scopeName, sizeOf, visitedAreas,
} from './export-image.js';
import { mercX, mercY } from './hexgrid.js';
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

// A pointer that moved less than this between down and up was a click, not a
// drag. Generous enough to survive the hand-wobble of a real tap on a phone.
const CLICK_SLOP_PX = 4;

// How far one wheel notch zooms, and how far the framing may be pushed either
// side of what would fit. Wide, because a poster of a valley inside a country
// is a reasonable thing to want, and so is pulling back to show where it is.
const ZOOM_STEP = 0.0016;
const ZOOM_RANGE = [0.15, 60];

const clampSide = (v) => Math.max(120, Math.min(MAX_SIDE_PX, Math.round(Number(v) || 0)));

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
  if (typeof raw.preset === 'string') spec.preset = raw.preset;
  if (SCALES.includes(raw.scale)) spec.scale = raw.scale;
  if (typeof raw.custom === 'boolean') spec.custom = raw.custom;
  if (Number.isFinite(raw.customW)) spec.customW = clampSide(raw.customW);
  if (Number.isFinite(raw.customH)) spec.customH = clampSide(raw.customH);
  if (DETAILS.some((d) => d.key === raw.detail)) spec.detail = raw.detail;
  if (HEAT_MODES[raw.colorBy]) spec.colorBy = raw.colorBy;
  if (PALETTES[raw.palette]) spec.palette = raw.palette;
  if (typeof raw.accent === 'string') spec.accent = raw.accent;
  if (Number.isFinite(raw.strength)) spec.strength = Math.min(1, Math.max(0.1, raw.strength));
  if (Number.isFinite(raw.cellSize)) spec.cellSize = Math.min(2, Math.max(0, Math.round(raw.cellSize)));
  if (typeof raw.outline === 'boolean') spec.outline = raw.outline;
  // It used to be a switch and is a strength now. A stored `true` means "on",
  // and what "on" was is the old constant.
  if (typeof raw.surroundings === 'boolean') spec.surroundings = raw.surroundings ? 0.34 : 0;
  else if (Number.isFinite(raw.surroundings)) spec.surroundings = Math.min(1, Math.max(0, raw.surroundings));
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
    if (typeof c.shadowColor === 'string') spec.caption.shadowColor = c.shadowColor;
    if (Number.isFinite(c.shadowStrength)) {
      spec.caption.shadowStrength = Math.min(1, Math.max(0, c.shadowStrength));
    }
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
  const shell = $('export-shell');
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
      // The framing is left out: it is a framing *of one selection*, and the
      // places are not remembered either. Restoring it onto a fresh map would
      // open the dialog looking at empty ocean.
      localStorage.setItem(SPEC_KEY, JSON.stringify({ ...spec, view: null }));
    } catch {
      /* a preference that will not persist is still a preference */
    }
  };

  const fail = (message) => {
    errorBox.textContent = message ?? '';
    errorBox.hidden = !message;
  };

  /** Wire one plain control: apply it, remember it, re-sync, redraw. */
  const bind = (el, event, apply) => {
    el.addEventListener(event, () => {
      apply();
      save();
      sync();
      schedule();
    });
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
      spec.view = null;
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

  const presetSel = $('export-preset');
  presetSel.addEventListener('change', () => {
    spec.preset = presetSel.value;
    save();
    sync();
    schedule();
  });

  /** The proportions on offer follow the shape, so the list is rebuilt with it. */
  function fillPresets() {
    const shape = SHAPES[spec.shape] ?? SHAPES.vertical;
    presetSel.textContent = '';
    for (const p of shape.presets) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      presetSel.append(opt);
    }
    // Switching family almost never leaves the old key valid, and a select left
    // pointing at nothing shows blank.
    if (!shape.presets.some((p) => p.key === spec.preset)) spec.preset = shape.presets[0].key;
    presetSel.value = spec.preset;
  }

  const scaleSel = $('export-scale');
  for (const n of SCALES) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === 1 ? 'Standard (1×)' : `${n}×`;
    scaleSel.append(opt);
  }
  scaleSel.addEventListener('change', () => {
    spec.scale = Number(scaleSel.value) || 1;
    save();
    sync();
    schedule();
  });

  const customOn = $('export-custom');
  const customW = $('export-custom-w');
  const customH = $('export-custom-h');
  bind(customOn, 'change', () => {
    spec.custom = customOn.checked;
    // Seeded from whatever is on screen, so turning it on is a starting point
    // rather than a blank pair of boxes.
    if (spec.custom) {
      const now = sizeOf({ ...spec, custom: false });
      spec.customW = now.w;
      spec.customH = now.h;
    }
  });
  for (const [el, key] of [[customW, 'customW'], [customH, 'customH']]) {
    // On `change`, not `input`: half-typed numbers are how "1080" briefly
    // becomes "1", and a preview that re-renders at 1 px per keystroke is both
    // useless and slow.
    bind(el, 'change', () => {
      spec[key] = clampSide(el.value);
    });
  }

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
  bind(surroundings, 'input', () => {
    spec.surroundings = Number(surroundings.value) / 100;
  });

  const captionOn = $('export-caption-on');
  bind(captionOn, 'change', () => {
    spec.caption.on = captionOn.checked;
  });

  const title = $('export-title');
  bind(title, 'input', () => {
    spec.caption.title = title.value.slice(0, 120);
  });

  /**
   * Take the suggestion. The placeholder is the title the picture would use if
   * you typed nothing — the names of the places, kept current as you pick them —
   * and this is how you get hold of it to edit rather than retyping it.
   *
   * Tab, Space and Right all mean "accept" in one autocomplete or another, and
   * all three are free here: the field is empty, so none of them had anything
   * else to do.
   */
  title.addEventListener('keydown', (e) => {
    if (title.value !== '' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'Tab' && e.key !== ' ' && e.key !== 'ArrowRight') return;
    const suggestion = title.placeholder;
    if (!suggestion) return;
    e.preventDefault();
    title.value = suggestion;
    title.setSelectionRange(suggestion.length, suggestion.length);
    spec.caption.title = suggestion;
    save();
    schedule();
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

  const shadowColor = $('export-shadow-color');
  bind(shadowColor, 'input', () => {
    spec.caption.shadowColor = shadowColor.value;
  });

  const shadowStrength = $('export-shadow-strength');
  bind(shadowStrength, 'input', () => {
    spec.caption.shadowStrength = Number(shadowStrength.value) / 100;
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

  /**
   * The list, which is everywhere of this kind you have been — plus anything
   * you picked off the picture that you have not.
   *
   * Clicking the map can land on a canton with no cells in it, and that is a
   * fair thing to do: a poster of your valley and the one next door is a
   * composition, not a mistake. But a selection holding something the list
   * cannot show is a selection you can only undo by finding the same pixel
   * again, so anything picked appears here whether it has been visited or not.
   */
  function listedAreas(kind) {
    const all = areaCache.get(kind) ?? [];
    const known = new Set(all.map((a) => a.id));
    const extra = spec.scope.ids
      .filter((id) => !known.has(id))
      .map((id) => ({ id, cells: 0, name: scopeName(kind, id), country: scopeCountryOf(kind, id) }));
    return extra.length ? [...all, ...extra] : all;
  }

  function renderList() {
    const kind = spec.scope.kind;
    const all = listedAreas(kind);
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
        // Ticking a place in the list re-frames on it. Clicking one *on the
        // picture* deliberately does not (see pickHere): there you are already
        // looking at it, and moving the camera out from under the cursor is
        // what would make picking a second one hard.
        spec.view = null;
        save();
        sync();
        schedule();
      });
      const name = document.createElement('b');
      name.textContent = area.name;
      const sub = document.createElement('small');
      sub.textContent = area.cells ? (area.country ?? '') : 'not been';
      if (!area.cells) label.classList.add('unvisited');
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
    fillPresets();
    customOn.checked = spec.custom;
    $('export-custom-row').hidden = !spec.custom;
    // Quality multiplies a preset. A size typed in pixels is already the answer.
    $('export-quality-row').hidden = spec.custom;
    customW.value = String(spec.customW);
    customH.value = String(spec.customH);
    scaleSel.value = String(spec.scale);
    const mp = (size.w * size.h) / 1e6;
    $('export-size-note').textContent =
      `${size.w.toLocaleString()} × ${size.h.toLocaleString()} px · ${mp.toFixed(1)} MP${
        size.clamped ? ' — capped, a canvas will not go larger' : ''}`;
    $('export-size-note').classList.toggle('warn', !!size.clamped);
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
    surroundings.value = String(Math.round(spec.surroundings * 100));
    $('export-surroundings-note').textContent =
      spec.surroundings <= 0.001 ? 'Off' : `${Math.round(spec.surroundings * 100)}% behind the cut`;

    captionOn.checked = spec.caption.on;
    $('export-caption-body').hidden = !spec.caption.on;
    title.value = spec.caption.title;
    fontSel.value = spec.caption.font;
    textSize.value = String(Math.round(spec.caption.size * 100));
    textColor.value = (spec.caption.color || palette.text || '#ffffff').slice(0, 7);
    shadow.checked = spec.caption.shadow;
    $('export-shadow-body').hidden = !spec.caption.shadow;
    // Blank means "work it out from the text", which is the sensible answer and
    // the one most people want; the swatch shows what that came to so pressing
    // it is an edit rather than a jump.
    shadowColor.value = (spec.caption.shadowColor || autoShadowColor()).slice(0, 7);
    $('export-shadow-auto').textContent = spec.caption.shadowColor ? 'Chosen' : 'Follows the text';
    shadowStrength.value = String(Math.round((spec.caption.shadowStrength ?? 0.45) * 100));

    $('export-scope-hint').hidden = spec.scope.kind !== 'world';
    $('export-refit').hidden = !spec.view;
    frame.classList.toggle('pickable', spec.scope.kind !== 'world');
    fitFrame();
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

    // One generation per refresh, and everything slow checks it before it
    // writes: two of these can be in flight at once and the older must not land
    // on top of the newer.
    const gen = ++asking;

    // The detailed boundaries for whatever is in the picture — started, not
    // waited for. The overview outlines are already a picture, and a preview
    // that goes blank for a second while a country's real coastline is fetched
    // reads as a bug rather than as an improvement arriving. It lands when it
    // lands, and the picture sharpens under you.
    ensureSharpBoundaries(spec.scope, { spec, data, size: previewSize() })
      .then((arrived) => {
        if (arrived && open_ && gen === asking) draw();
      })
      .catch(() => {
        /* a country nobody has boundaries for keeps the ones we shipped */
      });

    const key = scopeKey();
    if (key !== coverageKey || !numbers) {
      note.textContent = 'Measuring…';
      try {
        const answer = await coverageOf(spec.scope, data);
        // A slower sweep for a selection you have already moved on from must
        // not overwrite the one you are looking at.
        if (gen !== asking || !open_) return;
        numbers = answer;
        coverageKey = key;
      } catch {
        if (gen !== asking) return;
        fail('Those numbers could not be worked out.');
        note.textContent = '';
        return;
      }
    }
    draw();
  }

  /**
   * Fit the picture's box inside the space the stage has left it.
   *
   * In JS rather than in CSS because `aspect-ratio` will not do it: with a
   * definite height and `max-width: 100%`, a ratio wider than its container has
   * its width clamped and its height left alone, so a 21:9 export came out
   * squashed into the height of a 4:5 one. Two lines of arithmetic are exact for
   * every ratio and leave the line underneath its own room.
   */
  function fitFrame() {
    const full = sizeOf(spec);
    const box = shell.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = full.w / full.h;
    let w = box.width;
    let h = w / ratio;
    if (h > box.height) {
      h = box.height;
      w = h * ratio;
    }
    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(h)}px`;
  }

  /** The size the preview is drawn at — the same picture, not a scaled copy. */
  function previewSize() {
    const full = sizeOf(spec);
    const box = frame.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.min(full.w, Math.round((box.width || 320) * dpr)));
    return { w, h: Math.max(1, Math.round((w * full.h) / full.w)) };
  }

  function draw() {
    if (!numbers) return;
    fitFrame();
    // The placeholder is the title the picture would use if you typed nothing,
    // and it follows the selection — pick a second country and it says so. That
    // is also what the Tab/Space/→ shortcut hands you to edit.
    title.placeholder = numbers.title || 'Switzerland';
    try {
      renderExport(canvas, spec, data, numbers, previewSize());
      note.textContent = describe();
    } catch (e) {
      fail(`The picture could not be drawn — ${e?.message ?? e}`);
    }
  }

  // --- Dragging the picture ---------------------------------------------------------
  //
  // The frame fits the selection, which is the right answer often enough to be
  // the default and never the right answer for a *composition*: half the reason
  // to export a country is to put it off-centre with the caption in the space.
  // So the preview is the camera. Drag it, wheel it, and click it to take a
  // place in or out — clicking is why this is the preview rather than a
  // separate map, because pointing at Valais is a far better way of picking it
  // than finding "Valais" in a list of 26.
  //
  // The override is a Mercator centre and a multiple of the fitted scale (see
  // `cameraFor`), so it survives the shape changing under it and the preview
  // being a third of the size of the file.

  /** The camera the preview is showing, or null when there is nothing to show. */
  function previewCamera() {
    const frameRect = frameOf(spec, data);
    if (!frameRect) return null;
    const size = previewSize();
    return { cam: cameraFor(spec, frameRect, size), fitted: fitCamera(frameRect, size), size };
  }

  /** Canvas pixels for a pointer event, in the units the camera works in. */
  function atPointer(e) {
    const box = frame.getBoundingClientRect();
    const view = previewCamera();
    if (!view || !box.width) return null;
    const px = ((e.clientX - box.left) / box.width) * view.size.w;
    const py = ((e.clientY - box.top) / box.height) * view.size.h;
    return { ...view, px, py };
  }

  /** Pin the current framing as an explicit one, so a drag has something to move. */
  function holdView(view) {
    if (spec.view) return;
    const rect = { xMin: view.cam.x0, xMax: view.cam.x0 + view.cam.w / view.cam.k };
    spec.view = {
      cx: (rect.xMin + rect.xMax) / 2,
      cy: view.cam.y0 - view.cam.h / view.cam.k / 2,
      zoom: view.cam.k / view.fitted.k,
    };
  }

  let drag = null;
  let painting = 0;

  /** Redraw on the next frame rather than on every pointer event. */
  function paintSoon() {
    if (painting) return;
    painting = requestAnimationFrame(() => {
      painting = 0;
      draw();
    });
  }

  canvas.addEventListener('pointerdown', (e) => {
    const view = atPointer(e);
    if (!view) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, px: e.clientX, py: e.clientY, moved: 0, k: view.cam.k };
    holdView(view);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !spec.view) return;
    const box = frame.getBoundingClientRect();
    if (!box.width) return;
    // Screen pixels → canvas pixels → Mercator metres. Dragging right moves the
    // world right, so the camera centre moves left.
    const toCanvas = previewSize().w / box.width;
    const dx = ((e.clientX - drag.px) * toCanvas) / drag.k;
    const dy = ((e.clientY - drag.py) * toCanvas) / drag.k;
    drag.moved += Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py);
    drag.px = e.clientX;
    drag.py = e.clientY;
    spec.view.cx -= dx;
    spec.view.cy += dy;
    frame.classList.add('dragging');
    paintSoon();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const wasClick = drag.moved <= CLICK_SLOP_PX;
    drag = null;
    frame.classList.remove('dragging');
    if (wasClick) pickHere(e);
    else {
      sync();
      schedule();
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** A click on the picture takes the place under it in or out of the selection. */
  function pickHere(e) {
    const kind = spec.scope.kind;
    if (kind === 'world') {
      // Nothing to pick against. Say so rather than doing nothing, which reads
      // as a broken click.
      note.textContent = 'Pick Continents, Countries or Regions first, then tap the map';
      sync();
      return;
    }
    const view = atPointer(e);
    if (!view) return;
    const [lng, lat] = lngLatAt(view.cam, view.px, view.py);
    const id = pickAt(kind, lng, lat);
    if (!id) return;
    const at = spec.scope.ids.indexOf(id);
    if (at >= 0) spec.scope.ids.splice(at, 1);
    else spec.scope.ids.push(id);
    // Deliberately *not* refitting. You are looking straight at the thing you
    // just picked; moving the camera out from under the cursor is the one thing
    // that would make picking a second one hard.
    renderList();
    save();
    sync();
    schedule();
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      const view = atPointer(e);
      if (!view) return;
      e.preventDefault();
      holdView(view);
      const before = lngLatAt(view.cam, view.px, view.py);
      const factor = Math.exp(-e.deltaY * ZOOM_STEP);
      spec.view.zoom = Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], spec.view.zoom * factor));
      // Zoom about the pointer: whatever was under it stays under it, which is
      // what makes a wheel feel like a magnifier rather than a slider.
      const after = previewCamera();
      if (after) {
        const [lng2, lat2] = lngLatAt(after.cam, view.px, view.py);
        spec.view.cx += mercX(before[0]) - mercX(lng2);
        spec.view.cy += mercY(before[1]) - mercY(lat2);
      }
      sync();
      paintSoon();
    },
    { passive: false },
  );

  $('export-refit').addEventListener('click', () => {
    spec.view = null;
    sync();
    schedule();
  });

  /** What the renderer would pick if no shadow colour has been chosen. */
  function autoShadowColor() {
    const text = spec.caption.color || paletteOf(spec).text || '#ffffff';
    return isLightColor(text) ? '#000000' : '#ffffff';
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
  // Clicking the backdrop closes — but only when the click *started* there too.
  // A `click` is dispatched on the nearest common ancestor of the press and the
  // release, so letting go of a slider outside the card fires one on the overlay
  // and the dialog shut itself in the middle of dragging a colour.
  let pressedBackdrop = false;
  overlay.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === overlay;
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && pressedBackdrop) close();
    pressedBackdrop = false;
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
