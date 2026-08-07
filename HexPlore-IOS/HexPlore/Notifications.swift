// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import Foundation
import UserNotifications

/// The only things this app ever says to you when it is not on screen.
///
/// **All of them are local.** There is no push server, no APNs certificate and
/// no device token going anywhere — every notification here is scheduled by this
/// phone, from something this phone already knew, and fires whether or not the
/// server is reachable. That is not a limitation being worked around; it is the
/// shape the rest of the app already has. The one thing a native app is *for*
/// here is knowing where it is with the screen off, and a notification about
/// where you are is the same fact arriving a second time.
///
/// It also means the permission is worth asking for honestly. An app that asks
/// on first launch, before it has done anything, is asking you to trust a
/// promise; this asks from a switch you turned on, next to a sentence saying
/// what it will send. Nothing here asks at launch, and nothing here asks twice —
/// iOS only shows the dialog once, and after that the only way back is the
/// Settings app, which `SettingsView` links to rather than pretending otherwise.
@MainActor
final class Notifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {

    static let shared = Notifications()

    /// What iOS currently allows. Read rather than assumed, because it can be
    /// changed in the Settings app while this app is not running, and a switch
    /// that claims to be on over silence is the failure this is here to avoid.
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        center.delegate = self
    }

    /// Whether anything can actually be delivered.
    ///
    /// `.provisional` counts: it is the quiet authorisation iOS grants without a
    /// dialog, where notifications arrive silently in the notification centre.
    /// That is a perfectly good place for "have a good flight" to land.
    var isAllowed: Bool {
        authorization == .authorized || authorization == .provisional || authorization == .ephemeral
    }

    /// Ask iOS what it thinks. Cheap, and worth doing every time the Settings
    /// tab appears.
    func refresh() async {
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Ask the person, once.
    ///
    /// iOS shows its dialog only for `.notDetermined`; every later call returns
    /// the standing answer without showing anything, which is why the Settings
    /// tab offers a link to the Settings app rather than a button that would
    /// silently do nothing on the second press.
    @discardableResult
    func request() async -> Bool {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        await refresh()
        return granted
    }

    /// Put one in the queue for later.
    ///
    /// A time trigger rather than a location one, and that is the whole design of
    /// the flight notification: see `FlightWatch`. Replacing an existing request
    /// with the same identifier is how iOS updates it, so a caller that
    /// re-schedules is not stacking duplicates.
    ///
    /// - Parameter after: seconds from now. Must be > 0; iOS rejects zero.
    func schedule(id: String, title: String, body: String, after: TimeInterval) async {
        guard isAllowed, after > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: id,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: after, repeats: false)
        )
        try? await center.add(request)
    }

    /// Take one back before it fires.
    func cancel(id: String) {
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    /// Is one still waiting to fire?
    func isPending(id: String) async -> Bool {
        await center.pendingNotificationRequests().contains { $0.identifier == id }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show it even when the app is open.
    ///
    /// Without this, iOS delivers a foreground notification to the delegate and
    /// draws nothing — which is right for an app whose notification duplicates
    /// what is already on the screen, and wrong for these: nothing on the Map tab
    /// says you have been at an airport for ten minutes.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
