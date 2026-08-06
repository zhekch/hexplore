import CoreLocation
import SwiftUI
import UIKit

/// The app's own settings, which are few on purpose.
///
/// Almost everything about your *map* — importing, syncing, backups, colours,
/// home, statistics — lives in the web app's own menu on the Map tab, where it
/// already works and where a laptop finds it in the same place. Duplicating any
/// of it here would mean two screens that have to agree.
///
/// What is left is the handful of things only this app can answer: which server
/// to open, how this phone records where it has been, and how to forget both.
///
/// The middle one is the exception that proves the rule. It looks like a sync
/// setting and by rights belongs on the sync screen with Home Assistant and
/// Strava — except that a schedule stored on the server could not wake a
/// sleeping phone, so the timer runs here or it does not run. What the server
/// *does* keep is the result: open the site on a laptop and this phone is listed
/// under Import & sync with what it has sent and when it last spoke.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var tracking: TrackingSettings
    @StateObject private var logger = LocationLogger.shared
    @StateObject private var photos = PhotoSync.shared
    @StateObject private var server = ServerCheck.shared

    @State private var draft = ""
    @State private var confirmingReread = false
    @State private var syncing = false

    var body: some View {
        NavigationStack {
            Form {
                serverSection

                if settings.isConfigured {
                    locationSection
                    if tracking.isTracking { statusSection }
                    healthSection
                    photosSection

                    technicalSection
                }

                Section {
                    LabeledContent("App version", value: Self.version)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            draft = settings.serverURL
            server.check()
        }
        // The address changing is the one moment the answer is certainly stale.
        // The one-argument `onChange` because this app deploys to iOS 16 — the
        // two-argument one wants 17, and this one is deprecated rather than
        // gone. Same trade, and same comment, as `ContentView`.
        .onChange(of: settings.reloadToken) { _ in server.check() }
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
            Button("Clean cache", role: .destructive) {
                Task { await settings.signOut() }
            }
        } header: {
            Text("Technical")
        } footer: {
            // No confirmation in front of it: nothing here is data. The cache is
            // the site's cookies and its offline copy, both of which come back
            // by signing in again, and a dialog in front of a button whose worst
            // outcome is "log in once more" teaches people to dismiss dialogs.
            Text("Cleaning the cache forgets the site's cookies and any stored data on this device. You will need to sign in again.")
        }
    }

    // MARK: - Where the map is

    private var serverSection: some View {
        Section {
            TextField("hexplore.your-tailnet.ts.net", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
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
        }
    }

    /// Whether that address is a Hexplore server, and whether it is up.
    ///
    /// Directly under the field it describes, because it is an answer about the
    /// thing you just typed. It used to be inferable only from the sync errors
    /// further down, which are about *uploading* — a phone with nothing queued
    /// has nothing to fail, so a wrong address said nothing at all until you
    /// went to the Map tab and found a white rectangle.
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

    // MARK: - What this phone records

    private var locationSection: some View {
        Section {
            Picker("Update", selection: $tracking.cadence) {
                ForEach(TrackingSettings.Cadence.allCases) { cadence in
                    Text(cadence.title).tag(cadence)
                }
            }

            if tracking.isTracking {
                Picker("Skip vague fixes", selection: $tracking.precision) {
                    ForEach(TrackingSettings.Precision.allCases) { precision in
                        Text(precision.title).tag(precision)
                    }
                }
                // Labelled, because on its own it was a text field with a name
                // already in it and no indication of what the name was *for* —
                // it looked like the app telling you which phone this is rather
                // than asking what to call it. It is the only thing on this
                // screen that other people (well, the other you, on a laptop)
                // ever see.
                LabeledContent("Name") {
                    TextField("This phone", text: $tracking.deviceName)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                }
            }

            if let warning = permissionWarning {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        } header: {
            Text("Location")
        } footer: {
            Text(locationFooter)
        }
    }

    private var locationFooter: String {
        switch tracking.cadence {
        case .off:
            return "Uses your iPhone's location to fill in the cells in background."
        case .significant:
            return "Uses the least battery, but with the lowest accuracy."
        default:
            return "The higher the update frequency, the higher the battery consumption is. Can also skip the location fixes with low GPS accuracy."
        }
    }

    private var permissionWarning: String? {
        guard tracking.isTracking else { return nil }
        switch logger.authorization {
        case .denied, .restricted:
            return "Location is turned off for the app. Open Settings to allow it."
        case .authorizedWhenInUse:
            return "Set to “While Using the App”. Change to “Always” to keep recording in background."
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
                    await HealthSync.shared.sync()
                    syncing = false
                }
            }
            .disabled(syncing)

            if tracking.status.signedOut {
                Text("Signed out. Open the Map tab and sign in to sync all the data.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } 
        } footer: {
            Text("The records are cached until there is a connection to the server.")
        }
    }

    // MARK: - Apple Health

    private var healthSection: some View {
        Section {
            Toggle("Sync workouts", isOn: $tracking.syncWorkouts)
                .disabled(!HealthSync.shared.isAvailable)

            if tracking.syncWorkouts {
                LabeledContent("Last checked", value: Self.when(tracking.status.lastWorkoutScan))
                if tracking.status.workoutsSent > 0 {
                    LabeledContent("Sent", value: "\(tracking.status.workoutsSent)")
                }
                Button("Re-import", role: .destructive) { confirmingReread = true }
                    .disabled(syncing)
            }
        } header: {
            Text("Apple Health")
        } footer: {
            Text(healthFooter)
        }
        .confirmationDialog(
            "Read Apple Health again?",
            isPresented: $confirmingReread,
            titleVisibility: .visible
        ) {
            Button("Re-read everything", role: .destructive) {
                syncing = true
                Task {
                    do {
                        try await SyncClient.shared.resetHealth()
                        await HealthSync.shared.sync()
                    } catch {
                        tracking.status.lastError = error.localizedDescription
                    }
                    syncing = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes the cells and routes Apple Health put on your map and reads every workout again.")
        }
    }

    private var healthFooter: String {
        guard HealthSync.shared.isAvailable else {
            return "Health is not available on this device."
        }
        return "Only imports the workouts with a route."
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
                    Text("Only the photos you picked are readable, so the map will only know about those. Allow access to all photos in Settings to use the whole library.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                } else if photos.isDenied {
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        Label("Photos are turned off for Hexplore. Open Settings to allow them.",
                              systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
        } header: {
            Text("Photos")
        } footer: {
            Text("Import the geolocation of every photo from your library. Also allows to view your photos on the map from the phone.")
        }
    }

    // MARK: -

    private func commit() {
        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
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
        .environmentObject(AppSettings.shared)
        .environmentObject(TrackingSettings.shared)
}
