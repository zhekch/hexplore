// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import CoreLocation
import Foundation
import UIKit

/// Recording where the phone has been, with the screen off.
///
/// This is the reason for a native app to exist at all. Everything else here is
/// the web app in a web view, because the web app is better at being itself;
/// this is the one thing a page categorically cannot do, however good it is.
///
/// ## Two services, not one
///
/// **Significant-change monitoring** runs whenever tracking is on, at every
/// cadence. It is not about precision — it is coarse, roughly half a kilometre
/// and whenever iOS feels like it — it is about *survival*. It is the only
/// location service that relaunches a terminated app, so it is what makes the
/// difference between a logger and a logger-until-you-swipe-it-away. It also
/// costs nothing: it is fed by the cell radio doing what it does anyway.
///
/// **Standard updates** run on top of that for every cadence but "only when I
/// go somewhere", and are what the interval settings actually mean.
///
/// ## Why the fixes are coarse on purpose
///
/// `desiredAccuracy` is `kCLLocationAccuracyHundredMeters` at every setting,
/// which is not a compromise — it is the right answer. A cell is about 900 m
/// across, so a ten-metre fix and a hundred-metre fix land in the same hexagon
/// and produce the identical map. What they do not cost the same is power: a
/// hundred metres can be answered from wifi and cell towers, and ten cannot be
/// answered without the GPS chip. Asking for precision this app then throws
/// away would be spending your battery on rounding error.
@MainActor
final class LocationLogger: NSObject, ObservableObject, CLLocationManagerDelegate {

    static let shared = LocationLogger()

    /// What iOS currently allows, so the Settings tab can say why nothing is
    /// arriving instead of leaving a switch on over silence.
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()
    private var lastRecorded: Date?
    /// Set while we are waiting for the system prompt to be answered, so the
    /// answer can start the services the request was made for.
    private var startWhenAuthorized = false

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        // The single most important line in this file, and the least obvious.
        //
        // With the default, iOS pauses updates when it decides you have stopped
        // moving — and then does not resume them. The documented remedy is for
        // the app to notice and restart, which an app that has been suspended
        // for six hours is in no position to do. What it looks like from the
        // outside is a logger that works for an afternoon and then silently
        // stops, forever, with no error anywhere.
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .other
        authorization = manager.authorizationStatus
    }

    /// Start, stop or reconfigure to match the settings. Safe to call at any
    /// time and idempotent, which is what lets every caller be careless.
    func apply() {
        let settings = TrackingSettings.shared
        guard settings.isTracking else {
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            manager.allowsBackgroundLocationUpdates = false
            startWhenAuthorized = false
            return
        }

        switch manager.authorizationStatus {
        case .notDetermined:
            // When-in-use first, always second. Asking for Always outright is
            // allowed and is a worse question: iOS shows one dialog with the
            // strongest option and people say no to it, where the two-step ask
            // arrives after the app has visibly done something with location.
            startWhenAuthorized = true
            manager.requestWhenInUseAuthorization()
            return
        case .restricted, .denied:
            startWhenAuthorized = false
            return
        case .authorizedWhenInUse:
            // Works while the app is on screen, and the escalation prompt is
            // how it comes to work with it away. Asked here rather than at
            // launch because iOS only allows it once.
            manager.requestAlwaysAuthorization()
        default:
            break
        }

        startWhenAuthorized = false
        let cadence = settings.cadence

        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }

        if cadence.wantsContinuousUpdates {
            // Only legal with `location` in UIBackgroundModes — CoreLocation
            // raises rather than returning false if it is missing.
            manager.allowsBackgroundLocationUpdates = true
            manager.distanceFilter = cadence.distanceFilter
            manager.startUpdatingLocation()
        } else {
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
        }
    }

    /// Called from `application(_:didFinishLaunchingWithOptions:)`, including
    /// the launch that iOS performs *for* a location event with no user in
    /// sight. The services have to be restarted before the run loop turns or the
    /// event that caused the launch is delivered to nobody.
    func resume() {
        apply()
        Task { await SyncClient.shared.flush() }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
        guard startWhenAuthorized || TrackingSettings.shared.isTracking else { return }
        apply()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let settings = TrackingSettings.shared
        guard settings.isTracking else { return }

        let limit = Double(settings.precision.rawValue)
        let cadence = settings.cadence
        var took = false

        for location in locations {
            // A negative horizontal accuracy means the fix is invalid, which is
            // CoreLocation's way of handing over a coordinate it does not
            // believe in.
            guard location.horizontalAccuracy >= 0 else { continue }
            if limit > 0 && location.horizontalAccuracy > limit { continue }
            let stamp = location.timestamp
            // iOS opens a service by handing over the last fix it happens to
            // hold, which can be from before the app was launched. Old is fine —
            // it is where you were — but it must not set the throttle's clock
            // forward or be mistaken for a fresh reading.
            guard stamp.timeIntervalSinceNow > -3600 else { continue }
            if let last = lastRecorded, cadence.seconds > 0,
               stamp.timeIntervalSince(last) < cadence.seconds { continue }

            lastRecorded = stamp
            FixQueue.shared.append(FixQueue.Fix(
                lat: location.coordinate.latitude,
                lng: location.coordinate.longitude,
                t: Int(stamp.timeIntervalSince1970),
            ))
            // Offered every fix the app has decided to believe, and cheap on
            // nearly all of them — it does nothing until you have moved a few
            // hundred metres from wherever it last asked about.
            FlightWatch.shared.note(location)
            took = true
        }

        guard took else { return }
        settings.status.pending = FixQueue.shared.count
        Task {
            await SyncClient.shared.flush()
            // A wake is a wake. Health has its own observer, but it only fires
            // when a workout is *saved*, and a watch that finishes a ride out of
            // range of the phone saves it later and quietly.
            await HealthSync.shared.syncIfDue()
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // `kCLErrorLocationUnknown` is ordinary — a phone in a lift, a cold
        // start indoors — and iOS keeps trying on its own. Anything else is
        // worth showing, because the alternative is a Settings tab that says
        // tracking is on while nothing arrives.
        guard (error as? CLError)?.code != .locationUnknown else { return }
        TrackingSettings.shared.status.lastError = error.localizedDescription
    }
}
