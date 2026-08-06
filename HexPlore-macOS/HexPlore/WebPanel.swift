import AppKit
import CoreLocation
import SwiftUI
import WebKit

/// The web app, in a web view. This is the app.
///
/// The map, the menu, the import dialogs, the sync connectors, statistics,
/// backups and the login are twenty thousand lines that already work and are
/// already tested by being used every day. Rebuilding them natively would be an
/// enormous amount of effort to arrive back where the browser already is, so the
/// Mac hosts them rather than replacing them.
///
/// Nothing is restyled and nothing is hidden. The one thing the host tells the
/// page is what a clock reads here, which is a fact about this machine the page
/// has no way to learn — see ``WebViewController/hourCycle``.
struct WebPanel: NSViewControllerRepresentable {

    let url: URL
    /// Bumped to force a reload — changing the server, or asking for one.
    let reloadToken: Int

    func makeNSViewController(context: Context) -> WebViewController {
        let controller = WebViewController()
        controller.load(url: url, token: reloadToken)
        return controller
    }

    func updateNSViewController(_ controller: WebViewController, context: Context) {
        controller.load(url: url, token: reloadToken)
    }
}

/// Hosts the web view, and answers for it.
final class WebViewController: NSViewController, WKUIDelegate, WKNavigationDelegate {

    /// Appended to the User-Agent, and the whole of how a server log can tell
    /// this app's traffic from a browser's.
    ///
    /// **Deliberately not the iPhone app's tag.** `server/index.js` keys a
    /// layout on `HexploreiOS` (`IOS_CLIENT`) — the button cluster clearing a
    /// tab bar, the attribution moving out from under a status bar. A Mac window
    /// has neither, so this wants the ordinary desktop page, and the way to ask
    /// for it is to not claim to be a phone.
    static let userAgentTag = "HexploreMac"

    private var webView: WKWebView!
    private var loaded: (url: URL, token: Int)?

    override func loadView() {
        // No storyboard and no nib, so the root view is made here. A plain
        // container rather than the web view itself, because `viewDidLoad`
        // wants somewhere to add it and `NSViewController` insists on having a
        // view before it runs.
        view = NSView()
        view.wantsLayer = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let configuration = WKWebViewConfiguration()
        // The persistent store, so the session survives the app being quit.
        // Signing in every launch would be its own reason not to use this.
        //
        // It buys a second thing that is not obvious from the name. The site
        // registers a service worker, and this store is what persists its
        // registration and its Cache Storage across launches — so the app opens
        // with no server, on the map you last saw, with nothing native written
        // for it and nothing bundled into the app. Swapping this for
        // `.nonPersistent()` would take offline away along with the session.
        // See "The offline shell" in ARCHITECTURE.md.
        configuration.websiteDataStore = .default()
        // The one thing the page can ask this app *for*, rather than be told.
        //
        // A photo library cannot be reached from a page or from the server, so
        // the page asks over this channel and `PhotoBridge` answers. Its absence
        // in a browser is what takes the switch out of the menu — see
        // `photoHost()` in src/photos.js. The page's test is for the handler
        // itself, not for a user-agent string, which is why the same web app
        // finds the library here as on the phone without knowing which it is
        // talking to.
        //
        // `addScriptMessageHandler(_:contentWorld:name:)` rather than the older
        // `add(_:name:)`: this one replies, so the page awaits a promise instead
        // of posting a message and waiting to be called back on some other
        // channel it has to correlate by hand.
        configuration.userContentController.addScriptMessageHandler(
            PhotoBridge.shared, contentWorld: .page, name: PhotoBridge.name
        )
        // The other thing the page cannot do for itself: write a file. See
        // `SaveBridge` — `a.download` is silently ignored in a web view.
        configuration.userContentController.addScriptMessageHandler(
            SaveBridge.shared, contentWorld: .page, name: SaveBridge.name
        )
        // Set on the configuration *before* the web view exists, because
        // `WKWebView` copies its configuration at init — assigning to
        // `webView.configuration` afterwards writes to a copy nobody reads.
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
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = false
        // What shows past the edge of the page while it is settling, and behind
        // an elastic scroll. The page is a full-bleed dark map; the default is
        // white, and a white flash on every load is the one thing you cannot
        // help noticing.
        webView.underPageBackgroundColor = NSColor(red: 0.07, green: 0.078, blue: 0.102, alpha: 1)
        view.addSubview(webView)
        view.layer?.backgroundColor = webView.underPageBackgroundColor.cgColor
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        // Asked here rather than waiting for the page to ask. Before macOS 27 a
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

    // MARK: - There is no safe area to push here
    //
    // The iPhone app measures its own insets and sets `--safe-t/r/b/l` on the
    // root element, because a phone draws the map under a status bar and a tab
    // bar and `env(safe-area-inset-*)` reads zero in a `WKWebView` however
    // correct the insets are.
    //
    // None of that applies to a window with a title bar. The web view starts
    // below the title bar and ends at the frame, so every edge is genuinely
    // clear and the `env(…, 0px)` defaults in `src/style.css` are already right.
    // Pushing zeros would be the same numbers with a round trip in front of them.
    //
    // It is also why this window keeps its title bar rather than hiding it for a
    // full-bleed map. `.hud` in src/style.css sits 20 px from the top left, and
    // that is exactly where the traffic lights would be — a map drawn under them
    // would need this machinery back, to work around a problem it chose.

    // MARK: - Telling the page what a clock says here

    /// Whether this Mac writes 13:05 or 1:05 PM, as an ECMA-402 hour cycle.
    ///
    /// **The page cannot work this out.** `Intl` knows the locale and nothing
    /// else, and System Settings ▸ General ▸ Date & Time ▸ 24-hour time is not
    /// the locale — it is an override on top of it. Safari gets away with
    /// ignoring that because WebKit folds the override into the locale it hands
    /// the page; here the locale is the *app's*. `src/clock.js` is the other
    /// half of this.
    ///
    /// The template trick rather than `Locale.hourCycle`: asking
    /// `DateFormatter` for the pattern behind the "j" skeleton is what returns
    /// the user's *preference* rather than the region's convention. A pattern
    /// containing `a` has an AM/PM field; nothing else does.
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
    /// controller is built, so a web view that reloads after the setting was
    /// changed would otherwise be repeating what was true at launch.
    private func pushClock() {
        guard isViewLoaded, let webView else { return }
        webView.evaluateJavaScript(Self.clockScript)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushClock()

        // The app's own uploader has no login of its own and should not: a
        // second session to keep in step with this one is the bug, not the
        // feature. So it borrows this one. Here rather than at launch because
        // this is the moment it changes — you have just signed in — and a copy
        // taken any earlier is the copy from before you did.
        Task { await SyncClient.adoptWebViewCookies() }
    }

    // MARK: - Location

    /// The page's "my location" button, granted.
    ///
    /// Only ever called on macOS 27 and later — before that WebKit decides for
    /// itself, which is why the real work is the usage description in
    /// Info.plist and the authorization request below rather than this method.
    @available(macOS 27.0, *)
    func webView(
        _ webView: WKWebView,
        requestGeolocationPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        requestLocationIfNeeded()
        // Granted without a second question. The page asking is your own map
        // asking, on a server you run, and macOS has already put its own prompt
        // in front of this the first time — two dialogs for one button is how a
        // permission gets refused by accident.
        decisionHandler(.grant)
    }

    /// Ask macOS for location, once.
    ///
    /// It has to come from the app: a web view cannot raise the system prompt on
    /// its own, so without this the page's locate button fails silently with a
    /// permission error and looks broken.
    ///
    /// Note the page also needs a **secure context** for `navigator.geolocation`
    /// at all — https, or localhost. Over plain `http://192.168.x.x` WebKit
    /// refuses regardless of permissions, which is one more reason to put the
    /// server behind `tailscale serve`.
    /// Asked through ``LocationLogger``, which owns the only `CLLocationManager`
    /// in the app and has a delegate on it. A manager without one never raises
    /// the prompt at all — see
    /// ``LocationLogger/requestAuthorizationIfNeeded()``, which is where that
    /// is written down.
    func requestLocationIfNeeded() {
        LocationLogger.shared.requestAuthorizationIfNeeded()
    }
}
