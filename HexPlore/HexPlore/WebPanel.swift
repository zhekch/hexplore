import CoreLocation
import SwiftUI
import WebKit

/// The web app, in a web view. This is the app.
///
/// The map, the menu, the import dialogs, the sync connectors, statistics,
/// backups and the login are twenty thousand lines that already work and are
/// already tested by being used every day. Rebuilding them natively would be an
/// enormous amount of effort to arrive back where the browser already is, so the
/// phone hosts them rather than replacing them.
///
/// Nothing is restyled and nothing is hidden. The one thing the host tells the
/// page is its own geometry — how much of each edge the status bar and the tab
/// bar are standing on — because that is a fact about the window which the page
/// has no other way to learn. See ``WebViewController/pushSafeArea()``.
struct WebPanel: UIViewControllerRepresentable {

    let url: URL
    /// Bumped to force a reload — changing the server, or asking for one.
    let reloadToken: Int

    func makeUIViewController(context: Context) -> WebViewController {
        let controller = WebViewController()
        controller.load(url: url, token: reloadToken)
        return controller
    }

    func updateUIViewController(_ controller: WebViewController, context: Context) {
        controller.load(url: url, token: reloadToken)
    }
}

/// Hosts the web view, and answers for it.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {

    /// Appended to the User-Agent, and the whole of how the server knows this is
    /// the app. Changing it means changing `IOS_CLIENT` in server/index.js.
    static let userAgentTag = "HexploreiOS"

    private var webView: WKWebView!
    private var loaded: (url: URL, token: Int)?
    private let locations = CLLocationManager()

    override func viewDidLoad() {
        super.viewDidLoad()

        let configuration = WKWebViewConfiguration()
        // The persistent store, so the session survives the app being closed.
        // Signing in every launch would be its own reason not to use this.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        // How the server tells this app apart from a browser: it lands at the
        // end of the User-Agent, so `server/index.js` can key a layout on it.
        //
        // Set on the configuration *before* the web view exists, because
        // `WKWebView` copies its configuration at init — assigning to
        // `webView.configuration` afterwards writes to a copy nobody reads,
        // which is exactly how the first attempt failed silently.
        configuration.applicationNameForUserAgent = Self.userAgentTag

        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.allowsBackForwardNavigationGestures = false
        // The page is a full-bleed dark map; bouncing past it shows white.
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.07, green: 0.078, blue: 0.102, alpha: 1)
        view.addSubview(webView)
        view.backgroundColor = webView.backgroundColor
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        pushSafeArea()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Asked here rather than waiting for the page to ask. Before iOS 27 the
        // web view has no way to tell us it wants a position, so a permission
        // that is still undetermined at the moment the locate button is pressed
        // is a button that does nothing — and a map asking for location the
        // first time it opens is what anyone expects a map to do.
        requestLocationIfNeeded()
    }

    func load(url: URL, token: Int) {
        guard isViewLoaded else { return }
        guard loaded?.url != url || loaded?.token != token else { return }
        loaded = (url, token)
        webView.load(URLRequest(url: url))
    }

    // MARK: - Telling the page where the edges are

    /// Hand the page the four insets, as the CSS variables `src/style.css`
    /// already reads.
    ///
    /// This exists because `env(safe-area-inset-*)` does not work here, and it
    /// took measuring to establish rather than reasoning: with the map drawn
    /// edge to edge this controller's `view.safeAreaInsets.bottom` is a correct
    /// **83** — the tab bar and the home indicator — and the scroll view adjusts
    /// by the same 83, and yet the page reads `env(safe-area-inset-bottom)` as
    /// `0px`. Every button therefore stayed in the corner it was meant to move
    /// out of, and nothing in the Swift said anything was wrong.
    ///
    /// So the number is sent rather than inferred. `:root` in `src/style.css`
    /// still defaults these to `env()`, which is what a real browser uses and
    /// what makes the same rules work in mobile Safari; setting them inline on
    /// the root element simply wins where that default is not filled in.
    private func pushSafeArea() {
        guard isViewLoaded, let webView else { return }
        let insets = view.safeAreaInsets
        let script = """
        (function (style) {
          style.setProperty('--safe-t', '\(Int(insets.top.rounded()))px');
          style.setProperty('--safe-r', '\(Int(insets.right.rounded()))px');
          style.setProperty('--safe-b', '\(Int(insets.bottom.rounded()))px');
          style.setProperty('--safe-l', '\(Int(insets.left.rounded()))px');
        })(document.documentElement.style);
        """
        webView.evaluateJavaScript(script)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Again on load, because a page that has just replaced itself has none
        // of the properties the last one was given.
        pushSafeArea()

        #if DEBUG
        // What the page ends up with. The chrome's position depends entirely on
        // these reaching it, and a wrong guess about that is invisible from the
        // Swift side — which is how `env(safe-area-inset-*)` silently reporting
        // zero survived a whole round of "it should work".
        webView.evaluateJavaScript(
            """
            JSON.stringify({
              client: document.documentElement.dataset.client || '(none)',
              safeB: getComputedStyle(document.documentElement).getPropertyValue('--safe-b').trim(),
              layersBottom: (document.getElementById('layers')
                ? getComputedStyle(document.getElementById('layers')).bottom : '(absent)'),
              attribBottom: (document.querySelector('.maplibregl-ctrl-top-right')
                ? getComputedStyle(document.querySelector('.maplibregl-ctrl-top-right')).bottom : '(absent)')
            })
            """
        ) { value, _ in
            if let value { print("[HexPlore] \(value)") }
        }
        #endif
    }

    // MARK: - Location

    /// The page's "my location" button, granted.
    ///
    /// Only ever asked on iOS 27 and later — before that WebKit decides for
    /// itself and shows its own prompt, which is why the real work is the
    /// `NSLocationWhenInUseUsageDescription` in Info.plist and the authorization
    /// request above rather than this method.
    @available(iOS 27.0, *)
    func webView(
        _ webView: WKWebView,
        requestGeolocationPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        requestLocationIfNeeded()
        // Granted without a second question. The page asking is your own map
        // asking, on a server you run, and iOS has already put its own prompt in
        // front of this the first time — two dialogs for one button is how a
        // permission gets refused by accident.
        decisionHandler(.grant)
    }

    /// Ask iOS for location, once.
    ///
    /// It has to come from the app: a web view cannot raise the system prompt on
    /// its own, so without this the page's locate button fails silently with a
    /// permission error and looks broken.
    ///
    /// Note the page also needs a **secure context** for `navigator.geolocation`
    /// at all — https, or localhost. Over plain `http://192.168.x.x` WebKit
    /// refuses regardless of permissions, which is one more reason to put the
    /// server behind `tailscale serve`.
    func requestLocationIfNeeded() {
        guard locations.authorizationStatus == .notDetermined else { return }
        locations.requestWhenInUseAuthorization()
    }
}
