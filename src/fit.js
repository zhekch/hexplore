// Garmin FIT, read-only, and only as far as the map needs: where you were and
// when. Most Strava activities come out of the bulk export as .fit — that is
// what the phone app and every bike computer upload — so without this the
// archive import would miss the majority of a history.
//
// FIT is binary and self-describing: the file carries its own schema. A
// *definition* message says "local type 3 means global message 20, and its
// fields are, in this order, a 4-byte uint32 numbered 253 and two 4-byte
// sint32s numbered 0 and 1"; every *data* message tagged local type 3 after it
// is then only those bytes back to back, carrying no field numbers of its own.
// So the stream has to be walked from the front: you cannot seek to the
// records, and one definition you failed to read leaves you unable to size
// every data message after it.
//
// We want global message 20 (`record`) — field 0 position_lat, field 1
// position_long, field 253 timestamp — plus the sport, if the file names it.
// Power, heart rate, laps and everything else are stepped over by their
// declared width without being decoded.
//
// Nothing here verifies a CRC, neither the header's nor the file's. A FIT that
// is actually damaged trips over its own structure long before the checksum
// would catch it, and throwing away an otherwise readable ride because two
// trailing bytes are stale is the worse outcome.

// degrees = semicircles * 180 / 2^31. Positions are int32 semicircles, which is
// why an "invalid" one has to be caught by its sentinel rather than by a range
// check: 0x7FFFFFFF is a hair under +180°, a perfectly plausible longitude.
const SEMICIRCLE = 180 / 2 ** 31;

// FIT counts seconds from 1989-12-31T00:00:00Z, not from the Unix epoch.
const FIT_EPOCH = 631065600;

// Below 0x10000000 the spec says a timestamp is device uptime rather than a
// date — a watch that never got a satellite fix or a clock. Those are not
// times we can put on a map, so they read as "the file did not say".
const MIN_REAL_TIMESTAMP = 0x10000000;

// The spec sets no bound in the other direction, but a clock is just as able to
// be wrong forwards: a flat backup battery, or the GPS week rollover that dated
// a whole generation of receivers twenty years out. src/tcx.js and
// src/locations.js drop those for the same reason — one fix stamped 2089 would
// pin a cell's "last seen" there for good, and a date nothing else in the
// import would have accepted is worth less than no date at all.
function unixSeconds(fitSeconds) {
  if (fitSeconds < MIN_REAL_TIMESTAMP) return 0;
  const sec = fitSeconds + FIT_EPOCH;
  return sec < Date.now() / 1000 + 86400 ? sec : 0;
}

// Base type number (the low 5 bits of the base type byte; the top bit only
// says whether the type cares about endianness) → width, reader, and the value
// that means "this field was never filled in". The 64-bit types are absent on
// purpose: no field we read is one, and letting them return null skips their
// bytes without dragging BigInt through here.
const BASE_TYPES = {
  0x00: { size: 1, invalid: 0xff, read: (v, o) => v.getUint8(o) }, // enum
  0x01: { size: 1, invalid: 0x7f, read: (v, o) => v.getInt8(o) }, // sint8
  0x02: { size: 1, invalid: 0xff, read: (v, o) => v.getUint8(o) }, // uint8
  0x03: { size: 2, invalid: 0x7fff, read: (v, o, le) => v.getInt16(o, le) }, // sint16
  0x04: { size: 2, invalid: 0xffff, read: (v, o, le) => v.getUint16(o, le) }, // uint16
  0x05: { size: 4, invalid: 0x7fffffff, read: (v, o, le) => v.getInt32(o, le) }, // sint32
  0x06: { size: 4, invalid: 0xffffffff, read: (v, o, le) => v.getUint32(o, le) }, // uint32
  0x07: { size: 1, invalid: 0x00, read: (v, o) => v.getUint8(o) }, // string
  0x08: { size: 4, invalid: NaN, read: (v, o, le) => v.getFloat32(o, le) }, // float32
  0x09: { size: 8, invalid: NaN, read: (v, o, le) => v.getFloat64(o, le) }, // float64
  0x0a: { size: 1, invalid: 0x00, read: (v, o) => v.getUint8(o) }, // uint8z
  0x0b: { size: 2, invalid: 0x0000, read: (v, o, le) => v.getUint16(o, le) }, // uint16z
  0x0c: { size: 4, invalid: 0x00000000, read: (v, o, le) => v.getUint32(o, le) }, // uint32z
  0x0d: { size: 1, invalid: 0xff, read: (v, o) => v.getUint8(o) }, // byte
};

/**
 * One field of a data message, or null when it is missing, unreadable or
 * holding its type's invalid sentinel. A field wider than its base type is an
 * array; only its first element is of any interest to us.
 */
function fieldValue(view, off, base, size, le) {
  const type = BASE_TYPES[base];
  if (!type || size < type.size) return null;
  const raw = type.read(view, off, le);
  // The float sentinels are all bits set, which reads back as NaN, so the
  // finite check does double duty here.
  return !Number.isFinite(raw) || raw === type.invalid ? null : raw;
}

// The sport enum (global message 12 field 0, or a session's field 5), worded
// the way src/komoot.js words its own sports so route cards read the same
// whichever importer made them. Anything not listed — generic, indoor gear,
// the ball sports — deliberately has no label rather than a wrong one.
const SPORTS = {
  1: 'Run',
  2: 'Ride',
  5: 'Swim',
  11: 'Walk',
  12: 'Cross-country ski',
  13: 'Alpine ski',
  14: 'Snowboard',
  15: 'Row',
  16: 'Mountaineering',
  17: 'Hike',
  19: 'Paddle',
  20: 'Flight',
  21: 'E-bike ride',
  22: 'Motorcycle',
  23: 'Boat',
  24: 'Drive',
  27: 'Horse ride',
  30: 'Skate',
  32: 'Sail',
  33: 'Ice skate',
  35: 'Snowshoe',
  37: 'Paddleboard',
  38: 'Surf',
  41: 'Kayak',
  43: 'Windsurf',
};

const asBytes = (buffer) => {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return null;
};

// ".FIT" sits at offset 8, after the 12- or 14-byte header's size, protocol
// version, profile version and data size.
const hasMagic = (bytes, at) =>
  bytes.length >= at + 4 &&
  bytes[at] === 0x2e && bytes[at + 1] === 0x46 && bytes[at + 2] === 0x49 && bytes[at + 3] === 0x54;

/** Cheap sniff for the ".FIT" marker — enough to route a file to parseFit(). */
export function looksLikeFit(bytes) {
  const b = asBytes(bytes);
  return !!b && b.length >= 12 && b[0] >= 12 && hasMagic(b, 8);
}

// One field of a data message by its number, stepping over the fields before
// it by the widths the definition gave them.
function fieldOf(view, off, def, num) {
  for (const f of def.fields) {
    if (f.num === num) return fieldValue(view, off, f.base, f.size, def.le);
    off += f.size;
  }
  return null;
}

/**
 * Walk one FIT file segment (header already consumed) from `off` to `end`,
 * appending to `out`. Definitions are per segment: a chained file starts its
 * local message types over.
 *
 * False means the stream stopped making sense before `end` — a truncated
 * download, most often.
 */
function readMessages(view, off, end, out) {
  const defs = new Map();
  // The running timestamp, in raw FIT seconds, that compressed headers count
  // their 5-bit offsets from.
  let clock = 0;

  while (off < end) {
    const header = view.getUint8(off++);
    let local;
    let stamp = 0;

    if (header & 0x80) {
      // Compressed timestamp header: the message is a data message whose
      // timestamp is 5 bits of offset from the last full one, rolling over
      // every 32 seconds. Masking the difference back into 5 bits handles the
      // roll without a branch. Only two bits are left for the local type, and
      // before the first full timestamp there is nothing to offset from, so
      // such a point simply carries no time.
      local = (header >> 5) & 0x03;
      if (clock) {
        clock += ((header & 0x1f) - (clock & 0x1f)) & 0x1f;
        stamp = clock;
      }
    } else if (header & 0x40) {
      if (off + 5 > end) return false;
      // Byte order is declared per definition message, and holds for the
      // global message number here as well as for the data that follows.
      const le = view.getUint8(off + 1) === 0;
      const global = view.getUint16(off + 2, le);
      const count = view.getUint8(off + 4);
      off += 5;
      if (off + count * 3 > end) return false;

      const fields = [];
      let size = 0;
      for (let i = 0; i < count; i++, off += 3) {
        const width = view.getUint8(off + 1);
        fields.push({ num: view.getUint8(off), size: width, base: view.getUint8(off + 2) & 0x1f });
        size += width;
      }
      // Developer fields are user-defined extras (a third-party app's own
      // metric). We never want their values, but their bytes sit inside every
      // following data message, so their widths still have to be counted or
      // everything after them decodes as garbage.
      if (header & 0x20) {
        if (off >= end) return false;
        const devCount = view.getUint8(off++);
        if (off + devCount * 3 > end) return false;
        for (let i = 0; i < devCount; i++, off += 3) {
          const width = view.getUint8(off + 1);
          fields.push({ num: -1, size: width, base: -1 });
          size += width;
        }
      }
      defs.set(header & 0x0f, { global, le, fields, size });
      continue;
    } else {
      local = header & 0x0f;
    }

    const def = defs.get(local);
    // A data message we have no definition for is unsized, so there is no way
    // to find the message after it. Stop rather than guess.
    if (!def || off + def.size > end) return false;

    // Field 253 is the timestamp in every message that carries one, and it
    // resets the clock compressed headers count from — not only in the records
    // we care about.
    const written = fieldOf(view, off, def, 253);
    if (written !== null) clock = written;

    if (def.global === 20) {
      readRecord(view, off, def, written ?? stamp, out);
    } else if (def.global === 12 || def.global === 18) {
      // The sport arrives either in its own message (global 12, field 0) or on
      // the session summary (global 18, field 5). The dedicated message is the
      // more specific of the two, so it wins wherever both are present.
      const v = fieldOf(view, off, def, def.global === 12 ? 0 : 5);
      const label = v === null ? '' : SPORTS[v] ?? '';
      if (label && (def.global === 12 || !out.sport)) out.sport = label;
    }
    off += def.size;
  }
  return true;
}

// Altitude, speed, power and the rest of a record are skipped by width: the
// map only ever stores lat/lng/time.
function readRecord(view, off, def, t, out) {
  const lat = fieldOf(view, off, def, 0);
  const lng = fieldOf(view, off, def, 1);
  if (lat === null || lng === null) return; // a record with no fix: paused, or indoors

  const deg = { lat: lat * SEMICIRCLE, lng: lng * SEMICIRCLE };
  if (Math.abs(deg.lat) > 90 || Math.abs(deg.lng) > 180) return;
  if (deg.lat === 0 && deg.lng === 0) return; // null-island noise, as in src/locations.js
  out.points.push({ lat: deg.lat, lng: deg.lng, t: unixSeconds(t) });
}

/**
 * Decode a Garmin FIT file into a track.
 *
 * `points` come back in file order with epoch-second timestamps (0 when the
 * file carried none), the same shape src/locations.js produces. An empty list
 * is not a failure: a treadmill run or a trainer session is a valid FIT with
 * no positions in it, and the caller should skip such a file rather than
 * report it as broken.
 *
 * @param {ArrayBuffer|Uint8Array} buffer raw file bytes
 * @returns {{points: Array<{lat:number, lng:number, t:number}>, sport?: string}}
 */
export function parseFit(buffer) {
  const bytes = asBytes(buffer);
  if (!bytes || bytes.length < 14) {
    throw new Error('This file is too small to be a Garmin FIT file — the download may have been cut short.');
  }
  if (bytes[0] < 12 || !hasMagic(bytes, 8)) {
    throw new Error('This is not a Garmin FIT file (its header is missing the ".FIT" marker).');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { points: [] };
  let pos = 0;
  let truncated = false;

  // FIT files can be chained: several complete files, each with its own
  // header and trailing CRC, concatenated into one. Multi-sport watches do
  // this routinely, and reading only the first would silently drop the run
  // after the swim.
  while (pos + 12 <= bytes.length && bytes[pos] >= 12 && hasMagic(bytes, pos + 8)) {
    const headerSize = bytes[pos];
    if (pos + headerSize > bytes.length) break;
    const start = pos + headerSize;
    // The declared data size is trusted only as far as the bytes we actually
    // have; a partial download would otherwise read off the end.
    const end = Math.min(start + view.getUint32(pos + 4, true), bytes.length);
    if (!readMessages(view, start, end, out)) truncated = true;
    pos = end + 2; // the two CRC bytes we are not checking
  }

  if (!out.points.length && truncated) {
    throw new Error('This FIT file is damaged — it ends part way through the recording.');
  }
  return out;
}
