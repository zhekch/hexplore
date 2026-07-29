// The "Import locations" dialog: pick one or more export files, see what the
// app made of them, then push the cells to the server.
//
// Everything is parsed in the browser (src/locations.js) — the file never
// leaves the machine except as the list of hex cells it resolves to. Files are
// grouped by the format they were detected as, so dropping a Google Timeline
// export and a GPX track in together still records two distinct sources.
//
// Files that drew a line (an activity, a trip) can also keep the line itself:
// those become saved routes (src/routes.js), drawn over the map rather than
// folded into it. The cells they light up are the same either way.

import { auth } from './auth.js';
import { parseLocationFile, pointsToCells, sourceLabel, IMPORT_SOURCES } from './locations.js';
import { buildRoutes, totalLength, formatDistance } from './routes.js';
import { loadPlaces, describeRoute, isGenericName } from './places.js';
import { isZip, isGzip, unzip, gunzip, stripCompressedExt } from './archive.js';
import { parseFit, looksLikeFit } from './fit.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const day = (sec) => (sec ? dayFmt.format(new Date(sec * 1000)) : null);
const n = (v) => v.toLocaleString();

function span(first, last) {
  const a = day(first);
  const b = day(last);
  if (!a && !b) return 'no dates in file';
  if (!a || !b || a === b) return a ?? b;
  return `${a} – ${b}`;
}

// --- Containers ------------------------------------------------------------------
// Strava's bulk export — the free route now that its API is behind a
// subscription — is one ZIP whose `activities/` folder holds a file per
// activity, individually gzipped as often as not, in whichever format the
// device originally wrote. So a dropped file may be a container two layers deep
// before there is anything to parse.
//
// Only these are worth inflating: an archive also carries a hundred CSVs,
// media files and a README, and inflating those would cost minutes and
// gigabytes for nothing.
const IMPORTABLE = /\.(gpx|tcx|kml|geojson|json|csv|tsv|txt|fit)(\.gz)?$/i;

/**
 * One dropped file → the list of real files inside it.
 * @returns {Promise<{items: Array<{name, bytes}>, source: string|null}>}
 */
async function expand(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isZip(bytes)) {
    const entries = await unzip(bytes, { filter: (n) => IMPORTABLE.test(n) });
    if (!entries.length) throw new Error(`${file.name} has no location files in it.`);
    // Strava lays its export out as activities/<id>.<ext>; recognizing that is
    // what lets a whole archive land under the Strava source rather than as a
    // pile of anonymous GPX and FIT files. It also narrows what's worth
    // opening: the archive's own activities.csv is an index, not a track, and
    // reporting it as an unreadable file would be noise.
    const activities = entries.filter((e) => /(^|\/)activities\//i.test(e.name));
    const source = activities.length ? 'strava' : null;
    const items = [];
    for (const e of source ? activities : entries) {
      items.push({
        name: stripCompressedExt(e.name),
        bytes: isGzip(e.bytes) ? await gunzip(e.bytes) : e.bytes,
      });
    }
    return { items, source };
  }

  if (isGzip(bytes)) {
    return { items: [{ name: stripCompressedExt(file.name), bytes: await gunzip(bytes) }], source: null };
  }
  return { items: [{ name: file.name, bytes }], source: null };
}

// FIT is binary, everything else this reads is text.
function parseExpanded(name, bytes) {
  if (looksLikeFit(bytes)) {
    const { points, sport } = parseFit(bytes);
    const track = { name: '', segments: [points], firstAt: 0, lastAt: 0, sport: sport || '' };
    return { source: 'fit', format: 'FIT', points, tracks: points.length >= 2 ? [track] : [] };
  }
  return parseLocationFile(name, new TextDecoder().decode(bytes));
}

/**
 * @param {object} opts
 * @param {() => Set<string>} opts.knownCells  cells already on the map (for the new/existing split)
 * @param {() => string[]}    opts.knownSources sources already present in the account
 * @param {(what:{routes:boolean}) => Promise<void>} opts.onImported called after a successful import
 * @param {() => void} [opts.onKomoot] hand off to the Komoot link dialog
 */
export function mountImport({ knownCells, knownSources, onImported, onKomoot }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('import-overlay');
  const fileInput = $('import-file');
  const drop = $('import-drop');
  const dropText = $('import-drop-text');
  const report = $('import-report');
  // The explainer above the preview. It answers the questions you have before
  // choosing a file; once the preview is there it is just pushing the buttons
  // down the card, so it steps aside for it.
  const note = $('import-note');
  const sourceRow = $('import-source-row');
  const sourceSel = $('import-source');
  const routesRow = $('import-routes-row');
  const routesBox = $('import-routes');
  const routesNote = $('import-routes-note');
  const errEl = $('import-error');
  const goBtn = $('import-go');
  const cancelBtn = $('import-cancel');
  const closeBtn = $('import-close');
  const komootBtn = $('import-komoot');

  // [{ source, files:[{name, format, fixes, routes, error}], cells, routes, fixes, firstAt, lastAt }]
  let groups = [];
  let busy = false;

  const allRoutes = () => groups.flatMap((g) => g.routes);

  const showErr = (m) => {
    errEl.textContent = m;
    errEl.hidden = !m;
  };

  // Files chosen so far, across every drop and pick until the dialog is closed
  // or cleared. reset() deliberately leaves this alone — it re-runs the parse,
  // it doesn't throw the selection away.
  let picked = [];
  // How many of the files just handed over were already in the set. Reported
  // rather than swallowed: silently ignoring a file someone dropped is exactly
  // the kind of thing that makes an importer feel broken.
  let duplicates = 0;

  function reset() {
    groups = [];
    fileInput.value = '';
    report.replaceChildren();
    report.hidden = true;
    if (note) note.hidden = false;
    sourceRow.hidden = true;
    routesRow.hidden = true;
    routesBox.checked = true;
    dropText.textContent = 'Choose files or drop them here';
    goBtn.disabled = true;
    goBtn.textContent = 'Import';
    delete goBtn.dataset.done;
    showErr('');
  }

  // Opening and closing *do* start fresh — it's only a second drop within one
  // sitting that adds to what's already there.
  function open() {
    picked = [];
    duplicates = 0;
    reset();
    overlay.hidden = false;
  }

  function close() {
    overlay.hidden = true;
    picked = [];
    duplicates = 0;
    reset();
  }

  function clearFiles() {
    picked = [];
    duplicates = 0;
    reset();
  }

  // --- Naming ------------------------------------------------------------------
  // Where a route went beats what the file called it — but only when the file
  // had nothing to say. A name you gave it in Strava or on your watch survives;
  // a bare date, "Track", or a filename does not.
  function nameRoutes(routes) {
    for (const route of routes) {
      route.place = describeRoute(route) ?? '';
      if (route.place && isGenericName(route.trackName)) route.name = route.place;
    }
    return routes;
  }

  // --- Reading & parsing -------------------------------------------------------
  // Dropping a second file used to throw the first one away — the drop handler
  // re-ran the whole parse from scratch on whatever had just landed, which
  // looked like "it replaced my file" because that is exactly what it did.
  // Files now accumulate across drops *and* picks, so you can drag them in a
  // few at a time; `picked` is the running set and the parse always runs over
  // all of it.
  //
  // Two drops of the same file would otherwise be read twice and count their
  // fixes twice, so a file already in the set is recognised and ignored.
  //
  // Name and size only — deliberately not lastModified. It sounds like the
  // obvious third component and isn't: it is the moment the *File object* was
  // made, not the file itself, so the same file added twice can carry two
  // different values (measured: identical name and size, timestamps 18 s
  // apart) and slip through as a duplicate. Two genuinely different files with
  // the same name *and* the same byte count in one sitting is rare enough to
  // be worth the trade — and it isn't silent either way, because whatever gets
  // dropped this way is reported below.
  const fileKey = (f) => `${f.name}:${f.size}`;

  function addFiles(fileList) {
    const incoming = [...fileList];
    if (!incoming.length) return false;
    const seen = new Set(picked.map(fileKey));
    const fresh = [];
    for (const f of incoming) {
      // Checked against this batch too: one drop can contain the same file twice.
      if (seen.has(fileKey(f))) continue;
      seen.add(fileKey(f));
      fresh.push(f);
    }
    duplicates = incoming.length - fresh.length;
    picked = [...picked, ...fresh];
    return true;
  }

  async function handleFiles() {
    const files = picked;
    if (!files.length) return;
    // Keep the accumulated set: reset() clears everything *except* `picked`.
    reset();
    busy = true;
    dropText.textContent = files.length === 1 ? `Reading ${files[0].name}…` : `Reading ${n(files.length)} files…`;
    // The place names are their own chunk (~2 MB); start it now so it is ready
    // by the time the files are parsed, and carry on without it if it fails.
    const places = loadPlaces().catch(() => false);
    // Let the label repaint before a multi-megabyte parse blocks the thread.
    await new Promise((r) => setTimeout(r, 30));
    await places;

    const bySource = new Map();
    try {
      for (const file of files) {
        // A ZIP or a .gz stands in for many real files; everything else expands
        // to just itself, so the loop below doesn't care which it was.
        let expanded;
        try {
          expanded = await expand(file);
        } catch (e) {
          expanded = { items: [], source: null, error: e.message };
        }
        if (expanded.error || !expanded.items.length) {
          const g = bySource.get('__failed') ?? { source: 'other', files: [], points: [], routes: [] };
          bySource.set('__failed', g);
          g.files.push({ name: file.name, format: '?', fixes: 0, routes: 0, error: expanded.error });
          continue;
        }
        // A whole archive is announced once rather than once per activity —
        // a Strava export runs to hundreds of files.
        const many = expanded.items.length > 1;
        const tally = new Map(); // source → {files, fixes, routes}

        for (const item of expanded.items) {
          let parsed;
          try {
            parsed = parseExpanded(item.name, item.bytes);
          } catch (e) {
            parsed = { source: 'other', format: '?', points: [], tracks: [], error: e.message };
          }
          // The container knows better than the file does: a FIT out of a
          // Strava archive is a Strava activity, whatever the bytes say.
          const source = expanded.source ?? parsed.source;
          const key = parsed.points.length ? source : '__failed';
          let g = bySource.get(key);
          if (!g) bySource.set(key, (g = { source, files: [], points: [], routes: [] }));
          const routes = nameRoutes(
            buildRoutes(parsed.tracks ?? [], { source, fileName: item.name }),
          );
          if (many) {
            const t = tally.get(key) ?? { files: 0, fixes: 0, routes: 0, format: parsed.format };
            t.files++;
            t.fixes += parsed.points.length;
            t.routes += routes.length;
            tally.set(key, t);
          } else {
            g.files.push({
              name: item.name,
              format: parsed.format,
              fixes: parsed.points.length,
              routes: routes.length,
              error: parsed.error,
            });
          }
          g.points.push(...parsed.points);
          g.routes.push(...routes);
        }

        for (const [key, t] of tally) {
          bySource.get(key)?.files.push({
            name: `${file.name} — ${t.files} ${t.files === 1 ? 'activity' : 'activities'}`,
            format: t.format,
            fixes: t.fixes,
            routes: t.routes,
          });
        }
      }
    } catch (e) {
      busy = false;
      showErr(e.message || 'Could not read those files.');
      dropText.textContent = 'Choose files or drop them here';
      return;
    }

    const failed = bySource.get('__failed');
    bySource.delete('__failed');

    groups = [...bySource.values()].map((g) => {
      const cells = pointsToCells(g.points);
      let firstAt = 0;
      let lastAt = 0;
      for (const c of cells) {
        if (c.first && (!firstAt || c.first < firstAt)) firstAt = c.first;
        if (c.last > lastAt) lastAt = c.last;
      }
      return { source: g.source, files: g.files, cells, routes: g.routes, fixes: g.points.length, firstAt, lastAt };
    });

    busy = false;
    // Say what's held *and* that more can be added — the whole reason a second
    // drop looked broken was that nothing said it would be added rather than
    // swapped in.
    dropText.textContent = files.length === 1
      ? `${files[0].name} · drop more to add`
      : `${n(files.length)} files selected · drop more to add`;
    renderReport(failed);
  }

  // --- The preview ---------------------------------------------------------------
  function renderReport(failed) {
    report.replaceChildren();
    report.hidden = false;
    if (note) note.hidden = true;

    if (duplicates) {
      const dup = document.createElement('div');
      dup.className = 'import-file-line';
      dup.textContent = duplicates === 1
        ? 'One file was already in the list and was not added again.'
        : `${n(duplicates)} files were already in the list and were not added again.`;
      report.append(dup);
    }

    // Files add up now, so there has to be a way back to none of them.
    if (picked.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'import-clear';
      clear.textContent = picked.length === 1 ? 'Remove file' : `Clear ${n(picked.length)} files`;
      clear.addEventListener('click', () => {
        if (!busy) clearFiles();
      });
      report.append(clear);
    }

    const line = (cls, text) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      return el;
    };

    for (const f of failed?.files ?? []) {
      report.append(line('import-file-line bad', `${f.name} — ${f.error ?? 'no coordinates found'}`));
    }
    for (const g of groups) {
      for (const f of g.files) {
        const bits = [sourceLabel(g.source), `${n(f.fixes)} fixes`];
        if (f.routes) bits.push(f.routes === 1 ? '1 route' : `${n(f.routes)} routes`);
        report.append(line('import-file-line', `${f.name} — ${bits.join(' · ')}`));
      }
    }

    const known = knownCells();
    const seen = new Set();
    let fresh = 0;
    let total = 0;
    for (const g of groups) {
      for (const c of g.cells) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        total++;
        if (!known.has(c.id)) fresh++;
      }
    }

    if (!total) {
      goBtn.disabled = true;
      if (!failed) showErr('No usable coordinates in those files.');
      return;
    }

    const firstAt = Math.min(...groups.filter((g) => g.firstAt).map((g) => g.firstAt), Infinity);
    const lastAt = Math.max(...groups.map((g) => g.lastAt), 0);
    const summary = document.createElement('div');
    summary.className = 'import-summary';
    summary.append(
      line('import-summary-main', `${n(total)} cells · ${n(fresh)} new · ${n(total - fresh)} already on the map`),
      line('import-summary-sub', span(Number.isFinite(firstAt) ? firstAt : 0, lastAt)),
    );
    const routes = allRoutes();
    if (routes.length) {
      summary.append(
        line(
          'import-summary-sub',
          `${routes.length === 1 ? '1 route' : `${n(routes.length)} routes`} · ${formatDistance(totalLength(routes))}`,
        ),
      );
    }
    report.append(summary);

    // One group: offer to relabel it (a generic KML may really be a Google
    // Maps export). Several: each keeps the source it was detected as.
    if (groups.length === 1) {
      const keys = [...new Set([groups[0].source, ...IMPORT_SOURCES, ...knownSources()])];
      sourceSel.replaceChildren();
      for (const key of keys) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = sourceLabel(key);
        sourceSel.append(opt);
      }
      sourceSel.value = groups[0].source;
      sourceRow.hidden = false;
    }

    // Only offered when there is a line to keep — most exports are loose fixes.
    routesRow.hidden = !routes.length;
    if (routes.length) {
      routesNote.textContent =
        `Keeps the ${routes.length === 1 ? 'track' : 'tracks'} themselves, drawn over the map`;
    }

    goBtn.disabled = false;
    goBtn.textContent = fresh ? `Import ${n(fresh)} new cells` : `Refresh ${n(total)} cells`;
    showErr('');
  }

  // --- Sending -------------------------------------------------------------------
  async function runImport() {
    if (busy || !groups.length) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = 'Importing…';
    showErr('');
    try {
      let added = 0;
      let updated = 0;
      let routesAdded = 0;
      const keepRoutes = routesBox.checked;
      const routes = [];
      for (const g of groups) {
        const source = groups.length === 1 ? sourceSel.value : g.source;
        const payload = g.cells.map((c) => [c.id, c.first, c.last, c.hits, c.fixes]);
        const r = await auth.importCells(source, payload);
        added += r.added ?? 0;
        updated += r.updated ?? 0;
        // Relabelling the group relabels its routes with it.
        if (keepRoutes) routes.push(...g.routes.map((route) => ({ ...route, source })));
      }
      if (routes.length) {
        // Re-importing the same track is a no-op server-side (routes are keyed
        // by their own geometry), so `added` here is only what's actually new.
        routesAdded = (await auth.saveRoutes(routes)).added ?? 0;
      }
      await onImported?.({ routes: routes.length > 0 });
      // `added` counts cells that reached the map for the first time;
      // `updated` counts the ones that were already there and just had this
      // source's dates and visit counts refreshed (or newly attached).
      const bits = [`${n(added)} new`];
      if (updated) bits.push(`${n(updated)} refreshed`);
      if (routesAdded) bits.push(routesAdded === 1 ? '1 route' : `${n(routesAdded)} routes`);
      report.replaceChildren();
      const done = document.createElement('div');
      done.className = 'import-summary';
      done.innerHTML = '<div class="import-summary-main"></div><div class="import-summary-sub">Your map has been updated.</div>';
      done.firstChild.textContent = `Imported: ${bits.join(' · ')}`;
      report.append(done);
      sourceRow.hidden = true;
      routesRow.hidden = true;
      groups = [];
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

  // --- Wiring ---------------------------------------------------------------------
  // Komoot has no file to drop — it's a link — but it is still an import, so
  // it hands off from here rather than from the Sync picker.
  komootBtn?.addEventListener('click', () => {
    if (busy) return;
    close();
    onKomoot?.();
  });

  fileInput.addEventListener('change', () => {
    if (addFiles(fileInput.files)) handleFiles();
  });
  drop.addEventListener('click', (e) => {
    // The <input> is inside the label; let its own click through untouched.
    if (e.target !== fileInput) {
      e.preventDefault();
      fileInput.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (busy) return; // a parse is already running over the current set
    if (e.dataTransfer?.files?.length && addFiles(e.dataTransfer.files)) handleFiles();
  });

  goBtn.addEventListener('click', () => {
    if (goBtn.dataset.done) {
      delete goBtn.dataset.done;
      close();
    } else {
      runImport();
    }
  });
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !busy) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden && !busy) close();
  });

  return { open };
}
