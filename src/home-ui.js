// "Where you live" — the one number in the Trips tab that is a guess about you.
//
// Everything there is measured from home: what counts as away, how far a trip
// went, whether a run of days is a trip at all. The guess (the centre of
// gravity of the cells you visit most) is right for most people most of the
// time and wrong in a way nobody could debug — a second flat, a year abroad, a
// map that starts with an imported holiday. So it is shown, and it is
// correctable, by something more precise than another guess.

import { loadPlaces, searchPlaces } from './places.js';

/**
 * @param {object} opts
 * @param {() => ({lng:number, lat:number}|null)} opts.center where the map is looking
 * @param {(home:{lng:number, lat:number, name:string}|null) => Promise<void>|void} opts.onSet
 * @param {() => void} [opts.onClose] called when dismissed with Back
 */
export function mountHome({ center, onSet, onClose }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('home-overlay');
  const currentEl = $('home-current');
  const input = $('home-search');
  const hitsEl = $('home-hits');
  const hereBtn = $('home-here');
  const clearBtn = $('home-clear');
  const errEl = $('home-error');

  let current = null;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  function renderCurrent() {
    currentEl.replaceChildren();
    const line = document.createElement('div');
    line.innerHTML = current
      ? `Home is <b>${''}</b>`
      : 'Home is <b>worked out from the cells you visit most</b>';
    if (current) line.querySelector('b').textContent = current.name || 'the place you set';
    currentEl.append(line);
    clearBtn.hidden = !current;
  }

  async function pick(home) {
    showErr('');
    try {
      await onSet?.(home);
      current = home;
      renderCurrent();
      close();
    } catch (e) {
      showErr(String(e.message ?? e));
    }
  }

  function renderHits(list) {
    hitsEl.replaceChildren();
    for (const p of list) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'home-hit';
      el.innerHTML = '<b></b><small></small>';
      el.querySelector('b').textContent = p.name;
      el.querySelector('small').textContent = p.pop ? `${p.pop.toLocaleString()},000 people` : 'Town';
      el.addEventListener('click', () => pick({ lng: p.lng, lat: p.lat, name: p.name }));
      hitsEl.append(el);
    }
  }

  input.addEventListener('input', async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      hitsEl.replaceChildren();
      return;
    }
    await loadPlaces();
    renderHits(searchPlaces(q, 6).filter((p) => p.kind === 'town'));
  });

  // The map is already pointed at somewhere by the time anyone opens this, and
  // "here" is easier to be sure about than a name in a list of thousands.
  hereBtn.addEventListener('click', () => {
    const c = center?.();
    if (!c) return;
    pick({ lng: c.lng, lat: c.lat, name: 'The middle of the map' });
  });

  clearBtn.addEventListener('click', () => pick(null));

  const open = (existing) => {
    current = existing ?? null;
    overlay.hidden = false;
    input.value = '';
    hitsEl.replaceChildren();
    showErr('');
    renderCurrent();
    loadPlaces().catch(() => {});
    input.focus();
  };
  const close = () => {
    overlay.hidden = true;
  };

  $('home-close').addEventListener('click', close);
  $('home-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
