import SwiftUI

/// Two tabs.
///
/// **Map** is the web app — all of it, unmodified. The map, the menu, the import
/// dialogs, the sync connectors, statistics and backups already work and already
/// have their own login; the phone hosts them rather than replacing them.
///
/// **Settings** is the little this app knows that the site does not: which
/// server to open, and how to forget it.
///
/// The derived data behind all of it — trips, coverage, the calendar — is worked
/// out once by the server (`server/derive.js`), so this phone and a laptop
/// cannot disagree about what they show.
struct ContentView: View {
    @StateObject private var settings = AppSettings()

    var body: some View {
        TabView {
            MapTab()
                .tabItem { Label("Map", systemImage: "map") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .environmentObject(settings)
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
            // bar, which is how a map should look. The buttons stay where they
            // are because the page is *told* how much of its bottom edge is
            // covered — the reader reports the insets it is ignoring, the web
            // view turns them into its own safe area, and `src/style.css` reads
            // them back as `env(safe-area-inset-bottom)`.
            GeometryReader { proxy in
                WebPanel(
                    url: url,
                    reloadToken: settings.reloadToken,
                    bottomInset: proxy.safeAreaInsets.bottom
                )
            }
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
