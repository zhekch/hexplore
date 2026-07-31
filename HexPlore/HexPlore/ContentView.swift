import HexploreCore
import SwiftUI

/// Two tabs, and the split is the whole architecture in one screen.
///
/// **Map** is native, because a map is the one thing a phone does better than a
/// web view: the gestures, the GPU, and eventually the background location a
/// browser cannot have at all.
///
/// **Settings** is the web app's own menu, because the import dialogs, the sync
/// connectors and the backup schedule already work against this same server.
///
/// Both sides read data derived once on the server — see `server/derive.js` —
/// so a phone and a laptop signed into one account cannot disagree about what
/// they show, because neither of them decides.
struct ContentView: View {
    @StateObject private var settings = AppSettings()
    @StateObject private var session = Session()

    var body: some View {
        TabView {
            MapTab()
                .tabItem { Label("Map", systemImage: "map") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .environmentObject(settings)
        .environmentObject(session)
        .task(id: settings.serverURL) {
            await session.use(baseURL: settings.baseURL)
        }
    }
}

/// The native map, with the visited cells on it.
private struct MapTab: View {
    @EnvironmentObject private var session: Session
    @State private var basemap = Basemap.default

    var body: some View {
        ZStack(alignment: .bottom) {
            MapView(basemap: basemap, cells: session.cells)
                .ignoresSafeArea()

            controls
        }
        .overlay(alignment: .top) { banner }
    }

    /// Says what is wrong when nothing is drawn, because an empty map and a map
    /// that failed to load look exactly alike.
    @ViewBuilder
    private var banner: some View {
        let message: String? = switch session.state {
        case .unconfigured: "Set your server address in Settings"
        // A reachable server that wants a password says so in one line; one that
        // could not be reached at all says *that*, because they are different
        // problems and only one of them is solved by signing in.
        case .signedOut(let trouble): trouble ?? "Sign in on the Settings tab"
        case .checking: nil
        case .signedIn: session.loadError ?? (session.loadingCells ? "Loading your map…" : nil)
        }

        if let message {
            Text(message)
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.thinMaterial, in: Capsule())
                .padding(.top, 8)
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Text(summary)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)

            Picker("Basemap", selection: $basemap) {
                ForEach(Basemap.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var summary: String {
        let cells = session.cells.count
        guard cells > 0 else { return "no cells yet" }
        // Ground covered, at the latitude the map opened at — the same cos²φ the
        // statistics use, so the number here and the number in the web app's
        // statistics are measuring the same thing.
        let lat = MapView.initialCenter.latitude
        let each = HexGrid.sqrt3 * HexGrid.radius(level: 0) * cos(lat * .pi / 180)
        let km2 = (each * each * 0.8660254) / 1_000_000 * Double(cells)
        return String(format: "%d cells · ≈%.0f km²", cells, km2)
    }
}

#Preview {
    ContentView()
}
