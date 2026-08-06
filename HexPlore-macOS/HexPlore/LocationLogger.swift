// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import CoreLocation
import Foundation

/// Recording where the Mac has been.
///
/// ## What this is, and is not, on a Mac
///
/// On the phone this is the reason the app exists: recording your position with
/// the screen off is the one thing a web page categorically cannot do. Here the
/// claim is smaller and worth stating plainly, because the difference is easy to
/// assume away.
///
/// **A Mac records while the app is running.** macOS does not relaunch an app
/// for a location event and does not wake a sleeping machine to take a fix, so
/// there is no equivalent of the phone's "swiped away and still logging". Quit
/// HexPlore and nothing is recorded until you open it again; close the window
/// and it keeps going, which is why `applicationShouldTerminateAfterLastWindowClosed`
/// answers false. A closed lid is asleep, and asleep is not anywhere.
///
/// That makes this genuinely useful on a laptop that travels and nearly useless
/// on a desktop that does not, which is why the switch starts off — see
/// ``TrackingSettings/Cadence``.
///
/// ## Two services, not one
///
/// **Significant-change monitoring** runs whenever tracking is on, at every
/// cadence. On the phone its job is survival — it is the only service that
/// relaunches a terminated app. Here it cannot do that, so it is kept for the
/// duller half of the same reason: it is coarse, roughly half a kilometre,
/// costs almost nothing, and is exactly what "only when I go somewhere" means.
///
/// **Standard updates** run on top of it for every cadence but that one, and are
/// what the interval settings actually mean.
///
/// ## Why the fixes are coarse on purpose
///
/// `desiredAccuracy` is `kCLLocationAccuracyHundredMeters` at every setting,
/// which is not a compromise — it is the right answer. A cell is about 900 m
/// across, so a ten-metre fix and a hundred-metre fix land in the same hexagon
/// and produce the identical map. A Mac has no GPS chip and answers from wifi
/// positioning either way, so asking for precision it cannot give and this app
/// would throw away buys nothing at all.
@MainActor
final class LocationLogger: NSObject, ObservableObject, CLLocationManagerDelegate {

    static let shared = LocationLogger()

    /// What macOS currently allows, so the Settings window can say why nothing
    /// is arriving instead of leaving a switch on over silence.
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()
    private var lastRecorded: Date?
    /// Set while we are waiting for the system prompt to be answered, so the
    /// answer can start the services the request was made for.
    private var startWhenAuthorized = false
    /// Set while the manager is running only to make the prompt appear, so the
    /// answer can stop it again. See ``requestAuthorizationIfNeeded()``.
    private var nudging = false

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        // With the default, the system pauses updates when it decides you have
        // stopped moving — and then does not resume them. The documented remedy
        // is for the app to notice and restart, and what it looks like from the
        // outside if it does not is a logger that works for an afternoon and
        // then silently stops, forever, with no error anywhere.
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
            startWhenAuthorized = false
            return
        }

        switch manager.authorizationStatus {
        case .notDetermined:
            // One ask, not the phone's two.
            //
            // `kCLAuthorizationStatusAuthorizedWhenInUse` is
            // `API_UNAVAILABLE(macos)` — naming it here would not compile. macOS
            // has a single location grant, so there is no weaker permission to
            // ask for first and no escalation prompt to follow it with, and
            // `requestAlwaysAuthorization` is the whole of the question.
            startWhenAuthorized = true
            manager.requestAlwaysAuthorization()
            return
        case .restricted, .denied:
            startWhenAuthorized = false
            return
        default:
            break
        }

        startWhenAuthorized = false
        let cadence = settings.cadence

        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }

        if cadence.wantsContinuousUpdates {
            // **`allowsBackgroundLocationUpdates` is deliberately not set**, and
            // this is the one line where copying the iPhone app would crash the
            // Mac one. CoreLocation's own header: "Setting this property to YES
            // when UIBackgroundModes does not include location is a fatal
            // error." There is no UIBackgroundModes on macOS to include it in.
            //
            // Nothing is lost. That property exists to keep an app running while
            // iOS would otherwise suspend it; a Mac app that is open is simply
            // running, window or no window.
            manager.distanceFilter = cadence.distanceFilter
            manager.startUpdatingLocation()
        } else {
            manager.stopUpdatingLocation()
        }
    }

    /// Called from `applicationDidFinishLaunching`.
    func resume() {
        apply()
        Task { await SyncClient.shared.flush() }
    }

    /// Raise the system prompt once, for the page's own "my location" button.
    ///
    /// Separate from ``apply()`` because it is a different question: that one is
    /// about the *logger*, and this is about the blue dot the web app draws,
    /// which people want with tracking switched off.
    ///
    /// **It has to be this manager.** The web view used to own a second
    /// `CLLocationManager` and ask on that one, and it silently never prompted:
    /// CoreLocation delivers the outcome of an authorization request through
    /// `locationManagerDidChangeAuthorization`, and a manager with no delegate
    /// has nowhere to deliver it — so the request goes nowhere and the only
    /// symptom is a permission that stays `.notDetermined` for ever. This
    /// manager has had a delegate since `init`, and it is the one object in the
    /// app that should be talking to CoreLocation anyway.
    func requestAuthorizationIfNeeded() {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestAlwaysAuthorization()
        // **And then actually want a location**, which is the part that was
        // missing.
        //
        // `requestAlwaysAuthorization()` alone is enough on a phone. On a Mac it
        // is documented to raise the prompt and does not reliably do so; what
        // does is a manager that has *started*, because the prompt is really
        // about a service being used rather than a permission being asked for.
        // Starting here costs nothing and cannot record anything:
        // `didUpdateLocations` returns immediately while tracking is off, which
        // on a Mac is the default.
        //
        // It stops itself the moment the question is answered, either way —
        // below, and on a timer in case the answer never arrives.
        nudging = true
        manager.startUpdatingLocation()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            self?.endNudge()
        }
    }

    /// Stop the manager started purely to raise the prompt — unless the logger
    /// itself now wants it running.
    private func endNudge() {
        guard nudging else { return }
        nudging = false
        guard !TrackingSettings.shared.isTracking else { return }
        manager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
        // Answered, so whatever was running only to ask can stop.
        if authorization != .notDetermined { endNudge() }
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
            // Opening a service hands over the last fix the system happens to
            // hold, which can be from before the app was launched — or from
            // before the lid was closed, which on a laptop can be days. Old is
            // fine, it is where you were, but it must not set the throttle's
            // clock forward or be mistaken for a fresh reading.
            guard stamp.timeIntervalSinceNow > -3600 else { continue }
            if let last = lastRecorded, cadence.seconds > 0,
               stamp.timeIntervalSince(last) < cadence.seconds { continue }

            lastRecorded = stamp
            FixQueue.shared.append(FixQueue.Fix(
                lat: location.coordinate.latitude,
                lng: location.coordinate.longitude,
                t: Int(stamp.timeIntervalSince1970),
            ))
            took = true
        }

        guard took else { return }
        settings.status.pending = FixQueue.shared.count
        Task { await SyncClient.shared.flush() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // `kCLErrorLocationUnknown` is ordinary — a machine that has just woken,
        // a room with no wifi it recognises — and the system keeps trying on its
        // own. Anything else is worth showing, because the alternative is a
        // Settings window that says tracking is on while nothing arrives.
        guard (error as? CLError)?.code != .locationUnknown else { return }
        TrackingSettings.shared.status.lastError = error.localizedDescription
    }
}
