import CoreLocation
import Foundation

/// "Have a good flight" — said once, ten minutes after you arrive at an airport.
///
/// ## Why this is scheduled forward rather than measured backward
///
/// The obvious implementation waits for a second fix ten minutes after the
/// first and compares them. It does not work, and the reason is the whole of
/// this file: at an airport you are *standing still*. On the "only when I go
/// somewhere" cadence there is no standard location service running at all —
/// significant-change monitoring is fed by the cell radio noticing you have
/// moved half a kilometre, and a person sitting at gate B47 has not. The second
/// fix arrives when you land.
///
/// So the ten minutes are a `UNTimeIntervalNotificationTrigger`. The first fix
/// inside an airport schedules a notification for ten minutes' time; any later
/// fix outside it cancels the notification before it fires. What that means in
/// practice is *you arrived at an airport ten minutes ago and nothing since has
/// said you left*, which is the same claim the dwell version would have made and
/// is arrived at without needing the phone to be awake in between.
///
/// It is also why leaving inside those ten minutes is the one case this gets
/// wrong in the direction of speaking: if you drive past a terminal and out of
/// range of another fix, you may be wished a happy flight. Ten minutes is long
/// enough that this is rare, and the failure is a friendly sentence rather than
/// a wrong map.
///
/// ## Why the server answers the question
///
/// The dataset is 5,272 airports and this phone has no copy of it. Bundling one
/// would mean a generated resource in the Xcode project, kept in step with
/// `sporra-webserver/src/airports-airline.json` by hand, going stale silently.
/// `GET /api/airport` is one small request made only when a fix has moved far
/// enough to be worth asking about — and a phone at an airport has a network,
/// because that is what an airport is.
///
/// If it has no network, or the session has ended, nothing is scheduled. Missing
/// the notification costs nothing; that is the right side to fail on.
@MainActor
final class FlightWatch {

    static let shared = FlightWatch()

    /// How long after arriving the notification fires.
    private static let dwell: TimeInterval = 10 * 60

    /// How far you have to have moved before the question is worth asking again.
    ///
    /// Airports are matched within a few kilometres of their reference point
    /// (`server/airport-at.js`), so a phone that has moved 400 m has almost
    /// certainly not changed its answer. This is the whole of the rate limiting:
    /// on the one-minute cadence a phone in a departure hall would otherwise ask
    /// sixty times an hour to be told the same thing.
    private static let askRadius: CLLocationDistance = 400

    /// How long before the same airport may be mentioned again.
    ///
    /// Long enough to cover a flight and its connection, so a delayed departure
    /// or a walk to a different terminal does not produce a second one. Short
    /// enough that the flight home next week does.
    private static let cooldown: TimeInterval = 12 * 3600

    /// One identifier, so a re-schedule replaces rather than stacks — and so
    /// cancelling needs to know nothing about which airport it was.
    private static let requestId = "sporra.flight"

    /// Where we last asked the server about, so most fixes cost nothing.
    private var lastAsked: CLLocation?
    /// Which airport is currently scheduled, and when we last spoke about each.
    private var pendingAirport: String?
    private var spokenAt: [String: Date] = [:]
    /// One question at a time. A burst of fixes arrives as an array, and iOS
    /// hands over its cached fix at the moment a service opens.
    private var asking = false

    private init() {}

    /// A fix has arrived. Cheap to call on every one of them.
    ///
    /// Called from `LocationLogger` after the fix has passed the accuracy and
    /// cadence filters, so what reaches here is a location the app has decided
    /// to believe and to record.
    func note(_ location: CLLocation) {
        guard TrackingSettings.shared.notifyFlights else { return }
        guard Notifications.shared.isAllowed else { return }

        // Not moved far enough to have changed the answer. This is the branch
        // nearly every fix takes.
        if let last = lastAsked, location.distance(from: last) < Self.askRadius { return }
        guard !asking else { return }

        asking = true
        lastAsked = location
        Task {
            defer { asking = false }
            await ask(about: location)
        }
    }

    /// Tracking was switched off, or notifications were. Anything already
    /// scheduled is about a phone that is no longer being watched.
    func stop() {
        Notifications.shared.cancel(id: Self.requestId)
        pendingAirport = nil
        lastAsked = nil
    }

    // MARK: -

    private func ask(about location: CLLocation) async {
        let airport: SyncClient.Airport?
        do {
            airport = try await SyncClient.shared.airport(
                lat: location.coordinate.latitude,
                lng: location.coordinate.longitude
            )
        } catch {
            // No network, no session, no server. The next fix that has moved far
            // enough asks again; `lastAsked` has already moved, which is the
            // right trade — retrying the same spot on a dead connection is how a
            // background wake spends all of its seconds.
            return
        }

        guard let airport, !airport.key.isEmpty else {
            // Out of every airport, including the one we were waiting on. This is
            // the cancel that makes the forward-scheduling honest.
            if pendingAirport != nil {
                Notifications.shared.cancel(id: Self.requestId)
                pendingAirport = nil
            }
            return
        }

        // Already waiting on this one — the trigger is running, leave it alone.
        // Re-adding with the same identifier would restart the ten minutes, so a
        // phone that reports a fix every minute would never reach the end of it.
        if pendingAirport == airport.key { return }

        if let last = spokenAt[airport.key], Date().timeIntervalSince(last) < Self.cooldown { return }

        pendingAirport = airport.key
        spokenAt[airport.key] = Date()
        await Notifications.shared.schedule(
            id: Self.requestId,
            title: "Have a good flight",
            body: Self.greeting(for: airport),
            after: Self.dwell
        )
    }

    /// What the notification says.
    ///
    /// Named, because "you are at an airport" is a thing you already know and
    /// "you are at Zürich Airport" is the app showing it knows where you are —
    /// which is the only reason this is charming rather than noise. The city is
    /// the fallback, and a bare sentence is the fallback for that: a dataset
    /// entry with neither is not a reason to say nothing.
    private static func greeting(for airport: SyncClient.Airport) -> String {
        if !airport.name.isEmpty { return "Safe travels from \(airport.name)." }
        if !airport.city.isEmpty { return "Safe travels from \(airport.city)." }
        return "Safe travels — wherever you are headed."
    }
}
