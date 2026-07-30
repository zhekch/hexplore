// The month grid, in the two places that ask "which weekend was that?".
//
// Its own grid rather than `<input type="date">`: the native picker is an
// opaque OS panel that cannot show which days have anything on them, and that
// is the only reason to open a calendar here at all.
//
// It lives in its own module because it has two hosts. The search palette has
// always had it; the Trips tab now does too, because browsing trips by name and
// browsing them by date are the same question asked twice, and they used to be
// two screens. Both hosts hand it the same three things — which days have
// something on them, which trip each day belongs to, and what to do when one is
// picked — and get back a grid that knows how to draw itself.

import { dayKey, tripDays } from './trips.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export { MONTHS };

/**
 * @param {object} opts
 * @param {HTMLElement} opts.title  where the month's name goes
 * @param {HTMLElement} opts.grid   where the days go
 * @param {() => Map<string, {cells:number, routes:number}>} opts.days
 * @param {() => Array<object>} opts.trips
 * @param {(key:string) => void} opts.onPick
 * @returns {{render():void, show(month:Date):void, month():Date, step(by:number):void,
 *   select(key:string|null):void, selected():string|null}}
 */
export function mountCalendar({ title, grid, days, trips, onPick }) {
  let month = new Date();
  let selected = null;

  function render() {
    const y = month.getFullYear();
    const m = month.getMonth();
    if (title) title.textContent = `${MONTHS[m]} ${y}`;
    grid.replaceChildren();
    for (const w of WEEKDAYS) {
      const el = document.createElement('div');
      el.className = 'cal-weekday';
      el.textContent = w;
      grid.append(el);
    }
    // Monday-first, which is what the rest of the app's dates assume.
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) {
      const el = document.createElement('div');
      el.className = 'cal-day cal-blank';
      grid.append(el);
    }
    const active = days();
    const onTrip = tripDays(trips());
    const todayKey = dayKey(Math.floor(Date.now() / 1000));
    const last = new Date(y, m + 1, 0).getDate();
    const keyOf = (d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    for (let d = 1; d <= last; d++) {
      const key = keyOf(d);
      const has = active.get(key);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cal-day';
      el.classList.toggle('has', !!has);
      el.classList.toggle('today', key === todayKey);
      el.classList.toggle('picked', key === selected);
      el.innerHTML = `<span>${d}</span><i></i>`;
      if (has) {
        el.title = [
          has.cells ? `${has.cells} new cell${has.cells === 1 ? '' : 's'}` : '',
          has.routes ? `${has.routes} route${has.routes === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');
        // A day that only added ground and a day you recorded a ride on are
        // different kinds of day, and the dot says which.
        el.classList.toggle('has-route', !!has.routes);
      }
      // A trip is one journey, so it is drawn as one shape: the dot of each day
      // in it grows into a pill. Loose dots said "something happened on the
      // 4th, the 5th and the 8th"; the pills say you were away from the 4th to
      // the 8th, which is the thing you are actually looking for in a month
      // grid. The days inside it with nothing recorded stay dim — they are part
      // of the journey, not evidence of it.
      const trip = onTrip.get(key);
      if (trip) {
        el.classList.add('trip');
        el.title = `${trip.name}${el.title ? ` · ${el.title}` : ''}`;
        // Which way the pill grows, which is only towards a neighbour in the
        // same trip. Nothing reaches outside its own day, so the last day of a
        // month and the end of a week need no special case.
        if (d > 1 && onTrip.get(keyOf(d - 1)) === trip) el.classList.add('trip-l');
        if (d < last && onTrip.get(keyOf(d + 1)) === trip) el.classList.add('trip-r');
      }
      el.addEventListener('click', () => onPick(key));
      grid.append(el);
    }
  }

  return {
    render,
    month: () => month,
    show(next) {
      month = next;
      render();
    },
    step(by) {
      month = new Date(month.getFullYear(), month.getMonth() + by, 1);
      render();
    },
    select(key) {
      selected = key;
      render();
    },
    selected: () => selected,
  };
}
