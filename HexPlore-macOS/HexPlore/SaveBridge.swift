import AppKit
import Foundation
import WebKit

/// Writing the exported picture to disk, because the page cannot.
///
/// `a.download` — which is how every browser saves the export — does nothing at
/// all in a `WKWebView`. The anchor is created, clicked, and ignored: no file,
/// no error, and nothing the page can feature-detect. So the dialog showed
/// "Saved …" and saved nothing, which is a worse failure than an error.
///
/// So the page asks the host instead, over
/// `window.webkit.messageHandlers.hexploreSave`, exactly as it asks
/// ``PhotoBridge`` for a photograph. In a browser the handler is absent,
/// `saveHost()` in `src/export-ui.js` sees as much, and the ordinary anchor
/// still runs — so this changes nothing outside the apps.
///
/// ## Downloads, like the browser it is standing in for
///
/// A Mac has a place files go, and putting the picture anywhere else would be
/// answering a question nobody asked. The iPhone app saves to the photo library
/// instead, because a phone has no visible filesystem and a picture belongs in
/// Photos — same message, same bridge, different right answer.
///
/// The sandbox allows this precisely and no further:
/// `com.apple.security.files.downloads.read-write` is write access to
/// `~/Downloads` and to nothing else, which is the whole of what saving a
/// picture needs.
///
/// ## Base64, and why it is not worse than it looks
///
/// A `Uint8Array` crossing `WKScriptMessage` arrives as an `NSArray` of boxed
/// numbers — one object per byte, which for a poster is tens of millions of
/// allocations. Base64 is a third larger on the wire and a single string, and
/// this happens once, on a button press, so the trade is not close.
@MainActor
final class SaveBridge: NSObject, WKScriptMessageHandlerWithReply {

    /// The name the page knows this by. Changing it means changing `saveHost()`
    /// in src/export-ui.js — and the iOS app's copy.
    static let name = "hexploreSave"

    static let shared = SaveBridge()

    private override init() { super.init() }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["ask"] as? String {
        case "png":
            replyHandler(save(body), nil)
        default:
            // A reply rather than an error: a page asking something this build
            // has never heard of is an old app and a new site.
            replyHandler(["ok": false, "error": "unknown"], nil)
        }
    }

    private func save(_ body: [String: Any]) -> [String: Any] {
        guard let base64 = body["data"] as? String,
              let data = Data(base64Encoded: base64)
        else { return ["ok": false, "error": "The picture could not be read."] }

        let name = Self.safeName(body["name"] as? String)

        guard let folder = try? FileManager.default.url(
            for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else {
            return ["ok": false, "error": "The Downloads folder could not be found."]
        }

        let target = Self.unused(folder.appendingPathComponent(name))
        do {
            try data.write(to: target, options: .atomic)
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
        // The bounce in the Dock a download gets from every other app.
        NSWorkspace.shared.activateFileViewerSelecting([target])
        return ["ok": true, "where": "Downloads"]
    }

    /// A file name that cannot escape the folder it is meant for.
    ///
    /// The page composes this from a place name, and a place name is somebody
    /// else's text — a slash in it would be a path separator here.
    private static func safeName(_ raw: String?) -> String {
        let fallback = "hexplore.png"
        var name = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        name = name.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        // A leading dot would make it invisible; a leading dash is awkward on a
        // command line. Neither is what anybody meant.
        while name.hasPrefix(".") || name.hasPrefix("-") { name.removeFirst() }
        guard !name.isEmpty else { return fallback }
        return name.lowercased().hasSuffix(".png") ? name : "\(name).png"
    }

    /// `name.png`, `name 2.png`, `name 3.png` — the Finder's own answer to a
    /// name already taken, rather than overwriting a picture somebody made
    /// earlier.
    private static func unused(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let folder = url.deletingLastPathComponent()
        let stem = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        for n in 2...999 {
            let next = folder.appendingPathComponent("\(stem) \(n)").appendingPathExtension(ext)
            if !fm.fileExists(atPath: next.path) { return next }
        }
        return url
    }
}
