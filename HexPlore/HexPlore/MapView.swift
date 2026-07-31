import HexploreCore
import MapLibre
import SwiftUI

/// MapLibre's map view, wrapped so SwiftUI can hold it, with the visited cells
/// drawn on top.
///
/// This is the same renderer the web app uses — MapLibre GL JS and MapLibre
/// Native are the same project — so the styles, sources and layer types are the
/// ones already in `src/main.js`, spelled `MLN…` instead.
///
/// **The cells are drawn as polygons, not as the blurred sheet.** The web app
/// has both: the blob canvas, and a vector fallback for browsers without canvas
/// filters, which "chains the hex union into closed loops". This is that
/// fallback, and it is the honest thing to ship first — it is correct, it is
/// fast, and it shows you your map. `BlobRenderer` is written and tested and
/// wiring it to an `MLNImageSource` is the next step, not this one.
struct MapView: UIViewRepresentable {

    let basemap: Basemap
    let cells: [Cell]

    static let initialCenter = CLLocationCoordinate2D(latitude: 46.948, longitude: 7.4474)
    static let initialZoom: Double = 7

    /// The visited wash. `BlobShaping.alpha` is the same 0.3 the web app uses —
    /// a hint you read the map through rather than a coat of paint.
    static let visitedColor = UIColor(red: 0.376, green: 0.675, blue: 1.0, alpha: 1.0)

    private enum Ids {
        static let source = "hexplore-visited"
        static let fill = "hexplore-visited-fill"
    }

    func makeUIView(context: Context) -> MLNMapView {
        let mapView = MLNMapView(frame: .zero, styleURL: basemap.styleURL)
        mapView.delegate = context.coordinator
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // The grid is defined in Web Mercator and every cell is a polygon in it,
        // which only stays a hexagon while the map is flat. The web app relies
        // on the same thing; here it has to be said out loud, because on a phone
        // a two-finger twist is a gesture people make by accident.
        mapView.allowsRotating = false
        mapView.allowsTilting = false

        mapView.setCenter(Self.initialCenter, zoomLevel: Self.initialZoom, animated: false)
        context.coordinator.cells = cells
        return mapView
    }

    func updateUIView(_ mapView: MLNMapView, context: Context) {
        if let url = basemap.styleURL, mapView.styleURL != url {
            mapView.styleURL = url
        }
        if context.coordinator.cells != cells {
            context.coordinator.cells = cells
            context.coordinator.redraw(mapView, force: true)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(ids: (Ids.source, Ids.fill)) }

    /// The delegate, and the owner of everything this app adds to the map.
    ///
    /// Everything is rebuilt in `didFinishLoading style:` and re-added every time
    /// it fires, because a basemap switch replaces the whole style and takes
    /// every source and layer with it. That is `installGrid()` in the web app,
    /// and it is the single most surprising thing about this API.
    final class Coordinator: NSObject, MLNMapViewDelegate {

        private let ids: (source: String, fill: String)
        var cells: [Cell] = []
        /// What is currently drawn, so a pan does not rebuild the world.
        private var drawnLevel: Int?

        init(ids: (String, String)) {
            self.ids = ids
        }

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            drawnLevel = nil
            install(on: style)
            redraw(mapView, force: true)
        }

        func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) {
            redraw(mapView, force: false)
        }

        private func install(on style: MLNStyle) {
            guard style.source(withIdentifier: ids.source) == nil else { return }

            let source = MLNShapeSource(identifier: ids.source, shape: nil, options: nil)
            style.addSource(source)

            let fill = MLNFillStyleLayer(identifier: ids.fill, source: source)
            fill.fillColor = NSExpression(forConstantValue: MapView.visitedColor)
            fill.fillOpacity = NSExpression(forConstantValue: BlobShaping.alpha)
            // Below the basemap's own labels, because the wash is tinted ground
            // and street names belong on top of it. The web app aims past the
            // last non-symbol layer for the same reason.
            if let firstSymbol = style.layers.first(where: { $0 is MLNSymbolStyleLayer }) {
                style.insertLayer(fill, below: firstSymbol)
            } else {
                style.addLayer(fill)
            }
        }

        /// Rebuild the drawn geometry if the zoom now wants a different level.
        func redraw(_ mapView: MLNMapView, force: Bool) {
            guard let style = mapView.style,
                  let source = style.source(withIdentifier: ids.source) as? MLNShapeSource
            else { return }

            let level = HexGrid.levelForZoom(mapView.zoomLevel)
            guard force || level != drawnLevel else { return }
            drawnLevel = level

            source.shape = Self.shape(for: cells, at: level)
        }

        /// Every visited cell rolled up to one level and turned into polygons.
        ///
        /// Rolled up rather than re-resolved: `HexGrid.rollUp` walks a cell to its
        /// parent one step at a time, which is what the web app does, and the two
        /// genuinely disagree with a single point-location at the target level.
        private static func shape(for cells: [Cell], at level: Int) -> MLNShape? {
            guard !cells.isEmpty else { return nil }

            var seen = Set<Cell>()
            var polygons: [MLNPolygonFeature] = []
            polygons.reserveCapacity(min(cells.count, 4096))

            for cell in cells {
                let coarse = HexGrid.rollUp(cell, to: level)
                guard seen.insert(coarse).inserted else { continue }

                var ring = HexGrid.corners(of: coarse).map {
                    CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng)
                }
                // Closed explicitly: MapLibre will close it anyway, and a ring
                // that says so is a ring nobody has to wonder about.
                if let first = ring.first { ring.append(first) }
                polygons.append(MLNPolygonFeature(coordinates: ring, count: UInt(ring.count)))
            }

            return MLNShapeCollectionFeature(shapes: polygons)
        }
    }
}
