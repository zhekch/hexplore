import Foundation
// `Photos` explicitly, for the two authorization cases read below. This target
// turns on MemberImportVisibility, so importing `PhotoLibrary`'s module is not
// enough to lend `.limited` and `.notDetermined` — the module that *defines* a
// member has to be imported where the member is named.
import Photos
import WebKit

/// What the web app asks when it wants to draw your photographs.
///
/// The overlay — a point per photo, clicked for the picture — is drawn by the
/// page, and a page cannot see a photo library. Nor can the server: nothing but
/// coordinates has ever left this machine, and adding a thumbnail upload to fix
/// that would be a worse trade than the feature is worth. So the page asks the
/// host it happens to be running inside, over
/// `window.webkit.messageHandlers.hexplorePhotos`, and this answers.
///
/// Which is also why the switch exists **only in the apps**. In a browser that
/// message handler is simply not there, `src/photos.js` sees as much, and the
/// row is left out of the menu rather than shown as a control that cannot work.
/// Note that the page's test is for the handler, not for a user-agent string —
/// which is why the same site finds a library here without being told that this
/// host is a Mac rather than a phone.
///
/// ## The page never learns an asset's identity
///
/// A reply carries `[lat, lng, t]` per photo and nothing else. Afterwards a
/// photograph is named by its **index** into the array that was just sent; the
/// `localIdentifier` stays on this side. That is not ceremony. A page is
/// reloaded from a server, keeps storage a browser hands around, and runs
/// scripts this app did not write — handing it durable names for eighty
/// thousand photographs would be building an index of somebody's library in the
/// one place here that is not private by construction.
///
/// An index only means anything against the list that produced it, so every
/// scan is numbered and every later question quotes the number. A question
/// against a scan that has been replaced is answered `stale` and the page asks
/// again — cheap, and the alternative is a click that quietly opens the wrong
/// photograph after a screenshot has landed at the top of the library.
///
/// ## It is answered from the library each time it is asked
///
/// There is no cache and no change observer here. The page asks when the
/// overlay is switched on and when it is reloaded, which is exactly when the
/// answer matters, and a scan is a metadata query — the same one
/// ``PhotoLibrary/located(limit:)`` does for the uploader, at the same cost.
@MainActor
final class PhotoBridge: NSObject, WKScriptMessageHandlerWithReply {

    /// The name the page knows this by, and the whole of how it detects the app.
    /// Changing it means changing `HOST` in src/photos.js.
    static let name = "hexplorePhotos"

    static let shared = PhotoBridge()

    /// How big a picture the card is ever handed. The card is a card whatever
    /// the screen is, and a JPEG this size is ~200 KB — which crosses the bridge
    /// as base64 text, so this is the number that decides whether clicking a
    /// point feels instant. Opening the gallery asks separately, and much
    /// bigger: see ``PhotoLibrary/fullImage(id:)``.
    private static let maxPixels = 1600

    /// The list the page's indices point into, and which list it is.
    private var snapshot: [PhotoLibrary.Located] = []
    private var scan = 0

    private override init() { super.init() }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["ask"] as? String {
        case "points":
            Task { replyHandler(await points(), nil) }
        case "photo":
            Task { replyHandler(await photo(body), nil) }
        case "play":
            Task { replyHandler(await play(body), nil) }
        case "view":
            Task { replyHandler(await view(body), nil) }
        default:
            // A reply rather than an error: the page asking something this build
            // has never heard of is an old app and a new site, which is a
            // situation to report rather than a bug to throw on.
            replyHandler(["ok": false, "error": "unknown"], nil)
        }
    }

    // MARK: - The answers

    /// Every geotagged photograph, and what the page needs to know about the
    /// library it came from.
    private func points() async -> [String: Any] {
        let status = await PhotoLibrary.authorize()
        guard PhotoLibrary.isReadable else {
            return ["ok": false, "error": status == .notDetermined ? "unasked" : "denied"]
        }
        // Off the main actor: this is the one part that is not instant, and it
        // runs while the map is on screen — a second of a frozen map is a second
        // in which the overlay looks broken rather than busy.
        let located = await Task.detached { PhotoLibrary.located() }.value
        snapshot = located
        scan += 1
        return [
            "ok": true,
            "scan": scan,
            // The triple `pointsToCells` reads on the other side of the sync, in
            // the same order, because a photograph is a photograph — with a
            // fourth field saying whether it moves. Always four rather than three
            // for a still and four for a video: rows of two different lengths are
            // a footgun for a few bytes.
            "photos": located.map { [$0.lat, $0.lng, Double($0.t), $0.isVideo ? 1 : 0] },
            // "Only some of them" is worth saying out loud: a limited library is
            // not a smaller map, it is a wrong one, and nothing else on screen
            // would tell you.
            "limited": PhotoLibrary.authorization == .limited,
        ]
    }

    /// One photograph, as a data URL the page can put straight in an `<img>`.
    ///
    /// Base64 rather than a custom URL scheme the page could link to, which
    /// would be the tidier shape and does not survive contact with the site's
    /// own Content-Security-Policy: `img-src` there lists `data:` and https, and
    /// widening a real security header to make a nicer-looking image URL is the
    /// wrong way round.
    private func photo(_ body: [String: Any]) async -> [String: Any] {
        guard (body["scan"] as? Int) == scan else { return ["ok": false, "error": "stale"] }
        guard let i = body["i"] as? Int, snapshot.indices.contains(i) else {
            return ["ok": false, "error": "missing"]
        }
        let px = min(Self.maxPixels, max(64, body["px"] as? Int ?? 512))
        let id = snapshot[i].id
        guard let picture = await PhotoLibrary.jpeg(id: id, px: px) else {
            // The usual cause is an original that lives in iCloud and could not
            // be fetched — no connection, or the download was still going. It is
            // a thing to say in the card, not a failure of the overlay.
            return ["ok": false, "error": "unavailable"]
        }
        return [
            "ok": true,
            "src": "data:image/jpeg;base64,\(picture.data.base64EncodedString())",
            "w": picture.width,
            "h": picture.height,
        ]
    }

    /// Show the group, natively, in a window in front of the page, opened at
    /// whichever of them was clicked.
    ///
    /// `group` is the card's own list — the indices behind the strip along its
    /// bottom, in the order the strip shows them. It is sent because this side
    /// has no way to work it out: clustering happens in the page, on a map the
    /// app cannot see, so "the forty pictures under that dot" is a fact only the
    /// page holds.
    ///
    /// An old page that sends no `group` is answered with the one photograph,
    /// which is what it is expecting.
    private func view(_ body: [String: Any]) async -> [String: Any] {
        open(body)
    }

    /// Play one, natively, in the same window.
    ///
    /// The same gallery, opened on a video, which starts itself. Kept as its own
    /// message because the card has two controls and they mean different things.
    /// See ``PhotoGalleryWindowController`` for why a video is shown this way
    /// rather than handed to the page.
    private func play(_ body: [String: Any]) async -> [String: Any] {
        open(body)
    }

    /// Both of the above: the group, and where in it to start.
    ///
    /// Neither answers with anything but the word "yes" — no data crosses the
    /// bridge here at all.
    private func open(_ body: [String: Any]) -> [String: Any] {
        guard (body["scan"] as? Int) == scan else { return ["ok": false, "error": "stale"] }
        guard let i = body["i"] as? Int, snapshot.indices.contains(i) else {
            return ["ok": false, "error": "missing"]
        }
        // Filtered rather than trusted. These are indices into a list this side
        // owns, arriving from a page, and one of them being out of range has to
        // be a photograph left out of the gallery rather than a crash.
        let wanted = (body["group"] as? [Int])?.filter { snapshot.indices.contains($0) } ?? []
        let group = wanted.isEmpty ? [i] : wanted
        // Where the clicked one ended up after that filtering, which is not
        // `i`'s position in what was sent if anything ahead of it was dropped.
        let at = group.firstIndex(of: i) ?? 0
        guard PhotoLibrary.open(group.map { snapshot[$0] }, at: at) else {
            return ["ok": false, "error": "unavailable"]
        }
        return ["ok": true]
    }
}
