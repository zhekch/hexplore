import HexploreCore
import SwiftUI

struct ContentView: View {
    @State private var basemap = Basemap.default

    var body: some View {
        ZStack(alignment: .bottom) {
            MapView(basemap: basemap)
                .ignoresSafeArea()

            controls
        }
    }

    /// A basemap switcher and a readout of the grid maths, which is the whole of
    /// the interface so far. The readout is not decoration: it is the visible
    /// proof that the ported lattice agrees with the web app, on the device
    /// rather than only in a test.
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
