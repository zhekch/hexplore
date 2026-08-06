// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import CoreLocation
import Foundation

/// What this Mac records about where it has been.
///
/// Everything else about your map lives on the server, where a phone and a
/// laptop find it in the same place. This does not, and the reason is not
/// tidiness: a schedule stored on the server cannot make a machine write
/// anything down. The timer runs here or it does not run, so the setting lives
/// where the timer is.
///
/// A singleton for the same reason as ``AppSettings``: the uploader reads it
/// from places that have no view hierarchy, including the push on the way out.
@MainActor
final class TrackingSettings: ObservableObject {

    static let shared = TrackingSettings()

    /// How often the Mac writes down where it is.
    ///
    /// Named in time because that is the question anyone actually asks, and
    /// implemented in distance as well because that is what CoreLocation can be
    /// cheap about — a machine that has not moved is not worth waking on a
    /// timer, and `distanceFilter` is how you say so.
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

        /// How far you have to move before macOS bothers telling us.
        ///
        /// Scaled with the cadence so a Mac on a desk costs nothing at any
        /// setting: the fixes it would deliver are the ones the throttle would
        /// throw away anyway, and the cheapest fix is the one never taken. The
        /// floor is 100 m because that is the accuracy asked for in
        /// ``LocationLogger`` — a tighter filter than the accuracy is a filter
        /// on noise.
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
    /// A cell is about 900 m across, so a fix the machine itself calls loose
    /// lands in the wrong one often enough to matter — and a Mac indoors on
    /// wifi positioning alone produces plenty of them. Home Assistant has the
    /// same setting for the same reason; the difference is that there it has to
    /// live on the server, because the server is the thing doing the reading.
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

    /// Whether to read the photo library for the places it has been.
    @Published var syncPhotos: Bool {
        didSet {
            guard syncPhotos != oldValue else { return }
            defaults.set(syncPhotos, forKey: Keys.syncPhotos)
            PhotoSync.shared.apply()
        }
    }

    /// What this Mac calls itself on the sync screen.
    ///
    /// Unlike the phone, the machine has a real answer to this — `Host.current()`
    /// gives the name you set in Sharing, which is already how this Mac is
    /// listed everywhere else on your network. It stays editable because two
    /// machines called "MacBook Pro" is exactly what this field exists to
    /// prevent, and because the name is the only thing on this screen that the
    /// other you, on a laptop, ever sees.
    @Published var deviceName: String {
        didSet {
            let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
            defaults.set(trimmed, forKey: Keys.deviceName)
        }
    }

    /// This Mac's identity to the server, made once and kept.
    ///
    /// A UUID of our own rather than the hardware serial or anything derived
    /// from it: the server keys a per-device cursor on this, and an id that
    /// changed with a logic-board swap would silently turn one Mac into two in
    /// the device list — and reset the cursor that stops a re-sent batch being
    /// counted twice.
    let deviceId: String

    /// The last thing the uploader has to say for itself, for the Settings
    /// window.
    @Published var status = SyncStatus()

    struct SyncStatus {
        var pending = 0
        var lastPush: Date?
        var lastError: String?
        /// The session cookie has gone. Nothing native can fix this — signing in
        /// happens in the map window, in the site's own login.
        var signedOut = false
        var lastPhotoScan: Date?
        var photosSent = 0
    }

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let cadence = "tracking.cadence"
        static let precision = "tracking.precision"
        static let syncPhotos = "tracking.syncPhotos"
        static let deviceName = "tracking.deviceName"
        static let deviceId = "tracking.deviceId"
    }

    private init() {
        let d = UserDefaults.standard
        // `object(forKey:)` rather than `integer(forKey:)`: an unset integer
        // reads back as 0, which is a real Cadence (`.significant`), so the
        // default would be "already tracking" for anyone who never asked.
        //
        // **Off is the right default here for a second reason.** On a phone the
        // logger is the reason the app exists; a Mac mostly sits still in a room
        // the map already knows about, and a desktop that never moves would file
        // the same cell every minute for years. Turning it on is a decision
        // somebody makes about a laptop they travel with, so it is asked for
        // rather than assumed.
        cadence = (d.object(forKey: Keys.cadence) as? Int).flatMap(Cadence.init) ?? .off
        precision = (d.object(forKey: Keys.precision) as? Int).flatMap(Precision.init) ?? .normal
        syncPhotos = d.bool(forKey: Keys.syncPhotos)
        deviceName = d.string(forKey: Keys.deviceName) ?? Host.current().localizedName ?? "This Mac"
        if let existing = d.string(forKey: Keys.deviceId), !existing.isEmpty {
            deviceId = existing
        } else {
            let fresh = UUID().uuidString
            d.set(fresh, forKey: Keys.deviceId)
            deviceId = fresh
        }
    }

    var isTracking: Bool { cadence != .off }

    /// What every push carries so the server can tell this Mac from anything
    /// else signed into the same account.
    var deviceHeader: [String: String] {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return [
            "id": deviceId,
            "name": deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
            "platform": "macOS \(v.majorVersion).\(v.minorVersion)",
        ]
    }
}
