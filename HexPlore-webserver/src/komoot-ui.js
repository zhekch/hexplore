// The "Komoot" dialog: paste a tour link, see what it is, keep it.
//
// The fetch happens in this tab, straight to Komoot (src/komoot.js) — the
// server never sees the link or the tour. That's the same bargain the file
// importer makes, and it means pasting ten tours costs this server nothing.

import { auth } from './auth.js';
import { parseKomootUrls, fetchTour, tourUrl } from './komoot.js';
import { pointsToCells } from './locations.js';
import { buildRoutes, formatDistance, formatDuration } from './routes.js';
import { loadPlaces, describeRoute, isGenericName } from './places.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const n = (v) => v.toLocaleString();

/**
 * @param {object} opts
 * @param {() => Set<string>} opts.knownCells cells already on the map
 * @param {(what:{routes:boolean}) => Promise<void>} opts.onImported
 * @param {() => void} [opts.onClose] called when the dialog is dismissed
 */
export function mountKomoot({ knownCells, onImported, onClose }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('komoot-overlay');
  const urlEl = $('komoot-url');
  const report = $('komoot-report');
  const errEl = $('komoot-error');
  const routesRow = $('komoot-routes-row');
  const routesBox = $('komoot-routes');
  const goBtn = $('komoot-go');
  const backBtn = $('komoot-back');
  const closeBtn = $('komoot-close');

  // { tours:[{tour, fixes}], failed:[{id, message}], cells, routes, fixes }
  let found = null;
  let busy = false;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  const linkCount = () => parseKomootUrls(urlEl.value).length;

  function lookupLabel() {
    const count = linkCount();
    return count > 1 ? `Look up ${count} tours` : 'Look up';
  }

  const routesLabel = routesRow.querySelector('span').firstChild;
  const ROUTES_LABEL = routesLabel.textContent;

  function reset() {
    found = null;
    report.replaceChildren();
    report.hidden = true;
    routesRow.hidden = true;
    routesBox.checked = true;
    // renderReport rewrites this for a multi-tour paste; a later single tour
    // must not inherit "Save 7 routes".
    routesLabel.textContent = ROUTES_LABEL;
    goBtn.textContent = lookupLabel();
    goBtn.disabled = !linkCount();
    delete goBtn.dataset.done;
    showErr('');
  }

  // --- Looking them up -----------------------------------------------------------
  async function lookup() {
    const refs = parseKomootUrls(urlEl.value);
    if (!refs.length) {
      showErr('No Komoot tour links in there.');
      return;
    }
    busy = true;
    reset();
    goBtn.disabled = true;
    goBtn.textContent = refs.length > 1 ? `Looking up 1 of ${refs.length}…` : 'Looking up…';
    try {
      // The place names are their own ~2 MB chunk; start it alongside the fetches.
      const places = loadPlaces().catch(() => false);

      // One at a time. Ten tours is ~20 requests to somebody else's undocumented
      // API, and a burst of parallel fetches is how a personal integration gets
      // itself rate limited; the wait is a second or two per tour either way.
      const tours = [];
      const failed = [];
      const allPoints = [];
      const routes = [];
      for (const [i, ref] of refs.entries()) {
        goBtn.textContent = refs.length > 1 ? `Looking up ${i + 1} of ${refs.length}…` : 'Looking up…';
        try {
          const { tour, points, tracks } = await fetchTour(ref);
          tours.push({ tour, fixes: points.length });
          allPoints.push(...points);
          // Keep the way back to the tour itself — stripped of the referral
          // tail Komoot appends when you copy a share link.
          const link = tourUrl(ref);
          routes.push(
            ...buildRoutes(tracks, { source: 'komoot', fileName: tour.name })
              .map((route) => ({ ...route, link })),
          );
        } catch (e) {
          // One private or mistyped tour shouldn't cost you the other nine.
          failed.push({ id: ref.id, message: e.message || 'could not be read' });
        }
      }
      if (!tours.length) {
        showErr(
          failed.length === 1
            ? failed[0].message
            : `None of those ${failed.length} tours could be read.`,
        );
        goBtn.textContent = lookupLabel();
        goBtn.disabled = false;
        return;
      }
      await places;

      // Folded in one pass over every tour's points rather than per tour and
      // merged afterwards: pointsToCells counts a visit per gap in what it is
      // given, so handing it the whole timeline is what makes two rides through
      // the same cell on the same afternoon count once rather than twice.
      allPoints.sort((a, b) => a.t - b.t);
      const cells = pointsToCells(allPoints);

      for (const route of routes) {
        route.place = describeRoute(route) ?? '';
        // Komoot names a recorded ride "Ride" and a planned one after its
        // endpoints; the first is worth replacing, the second isn't.
        if (route.place && isGenericName(route.trackName)) route.name = route.place;
      }
      found = { tours, failed, cells, routes, fixes: allPoints.length };
      renderReport();
    } catch (e) {
      showErr(e.message || 'Could not read that tour.');
      goBtn.textContent = lookupLabel();
      goBtn.disabled = false;
    } finally {
      busy = false;
    }
  }

  function renderReport() {
    const { tours, failed, cells, routes, fixes } = found;
    const known = knownCells();
    const fresh = cells.filter((c) => !known.has(c.id)).length;

    report.replaceChildren();
    report.hidden = false;
    const line = (cls, text) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      return el;
    };

    // One line per tour, so a paste of ten says which ten it found.
    for (const { tour, fixes: tourFixes } of tours) {
      const facts = [
        tour.startedAt ? dayFmt.format(new Date(tour.startedAt * 1000)) : 'no date',
        formatDistance(tour.distanceM),
        tour.planned ? 'planned, not recorded' : null,
      ].filter(Boolean);
      const el = line('import-file-line', `${[tour.name || 'Tour', tour.sport].filter(Boolean).join(' · ')}`);
      el.title = `${facts.join(' · ')} · ${n(tourFixes)} points`;
      const sub = document.createElement('small');
      sub.textContent = facts.join(' · ');
      el.append(sub);
      report.append(el);
    }
    for (const f of failed) {
      report.append(line('import-file-line bad', `Tour ${f.id} — ${f.message}`));
    }

    const summary = document.createElement('div');
    summary.className = 'import-summary';
    summary.append(
      line('import-summary-main', `${n(cells.length)} cells · ${n(fresh)} new · ${n(cells.length - fresh)} already on the map`),
    );
    const took = tours.length === 1 ? '1 tour' : `${n(tours.length)} tours`;
    const totalM = tours.reduce((m, t) => m + (t.tour.distanceM || 0), 0);
    const totalSec = tours.reduce((s, t) => s + (t.tour.durationSec || 0), 0);
    summary.append(
      line(
        'import-summary-sub',
        [took, formatDistance(totalM), totalSec ? formatDuration(totalSec) : null].filter(Boolean).join(' · '),
      ),
    );
    summary.append(line('import-summary-sub', `${n(fixes)} points from Komoot`));
    if (failed.length) {
      summary.append(line('import-summary-sub', `${n(failed.length)} could not be read and will be skipped`));
    }
    // A planned tour is a suggestion, not somewhere you've been. Importing one
    // would color ground you have never covered.
    const planned = tours.filter((t) => t.tour.planned).length;
    if (planned) {
      summary.append(
        line(
          'import-summary-sub',
          planned === tours.length
            ? 'Planned, not recorded — this is a route you have not ridden.'
            : `${n(planned)} of these are planned tours, not recorded ones.`,
        ),
      );
    }
    report.append(summary);

    routesRow.hidden = !routes.length;
    if (routes.length > 1) routesLabel.textContent = `Save ${n(routes.length)} routes`;
    goBtn.disabled = false;
    goBtn.textContent = fresh ? `Import ${n(fresh)} new cells` : `Refresh ${n(cells.length)} cells`;
  }

  // --- Saving --------------------------------------------------------------------
  async function save() {
    if (busy || !found) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = 'Importing…';
    showErr('');
    try {
      const payload = found.cells.map((c) => [c.id, c.first, c.last, c.hits, c.fixes]);
      const r = await auth.importCells('komoot', payload, false);
      let routesAdded = 0;
      const keep = routesBox.checked && found.routes.length;
      if (keep) routesAdded = (await auth.saveRoutes(found.routes)).added ?? 0;
      await onImported?.({ routes: !!keep });

      const bits = [`${n(r.added ?? 0)} new`];
      if (r.updated) bits.push(`${n(r.updated)} refreshed`);
      if (routesAdded) bits.push(routesAdded === 1 ? '1 route' : `${n(routesAdded)} routes`);
      else if (keep) bits.push(found.routes.length === 1 ? 'route already saved' : 'routes already saved');
      report.replaceChildren();
      const done = document.createElement('div');
      done.className = 'import-summary';
      const main = document.createElement('div');
      main.className = 'import-summary-main';
      main.textContent = `Imported: ${bits.join(' · ')}`;
      const sub = document.createElement('div');
      sub.className = 'import-summary-sub';
      sub.textContent = 'Your map has been updated.';
      done.append(main, sub);
      report.append(done);
      routesRow.hidden = true;
      found = null;
      goBtn.textContent = 'Done';
      goBtn.disabled = false;
      goBtn.dataset.done = '1';
    } catch (e) {
      showErr(e.message || 'Import failed.');
      goBtn.textContent = 'Import';
      goBtn.disabled = false;
    } finally {
      busy = false;
    }
  }

  // --- Wiring --------------------------------------------------------------------
  function open() {
    urlEl.value = '';
    reset();
    overlay.hidden = false;
    setTimeout(() => urlEl.focus(), 60);
  }

  function close(silent = false) {
    overlay.hidden = true;
    reset();
    if (!silent) onClose?.();
  }

  goBtn.addEventListener('click', () => {
    if (goBtn.dataset.done) close();
    else if (found) save();
    else lookup();
  });
  urlEl.addEventListener('input', () => {
    if (found || goBtn.dataset.done) reset();
    else goBtn.textContent = lookupLabel();
    goBtn.disabled = !linkCount();
  });
  urlEl.addEventListener('keydown', (e) => {
    // Enter belongs to the textarea now — it's how you get to the next link.
    // Cmd/Ctrl+Enter is the one that means "go".
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!busy && linkCount()) (found ? save() : lookup());
  });
  backBtn.addEventListener('click', () => close());
  closeBtn.addEventListener('click', () => close(true));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !busy) close(true);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden && !busy) close(true);
  });

  return { open, close: () => close(true) };
}
