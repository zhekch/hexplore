// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import CoreLocation
import Foundation
import UIKit

/// How this phone records where it has been.
///
/// Everything else about your map lives on the server, where a laptop finds it
/// in the same place. This does not, and the reason is not tidiness: a schedule
/// stored on the server could not make a sleeping phone wake up. The timer runs
/// here or it does not run, so the setting lives where the timer is.
///
/// A singleton because iOS relaunches this app *into the background* when the
/// significant-change monitor fires, and at that moment there is no window, no
/// `ContentView` and no `@StateObject` — only `didFinishLaunchingWithOptions`
/// and about a second to have opinions in.
@MainActor
final class TrackingSettings: ObservableObject {

    static let shared = TrackingSettings()

    /// How often the phone writes down where it is.
    ///
    /// Named in time because that is the question anyone actually asks, and
    /// implemented in distance as well because that is what CoreLocation can be
    /// cheap about — a phone that has not moved is not worth waking on a timer,
    /// and `distanceFilter` is how you say so without holding the GPS open.
    enum Cadence: Int, CaseIterable, Identifiable {
        case off = -1
        case significant = 0
        case hour = 60
        case halfHour = 30
        case quarterHour = 15
        case fiveMinutes = 5
        case minute = 1

        var id: Int { rawValue }

        var title: String {
            switch self {
            case .off: return "Off"
            case .significant: return "Only when I go somewhere"
            case .hour: return "Every hour"
            case .halfHour: return "Every half hour"
            case .quarterHour: return "Every 15 minutes"
            case .fiveMinutes: return "Every 5 minutes"
            case .minute: return "Every minute"
            }
        }

        /// The shortest gap between two recorded fixes.
        var seconds: TimeInterval { self == .significant ? 0 : Double(max(0, rawValue)) * 60 }

        /// How far you have to move before iOS bothers telling us.
        ///
        /// Scaled with the cadence so a phone on your desk costs nothing at any
        /// setting: the fixes it would deliver are the ones the throttle would
        /// throw away anyway, and the cheapest fix is the one never taken. The
        /// floor is 100 m because that is the accuracy asked for below — a
        /// tighter filter than the accuracy is a filter on noise.
        var distanceFilter: CLLocationDistance {
            switch self {
            case .off, .significant: return kCLDistanceFilterNone
            case .hour: return 500
            case .halfHour: return 350
            case .quarterHour: return 250
            case .fiveMinutes: return 150
            case .minute: return 100
            }
        }

        /// Whether this cadence needs the standard location service at all.
        /// `.significant` does not: the significant-change monitor is a
        /// different service and a far cheaper one.
        var wantsContinuousUpdates: Bool {
            switch self {
            case .off, .significant: return false
            default: return true
            }
        }
    }

    /// How vague a fix can be before it is thrown away.
    ///
    /// A cell is about 900 m across, so a fix the phone itself calls loose —
    /// cell-tower fallback, indoors, a cold start — lands in the wrong one often
    /// enough to matter. Home Assistant has the same setting for the same
    /// reason; the difference is that there it has to live on the server,
    /// because the server is the thing doing the reading.
    enum Precision: Int, CaseIterable, Identifiable {
        case tight = 100
        case normal = 250
        case loose = 500
        case any = 0

        var id: Int { rawValue }

        var title: String {
            switch self {
            case .tight: return "Within 100 m"
            case .normal: return "Within 250 m"
            case .loose: return "Within 500 m"
            case .any: return "Take every fix"
            }
        }
    }

    @Published var cadence: Cadence {
        didSet {
            guard cadence != oldValue else { return }
            defaults.set(cadence.rawValue, forKey: Keys.cadence)
            LocationLogger.shared.apply()
        }
    }

    @Published var precision: Precision {
        didSet {
            guard precision != oldValue else { return }
            defaults.set(precision.rawValue, forKey: Keys.precision)
        }
    }

    /// Whether to bring in Apple Health workouts — the ones that went somewhere.
    @Published var syncWorkouts: Bool {
        didSet {
            guard syncWorkouts != oldValue else { return }
            defaults.set(syncWorkouts, forKey: Keys.syncWorkouts)
            HealthSync.shared.apply()
        }
    }

    /// Whether to read the photo library for the places it has been.
    @Published var syncPhotos: Bool {
        didSet {
            guard syncPhotos != oldValue else { return }
            defaults.set(syncPhotos, forKey: Keys.syncPhotos)
            PhotoSync.shared.apply()
        }
    }

    /// What this phone calls itself on the sync screen.
    ///
    /// Typed rather than read, because since iOS 16 `UIDevice.name` answers
    /// "iPhone" for everyone unless the app carries an entitlement Apple grants
    /// case by case. Two phones both filed under "iPhone" is exactly the thing
    /// this field exists to prevent.
    @Published var deviceName: String {
        didSet {
            let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
            defaults.set(trimmed, forKey: Keys.deviceName)
        }
    }

    /// This phone's identity to the server, made once and kept.
    ///
    /// Not `identifierForVendor`: that is reissued when the last app from a
    /// vendor is deleted, which would silently turn one phone into two in the
    /// device list — and, worse, reset the server-side cursor that stops a
    /// re-sent batch being counted twice.
    let deviceId: String

    /// The last thing the uploader has to say for itself, for the Settings tab.
    @Published var status = SyncStatus()

    struct SyncStatus {
        var pending = 0
        var lastPush: Date?
        var lastError: String?
        /// The session cookie has gone. Nothing native can fix this — signing in
        /// happens on the Map tab, in the site's own login.
        var signedOut = false
        var lastWorkoutScan: Date?
        var workoutsSent = 0
        var lastPhotoScan: Date?
        var photosSent = 0
    }

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let cadence = "tracking.cadence"
        static let precision = "tracking.precision"
        static let syncWorkouts = "tracking.syncWorkouts"
        static let syncPhotos = "tracking.syncPhotos"
        static let deviceName = "tracking.deviceName"
        static let deviceId = "tracking.deviceId"
    }

    private init() {
        let d = UserDefaults.standard
        // `object(forKey:)` rather than `integer(forKey:)`: an unset integer
        // reads back as 0, which is a real Cadence (`.significant`), so the
        // default would be "already tracking" for anyone who never asked.
        cadence = (d.object(forKey: Keys.cadence) as? Int).flatMap(Cadence.init) ?? .off
        precision = (d.object(forKey: Keys.precision) as? Int).flatMap(Precision.init) ?? .normal
        syncWorkouts = d.bool(forKey: Keys.syncWorkouts)
        syncPhotos = d.bool(forKey: Keys.syncPhotos)
        deviceName = d.string(forKey: Keys.deviceName) ?? UIDevice.current.name
        if let existing = d.string(forKey: Keys.deviceId), !existing.isEmpty {
            deviceId = existing
        } else {
            let fresh = UUID().uuidString
            d.set(fresh, forKey: Keys.deviceId)
            deviceId = fresh
        }
    }

    var isTracking: Bool { cadence != .off }

    /// What every push carries so the server can tell this phone from another.
    var deviceHeader: [String: String] {
        [
            "id": deviceId,
            "name": deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
            "platform": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
        ]
    }
}
