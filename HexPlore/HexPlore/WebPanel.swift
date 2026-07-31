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
/// Nothing is injected and nothing is hidden. What you get is the site, exactly
/// as it is on a laptop, which is the point — a bug here is a bug there, and a
/// fix there is a fix here.
///
/// A view *controller* rather than a bare view, for one reason:
/// `additionalSafeAreaInsets`. The map is drawn edge to edge, under the status
/// bar and under the tab bar, and the page has to be told how much of its own
/// bottom edge is spoken for or it puts its buttons underneath the tab bar.
/// That is what `bottomInset` carries, and `src/style.css` reads it back out as
/// `env(safe-area-inset-bottom)`.
struct WebPanel: UIViewControllerRepresentable {

    let url: URL
    /// Bumped to force a reload — changing the server, or asking for one.
    let reloadToken: Int
    /// How much of the bottom edge the native tab bar and home indicator cover.
    let bottomInset: CGFloat

    func makeUIViewController(context: Context) -> WebViewController {
        let controller = WebViewController()
        controller.load(url: url, token: reloadToken)
        controller.coveredAtBottom = bottomInset
        return controller
    }

    func updateUIViewController(_ controller: WebViewController, context: Context) {
        controller.coveredAtBottom = bottomInset
        controller.load(url: url, token: reloadToken)
    }
}

/// Hosts the web view, owns its safe area, and answers for it.
final class WebViewController: UIViewController, WKUIDelegate {

    private var webView: WKWebView!
    private var loaded: (url: URL, token: Int)?
    private let locations = CLLocationManager()

    /// How much of the bottom edge belongs to the tab bar and home indicator.
    var coveredAtBottom: CGFloat = 0 {
        didSet { applySafeArea() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let configuration = WKWebViewConfiguration()
        // The persistent store, so the session survives the app being closed.
        // Signing in every launch would be its own reason not to use this.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.uiDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.allowsBackForwardNavigationGestures = false
        // The page is a full-bleed dark map; bouncing past it shows white.
        webView.scrollView.bounces = false
        // The page positions its own chrome against the viewport and reads the
        // safe area itself. Letting the scroll view also inset the content would
        // apply the same allowance twice.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.07, green: 0.078, blue: 0.102, alpha: 1)
        view.addSubview(webView)
        view.backgroundColor = webView.backgroundColor
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        applySafeArea()
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

    /// Add whatever the tab bar covers on top of what the device already claims.
    ///
    /// The window's own inset is the home indicator; the difference is the tab
    /// bar. Adding the total would count the home indicator twice and lift every
    /// button a thumb's width too high.
    private func applySafeArea() {
        guard isViewLoaded else { return }
        let deviceBottom = view.window?.safeAreaInsets.bottom ?? 0
        let extra = max(0, coveredAtBottom - deviceBottom)
        // Guarded, because assigning this triggers another layout pass.
        if abs(additionalSafeAreaInsets.bottom - extra) > 0.5 {
            additionalSafeAreaInsets.bottom = extra
        }
    }

    func load(url: URL, token: Int) {
        guard isViewLoaded else { return }
        guard loaded?.url != url || loaded?.token != token else { return }
        loaded = (url, token)
        webView.load(URLRequest(url: url))
    }

    // MARK: - Location

    /// The page's "my location" button, granted.
    ///
    /// Only ever asked on iOS 27 and later — before that WebKit decides for
    /// itself and shows its own prompt, which is why the real work is the
    /// `NSLocationWhenInUseUsageDescription` in Info.plist and the authorization
    /// request below rather than this method.
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

    /// Ask iOS for location, once, the first time the map is on screen.
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
