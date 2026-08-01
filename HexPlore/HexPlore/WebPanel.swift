import CoreLocation
import ObjectiveC
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
        // And it does not scroll at all. The page is exactly one screen tall —
        // `body` is `overflow: hidden` and every panel over the map is fixed —
        // so this scroll view has nothing to move even in principle. It gets
        // something the moment the keyboard appears: WebKit insets the scroll
        // view by the keyboard's height so a focused field can be scrolled into
        // view, and from then on a finger anywhere on the glass drags the whole
        // map, the search results and the status bar's worth of chrome up the
        // screen, where they stay.
        //
        // Off, then. The page keeps itself clear of the keyboard instead, using
        // the height `observeKeyboard()` hands it, so nothing here ever needs
        // revealing by being moved. The panels' own scroll areas — the layers
        // menu, the search results, the sync dialogs — are separate scroll
        // views inside the content and are untouched by this: with the page
        // pinned, a drag over a list is the list's, which is the whole point.
        webView.scrollView.isScrollEnabled = false
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
        webView.hideInputAccessoryBar()
        observeKeyboard()
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

    // MARK: - Telling the page where the keyboard is

    /// Watch the keyboard, because the page cannot.
    ///
    /// This is the same discovery as `pushSafeArea()`, one layer along, and it
    /// cost the same afternoon. `src/keyboard.js` derives the keyboard's height
    /// from `window.innerHeight - visualViewport.height`, which is correct in
    /// mobile Safari and **always zero here**: a plain `WKWebView` does not
    /// resize its viewport for the keyboard at all. WebKit leaves the page the
    /// full height of the web view, adds an obscured inset to the scroll view,
    /// and scrolls. Nothing the page can read changes — not `innerHeight`, not
    /// `visualViewport.height`, not `env()`.
    ///
    /// Which is why the panels kept ending up behind the keys inside the app
    /// while behaving perfectly in a browser, and why the whole page was the
    /// only thing left to drag: with `--kb` stuck at 0 the search card kept its
    /// full height, its results list had nothing to overflow, and the scroll
    /// view underneath was the one scroller with anywhere to go.
    ///
    /// So the number is sent, exactly as the safe areas are. `willChangeFrame`
    /// rather than `didShow`, so the layout moves with the keyboard instead of
    /// after it.
    private func observeKeyboard() {
        let centre = NotificationCenter.default
        centre.addObserver(
            self, selector: #selector(keyboardFrameChanged),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil
        )
        centre.addObserver(
            self, selector: #selector(keyboardWillHide),
            name: UIResponder.keyboardWillHideNotification, object: nil
        )
    }

    @objc private func keyboardFrameChanged(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let window = view.window
        else { return }
        // The notification's frame is in screen coordinates; what the page needs
        // is how much of *this view* the keyboard stands on. A hardware keyboard
        // or a floating one lands mostly or entirely off the bottom, and this
        // arithmetic gives the right answer — nothing — for both.
        let inView = view.convert(window.convert(frame, from: nil), from: window)
        pushKeyboard(max(0, view.bounds.maxY - inView.minY))
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        pushKeyboard(0)
    }

    /// Hand the page the keyboard's height as `--kb`, the variable `style.css`
    /// already lays out around.
    private func pushKeyboard(_ overlap: CGFloat) {
        guard isViewLoaded, let webView else { return }
        // `data-kb-host` tells src/keyboard.js to stop measuring and leave this
        // alone: two writers for one variable, one of which is always wrong
        // here, is how it would start flickering.
        let script = """
        document.documentElement.dataset.kbHost = '1';
        document.documentElement.style.setProperty('--kb', '\(Int(overlap.rounded()))px');
        """
        webView.evaluateJavaScript(script)
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
        // And again here: the view the accessory bar belongs to is created with
        // the first document, so at viewDidLoad there was nothing to swap.
        webView.hideInputAccessoryBar()

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

// MARK: - The bar above the keyboard

/// Carries the one override, so its implementation can be copied onto a class
/// that does not exist at compile time. Nothing is ever instantiated from it.
private final class NoAccessoryBar: NSObject {
    @objc var inputAccessoryView: UIView? { nil }
}

extension WKWebView {

    /// Take away the grey bar iOS floats above the keyboard — ‹ ›, and a tick.
    ///
    /// It is a form-stepping control, and this page is not a form: the fields it
    /// appears over are a search box, a token, a URL. There is nothing to step
    /// to, so all three of its buttons do nothing you wanted, while it eats
    /// ~45 pt at the one moment the screen is at its shortest.
    ///
    /// **How.** The bar belongs to `WKContentView`, which is internal to WebKit
    /// and cannot be subclassed at compile time. So it is subclassed at run
    /// time: allocate a subclass of whatever class the content view actually
    /// is, graft `NoAccessoryBar`'s `inputAccessoryView` getter onto it, and
    /// change the object's class to that. Only public Objective-C runtime calls
    /// are involved — no private API is *called* — but it does depend on a
    /// private class's name, so if WebKit ever renames it the `guard` below
    /// simply finds nothing and the bar comes back. That is the failure mode we
    /// want: cosmetic, not a crash.
    ///
    /// Idempotent, and it has to be said out loud: the target's class is read
    /// back to build the new name, so a version without the `hasSuffix` check
    /// below subclasses its own subclass on the second call and again on the
    /// third — a fresh class per navigation, none of them ever freed.
    func hideInputAccessoryBar() {
        let suffix = "_NoAccessoryBar"
        guard let target = scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else {
            // Said out loud for the same reason `pushSafeArea()` prints what the
            // page ended up with: the whole failure mode here is silence. If
            // WebKit ever renames the class, everything still works and the bar
            // is simply back, with nothing anywhere to say why.
            #if DEBUG
            print("[HexPlore] accessory bar: no WKContentView — bar left in place")
            #endif
            return
        }

        let current = String(describing: type(of: target))
        guard !current.hasSuffix(suffix) else { return } // already swapped

        let name = current + suffix
        if let existing = NSClassFromString(name) {
            object_setClass(target, existing)
            return
        }

        guard let base = object_getClass(target),
              let getter = class_getInstanceMethod(
                  NoAccessoryBar.self,
                  #selector(getter: NoAccessoryBar.inputAccessoryView)
              ),
              let subclass = name.withCString({ objc_allocateClassPair(base, $0, 0) })
        else { return }

        class_addMethod(
            subclass,
            #selector(getter: NoAccessoryBar.inputAccessoryView),
            method_getImplementation(getter),
            method_getTypeEncoding(getter)
        )
        objc_registerClassPair(subclass)
        object_setClass(target, subclass)
        #if DEBUG
        print("[HexPlore] accessory bar: \(current) → \(name)")
        #endif
    }
}
