import MapLibre
import SwiftUI

/// MapLibre's map view, wrapped so SwiftUI can hold it.
///
/// `MLNMapView` is UIKit, and there is no SwiftUI version of it — so
/// `UIViewRepresentable` is the bridge, and it is the standard one: `makeUIView`
/// builds the view once, `updateUIView` is handed it again whenever the SwiftUI
/// state it depends on changes, and the `Coordinator` is the object that can be
/// a delegate, because a `struct` cannot.
///
/// This is the same renderer the web app uses — MapLibre GL JS and MapLibre
/// Native are the same project — so the styles, the sources and the layer types
/// are the ones already in `src/main.js`, spelled `MLN…` instead.
struct MapView: UIViewRepresentable {

    let basemap: Basemap

    /// Where the map opens. The web app asks an IP geolocation service and
    /// zooms down to whatever it answers, falling back to the world; that is not
    /// ported yet, so this opens where the author's data mostly is.
    static let initialCenter = CLLocationCoordinate2D(latitude: 46.948, longitude: 7.4474)
    static let initialZoom: Double = 7

    func makeUIView(context: Context) -> MLNMapView {
        let mapView = MLNMapView(frame: .zero, styleURL: basemap.styleURL)
        mapView.delegate = context.coordinator
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // The grid is defined in Web Mercator and drawn as an image pinned to a
        // rectangle in it, which only maps linearly while the map is flat. The
        // web app relies on the same thing; here it has to be said out loud,
        // because on a phone a two-finger twist is a gesture people make by
        // accident.
        mapView.allowsRotating = false
        mapView.allowsTilting = false

        mapView.setCenter(Self.initialCenter, zoomLevel: Self.initialZoom, animated: false)
        return mapView
    }

    func updateUIView(_ mapView: MLNMapView, context: Context) {
        // Only when it actually changed: assigning `styleURL` re-parses the
        // whole style and throws away every source and layer the app added, so
        // doing it on an unrelated state change would be expensive and visible.
        guard let url = basemap.styleURL, mapView.styleURL != url else { return }
        mapView.styleURL = url
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// The delegate. Everything the app adds to the map gets added here, in
    /// `didFinishLoading style:` — and re-added every time it fires, because a
    /// basemap switch replaces the style and takes every source and layer with
    /// it. That is `installGrid()` in the web app, and it is the single most
    /// surprising thing about this API.
    final class Coordinator: NSObject, MLNMapViewDelegate {

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            // Nothing yet — the visited-cell layers go here.
        }
    }
}
