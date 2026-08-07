// The "3D basemap" dialog: somewhere to put a Mapbox token.
//
// It is the only credential this app asks anyone for that is not its own, and
// the only one it deliberately never sends to the server, so it gets a dialog
// rather than a row: there is a paragraph's worth of *why am I being asked
// this* to answer, and a row in a list is not the place to answer it.
//
// The check on save is not decoration either. A Mapbox token can be wrong in
// four ways that all look identical from the map — mistyped, expired, scoped
// without `styles:read`, or URL-restricted to somebody else's domain — and each
// of them shows up as a basemap that quietly falls back to Dark. Asking Mapbox
// at the moment the token is pasted is the difference between "that token is
// restricted to other URLs" and half an hour of wondering why the button does
// nothing.

import {
  LIGHT_PRESETS, checkMapboxToken, lightPreset, mapboxToken, setLightPreset, setMapboxToken,
  tokenComplaint,
} from './mapbox.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]  called when the dialog is dismissed with Back
 * @param {(token: string) => void} [opts.onToken] a token was saved or cleared
 * @param {(key: string) => void} [opts.onPreset] the light preset was changed
 */
export function mountMapbox({ onClose, onToken, onPreset } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('mapbox-overlay');
  const input = $('mapbox-token');
  const saveBtn = $('mapbox-save');
  const clearBtn = $('mapbox-clear');
  const note = $('mapbox-note');
  const lightSeg = $('mapbox-light-seg');

  /** Say something under the field, in one of three registers. */
  const say = (text, kind) => {
    note.textContent = text ?? '';
    note.hidden = !text;
    note.classList.toggle('ok', kind === 'ok');
    note.classList.toggle('bad', kind === 'bad');
  };

  // Standard's four light presets. Built from the list rather than written into
  // the markup so the two cannot drift, the same as the railway's group rows.
  lightSeg.replaceChildren(...LIGHT_PRESETS.map((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.light = preset.key;
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      setLightPreset(preset.key);
      drawLight();
      onPreset?.(preset.key);
    });
    return btn;
  }));

  function drawLight() {
    const now = lightPreset();
    for (const btn of lightSeg.querySelectorAll('[data-light]')) {
      btn.classList.toggle('active', btn.dataset.light === now);
    }
  }

  function draw() {
    const held = mapboxToken();
    input.value = held;
    clearBtn.hidden = !held;
    drawLight();
    // Deliberately not re-checked on every opening: that is a network request
    // for a question nobody asked, and the answer was already given when the
    // token went in. It says what is *stored*, which is the thing the dialog is
    // about.
    say(held ? 'A token is saved on this device.' : '', held ? 'ok' : null);
  }

  async function save() {
    const token = input.value.trim();
    // Emptying the box and pressing Save is how you take it off, and it should
    // not be answered with "a Mapbox public token starts with pk."
    if (!token) return clear();
    const complaint = tokenComplaint(token);
    if (complaint) return say(complaint, 'bad');

    saveBtn.disabled = true;
    say('Asking Mapbox…');
    const { ok, why } = await checkMapboxToken(token);
    saveBtn.disabled = false;
    if (!ok) return say(why ?? 'That token did not work.', 'bad');

    setMapboxToken(token);
    clearBtn.hidden = false;
    say('Working — the 3D basemap is in the layers menu.', 'ok');
    onToken?.(token);
  }

  function clear() {
    setMapboxToken('');
    input.value = '';
    clearBtn.hidden = true;
    say('Token removed from this device.');
    onToken?.('');
  }

  const open = () => {
    draw();
    overlay.hidden = false;
    // Not focused on a phone, where it would throw the keyboard up over the
    // paragraph explaining what the field is for.
    if (!matchMedia('(hover: none)').matches) input.focus();
  };
  const close = () => {
    overlay.hidden = true;
  };

  saveBtn.addEventListener('click', save);
  clearBtn.addEventListener('click', clear);
  // A token is one long line pasted from somewhere else; Return is the natural
  // way to finish it.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
  // Anything typed invalidates whatever the last answer was talking about.
  input.addEventListener('input', () => say(''));

  $('mapbox-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('mapbox-done').addEventListener('click', close);
  $('mapbox-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
