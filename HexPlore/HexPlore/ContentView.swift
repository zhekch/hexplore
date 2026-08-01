// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `onReceive` wants a publisher.
import Combine
import SwiftUI
import UIKit

/// Two tabs.
///
/// **Map** is the web app — all of it, unmodified. The map, the menu, the import
/// dialogs, the sync connectors, statistics and backups already work and already
/// have their own login; the phone hosts them rather than replacing them.
///
/// **Settings** is the little this app knows that the site does not: which
/// server to open, how this phone records where it has been, and how to forget
/// both. The second of those is not a duplicate of anything on the Map tab — it
/// is the one setting that *could not* live on the server, because a schedule
/// stored there cannot wake a sleeping phone.
///
/// The derived data behind all of it — trips, coverage, the calendar — is worked
/// out once by the server (`server/derive.js`), so this phone and a laptop
/// cannot disagree about what they show.
struct ContentView: View {
    @StateObject private var settings = AppSettings.shared
    @StateObject private var tracking = TrackingSettings.shared

    var body: some View {
        TabView {
            MapTab()
                .tabItem { Label("Map", systemImage: "map") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .environmentObject(settings)
        .environmentObject(tracking)
        // Leaving is the best moment there is to push: the queue is as full as
        // it is going to get, and the app is about to stop being handed any
        // runtime it did not ask for. The notification rather than `scenePhase`
        // because the one-argument `onChange` this deployment target still needs
        // is deprecated, and the two-argument one wants iOS 17.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            Task { await SyncClient.shared.flush(force: true) }
        }
        // The site is dark — its login card, its menu, and three of its four
        // basemaps. A tab bar following the system into light mode puts a white
        // strip under all of that, which reads as a bar belonging to some other
        // app. Fixed rather than adaptive, because the thing it sits against is
        // fixed too.
        .preferredColorScheme(.dark)
    }
}

private struct MapTab: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        if let url = settings.baseURL {
            // Edge to edge: the map runs under the status bar and under the tab
            // bar, which is how a map should look. The buttons stay clear of
            // both because the controller hands the page its own safe area — see
            // `WebViewController.pushSafeArea`. Ignoring the safe area here is
            // what gives that controller a view the size of the screen *and* a
            // correct `safeAreaInsets` describing what covers it.
            WebPanel(url: url, reloadToken: settings.reloadToken)
                .ignoresSafeArea()
        } else {
            unconfigured
        }
    }

    /// A web view pointed at nothing is a white rectangle that cannot explain
    /// itself, so this says what is missing and where to put it.
    private var unconfigured: some View {
        VStack(spacing: 14) {
            Image(systemName: "globe.europe.africa")
                .font(.system(size: 44))
                .foregroundStyle(.tertiary)
            Text("No server yet")
                .font(.headline)
            Text("Add the address you open Hexplore at on the Settings tab.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}

#Preview {
    ContentView()
}
