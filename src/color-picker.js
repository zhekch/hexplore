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
export function hexToRgb(hex) {
  const s = String(hex ?? '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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

const hsvToHex = (hsv) => rgbToHex(hsvToRgb(hsv));

// Handpicked rather than a generated ramp: these are the colors that actually
// look right as a translucent wash over both basemaps.
const PRESETS = [
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
 * @returns {{ set(hex:string):void, get():string, close():void, isOpen():boolean }}
 */
// Only one picker is ever open. Each instance stops the click on its own button
// from propagating (otherwise the swatch's own document listener would close the
// panel it just opened) — which means a second picker's button click never
// reaches the first one's document listener, so the first stayed open and you
// had to dismiss it by hand. A shared reference is the fix: opening one closes
// whichever was open, whoever owns it.
let openPicker = null;

export function mountColorPicker({ button, panel, value, onInput, place }) {
  let hsv = rgbToHsv(hexToRgb(value) ?? [96, 172, 255]);
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
    <div class="cp-foot">
      <span class="cp-preview"></span>
      <input class="cp-hex" type="text" spellcheck="false" autocomplete="off"
        autocapitalize="none" autocorrect="off" maxlength="7" aria-label="Hex color" />
    </div>
    <div class="cp-presets">${PRESETS.map(
      (c) => `<button type="button" class="cp-preset" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
    ).join('')}</div>
  `;

  const area = panel.querySelector('.cp-area');
  const knob = panel.querySelector('.cp-knob');
  const hue = panel.querySelector('.cp-hue');
  const hueKnob = panel.querySelector('.cp-hue-knob');
  const preview = panel.querySelector('.cp-preview');
  const hexBox = panel.querySelector('.cp-hex');

  // --- Painting ----------------------------------------------------------------
  function paint({ typing = false } = {}) {
    const hex = hsvToHex(hsv);
    area.style.setProperty('--cp-hue', `hsl(${hsv[0]}, 100%, 50%)`);
    // 0..1 fractions, not percentages: the CSS maps them across (track − knob)
    // so a knob at either extreme sits inside its track rather than half out.
    knob.style.setProperty('--kx', String(hsv[1]));
    knob.style.setProperty('--ky', String(1 - hsv[2]));
    knob.style.background = hex;
    hueKnob.style.setProperty('--kx', String(hsv[0] / 360));
    preview.style.background = hex;
    button.style.setProperty('--swatch', hex);
    button.setAttribute('aria-label', `Visited color, ${hex}`);
    area.setAttribute('aria-valuetext', hex);
    hue.setAttribute('aria-valuenow', String(Math.round(hsv[0])));
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

  hexBox.addEventListener('input', () => {
    const rgb = hexToRgb(hexBox.value);
    if (!rgb) return; // half-typed — leave the rest alone until it parses
    hsv = rgbToHsv(rgb);
    emit({ typing: true });
  });
  hexBox.addEventListener('blur', () => paint());

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
      paint();
    },
    get: () => hsvToHex(hsv),
    close,
    isOpen: () => open,
  };
  return api;
}
