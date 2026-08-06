import Foundation
// `Photos` explicitly, for the authorization cases named below. This target
// turns on MemberImportVisibility, so the module that *defines* a member has to
// be imported where the member is named.
import Photos
import WebKit

/// Saving the exported picture, because the page cannot.
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
/// still runs — so this changes nothing in mobile Safari.
///
/// ## The photo library, not a file
///
/// A phone has no filesystem anybody looks at, and a picture of your map is a
/// picture: it belongs where the camera roll is, next to everything else you
/// would show somebody. The Mac app answers the same message by writing to
/// Downloads, because a Mac *does* have a place files go — same bridge, same
/// question, and the right answer is different on each.
///
/// ## Adding is a smaller permission than reading, and it is asked for separately
///
/// `PHAccessLevel.addOnly` cannot read one photograph, and this is the only
/// thing in the app that wants it. It is deliberately not folded into the
/// read permission the map overlay asks for: somebody who has never turned on
/// the photo overlay should still be able to save a picture, and saving one
/// should not be a reason to hand over a library.
@MainActor
final class SaveBridge: NSObject, WKScriptMessageHandlerWithReply {

    /// The name the page knows this by. Changing it means changing `saveHost()`
    /// in src/export-ui.js — and the macOS app's copy.
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
            Task { replyHandler(await save(body), nil) }
        default:
            // A reply rather than an error: a page asking something this build
            // has never heard of is an old app and a new site.
            replyHandler(["ok": false, "error": "unknown"], nil)
        }
    }

    private func save(_ body: [String: Any]) async -> [String: Any] {
        guard let base64 = body["data"] as? String,
              let data = Data(base64Encoded: base64)
        else { return ["ok": false, "error": "The picture could not be read."] }

        guard await authorize() else {
            return [
                "ok": false,
                "error": "Hexplore cannot add to your photo library. Allow it in Settings to save the picture.",
            ]
        }

        do {
            try await PHPhotoLibrary.shared().performChanges {
                // `forAsset()` with a resource rather than `creationRequestForAsset(from:)`:
                // the second wants a `UIImage`, which means decoding the PNG to
                // a bitmap and letting Photos re-encode it — a lossy round trip
                // through however many megabytes a poster decodes to. This
                // hands over the exact bytes the page produced.
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: nil)
            }
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
        return ["ok": true, "where": "Photos"]
    }

    /// Permission to add, asked for on its own account.
    private func authorize() async -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .authorized || status == .limited { return true }
        guard status == .notDetermined else { return false }
        let granted = await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { next in
                continuation.resume(returning: next)
            }
        }
        return granted == .authorized || granted == .limited
    }
}
