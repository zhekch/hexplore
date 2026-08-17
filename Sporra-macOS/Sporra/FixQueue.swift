import CoreLocation
import Foundation

/// Fixes that have been recorded but not yet accepted by the server.
///
/// This is a file rather than an array because of what it is standing between:
/// a laptop carried through a day with no usable network, and a map whose whole
/// claim is *I was here*. A fix held only in memory is a fix lost to the next
/// crash, forced quit or flat battery. So each one is on disk before the
/// delegate method returns, and leaves only when a 200 says it is somewhere
/// better.
///
/// The format is one `lat,lng,t` per line. It is append-only in the common case,
/// which is the operation that has to be cheap and safe; the rewrite happens
/// only after a successful push, when there is time.
@MainActor
final class FixQueue {

    static let shared = FixQueue()

    struct Fix {
        let lat: Double
        let lng: Double
        let t: Int

        /// The wire form: `[lat, lng, t]`, which is what `/api/device/fixes`
        /// reads. Positional because a day of one-a-minute logging is 1,440 of
        /// these and `{"lat":…,"lng":…,"t":…}` triples the bytes to say the same
        /// thing.
        var wire: [Double] { [lat, lng, Double(t)] }
    }

    /// A machine with no connection for a month at one fix a minute is ~43,000
    /// of them. Past that something is wrong rather than merely slow, and the
    /// oldest are the ones to lose: they are the ones whose cells the newer
    /// fixes have most likely lit up already.
    private static let maxHeld = 50_000

    private let url: URL
    private var fixes: [Fix] = []

    private init() {
        // Application Support, not Caches: the system empties Caches under
        // pressure, and this is the one thing here that cannot be re-derived.
        //
        // Inside a folder of our own, which the phone does not bother with and a
        // Mac has to. Sandboxed, this is already a private container; run
        // unsandboxed for any reason and the same call returns the *shared*
        // `~/Library/Application Support`, and dropping a bare
        // `pending-fixes.txt` in there among everyone else's folders is rude at
        // best and ambiguous at worst.
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sporra", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        url = base.appendingPathComponent("pending-fixes.txt")
        fixes = Self.read(url)
    }

    var count: Int { fixes.count }

    var newest: Int? { fixes.last?.t }

    func append(_ fix: Fix) {
        fixes.append(fix)
        if fixes.count > Self.maxHeld {
            fixes.removeFirst(fixes.count - Self.maxHeld)
            write()
            return
        }
        // The whole point of the line format: adding one costs an open and a
        // write of about thirty bytes, whatever else is in the file.
        guard let data = "\(Self.line(fix))\n".data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// The oldest `limit` fixes — the front of the queue, which is the order
    /// they have to leave in. The server drops anything at or before the cursor
    /// it holds for this device, so a batch sent out of order would be a batch
    /// thrown away.
    func head(limit: Int) -> [Fix] {
        Array(fixes.prefix(limit))
    }

    /// Forget the oldest `n` — called only when the server has said 200.
    func drop(_ n: Int) {
        guard n > 0 else { return }
        fixes.removeFirst(min(n, fixes.count))
        write()
    }

    func clear() {
        fixes = []
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - The file

    private static func line(_ f: Fix) -> String {
        // Six decimal places is about 11 cm, which is far past what a fix
        // deserves and still shorter than the default `Double` description.
        String(format: "%.6f,%.6f,%d", f.lat, f.lng, f.t)
    }

    private static func read(_ url: URL) -> [Fix] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var out: [Fix] = []
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: ",")
            guard parts.count == 3,
                  let lat = Double(parts[0]), let lng = Double(parts[1]), let t = Int(parts[2])
            else { continue } // a half-written last line, which is why this is lenient
            out.append(Fix(lat: lat, lng: lng, t: t))
        }
        return out
    }

    private func write() {
        let text = fixes.map(Self.line).joined(separator: "\n")
        try? (text.isEmpty ? "" : text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
}
