import Foundation

/// The four basemaps, as `src/main.js`'s `STYLES` table declares them.
///
/// Two of them are a URL and two are built at load time — `src/basemap.js` takes
/// somebody else's style JSON and rewrites the parts that are wrong (a zoom
/// diet for the labels, road classes gated by class, forest that actually draws
/// below z10). That rewriting has not been ported yet, so Terrain and Satellite
/// declare themselves unavailable rather than quietly falling back to Dark and
/// leaving you wondering why the button did nothing.
///
/// Nothing about MapLibre stands in the way of finishing them: `MLNMapView` has
/// a `styleJSON` property and an `init(frame:styleJSON:)` beside the URL forms,
/// and `MLNStyle.styleJSON` can be both read and written on an already-loaded
/// style — so "fetch somebody's style, rewrite it, hand it back" is a supported
/// path here exactly as it is in the browser. What is missing is the rewriting.
enum Basemap: String, CaseIterable, Identifiable {
    case dark
    case terrain
    case light
    case satellite

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dark: "Dark"
        case .terrain: "Terrain"
        case .light: "Light"
        case .satellite: "Satellite"
        }
    }

    /// Whether the map's own chrome should read as light or dark over it. The
    /// web app corrects this by sampling the rendered pixels, because imagery is
    /// nominally dark and is a snowfield often enough to matter — see
    /// "Chrome over a photograph" in ARCHITECTURE.md. Not ported yet; this is
    /// the declaration the sampling would start from.
    var isLight: Bool {
        switch self {
        case .light: true
        case .dark, .terrain, .satellite: false
        }
    }

    /// `nil` for the two that have to be built rather than fetched.
    var styleURL: URL? {
        switch self {
        case .dark:
            URL(string: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json")
        case .light:
            URL(string: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json")
        case .terrain, .satellite:
            nil
        }
    }

    var isAvailable: Bool { styleURL != nil }

    /// What the app opens on, matching the web app's default.
    static let `default` = Basemap.dark
}
