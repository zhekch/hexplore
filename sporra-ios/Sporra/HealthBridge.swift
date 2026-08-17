import Foundation
import WebKit

/// What the web app asks when it wants your workouts.
///
/// The introduction (`src/intro-ui.js`) offers three permissions on a first run,
/// and two of them could already be asked for from the page: a photo library is
/// asked by *asking it a question* — see ``PhotoBridge`` — and a position by the
/// ordinary `navigator.geolocation`. Health was the odd one out. There is no way
/// to raise HealthKit's sheet from a web page, so the card had to end in
/// directions: *go to the Settings tab and turn on Workouts*. Which works, and
/// is a worse thing to be told than to simply be asked.
///
/// This is that gap closed. It carries no data whatsoever — the workouts
/// themselves have always gone up through ``SyncClient``, on this app's own
/// schedule, and nothing about that changes. The only thing crossing here is the
/// question.
///
/// ## Throwing the switch *is* the request
///
/// There is no "ask for permission" call to make. ``HealthSync/apply()`` is
/// where `requestAuthorization` lives, and it runs off the `didSet` on
/// ``TrackingSettings/syncWorkouts``. So this sets the setting the Settings tab
/// would have set, and iOS puts its sheet in front of the result — which means
/// the page and the switch cannot disagree afterwards, because there is only one
/// of them.
///
/// ## "ok" means asked, not granted
///
/// Read permission in HealthKit never reports itself. For privacy, Health
/// answers a query the same way whether you said yes or no, and the only way to
/// find out is to ask for data and see what arrives — which is why
/// ``HealthSync/apply()`` has nothing to branch on either. So a `true` here says
/// the sheet was raised and the sync is on, and a refusal shows up later as a
/// sync that finds no workouts. The Settings tab says as much; so does the card.
///
/// ## Not on the Mac
///
/// There is no HealthKit on macOS at all, so there is no `HealthBridge.swift`
/// under `Sporra-macOS/` and the row is absent from the card there
/// (`permissionsFor` in src/intro.js). An older build of *this* app has no such
/// handler either, and the page falls back to the directions it used to give —
/// which is why the absence is answered rather than assumed away.
@MainActor
final class HealthBridge: NSObject, WKScriptMessageHandlerWithReply {

    /// The name the page knows this by, and the whole of how it detects that
    /// this build can be asked. Changing it means changing `healthHost()` in
    /// src/main.js.
    static let name = "sporraHealth"

    static let shared = HealthBridge()

    private override init() { super.init() }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["ask"] as? String {
        case "state":
            replyHandler(state(), nil)
        case "authorize":
            replyHandler(authorize(), nil)
        default:
            // A reply rather than an error, for the reason `PhotoBridge` gives:
            // a page asking something this build has never heard of is a new
            // site and an old app, which is a situation to report.
            replyHandler(["ok": false, "error": "unknown"], nil)
        }
    }

    /// Whether this phone can do it at all, and whether it is already on.
    ///
    /// Asked without asking — nothing here raises a sheet — so the introduction
    /// can say "already done" on a replay instead of offering to do it again.
    private func state() -> [String: Any] {
        [
            "ok": true,
            "available": HealthSync.shared.isAvailable,
            "on": TrackingSettings.shared.syncWorkouts,
        ]
    }

    /// Turn it on, which is what raises the sheet.
    private func authorize() -> [String: Any] {
        // An iPad without Health, or a device where it is restricted. Said
        // plainly rather than switched on to no effect: the switch would stay
        // on for ever afterwards, describing a sync that cannot happen.
        guard HealthSync.shared.isAvailable else {
            return ["ok": false, "error": "unavailable"]
        }
        if TrackingSettings.shared.syncWorkouts {
            // Already on, so the `didSet` will not fire — and this is reachable:
            // somebody who turned it on and dismissed the sheet has the setting
            // without the permission. Applying directly asks again, which is the
            // only thing that could possibly help them.
            HealthSync.shared.apply()
        } else {
            TrackingSettings.shared.syncWorkouts = true
        }
        return ["ok": true]
    }
}
