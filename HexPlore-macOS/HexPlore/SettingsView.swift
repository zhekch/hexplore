import AppKit
import CoreLocation
import SwiftUI

/// The app's own settings, which are few on purpose.
///
/// Almost everything about your *map* — importing, syncing, backups, colours,
/// home, statistics — lives in the web app's own menu in the map window, where
/// it already works and where a phone finds it in the same place. Duplicating
/// any of it here would mean two screens that have to agree.
///
/// What is left is the handful of things only this app can answer: which server
/// to open, what this Mac records about where it has been, and how to forget
/// both.
///
/// The middle one is the exception that proves the rule. It looks like a sync
/// setting and by rights belongs on the sync screen with Home Assistant and
/// Strava — except that a schedule stored on the server cannot make this machine
/// write anything down. What the server *does* keep is the result: open the site
/// anywhere and this Mac is listed under Import & sync with what it has sent and
/// when it last spoke.
///
/// ## There is no Apple Health section, and there will not be
///
/// The iPhone app's third section reads workouts that carry a route. HealthKit
/// does not exist on macOS — there is no framework to link and no store to read
/// — so the section is absent rather than present and disabled. Workouts on your
/// map still arrive: from the phone, which has Health, and from Strava and
/// Komoot on the site's own sync screen, which any client can reach.
struct SettingsView: View {
    @StateObject private var settings = AppSettings.shared
    @StateObject private var tracking = TrackingSettings.shared
    @StateObject private var logger = LocationLogger.shared
    @StateObject private var photos = PhotoSync.shared
    @StateObject private var server = ServerCheck.shared

    @State private var draft = ""
    @State private var syncing = false

    /// Which field has the keyboard, and — the reason this exists — the fact
    /// that at the moment the window opens the answer should be *none*.
    ///
    /// A macOS window makes its first text field the first responder when it
    /// becomes key, so opening Settings put the caret in the server address:
    /// the field you least want to be typing into by accident, since it is
    /// already filled in and already correct. Nothing here is a form you sit
    /// down and fill in, so nothing should be waiting for a keystroke.
    private enum Field: Hashable { case server, deviceName }
    @FocusState private var focused: Field?

    var body: some View {
        Form {
            serverSection

            if settings.isConfigured {
                locationSection
                if tracking.isTracking { statusSection }
                photosSection
                technicalSection
            }

            Section {
                LabeledContent("App version", value: Self.version)
            }
        }
        .formStyle(.grouped)
        // A settings window does not size itself to its content the way a sheet
        // does, and one left to guess comes up as a tall thin column.
        .frame(width: 520)
        .frame(minHeight: 420, idealHeight: 560)
        // Declarative half: nothing is the default focus for this scope.
        .defaultFocus($focused, nil)
        .onAppear {
            draft = settings.serverURL
            server.check()
            // …and the belt to that pair of braces. AppKit assigns the first
            // responder as the window becomes key, which happens *after* this
            // view appears, so the declaration above can be overruled by the
            // window itself. Handing focus back to nothing one turn of the run
            // loop later is what actually leaves the caret out of the address.
            DispatchQueue.main.async { focused = nil }
        }
        // The address changing is the one moment the answer is certainly stale.
        .onChange(of: settings.reloadToken) { server.check() }
    }

    // MARK: - Where the map is

    private var serverSection: some View {
        Section {
            // `prompt:` rather than `TextField("…", text:)`. On macOS a
            // TextField's title is its *row label* in a Form, not its
            // placeholder — so the one-argument form printed
            // "hexplore.your-tailnet.ts.net" down the left of the row and put
            // the actual address on the right, which reads as two values.
            // `.labelsHidden()` then gives the field the whole row, as on the
            // phone.
            TextField("Server address", text: $draft,
                      prompt: Text("hexplore.your-tailnet.ts.net"))
                .labelsHidden()
                .autocorrectionDisabled()
                .focused($focused, equals: .server)
                .onSubmit(commit)

            if draft.trimmingCharacters(in: .whitespacesAndNewlines) != settings.serverURL {
                Button("Connect", action: commit)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else if settings.isConfigured {
                connectionRow
            }
        } header: {
            Text("Server")
        } footer: {
            Text("The address of the server to connect to. Supports both http and https.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// Whether that address is a Hexplore server, and whether it is up.
    ///
    /// Directly under the field it describes, because it is an answer about the
    /// thing you just typed. It used to be inferable only from the sync errors
    /// further down, which are about *uploading* — a machine with nothing queued
    /// has nothing to fail, so a wrong address said nothing at all until you
    /// looked at the map and found a white rectangle.
    ///
    /// Three colours for three different mistakes: green for a Hexplore server,
    /// orange for something that answered and is not one (a router, a NAS, the
    /// wrong container), red for no answer — with the status or the URLError
    /// code, which is the part that can be searched for.
    private var connectionRow: some View {
        Button {
            server.check()
        } label: {
            HStack(spacing: 6) {
                if case .checking = server.state {
                    ProgressView().controlSize(.small)
                }
                Text(server.state.label)
                    .font(.footnote)
                    .foregroundStyle(connectionColor)
                Spacer(minLength: 4)
                if let symbol = server.state.symbol {
                    Image(systemName: symbol)
                        .font(.footnote)
                        .foregroundStyle(connectionColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var connectionColor: Color {
        switch server.state {
        case .connected: return .green
        case .notHexplore: return .orange
        case .http, .unreachable: return .red
        case .unset, .checking: return .secondary
        }
    }

    // MARK: - What this Mac records

    private var locationSection: some View {
        Section {
            Picker("Update", selection: $tracking.cadence) {
                ForEach(TrackingSettings.Cadence.allCases) { cadence in
                    Text(cadence.title).tag(cadence)
                }
            }

            accessRow

            if tracking.isTracking {
                Picker("Skip vague fixes", selection: $tracking.precision) {
                    ForEach(TrackingSettings.Precision.allCases) { precision in
                        Text(precision.title).tag(precision)
                    }
                }
                LabeledContent("Name") {
                    // Same reason as the server field above: the title would
                    // render as a second label inside a row that already has
                    // one.
                    TextField("Name", text: $tracking.deviceName,
                              prompt: Text("This Mac"))
                        .labelsHidden()
                        .autocorrectionDisabled()
                        .focused($focused, equals: .deviceName)
                        .multilineTextAlignment(.trailing)
                }
            }

            if let warning = permissionWarning {
                Button {
                    openPrivacySettings("Privacy_LocationServices")
                } label: {
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text("Location")
        } footer: {
            Text(locationFooter)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// Off is the honest default on a Mac, and the footer says why rather than
    /// leaving a switch that looks broken. The rest of the reasoning is on
    /// ``LocationLogger``.
    private var locationFooter: String {
        switch tracking.cadence {
        case .off:
            return "Mac only records while the app is running."
        case .significant:
            return "Uses the least power, but with the lowest accuracy. Recording stops when you quit the app."
        default:
            return "The higher the update frequency, the higher the power consumption. Recording stops when you quit the app."
        }
    }

    /// macOS has one location grant, so there is one thing that can be wrong
    /// with it. The phone's third case — "While Using the App", which stops
    /// recording the moment you leave — has no equivalent here, because
    /// `kCLAuthorizationStatusAuthorizedWhenInUse` does not exist on this
    /// platform.
    /// What macOS currently allows, said out loud, with the way to change it
    /// next to it.
    ///
    /// This row exists because its absence was unfalsifiable. Location simply
    /// did not work, and from the outside "the app never asked", "the app asked
    /// and you missed the prompt" and "you answered no once, months ago" are
    /// the same silence — there was no way to tell them apart, and the fix for
    /// each is different. A permission is a piece of state the app can read at
    /// any time, so there is no excuse for not showing it.
    ///
    /// The button is the other half. Raising the prompt from a control somebody
    /// pressed is the one call site guaranteed to run, with the app frontmost
    /// and a person looking at it — where a request fired from a view's
    /// lifecycle can be missed, land behind a window, or never happen at all if
    /// that lifecycle method is not called.
    private var accessRow: some View {
        LabeledContent("Access") {
            HStack(spacing: 8) {
                Text(accessLabel)
                    .foregroundStyle(accessColor)
                if logger.authorization == .notDetermined {
                    Button("Allow…") { logger.requestAuthorizationIfNeeded() }
                } else if logger.authorization == .denied || logger.authorization == .restricted {
                    // Nothing in the app can undo a refusal; only System
                    // Settings can, so the button goes there rather than
                    // pretending to ask again.
                    Button("Open System Settings") {
                        openPrivacySettings("Privacy_LocationServices")
                    }
                }
            }
        }
    }

    private var accessLabel: String {
        switch logger.authorization {
        case .notDetermined: return "Not asked yet"
        // `.authorized` is the same value as `.authorizedAlways` on macOS —
        // there is one grant here, not the phone's two. See LocationLogger.
        case .authorizedAlways: return "Allowed"
        case .denied: return "Denied"
        case .restricted: return "Not permitted on this Mac"
        @unknown default: return "Unknown"
        }
    }

    private var accessColor: Color {
        switch logger.authorization {
        case .authorizedAlways: return .green
        case .denied, .restricted: return .orange
        default: return .secondary
        }
    }

    /// Not gated on the switch being on, unlike the phone's.
    ///
    /// The map's own "where am I" button wants location with tracking off, so a
    /// refusal is worth saying either way — and a permission that is silently
    /// denied is otherwise invisible, which is exactly how it went unnoticed
    /// that the prompt was never being raised at all.
    private var permissionWarning: String? {
        switch logger.authorization {
        case .denied, .restricted:
            return "Location is turned off for the app. Open System Settings to allow it."
        default:
            return nil
        }
    }

    // MARK: - Is it working?

    private var statusSection: some View {
        Section {
            LabeledContent("Waiting to send", value: "\(tracking.status.pending)")
            LabeledContent("Last sent", value: Self.when(tracking.status.lastPush))
            Button(syncing ? "Sending…" : "Sync now") {
                syncing = true
                Task {
                    await SyncClient.shared.flush(force: true)
                    syncing = false
                }
            }
            .disabled(syncing)

            if tracking.status.signedOut {
                Text("Signed out. Open the map window and sign in to sync the cached location data.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else if let error = tracking.status.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("The records are cached until there is a connection to the server.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Photos

    private var photosSection: some View {
        Section {
            Toggle("Sync photos", isOn: $tracking.syncPhotos)

            if tracking.syncPhotos {
                LabeledContent("Last checked", value: Self.when(tracking.status.lastPhotoScan))
                if tracking.status.photosSent > 0 {
                    LabeledContent("Geotagged", value: "\(tracking.status.photosSent)")
                }
                Button(photos.scanning ? "Reading…" : "Read now") {
                    Task { await PhotoSync.shared.scan() }
                }
                .disabled(photos.scanning)

                if photos.isLimited {
                    Text("Only the photos you picked are readable, so the map will only know about those. Allow access to all photos in System Settings to use the whole library.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                } else if photos.isDenied {
                    Button {
                        openPrivacySettings("Privacy_Photos")
                    } label: {
                        Label("Photos are turned off for HexPlore. Open System Settings to allow them.",
                              systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                }
            }
        } header: {
            Text("Photos")
        } footer: {
            Text("Import every photo from this Mac's photo library.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - The two buttons that are about this app rather than your map
    //
    // Under a heading of their own, because without one they read as part of the
    // Photos section above them — a form groups by proximity whatever you
    // intended, and "Clean cache" filed under Photos is a sentence with a
    // meaning nobody wants.

    private var technicalSection: some View {
        Section {
            Button("Reload map") { settings.reload() }
            Button("Clean cache") {
                Task { await settings.signOut() }
            }
        } header: {
            Text("Technical")
        } footer: {
            // No confirmation in front of it: nothing here is data. The cache is
            // the site's cookies and its offline copy, both of which come back
            // by signing in again, and a dialog in front of a button whose worst
            // outcome is "log in once more" teaches people to dismiss dialogs.
            Text("Cleaning the cache forgets the site's cookies and any stored data on this Mac. You will need to sign in again.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: -

    private func commit() {
        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Open System Settings at the pane that holds the switch being complained
    /// about. The `x-apple.systempreferences:` scheme is how every app does
    /// this; if a future macOS renames an anchor the worst case is landing on
    /// Privacy & Security rather than the exact row.
    private func openPrivacySettings(_ anchor: String) {
        guard let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        NSWorkspace.shared.open(url)
    }

    /// "Just now" / "14:20" / "3 Jun" — the same three answers the web app's own
    /// sync screen gives, because they are the ones that tell you at a glance
    /// whether a schedule is actually running.
    private static func when(_ date: Date?) -> String {
        guard let date else { return "Never" }
        let ago = -date.timeIntervalSinceNow
        if ago < 90 { return "Just now" }
        if ago < 22 * 3600 { return date.formatted(.dateTime.hour().minute()) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}

#Preview {
    SettingsView()
}
