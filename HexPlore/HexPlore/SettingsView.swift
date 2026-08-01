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

    @State private var draft = ""
    @State private var confirmingSignOut = false
    @State private var syncing = false

    var body: some View {
        NavigationStack {
            Form {
                serverSection

                if settings.isConfigured {
                    locationSection
                    if tracking.isTracking { statusSection }
                    healthSection

                    Section {
                        Button("Reload") { settings.reload() }
                        Button("Sign out", role: .destructive) { confirmingSignOut = true }
                    } footer: {
                        Text("Signing out forgets the site's cookies and stored data on this device, anything this phone recorded but has not yet sent, and how far it had got through Apple Health. Your map is on the server and is not touched.")
                    }
                }

                Section {
                    LabeledContent("Version", value: Self.version)
                } footer: {
                    Text("The map, the menu and everything in it are the web app itself, running on this phone. A fix there is a fix here.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Sign out of Hexplore?",
                isPresented: $confirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task { await settings.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .onAppear { draft = settings.serverURL }
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
            }
        } header: {
            Text("Server")
        } footer: {
            Text("Where you open Hexplore. A plain `http://` address works on your own network; anything else needs HTTPS — `tailscale serve` in front of `npm start` gives you one reachable only from your devices.")
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
                TextField("This phone", text: $tracking.deviceName)
                    .autocorrectionDisabled()
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
            return "The one thing this app can do that the website cannot: keep the map filling in while it is in your pocket. Nothing is recorded until you pick how often."
        case .significant:
            return "The cheapest setting there is. iOS mentions it once you have moved a fair way — roughly half a kilometre — off radios the phone is already listening to, so it costs no measurable battery. Enough to fill in the places you go; not enough to draw how you got there."
        default:
            return "Fixes are asked for to about a hundred metres and never better: a cell is 900 m across, so a sharper one lands in the same hexagon and costs the GPS chip to get. Nothing is sent while there is no signal — it waits on this phone until there is."
        }
    }

    private var permissionWarning: String? {
        guard tracking.isTracking else { return nil }
        switch logger.authorization {
        case .denied, .restricted:
            return "Location is turned off for Hexplore. Open Settings to allow it."
        case .authorizedWhenInUse:
            return "Set to “While Using the App”. Recording stops when you leave it — choose “Always” in Settings to keep it going."
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
                Text("Signed out. Open the Map tab and sign in — this phone has been holding on to what it recorded in the meantime.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else if let error = tracking.status.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("Recorded here, sent when there is a connection. A push that fails changes nothing — the fixes stay on this phone and go with the next one.")
        }
    }

    // MARK: - Apple Health

    private var healthSection: some View {
        Section {
            Toggle("Sync workouts", isOn: $tracking.syncWorkouts)
                .disabled(!HealthSync.shared.isAvailable)

            if tracking.syncWorkouts {
                LabeledContent("Last looked", value: Self.when(tracking.status.lastWorkoutScan))
                if tracking.status.workoutsSent > 0 {
                    LabeledContent("Sent", value: "\(tracking.status.workoutsSent)")
                }
            }
        } header: {
            Text("Apple Health")
        } footer: {
            Text(healthFooter)
        }
    }

    private var healthFooter: String {
        guard HealthSync.shared.isAvailable else {
            return "Health is not available on this device."
        }
        return "Only workouts that went somewhere. A ride, a walk or a run recorded outdoors carries a route, and becomes cells and a saved line on the map; a gym session, a pool swim and twenty minutes on a rowing machine carry none and are left where they are. Health is only ever read from."
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
