// A color picker in the app's own glass, instead of the OS one.
//
// `<input type="color">` opens whatever the platform provides — a big grey
// macOS panel, a full-screen Android sheet — which is the one place the app
// stops looking like itself. This is the same idea in the same materials: a
// swatch you tap, a floating panel with a saturation/brightness field, a hue
// strip, a hex box and a few presets.
//
// Everything is pointer-events based, so a drag works the same under a mouse,
// a finger or a stylus, and `setPointerCapture` keeps the drag alive when it
// leaves the element — which is most of a drag, on a small field.

// --- Color maths ---------------------------------------------------------------
// HSV rather than HSL: a saturation/brightness square with a hue strip beside it
// is the arrangement people already know, and it maps directly onto HSV.
//
// Opacity rides along as a fourth digit pair — "#60acffcc" — which is a real
// CSS colour, so anything that only ever assigns it to a style keeps working
// without knowing this feature exists. Everything that takes a colour *apart*
// has to be told, and `hexToRgb` is where that starts: it accepts eight digits
// and hands back three numbers, because the callers doing arithmetic on
// channels want the colour, not its transparency.
export function hexToRgb(hex) {
  const s = String(hex ?? '').trim().replace(/^#/, '');
  const full = s.length === 3 || s.length === 4 ? s.replace(/./g, (c) => c + c) : s;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The opacity carried by a colour, 0..1. A colour without one is opaque —
 * which is what every stored value was before this existed.
 */
export function hexAlpha(hex) {
  const s = String(hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{4}$/i.test(s)) return parseInt(s[3] + s[3], 16) / 255;
  if (/^[0-9a-f]{8}$/i.test(s)) return parseInt(s.slice(6), 16) / 255;
  return 1;
}

/** The colour without its opacity, for the arithmetic that only wants channels. */
export const hexOpaque = (hex) => {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : String(hex ?? '');
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hex2 = (v) => Math.round(v).toString(16).padStart(2, '0');

export function rgbToHex([r, g, b]) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function rgbToHsv([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d + 6) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb([h, s, v]) {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0]
    : hh < 2 ? [x, c, 0]
    : hh < 3 ? [0, c, x]
    : hh < 4 ? [0, x, c]
    : hh < 5 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// Full opacity is written as six digits, not as "…ff": every colour stored
// before this existed is six digits, and emitting eight would rewrite them all
// on first paint for no change in what anyone sees.
const hsvToHex = (hsv, a = 1) =>
  `${rgbToHex(hsvToRgb(hsv))}${a >= 1 ? '' : hex2(clamp01(a) * 255)}`;

// Handpicked rather than a generated ramp: these are the colors that actually
// look right as a translucent wash over both basemaps.
//
// A row of ten, because the picker's job is nearly always "something like that
// but bluer" and a hue wheel is a slow way to say it. Callers with a different
// job pass their own — the image export's text colour wants a column of greys
// and near-blacks, and none of the ten below is one.
export const PRESETS = [
  '#60acff', '#7c8cff', '#b98cff', '#ff7ab8', '#ff7a6b',
  '#ff9f43', '#ffd25c', '#8fd14f', '#3ecf8e', '#2fd4c8',
];

/**
 * Turn a button into a color swatch that opens a picker panel.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.button   the swatch; its background shows the value
 * @param {HTMLElement} opts.panel    the (hidden) popover element to fill
 * @param {string} opts.value         initial color, "#rrggbb"
 * @param {(hex:string) => void} opts.onInput   fires continuously while dragging
 * @param {() => {left:number, top:number}} [opts.place] where to put the panel
 * @param {string[]} [opts.presets] the swatch row, for callers whose colour is
 *   doing a different job from the visited wash
 * @returns {{ set(hex:string):void, get():string, close():void, isOpen():boolean }}
 */
// Only one picker is ever open. Each instance stops the click on its own button
// from propagating (otherwise the swatch's own document listener would close the
// panel it just opened) — which means a second picker's button click never
// reaches the first one's document listener, so the first stayed open and you
// had to dismiss it by hand. A shared reference is the fix: opening one closes
// whichever was open, whoever owns it.
let openPicker = null;

export function mountColorPicker({ button, panel, value, onInput, place, presets = PRESETS }) {
  let hsv = rgbToHsv(hexToRgb(value) ?? [96, 172, 255]);
  let alpha = hexAlpha(value);
  let open = false;

  panel.classList.add('cp');
  panel.innerHTML = `
    <div class="cp-area" tabindex="0" role="slider" aria-label="Saturation and brightness">
      <div class="cp-area-sat"></div>
      <div class="cp-area-val"></div>
      <div class="cp-knob"></div>
    </div>
    <div class="cp-hue" tabindex="0" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="359">
      <div class="cp-hue-knob"></div>
    </div>
    <div class="cp-alpha" tabindex="0" role="slider" aria-label="Opacity" aria-valuemin="0" aria-valuemax="100">
      <div class="cp-alpha-ramp"></div>
      <div class="cp-alpha-knob"></div>
    </div>
    <div class="cp-foot">
      <span class="cp-preview"></span>
      <input class="cp-hex" type="text" spellcheck="false" autocomplete="off"
        autocapitalize="none" autocorrect="off" maxlength="9" aria-label="Hex color" />
    </div>
    <div class="cp-presets">${presets.map(
      (c) => `<button type="button" class="cp-preset" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
    ).join('')}</div>
  `;

  const area = panel.querySelector('.cp-area');
  const knob = panel.querySelector('.cp-knob');
  const hue = panel.querySelector('.cp-hue');
  const hueKnob = panel.querySelector('.cp-hue-knob');
  const alphaStrip = panel.querySelector('.cp-alpha');
  const alphaRamp = panel.querySelector('.cp-alpha-ramp');
  const alphaKnob = panel.querySelector('.cp-alpha-knob');
  const preview = panel.querySelector('.cp-preview');
  const hexBox = panel.querySelector('.cp-hex');

  // --- Painting ----------------------------------------------------------------
  function paint({ typing = false } = {}) {
    const hex = hsvToHex(hsv, alpha);
    const solid = hsvToHex(hsv);
    area.style.setProperty('--cp-hue', `hsl(${hsv[0]}, 100%, 50%)`);
    // 0..1 fractions, not percentages: the CSS maps them across (track − knob)
    // so a knob at either extreme sits inside its track rather than half out.
    knob.style.setProperty('--kx', String(hsv[1]));
    knob.style.setProperty('--ky', String(1 - hsv[2]));
    knob.style.background = solid;
    hueKnob.style.setProperty('--kx', String(hsv[0] / 360));
    // The ramp runs from nothing to this colour at full strength, over the
    // checkerboard the track already carries — the only way a strip can show
    // transparency rather than just claim it.
    alphaRamp.style.background = `linear-gradient(to right, transparent, ${solid})`;
    alphaKnob.style.setProperty('--kx', String(alpha));
    alphaKnob.style.background = hex;
    // Through the variable, not the background property: both of these draw the
    // colour as a layer over a checkerboard (see .color-swatch in style.css),
    // and assigning their background directly would paint over the board that
    // makes a translucent colour look translucent.
    preview.style.setProperty('--swatch', hex);
    button.style.setProperty('--swatch', hex);
    button.setAttribute('aria-label', `Visited color, ${hex}`);
    area.setAttribute('aria-valuetext', hex);
    hue.setAttribute('aria-valuenow', String(Math.round(hsv[0])));
    alphaStrip.setAttribute('aria-valuenow', String(Math.round(alpha * 100)));
    alphaStrip.setAttribute('aria-valuetext', `${Math.round(alpha * 100)}% opaque`);
    // Don't fight the field while it's being typed in.
    if (!typing) hexBox.value = hex;
    return hex;
  }

  const emit = (opts) => onInput?.(paint(opts));

  // --- Dragging ------------------------------------------------------------------
  // One handler for both strips. Pointer capture keeps the drag alive once the
  // finger leaves the element, which on a 150px-wide field is most of the time.
  function draggable(el, onAt) {
    const at = (e) => {
      const r = el.getBoundingClientRect();
      onAt(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
      emit();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.dataset.dragging = '1';
      at(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.dataset.dragging) at(e);
    });
    for (const type of ['pointerup', 'pointercancel']) {
      el.addEventListener(type, (e) => {
        delete el.dataset.dragging;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      });
    }
    // Touch drags inside the panel must not scroll the menu behind it.
    el.style.touchAction = 'none';
  }

  draggable(area, (x, y) => {
    hsv = [hsv[0], x, 1 - y];
  });
  draggable(hue, (x) => {
    hsv = [x * 360, hsv[1], hsv[2]];
  });
  draggable(alphaStrip, (x) => {
    alpha = x;
  });

  // Arrow keys, for anyone not using a pointer at all.
  area.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!move) return;
    e.preventDefault();
    hsv = [hsv[0], clamp01(hsv[1] + move[0]), clamp01(hsv[2] + move[1])];
    emit();
  });
  hue.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 30 : 5) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (!step) return;
    e.preventDefault();
    hsv = [(((hsv[0] + step) % 360) + 360) % 360, hsv[1], hsv[2]];
    emit();
  });
  alphaStrip.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 0.1 : 0.02) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (!step) return;
    e.preventDefault();
    alpha = clamp01(alpha + step);
    emit();
  });

  hexBox.addEventListener('input', () => {
    const rgb = hexToRgb(hexBox.value);
    if (!rgb) return; // half-typed — leave the rest alone until it parses
    hsv = rgbToHsv(rgb);
    alpha = hexAlpha(hexBox.value);
    emit({ typing: true });
  });
  hexBox.addEventListener('blur', () => paint());

  // A preset is a colour, not a colour *and* an opacity: reaching for a nicer
  // blue shouldn't silently undo the transparency you just dialled in.
  for (const btn of panel.querySelectorAll('.cp-preset')) {
    btn.addEventListener('click', () => {
      hsv = rgbToHsv(hexToRgb(btn.dataset.color));
      emit();
    });
  }

  // --- Opening -------------------------------------------------------------------
  function position() {
    const pad = 10;
    const box = panel.getBoundingClientRect();
    const want = place?.() ?? { left: button.getBoundingClientRect().left, top: button.getBoundingClientRect().bottom + 8 };
    const left = Math.min(Math.max(pad, want.left), window.innerWidth - box.width - pad);
    const top = Math.min(Math.max(pad, want.top), window.innerHeight - box.height - pad);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function show() {
    if (openPicker && openPicker !== api) openPicker.close();
    openPicker = api;
    panel.hidden = false;
    open = true;
    button.classList.add('active');
    paint();
    position();
  }

  function close() {
    if (openPicker === api) openPicker = null;
    if (!open) return;
    panel.hidden = true;
    open = false;
    button.classList.remove('active');
  }

  const onButton = (e) => {
    e.stopPropagation();
    if (open) close();
    else show();
  };
  const onPanel = (e) => e.stopPropagation();
  const onDocClick = (e) => {
    if (open && !panel.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && open) close();
  };

  button.addEventListener('click', onButton);
  panel.addEventListener('click', onPanel);
  document.addEventListener('click', onDocClick);
  window.addEventListener('keydown', onKey);

  paint();

  const api = {
    // The accent picker is mounted once and lives as long as the page, but the
    // per-activity ones are rebuilt whenever the routes menu re-renders — and
    // two of those listeners are on `document`/`window`, so without a way to
    // take them off again every re-render would leave another pair behind.
    destroy() {
      close();
      button.removeEventListener('click', onButton);
      panel.removeEventListener('click', onPanel);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKey);
    },
    set(hex) {
      const rgb = hexToRgb(hex);
      if (!rgb) return;
      hsv = rgbToHsv(rgb);
      alpha = hexAlpha(hex);
      paint();
    },
    get: () => hsvToHex(hsv, alpha),
    close,
    isOpen: () => open,
  };
  return api;
}
