import HexploreCore
import SwiftUI

/// Two tabs, and the split is the whole architecture in one screen.
///
/// **Map** is native, because a map is the one thing a phone does better than a
/// web view: the gestures, the GPU, and eventually the background location a
/// browser cannot have at all.
///
/// **Settings** is the web app, because the menu, the import dialogs, the sync
/// connectors and the backup schedule are nine thousand lines of interface that
/// already work against the same server. Rebuilding them in SwiftUI would be a
/// great deal of effort for a screen that looks the same.
///
/// Everything either side of that line reads the *same derived data*, worked out
/// once on the server — see server/derive.js. That is the point: a phone and a
/// laptop signed into one account cannot disagree about which trips you have
/// had, because neither of them decides.
struct ContentView: View {
    @StateObject private var settings = AppSettings()

    var body: some View {
        TabView {
            MapTab()
                .tabItem {
                    Label("Map", systemImage: "map")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        .environmentObject(settings)
    }
}

/// The native map, with the readout that shows the ported lattice agreeing with
/// the web app on the device rather than only in a test.
private struct MapTab: View {
    @State private var basemap = Basemap.default

    var body: some View {
        ZStack(alignment: .bottom) {
            MapView(basemap: basemap)
                .ignoresSafeArea()

            controls
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Text(gridSummary)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)

            Picker("Basemap", selection: $basemap) {
                ForEach(Basemap.allCases) { option in
                    Text(option.label)
                        .tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var gridSummary: String {
        let centre = MapView.initialCenter
        let id = HexGrid.cellId(level: 0, lat: centre.latitude, lng: centre.longitude)
        let km = (HexGrid.sqrt3 * HexGrid.radius(level: 0)
            * cos(centre.latitude * .pi / 180)) / 1000
        return String(format: "cell %@ · %.2f km across", id, km)
    }
}

#Preview {
    ContentView()
}
