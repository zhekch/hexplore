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
  CELL_SIZES, SHAPES, SWATCH_PRESETS, accentOf, cameraFor, captionRectOf, coverageOf, ensureGeography, ensureSharpBoundaries, exportFilename, fitBox, fitCamera,
  frameOf, isLightColor, lngLatAt, paletteOf, pickAt, presetOf, renderExport, scopeCountryOf,
  scopeName, sizeOf, visitedAreas,
} from './export-image.js';
import { mercX, mercY } from './hexgrid.js';
import { mountColorPicker } from './color-picker.js';
import { HEAT_MODES } from './coloring.js';
import { showToast } from './toast.js';
import { onBackdropClick } from './dismiss.js';

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

// Which borders the Borders slider is setting the strength of. The silhouette
// around the subject comes with all three — see `lineAlphas`.
const LINE_SCOPES = [
  { key: 'regions', label: 'Regions' },
  { key: 'countries', label: 'Countries' },
  { key: 'both', label: 'Both' },
];

// The same three said as the end of a sentence ("35% · region borders") rather
// than as the name of a button, which is why they are lower case here.
const LINE_SCOPE_NOTES = {
  regions: 'region borders',
  countries: 'country borders',
  both: 'region and country borders',
};

const ALIGNS = [
  { key: 'left', label: 'Left' },
  { key: 'center', label: 'Center' },
  { key: 'right', label: 'Right' },
];

// How long a control waits before the picture is redrawn. Long enough that
// dragging a slider does not queue a repaint per pixel, short enough that
// letting go feels like it landed.
const REDRAW_MS = 90;

// Room left around the picture inside its column — enough for the drop shadow it
// casts to run out rather than being cropped. A share of the column rather than
// a constant, because 16px is a comfortable margin on a desktop and a twentieth
// of a phone screen.
const FRAME_MARGIN_MAX = 16;
const frameMargin = (box) => Math.min(FRAME_MARGIN_MAX, Math.round(box.width * 0.025));

// Below this the dialog stacks the picture above the controls instead of beside
// them. Kept in step with the media query in src/style.css by hand — there is no
// way to ask CSS what it decided.
const STACKED_MAX_PX = 980;
// Stacked, the picture's row is sized to the picture (see fitFrame) rather than
// given a fixed share of the screen, so a wide shape does not sit in the middle
// of a tall hole. This is the most of the dialog's body a *tall* shape may take
// before it is capped instead — the rest belongs to the controls.
//
// Half, and the number matters. The fixed row this replaced was 46vh, about 54%
// of the body once the line under the picture is counted, and a tall shape was
// already filling it — there is no dead space to reclaim there. So anything above
// 54% would have made those pictures *bigger* and their controls smaller, which
// is the opposite of what was asked for. At a half every shape has at least as
// much room to scroll in as it had, and 16:9 has 140px more.
const STAGE_MAX_SHARE = 0.5;

// A pointer that moved less than this between down and up was a click, not a
// drag. Generous enough to survive the hand-wobble of a real tap on a phone.
const CLICK_SLOP_PX = 4;

// How far one wheel notch zooms, and how far the framing may be pushed either
// side of what would fit. Wide, because a poster of a valley inside a country
// is a reasonable thing to want, and so is pulling back to show where it is.
const ZOOM_STEP = 0.0016;
// The lower bound has to reach "the whole globe", and the frame it is a multiple
// of may be one canton — so it is far below 1. Mercator's full height is a whole
// world, so fitting the planet vertically inside a frame fitted to Europe is
// already a factor of twenty, and inside a frame fitted to a valley very much
// more.
const ZOOM_RANGE = [0.005, 80];

// What the buttons under a typed size offer. They multiply what is in the boxes
// rather than a preset, which is the only thing they can mean there: a size
// typed in pixels has no preset behind it to be a multiple of.
//
// So they compound — 2× twice is four times the size — and ½× is what makes that
// safe to play with. Without a way back down the only undo for an accidental 3×
// is remembering what you had typed, which is exactly the state somebody
// reaching for a multiplier is not in.
const CUSTOM_MULTIPLIERS = [0.5, 2, 3, 4];

const clampSide = (v) => Math.max(120, Math.min(MAX_SIDE_PX, Math.round(Number(v) || 0)));

/** A deep-ish copy, so the defaults can never be written through. */
const freshSpec = () => ({
  ...DEFAULT_SPEC,
  scope: { ...DEFAULT_SPEC.scope, ids: [] },
  colors: {},
  // `nudge` cloned for the reason `fields` is: a spread copies the reference,
  // and the first drag would then be writing into DEFAULT_SPEC — where it would
  // survive a reset, because reset copies the defaults it had already edited.
  caption: {
    ...DEFAULT_SPEC.caption,
    nudge: { ...DEFAULT_SPEC.caption.nudge },
    fields: [...DEFAULT_SPEC.caption.fields],
  },
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
  // It used to be an offset (0/1/2 steps coarser than auto) and is a level now.
  // An old value would mean a different size, so it is not carried over.
  if (CELL_SIZES.some((c) => c.key === raw.cellSize)) spec.cellSize = raw.cellSize;
  // It used to be a switch and is a strength now. A stored `true` means "on",
  // and what "on" was is the old constant.
  if (typeof raw.surroundings === 'boolean') spec.surroundings = raw.surroundings ? 0.34 : 0;
  else if (Number.isFinite(raw.surroundings)) spec.surroundings = Math.min(1, Math.max(0, raw.surroundings));
  if (Number.isFinite(raw.borders)) spec.borders = Math.min(1, Math.max(0, raw.borders));
  // Before they were separate, the borders came along with the land at 85% of
  // it. A spec from that build keeps the picture it described.
  else if (spec.surroundings > 0) spec.borders = spec.surroundings * 0.85;
  // The outline was a switch and the inside lines a strength, and they are one
  // control now. A spec from before that says what picture it wanted in two
  // fields, and both are worth keeping: somebody with the outline on and no
  // seams must not open the dialog to find the outline gone.
  //
  // Then the selector stopped asking *where* the lines go and started asking
  // *which borders* they are, so there are two older vocabularies to read. The
  // silhouette is unconditional now, which is what makes both readable: a spec
  // that asked for the outline alone keeps it and gains the national borders,
  // the fewest lines that change the picture at all.
  const OLD_SCOPES = { outline: 'countries', inside: 'regions', both: 'both' };
  if (Number.isFinite(raw.lines) && (LINE_SCOPES.some((l) => l.key === raw.lineScope)
    || raw.lineScope in OLD_SCOPES)) {
    spec.lines = Math.min(1, Math.max(0, raw.lines));
    spec.lineScope = OLD_SCOPES[raw.lineScope] ?? raw.lineScope;
  } else {
    // `outline` defaulted to true, so a spec that never mentions it wanted one.
    const hadOutline = typeof raw.outline === 'boolean' ? raw.outline : true;
    const inside = Number.isFinite(raw.divisions) ? Math.min(1, Math.max(0, raw.divisions)) : 0;
    if (hadOutline && inside > 0.001) {
      spec.lineScope = 'both';
      spec.lines = inside;
    } else if (hadOutline) {
      spec.lineScope = 'countries';
      spec.lines = 1;
    } else if (inside > 0.001) {
      spec.lineScope = 'regions';
      spec.lines = inside;
    } else {
      spec.lineScope = 'countries';
      spec.lines = 0;
    }
  }
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
    // A fraction of the canvas each way. Bounded well past anything reachable by
    // dragging — the renderer holds the block inside the canvas anyway — so a
    // hand-edited or corrupted spec cannot put the caption somewhere no gesture
    // can reach it back from.
    if (c.nudge && typeof c.nudge === 'object') {
      spec.caption.nudge = {
        x: Math.min(1, Math.max(-1, Number(c.nudge.x) || 0)),
        y: Math.min(1, Math.max(-1, Number(c.nudge.y) || 0)),
      };
    }
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
    $('export-lines-which'),
    LINE_SCOPES,
    () => spec.lineScope,
    (key) => {
      spec.lineScope = key;
      // Choosing where the lines go while there are none is choosing to have
      // some: the alternative is a segmented control that appears to do
      // nothing, three presses in a row, with the answer on a slider above it.
      if (spec.lines <= 0.001) spec.lines = 1;
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
      // The wash included. It is the loudest thing on the picture and the four
      // colours under it were chosen against it, so a look that changed
      // everything *but* the wash would be half a look — see `accentOf`.
      spec.accent = '';
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
      // The grid is how you get back. A drag leaves the caption somewhere none
      // of the nine describes, and without this the cell you pressed would move
      // it by its own offset and land somewhere else again — the control would
      // stop meaning "here" the moment it was most needed.
      spec.caption.nudge = { x: 0, y: 0 };
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

  const multRow = $('export-custom-mult');
  for (const m of CUSTOM_MULTIPLIERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.textContent = m === 0.5 ? '½×' : `${m}×`;
    // Both sides from the same numbers in the same tick, so a clamp on one axis
    // cannot quietly change the proportions of the other. `clampSide` already
    // holds each to the canvas limits; the note underneath reports the result,
    // including the further cap on total pixels.
    bind(btn, 'click', () => {
      spec.customW = clampSide(spec.customW * m);
      spec.customH = clampSide(spec.customH * m);
    });
    multRow.append(btn);
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
  for (const c of CELL_SIZES) {
    const opt = document.createElement('option');
    opt.value = String(c.key);
    opt.textContent = c.label;
    cellSize.append(opt);
  }
  bind(cellSize, 'change', () => {
    spec.cellSize = cellSize.value === 'auto' ? 'auto' : Number(cellSize.value);
  });

  // --- Colours ---------------------------------------------------------------------
  //
  // The app's own picker rather than the OS one, for the reason the map uses it:
  // a colour here is chosen *against* the thing it will sit on, so it has to
  // repaint the picture as you drag rather than hand back an answer when you let
  // go of a modal. The swatch rows differ by what the colour is for — see
  // SWATCH_PRESETS — because a row of ten bright hues is no help at all when you
  // are picking type.
  const pickers = new Map();

  /**
   * Turn a swatch button into a picker.
   *
   * @param {string} key      where the value lives, for `sync` to read back
   * @param {HTMLElement} button
   * @param {string[]} presets
   * @param {(hex:string) => void} onPick
   */
  function colorPicker(key, button, presets, onPick) {
    if (!button) return;
    const panel = document.createElement('div');
    panel.className = 'menu-popover color-panel export-color-panel';
    panel.hidden = true;
    // On the overlay, not the card: the card scrolls and clips, and a fixed
    // panel inside a scrolling column drifts away from the swatch that opened
    // it. The overlay is also above the card, which is where this has to be.
    overlay.append(panel);
    pickers.set(
      key,
      mountColorPicker({
        button,
        panel,
        presets,
        value: '#60acff',
        place: () => {
          const b = button.getBoundingClientRect();
          // Left of the swatch and level with it: the swatches live in the
          // right-hand column, so there is nothing to the right of them, and a
          // panel that drops *below* one near the foot of a scrolling column
          // ends up over the buttons. The picker clamps this to the viewport.
          return { left: b.left - 278, top: b.top + b.height / 2 - 138 };
        },
        onInput: (hex) => {
          onPick(hex);
          save();
          sync();
          schedule();
        },
      }),
    );
  }

  colorPicker('accent', $('export-accent'), SWATCH_PRESETS.accent, (hex) => {
    spec.accent = hex;
  });
  colorPicker('text', $('export-textcolor'), SWATCH_PRESETS.ink, (hex) => {
    spec.caption.color = hex;
  });
  colorPicker('shadow', $('export-shadow-color'), SWATCH_PRESETS.ink, (hex) => {
    spec.caption.shadowColor = hex;
  });
  // `.export-swatch >`, not `[data-color]` on its own. The picker's own preset
  // buttons carry `data-color` too, and by the time this ran three panels full
  // of them were already children of the overlay — so a bare attribute selector
  // matched thirty-three elements instead of three and mounted a colour picker
  // on every preset swatch. Clicking a preset then opened *its* picker, which
  // closed the one you were using and placed a new panel against a 14 px button
  // near the edge of the screen: the picker appeared to jump to the corner.
  for (const button of overlay.querySelectorAll('.export-swatch > [data-color]')) {
    const slot = button.dataset.color;
    colorPicker(slot, button, SWATCH_PRESETS.surface, (hex) => {
      spec.colors[slot] = hex;
    });
  }

  const strength = $('export-strength');
  bind(strength, 'input', () => {
    spec.strength = Number(strength.value) / 100;
  });


  const surroundings = $('export-surroundings');
  bind(surroundings, 'input', () => {
    spec.surroundings = Number(surroundings.value) / 100;
  });

  const borders = $('export-borders');
  bind(borders, 'input', () => {
    spec.borders = Number(borders.value) / 100;
  });

  const lines = $('export-lines');
  bind(lines, 'input', () => {
    spec.lines = Number(lines.value) / 100;
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

  const shadow = $('export-shadow');
  bind(shadow, 'change', () => {
    spec.caption.shadow = shadow.checked;
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
    // Quality multiplies a preset. A size typed in pixels is already the answer,
    // so the select goes and the multipliers that act on the boxes take over.
    $('export-quality-row').hidden = spec.custom;
    multRow.hidden = !spec.custom;
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
    strength.value = String(Math.round(spec.strength * 100));

    const palette = paletteOf(spec);
    // The swatch shows the colour that will actually be painted, whether or not
    // anyone picked it — same as the caption's shadow below. Pressing it is then
    // an edit of what you can see rather than a jump to something else.
    pickers.get('accent')?.set(accentOf(spec));
    $('export-accent-auto').textContent = spec.accent ? 'Chosen' : 'Follows the look';
    for (const slot of ['background', 'land', 'edge']) {
      // A transparent background is a real value and the swatch shows it as
      // one — the picker draws over a checkerboard, which is the only honest
      // way for a control to say "nothing".
      const value = palette[slot];
      pickers.get(slot)?.set(/^#[0-9a-f]{3,8}$/i.test(String(value)) ? value : '#00000000');
    }
    surroundings.value = String(Math.round(spec.surroundings * 100));
    $('export-surroundings-note').textContent =
      spec.surroundings <= 0.001 ? 'Off' : `${Math.round(spec.surroundings * 100)}% behind the cut`;
    borders.value = String(Math.round(spec.borders * 100));
    $('export-borders-note').textContent =
      spec.borders <= 0.001 ? 'Off' : `${Math.round(spec.borders * 100)}%`;
    lines.value = String(Math.round(spec.lines * 100));
    // Nothing lies between two blobs, so the choice of which borders goes rather
    // than sitting there with all of it doing nothing — the same call the Cell
    // size row makes in the other direction. `lineAlphas` reads that detail the
    // same way, so the slider still means the silhouette rather than nothing.
    const blobbed = spec.detail === 'blob';
    $('export-lines-which').hidden = blobbed;
    const pct = `${Math.round(spec.lines * 100)}%`;
    const what = blobbed ? 'the outline' : LINE_SCOPE_NOTES[spec.lineScope] ?? 'borders';
    $('export-lines-note').textContent = spec.lines <= 0.001 ? 'Off' : `${pct} · ${what}`;

    captionOn.checked = spec.caption.on;
    $('export-caption-body').hidden = !spec.caption.on;
    title.value = spec.caption.title;
    fontSel.value = spec.caption.font;
    textSize.value = String(Math.round(spec.caption.size * 100));
    pickers.get('text')?.set(spec.caption.color || palette.text || '#ffffff');
    shadow.checked = spec.caption.shadow;
    $('export-shadow-body').hidden = !spec.caption.shadow;
    // Blank means "work it out from the text", which is the sensible answer and
    // the one most people want; the swatch shows what that came to so pressing
    // it is an edit rather than a jump.
    pickers.get('shadow')?.set(spec.caption.shadowColor || autoShadowColor());
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
   * In JS rather than in CSS — see `fitBox`, which is the arithmetic; this is
   * the part that knows what space there is to give it.
   *
   * Stacked, it also decides how tall the picture's row is. Beside the controls
   * the row is a column of the card and the height is a measurement; stacked, a
   * fixed share of the screen is a slab that only one shape fits — a 16:9
   * picture in a 46vh row was a third the height of its own hole, with the empty
   * bars above and below it pushing the controls off the bottom of the phone.
   * So the width decides the height and the shell is told what it came to. The
   * cap is the other end of the same problem: left alone, 9:16 would take the
   * screen and leave the controls a letterbox.
   */
  function fitFrame() {
    const full = sizeOf(spec);
    const box = shell.getBoundingClientRect();
    if (!box.width) return;
    // Inset by the room the picture's own drop shadow needs. Without it the
    // shadow is cropped flat against the edge of the box, which reads as the
    // picture being cut off rather than as a shadow running out.
    const m = frameMargin(box);
    const stacked = window.matchMedia(`(max-width: ${STACKED_MAX_PX}px)`).matches;
    const room = stacked
      ? (shell.closest('.export-body')?.clientHeight || box.height) * STAGE_MAX_SHARE
      : box.height;
    if (!room) return;
    const { w, h } = fitBox(
      full.w / full.h,
      Math.max(80, box.width - m * 2),
      Math.max(80, room - m * 2),
    );
    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(h)}px`;
    // Only ever grows or shrinks to what was just measured off the width, so the
    // ResizeObserver below settles after one extra pass rather than oscillating.
    shell.style.height = stacked ? `${Math.ceil(h + m * 2)}px` : '';
  }

  // Whatever changes the space the picture has — the window, the card, a
  // control section folding open — re-fits it. Every one of those used to have
  // to remember to call fitFrame, and the one that did not left the frame at
  // the size it had before, overflowing the column it sits in.
  let fitted = '';
  const shellWatcher = new ResizeObserver(() => {
    const box = shell.getBoundingClientRect();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (key === fitted) return;
    fitted = key;
    fitFrame();
    schedule();
  });
  shellWatcher.observe(shell);

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
  // Every finger currently on the picture. A phone has no wheel, so without this
  // there was no way at all to zoom the preview on one — the only gesture the
  // picture understood was a one-finger pan.
  const touches = new Map();
  let pinch = null;

  /** Redraw on the next frame rather than on every pointer event. */
  function paintSoon() {
    if (painting) return;
    painting = requestAnimationFrame(() => {
      painting = 0;
      draw();
    });
  }

  /** Move the camera by a screen-pixel delta. */
  function panBy(dxPx, dyPx) {
    const box = frame.getBoundingClientRect();
    const view = previewCamera();
    if (!view || !box.width || !spec.view) return;
    // Screen pixels → canvas pixels → Mercator metres. Dragging right moves the
    // world right, so the camera centre moves left.
    const toCanvas = view.size.w / box.width;
    spec.view.cx -= (dxPx * toCanvas) / view.cam.k;
    spec.view.cy += (dyPx * toCanvas) / view.cam.k;
  }

  /**
   * Multiply the zoom, keeping whatever is at (px, py) in canvas pixels exactly
   * where it is. That anchoring is the whole difference between a magnifier and
   * a slider, and it is what both the wheel and a pinch want.
   */
  function zoomAbout(px, py, factor) {
    const view = previewCamera();
    if (!view || !spec.view) return;
    const before = lngLatAt(view.cam, px, py);
    spec.view.zoom = Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], spec.view.zoom * factor));
    const after = previewCamera();
    if (!after) return;
    const [lng2, lat2] = lngLatAt(after.cam, px, py);
    spec.view.cx += mercX(before[0]) - mercX(lng2);
    spec.view.cy += mercY(before[1]) - mercY(lat2);
  }

  /** Where two fingers are, as one span and one midpoint. */
  function pinchState() {
    const [a, b] = [...touches.values()];
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  /** Where a pointer is in the preview's own pixels, which is what the rect is in. */
  function previewPointAt(e) {
    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const size = previewSize();
    return {
      px: ((e.clientX - box.left) / box.width) * size.w,
      py: ((e.clientY - box.top) / box.height) * size.h,
      size,
    };
  }

  /** Is this pointer on the caption? */
  function onCaption(e) {
    if (!spec.caption?.on) return false;
    const rect = captionRectOf(canvas);
    const p = previewPointAt(e);
    if (!rect || !p) return false;
    // Slack around the block, because the block is the ink and the target is the
    // thing: a one-line caption in a small font is a few pixels tall, and asking
    // for a finger on exactly that is asking for the map to pan instead.
    const pad = Math.max(8, p.size.h * 0.015);
    return p.px >= rect.x - pad && p.px <= rect.x + rect.w + pad
      && p.py >= rect.y - pad && p.py <= rect.y + rect.h + pad;
  }

  // Dragging the caption rather than the picture. A separate gesture from the
  // pan below and deliberately not part of it: `drag` moves the camera and needs
  // `spec.view` pinned first, and the caption has nothing to do with where the
  // map is looking.
  let capDrag = null;

  canvas.addEventListener('pointerdown', (e) => {
    // The caption is drawn over the picture, so a press that lands on it is
    // about the text. Single pointer only — the second finger of a pinch is
    // always the map, whatever it happens to land on.
    if (!capDrag && !pinch && touches.size === 0 && onCaption(e)) {
      canvas.setPointerCapture(e.pointerId);
      capDrag = { id: e.pointerId, px: e.clientX, py: e.clientY };
      frame.classList.add('dragging');
      return;
    }
    const view = atPointer(e);
    if (!view) return;
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    holdView(view);
    if (touches.size >= 2) {
      // Two fingers is a pinch, and dropping the drag here is what stops the
      // second finger landing and yanking the picture halfway across the frame.
      drag = null;
      frame.classList.remove('dragging');
      pinch = pinchState();
    } else {
      drag = { id: e.pointerId, px: e.clientX, py: e.clientY, moved: 0 };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (capDrag && e.pointerId === capDrag.id) {
      const box = frame.getBoundingClientRect();
      if (box.width && box.height) {
        // In fractions of the frame, which is the same fraction of the canvas
        // whatever size either of them is — so the drag lands in the same place
        // in a 5,760px export as it looks in a 700px preview.
        const n = spec.caption.nudge ?? { x: 0, y: 0 };
        spec.caption.nudge = {
          x: Math.min(1, Math.max(-1, n.x + (e.clientX - capDrag.px) / box.width)),
          y: Math.min(1, Math.max(-1, n.y + (e.clientY - capDrag.py) / box.height)),
        };
        capDrag.px = e.clientX;
        capDrag.py = e.clientY;
        paintSoon();
      }
      return;
    }
    // Only a hint, and only while nothing is being dragged: the pointer changes
    // over the caption so that it looks like something you can pick up. Without
    // it the whole gesture is undiscoverable — there is nothing else on screen
    // to say the text is not simply painted on.
    if (!drag && !pinch && !touches.size) {
      canvas.style.cursor = onCaption(e) ? 'move' : '';
    }
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!spec.view) return;

    if (pinch && touches.size >= 2) {
      const now = pinchState();
      // The midpoint drags the picture exactly as a single finger would, and the
      // spread zooms about wherever the midpoint has got to. Both, in that
      // order: a pinch that only scales feels pinned to the middle of the frame
      // rather than to the two fingers doing it.
      panBy(now.mx - pinch.mx, now.my - pinch.my);
      const box = frame.getBoundingClientRect();
      const size = previewSize();
      if (box.width && box.height) {
        zoomAbout(
          ((now.mx - box.left) / box.width) * size.w,
          ((now.my - box.top) / box.height) * size.h,
          now.dist / pinch.dist,
        );
      }
      pinch = now;
      sync();
      paintSoon();
      return;
    }

    if (!drag || e.pointerId !== drag.id) return;
    panBy(e.clientX - drag.px, e.clientY - drag.py);
    drag.moved += Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py);
    drag.px = e.clientX;
    drag.py = e.clientY;
    frame.classList.add('dragging');
    paintSoon();
  });

  function endDrag(e) {
    // Its own exit, before the pan's: a caption drag never entered `touches`, so
    // the line below would drop it on the floor and leave `capDrag` set — every
    // later pointer would then go on moving the caption.
    if (capDrag && e.pointerId === capDrag.id) {
      capDrag = null;
      frame.classList.remove('dragging');
      // Saved on release rather than per move: the position is worth keeping and
      // a drag is a hundred of them.
      save();
      sync();
      schedule();
      return;
    }
    if (!touches.delete(e.pointerId)) return;
    if (pinch) {
      if (touches.size >= 2) {
        pinch = pinchState();
        return;
      }
      // One finger of a pinch lifted. The other is still down, but carrying on
      // as a drag from it would jump the picture by half the span between them,
      // and a pinch that ends on a tap must not toggle a country either. So the
      // gesture is over, and the finger left behind does nothing until it lifts.
      pinch = null;
      drag = null;
      frame.classList.remove('dragging');
      sync();
      schedule();
      return;
    }
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
      // About the pointer, so whatever was under it stays under it.
      zoomAbout(view.px, view.py, Math.exp(-e.deltaY * ZOOM_STEP));
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

  // The host that can actually write a file, or null in a browser.
  //
  // **`a.download` does nothing inside a `WKWebView`.** The anchor is created,
  // clicked, and ignored — no download, no error, no way to feature-detect it
  // from the page. Which meant both apps showed "Saved …" and saved nothing,
  // the one failure mode worse than an error message. Named and detected the
  // same way as the photo bridge: the handler is either there or it is not, so
  // a browser takes the anchor path below and nothing has to guess.
  //
  // Changing this name means changing `SaveBridge.name` in both apps.
  const saveHost = () => globalThis.webkit?.messageHandlers?.sporraSave ?? null;

  /** The bytes as base64, which is the only shape that survives the bridge. */
  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      // "data:image/png;base64,XXXX" — everything after the first comma.
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
      reader.readAsDataURL(blob);
    });

  async function download() {
    if (!numbers) return;
    fail(null);

    // The detailed boundaries for everything in the frame, and this time waited
    // for. The preview is allowed to be blunt — it is redrawn on every drag of a
    // slider, and `FINE_COUNTRY_LIMIT` keeps that affordable by fetching nothing
    // at all once the frame reaches more than ten countries. The file is not a
    // preview: a European framing crosses that line easily, and the poster came
    // out drawn entirely from the overview geometry.
    //
    // Asked at the file's own size, so the frame is the file's frame. Failures
    // are ignored exactly as they are for the preview — a country nobody has
    // boundaries for keeps the ones we shipped, and that is a picture rather
    // than an error.
    const save = $('export-save');
    const said = save.textContent;
    save.disabled = true;
    save.textContent = 'Sharpening…';
    try {
      await ensureSharpBoundaries(spec.scope, { spec, data, size: sizeOf(spec), all: true });
    } catch {
      /* keep the overview geometry */
    } finally {
      save.disabled = false;
      save.textContent = said;
    }
    // The preview is looking at the same shapes and can have them too.
    draw();

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
    const name = exportFilename(spec, numbers);

    // In an app: hand the bytes over and let it put them somewhere a person can
    // find — the photo library on a phone, Downloads on a Mac.
    const host = saveHost();
    if (host) {
      let reply;
      try {
        reply = await host.postMessage({ ask: 'png', name, data: await blobToBase64(blob) });
      } catch (e) {
        fail(`The picture could not be saved — ${e?.message ?? e}`);
        return;
      }
      if (!reply?.ok) {
        // Every refusal is a sentence somebody has to read: permission not
        // granted, disk full, a name that could not be written.
        fail(reply?.error ?? 'The picture could not be saved.');
        return;
      }
      showToast(reply.where ? `Saved to ${reply.where}` : `Saved ${name}`);
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
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
    save();
    sync();
    schedule();
  });
  // Clicking the backdrop closes — but only when the click *started* there too.
  // This dialog met that first, with a slider: letting go outside the card fires
  // a click on the overlay and it shut itself mid-drag. src/dismiss.js is that
  // answer, now that every other dialog turned out to need it for selected text.
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
  // The preview is sized from the element it sits in, so it has to be redrawn
  // when that element changes size — a rotated phone otherwise keeps a picture
  // rendered for the width it used to have.
  window.addEventListener('resize', () => schedule());

  return { open, close };
}
