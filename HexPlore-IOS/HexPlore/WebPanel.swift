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
        //
        // It buys a second thing that is not obvious from the name. The site
        // registers a service worker, WebKit has run those in a web view since
        // iOS 14, and this store is what persists its registration and its
        // Cache Storage across launches — so the app opens with no server, on
        // the map you last saw, with nothing native written for it and nothing
        // bundled into the IPA. Swapping this for `.nonPersistent()` would take
        // offline away along with the session. See "The offline shell" in
        // ARCHITECTURE.md.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        // The one thing the page can ask this app *for*, rather than be told.
        //
        // Everything else the host offers is pushed at the page (the safe area)
        // or happens beside it (the uploader). The photo overlay is the other
        // direction: a library cannot be reached from a page or from the server,
        // so the page asks over this channel and `PhotoBridge` answers. Its
        // absence in a browser is what takes the switch out of the menu — see
        // `photoHost()` in src/photos.js.
        //
        // `addScriptMessageHandler(_:contentWorld:name:)` rather than the older
        // `add(_:name:)`: this one replies, so the page awaits a promise instead
        // of posting a message and waiting to be called back on some other
        // channel it has to correlate by hand.
        configuration.userContentController.addScriptMessageHandler(
            PhotoBridge.shared, contentWorld: .page, name: PhotoBridge.name
        )
        // The other thing the page cannot do for itself: save a file. See
        // `SaveBridge` — `a.download` is silently ignored in a web view, so the
        // export button did nothing at all in this app.
        configuration.userContentController.addScriptMessageHandler(
            SaveBridge.shared, contentWorld: .page, name: SaveBridge.name
        )
        // And the third: the introduction's Health row, which is the one
        // permission a page cannot raise a sheet for on its own. See
        // `HealthBridge` — it moves no workouts, only the question.
        configuration.userContentController.addScriptMessageHandler(
            HealthBridge.shared, contentWorld: .page, name: HealthBridge.name
        )
        // How the server tells this app apart from a browser: it lands at the
        // end of the User-Agent, so `server/index.js` can key a layout on it.
        //
        // Set on the configuration *before* the web view exists, because
        // `WKWebView` copies its configuration at init — assigning to
        // `webView.configuration` afterwards writes to a copy nobody reads,
        // which is exactly how the first attempt failed silently.
        configuration.applicationNameForUserAgent = Self.userAgentTag
        // Before the page's first line runs, because `src/clock.js` builds its
        // formatters the moment it is imported and everything showing a time
        // reads them. Injected as well as pushed in `didFinish` — that one is a
        // fresh reading for a web view that reloads mid-session, this one is
        // what makes the very first timestamp on screen right.
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.clockScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.allowsBackForwardNavigationGestures = false
        // The page is a full-bleed dark map; bouncing past it shows white.
        webView.scrollView.bounces = false
        // Said out loud, because edge to edge depends on it and the default does
        // not say what it does: `.automatic` insets the content by the safe area
        // whenever the view decides the content scrolls, which for a page that
        // is *nearly* the height of the screen is a judgement call this code
        // should not be leaving to it. `.never` is the one value that always
        // means "the page is exactly as big as the web view".
        //
        // It was briefly `.always`, on the theory that WebKit derives the page's
        // `env(safe-area-inset-*)` from the same adjustment. It does not — that
        // read `0px` either way — so the setting bought nothing. The page is
        // told where its edges are by `pushSafeArea()` instead, which is a
        // measurement rather than a hope.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
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

    // MARK: - Telling the page what a clock says here

    /// Whether this device writes 13:05 or 1:05 PM, as an ECMA-402 hour cycle.
    ///
    /// **The page cannot work this out.** `Intl` knows the locale and nothing
    /// else, and Settings ▸ General ▸ Date & Time ▸ 24-Hour Time is not the
    /// locale — it is an override on top of it. Mobile Safari gets away with
    /// ignoring that because WebKit folds the override into the locale it hands
    /// the page; here the locale is the *app's*, which is English, so a phone
    /// that has said 13:05 everywhere for years was told 01:05 PM by this one
    /// screen. `src/clock.js` is the other half of this.
    ///
    /// The template trick rather than `Locale.hourCycle`: asking
    /// `DateFormatter` for the pattern behind the "j" skeleton is what returns
    /// the user's *preference* rather than the region's convention, and it has
    /// answered that question correctly since long before this app's deployment
    /// target. A pattern containing `a` has an AM/PM field; nothing else does.
    private static var hourCycle: String {
        let pattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? ""
        return pattern.contains("a") ? "h12" : "h23"
    }

    /// The one line that says it, and the nudge for a page already running.
    private static var clockScript: String {
        """
        document.documentElement.dataset.hourCycle = '\(hourCycle)';
        window.dispatchEvent(new Event('hexplore:clock'));
        """
    }

    /// Say it again, read again. The injected copy above is baked when this
    /// controller is built, so a web view that reloads after the switch was
    /// flipped would otherwise be repeating what was true at launch.
    private func pushClock() {
        guard isViewLoaded, let webView else { return }
        webView.evaluateJavaScript(Self.clockScript)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Again on load, because a page that has just replaced itself has none
        // of the properties the last one was given.
        pushSafeArea()
        pushClock()

        // The app's own uploader has no login of its own and should not: a
        // second session to keep in step with this one is the bug, not the
        // feature. So it borrows this one. Here rather than at launch because
        // this is the moment it changes — you have just signed in — and a copy
        // taken any earlier is the copy from before you did.
        Task { await SyncClient.adoptWebViewCookies() }

        #if DEBUG
        // What the page ends up with. The chrome's position depends entirely on
        // these reaching it, and a wrong guess about that is invisible from the
        // Swift side — which is how `env(safe-area-inset-*)` silently reporting
        // zero survived a whole round of "it should work".
        webView.evaluateJavaScript(
            """
            JSON.stringify({
              client: document.documentElement.dataset.client || '(none)',
              // Edge to edge means the page is as tall as the screen. Anything
              // shorter is the scroll view insetting the content, which is a
              // bar at each end of the map.
              pageHeight: window.innerHeight,
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

    /// The page's compass, granted.
    ///
    /// The beam out of the blue dot that says which way you are facing reads
    /// `webkitCompassHeading`, and a web view delivers that only to a page that
    /// has called `DeviceOrientationEvent.requestPermission()` and been told
    /// yes. **Without this method the answer is no** — `WKWebView` denies by
    /// default when the delegate does not implement it, and what that looks
    /// like is a dot with no beam and nothing anywhere saying why. See
    /// `askForCompass` in src/heading.js, which is the other end of it.
    ///
    /// Granted, for the reason the geolocation one above is: this is your own
    /// map on a server you run, asking the one question a map on a phone is for.
    /// There is no system prompt behind this one at all — the heading comes from
    /// CoreLocation, whose permission has already been asked for — so a dialog
    /// here would be a question with nothing on the other side of it.
    func webView(
        _ webView: WKWebView,
        requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
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
