// Opening Strava's bulk export in the browser, because there is no API left to ask.
//
// Since 1 June 2026 Strava's API needs a paid subscription, so the free way to
// get your own rides out is Settings → My Account → Download or Delete Your
// Account → Request Your Archive. What arrives is a ZIP whose `activities/`
// folder holds one file per activity — `2500155647.gpx`, `.gpx.gz`, `.fit`,
// `.fit.gz`, `.tcx.gz` — next to a hundred-odd CSVs, READMEs and profile
// pictures that have nothing to do with a map.
//
// This file is only the container layer: it turns a ZIP (or a lone .gz someone
// dragged in on its own) into named runs of bytes and hands them on. It knows
// nothing about GPX, FIT or TCX — src/locations.js and the FIT reader do that.
//
// No npm dependency is involved because the platform already ships the two
// codecs a Strava archive uses: DecompressionStream('deflate-raw') for ZIP
// method 8 and DecompressionStream('gzip') for .gz. Method 0 is the bytes
// themselves.
//
// Deliberately *not* supported: Zip64, encryption and multi-disk archives.
// Strava writes none of them, and half-implementing any of the three would
// mean silently reading the wrong bytes. Each is detected and named instead.

// --- Magic bytes ------------------------------------------------------------------
// Cheap enough to run on every dropped file before deciding what it is.

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('That file could not be read as data.');
}

/**
 * True if these bytes open a ZIP archive.
 * This looks for a *local header* (PK\x03\x04), not just "PK": an empty archive
 * starts PK\x05\x06 and a spanned one PK\x07\x08, and neither is worth opening.
 */
export function isZip(input) {
  const b = toBytes(input);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** True if these bytes open a gzip member. */
export function isGzip(input) {
  const b = toBytes(input);
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * Drop a trailing `.gz` so the caller can sniff the extension underneath.
 * Strava names a compressed track `2500155647.gpx.gz`, and everything
 * downstream dispatches on `.gpx` / `.fit` / `.tcx`.
 */
export function stripCompressedExt(name) {
  return String(name ?? '').replace(/\.gz$/i, '');
}

// --- Decompression ------------------------------------------------------------------

// Deflate can turn a few kilobytes into gigabytes, and reading the whole stream
// into one buffer means the tab dies before anything gets to look at it. A real
// Strava activity is tens of kilobytes and the largest thing in an export is a
// few megabytes, so a quarter-gigabyte ceiling is far past anything genuine and
// still small enough to survive hitting it.
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

async function inflate(bytes, format, what) {
  // Zero-length input has no stream to pipe; every caller here treats it as
  // nothing to read rather than an error.
  if (!bytes.length) return new Uint8Array(0);
  try {
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream(format));
    // Read it a chunk at a time rather than buffering the lot, so the ceiling
    // can stop a bomb partway instead of after it has already been allocated.
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_INFLATED_BYTES) {
        await reader.cancel();
        throw new RangeError('too big');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(`${what} unpacks to far more data than an export should — it has been skipped.`);
    }
    // The stream only ever fails on malformed data, which for a user file means
    // a download that stopped early or an archive that got edited.
    throw new Error(`${what} is damaged and could not be unpacked — try downloading the export again.`);
  }
}

/**
 * Decompress a lone gzip file (`2500155647.gpx.gz`).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(input) {
  const bytes = toBytes(input);
  if (!isGzip(bytes)) throw new Error('That file is not gzip-compressed.');
  const out = await inflate(bytes, 'gzip', 'That .gz file');
  if (!out.length) throw new Error('That .gz file is empty.');
  return out;
}

// --- ZIP ------------------------------------------------------------------------------

// A gzip member carries its own CRC and DecompressionStream checks it, but a ZIP
// entry's checksum lives in the directory and nothing verifies it for us. It has
// to be done here: a half-downloaded or edited archive still has correct-looking
// sizes, so without this a flipped byte becomes a plausible coordinate and lights
// up a hexagon the user has never stood in. Only entries that pass the filter are
// summed, so this runs over a few megabytes of activities, not the whole export.
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

// Only 0 (stored) and 8 (deflate) get read. The rest exist so a refusal can say
// what it actually found instead of a bare number.
const METHOD_NAMES = {
  1: 'Shrink',
  6: 'Implode',
  9: 'Deflate64',
  12: 'bzip2',
  14: 'LZMA',
  93: 'Zstandard',
  95: 'xz',
  98: 'PPMd',
};

// Filenames are UTF-8 when general-purpose bit 11 is set; Strava writes plain
// digits and never sets it, so everything is decoded as UTF-8 regardless. The
// decoder is non-fatal on purpose — a mojibake name in some unrelated entry
// must not abort an import.
const NAMES = new TextDecoder('utf-8');

/**
 * Every plausible End of Central Directory record, latest first.
 *
 * It is not at a fixed offset: a trailing archive comment of up to 64 KB sits
 * after it. The signature also occurs by chance inside stored file data, and on
 * purpose inside a comment that happens to carry a whole other ZIP (some tools
 * park metadata there), so the length check below is a filter, not a proof —
 * hence a generator. The caller keeps walking until one of these candidates
 * actually leads to a central directory.
 */
function* eocdCandidates(view, len) {
  const floor = Math.max(0, len - (0xffff + 22));
  for (let i = len - 22; i >= floor; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    // A real EOCD's comment runs to exactly the end of the file.
    if (view.getUint16(i + 20, true) === len - (i + 22)) yield i;
  }
}

/**
 * Where the central directory really starts, or -1 if this candidate leads
 * nowhere.
 *
 * Both known positions are guesses. `cdOffset` is recorded relative to the
 * start of the *archive*, which is not the start of the file when bytes have
 * been prepended (a self-extracting stub, a mail scanner's banner) or when two
 * archives were concatenated — and in a concatenated file the stale value can
 * land on the *other* archive's directory, which reads perfectly and is
 * entirely the wrong list of files. Stepping back over the directory from the
 * EOCD is arithmetic on one record, so it is trusted first; the recorded offset
 * is the fallback for the rare writer that puts a digital-signature record
 * between the directory and the EOCD.
 */
function centralDirStart(view, eocd) {
  const derived = eocd.at - eocd.cdSize;
  if (derived >= 0 && view.getUint32(derived, true) === SIG_CENTRAL) return derived;
  if (eocd.cdOffset + 4 <= view.byteLength && view.getUint32(eocd.cdOffset, true) === SIG_CENTRAL) {
    return eocd.cdOffset;
  }
  return -1;
}

function isZip64(view, eocd) {
  // Every one of these is the "look in the Zip64 record instead" sentinel, which
  // is where a >4 GB or >65535-entry archive keeps its real numbers.
  return (
    eocd.count === 0xffff ||
    eocd.cdSize === 0xffffffff ||
    eocd.cdOffset === 0xffffffff ||
    (eocd.at >= 20 && view.getUint32(eocd.at - 20, true) === SIG_ZIP64_LOCATOR)
  );
}

function readEocd(view, len) {
  let sawCandidate = false;
  for (const at of eocdCandidates(view, len)) {
    sawCandidate = true;
    const eocd = {
      disk: view.getUint16(at + 4, true),
      cdDisk: view.getUint16(at + 6, true),
      count: view.getUint16(at + 10, true),
      cdSize: view.getUint32(at + 12, true),
      cdOffset: view.getUint32(at + 16, true),
      at,
    };
    // Checked before the directory is located, because a Zip64 archive keeps
    // sentinels here and its directory is not findable by these rules at all.
    if (isZip64(view, eocd)) {
      throw new Error('That ZIP file is in Zip64 format, which this importer cannot read. Unzip it yourself and drag the activities folder in.');
    }
    const cdAt = centralDirStart(view, eocd);
    if (cdAt < 0) continue;
    if (eocd.disk !== 0 || eocd.cdDisk !== 0) {
      throw new Error('That ZIP file is one piece of a multi-part archive. Join the parts first, or unzip it yourself.');
    }
    // How far the whole archive sits from the start of the file. Local header
    // offsets are recorded in the same frame as `cdOffset`, so whatever the
    // directory was off by, they are off by too.
    return { ...eocd, cdAt, shift: cdAt - eocd.cdOffset };
  }
  if (sawCandidate) {
    throw new Error('That ZIP file is damaged — its table of contents is missing. Try downloading the export again.');
  }
  throw new Error('That does not look like a ZIP file, or the download did not finish.');
}

function readCentralEntry(view, at) {
  if (at + 46 > view.byteLength || view.getUint32(at, true) !== SIG_CENTRAL) return null;
  const nameLen = view.getUint16(at + 28, true);
  const extraLen = view.getUint16(at + 30, true);
  const commentLen = view.getUint16(at + 32, true);
  const nameAt = at + 46;
  if (nameAt + nameLen > view.byteLength) return null;
  const rawName = new Uint8Array(view.buffer, view.byteOffset + nameAt, nameLen);
  return {
    flags: view.getUint16(at + 8, true),
    method: view.getUint16(at + 10, true),
    // The directory's copy, which is filled in even for entries written with a
    // data descriptor, where the local header's copy is left at zero.
    crc: view.getUint32(at + 16, true),
    compressedSize: view.getUint32(at + 20, true),
    size: view.getUint32(at + 24, true),
    diskStart: view.getUint16(at + 34, true),
    localAt: view.getUint32(at + 42, true),
    rawName,
    name: NAMES.decode(rawName),
    next: nameAt + nameLen + extraLen + commentLen,
  };
}

// Only checked for entries the caller actually wants: a Strava archive is
// hundreds of files, and one oddity in a README nobody asked for should not
// take the whole import down with it.
function assertReadable(entry) {
  if (entry.flags & 0x1 || entry.flags & 0x40) {
    throw new Error(`"${entry.name}" is password-protected, which this importer cannot open. Unzip it yourself and drag the activity files in.`);
  }
  if (entry.diskStart !== 0) {
    throw new Error('That ZIP file is one piece of a multi-part archive. Join the parts first, or unzip it yourself.');
  }
  if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.localAt === 0xffffffff) {
    throw new Error('That ZIP file is in Zip64 format, which this importer cannot read. Unzip it yourself and drag the activities folder in.');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    const how = METHOD_NAMES[entry.method] ?? `method ${entry.method}`;
    throw new Error(`"${entry.name}" uses ${how} compression, which this importer cannot read. Re-zip it with normal compression, or drag the activity files in.`);
  }
}

/**
 * Where an entry's data begins.
 *
 * The local header repeats the name and extra fields, and its *lengths need not
 * match the central directory's* — writers routinely pad the local extra field
 * for alignment. Reading them from the local header is the only way to land on
 * the first byte of data.
 *
 * The name is compared as well. Landing on some *other* entry's header is the
 * one failure that produces a plausible file full of the wrong bytes, and this
 * ends up on a map of where someone has been, so it is worth one memcmp to
 * refuse loudly instead.
 */
function dataStart(view, entry, shift) {
  const at = entry.localAt + shift;
  const fits = at >= 0 && at + 30 <= view.byteLength;
  const nameLen = fits ? view.getUint16(at + 26, true) : 0;
  const misplaced =
    !fits ||
    at + 30 + nameLen > view.byteLength ||
    view.getUint32(at, true) !== SIG_LOCAL ||
    nameLen !== entry.rawName.length ||
    !entry.rawName.every((b, i) => b === view.getUint8(at + 30 + i));
  if (misplaced) {
    throw new Error(`"${entry.name}" could not be found inside the ZIP file — the archive looks damaged.`);
  }
  return at + 30 + nameLen + view.getUint16(at + 28, true);
}

/**
 * Expand a ZIP archive.
 *
 * Entries are inflated one at a time, in order, and only after `filter` has
 * said yes to the name — that is the memory knob. A multi-year Strava export
 * runs to hundreds of megabytes, so a caller that wants `activities/` only
 * should say so here rather than inflating a hundred CSVs to throw them away.
 * What comes back is still held in memory all at once, so filter narrowly.
 *
 * Directory entries and empty files are dropped; both are noise from a ZIP
 * writer, never something a caller asked for.
 *
 * @param {ArrayBuffer|Uint8Array} buffer the whole archive
 * @param {{filter?: (name: string) => boolean}} [options]
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function unzip(buffer, { filter } = {}) {
  const bytes = toBytes(buffer);
  if (bytes.length < 22) throw new Error('That file is too small to be a ZIP archive.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = readEocd(view, bytes.length);
  let at = eocd.cdAt;

  const out = [];
  for (let i = 0; i < eocd.count; i++) {
    const entry = readCentralEntry(view, at);
    if (!entry) {
      throw new Error('That ZIP file is damaged — its table of contents stops early. Try downloading the export again.');
    }
    at = entry.next;

    // A trailing slash is how a ZIP writes a folder; it has no data of its own.
    if (entry.name.endsWith('/') || entry.size === 0) continue;
    if (filter && !filter(entry.name)) continue;
    assertReadable(entry);

    const from = dataStart(view, entry, eocd.shift);
    if (from + entry.compressedSize > bytes.length) {
      throw new Error(`"${entry.name}" runs past the end of the ZIP file — the download did not finish.`);
    }
    const raw = bytes.subarray(from, from + entry.compressedSize);

    // `slice` rather than the subarray for stored entries: a view would keep the
    // entire multi-hundred-megabyte archive alive for as long as the caller
    // holds on to one small activity file.
    const data = entry.method === 0 ? raw.slice() : await inflate(raw, 'deflate-raw', `"${entry.name}"`);
    if (data.length !== entry.size) {
      throw new Error(`"${entry.name}" did not unpack to the size the ZIP file promised — the archive looks damaged.`);
    }
    if (crc32(data) !== entry.crc) {
      throw new Error(`"${entry.name}" does not match the checksum stored in the ZIP file — the archive is damaged. Try downloading the export again.`);
    }
    out.push({ name: entry.name, bytes: data });
  }
  return out;
}
