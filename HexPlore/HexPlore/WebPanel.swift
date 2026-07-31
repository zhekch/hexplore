import SwiftUI
import WebKit

/// The web app's own menu, hosted in a web view.
///
/// The menu, the import dialogs, the sync connectors and the backup schedule are
/// some nine thousand lines of interface that already work against this same
/// server. Rebuilding them in SwiftUI would be a great deal of effort for a
/// screen that looks the same, so this tab is the real thing.
///
/// **The map is hidden and the menu is opened.** Loading the site plainly gives
/// you the whole app — a second map, behind the settings you came for. So a
/// stylesheet takes the map surface and the editing chrome off screen and a
/// small script opens the menu, which leaves exactly the panel and the dialogs
/// underneath it. Everything else is untouched: the menu is the site's own, and
/// every button in it still talks to the server the way it always did.
///
/// That is a stopgap rather than a design. The honest version is a mode the web
/// app itself supports — it already reads `?debuglevels`, so a `?panel=settings`
/// that boots without a map would be a small change there and would delete all
/// of the injection below.
struct WebPanel: UIViewRepresentable {

    let url: URL
    @Binding var reloadToken: Int
    /// Copies the native session cookie into the web view's own store.
    let adoptCookies: (WKWebView) async -> Void

    /// Take the map off the screen. `visibility` rather than `display`, because
    /// MapLibre measures its container and a zero-sized one makes it complain
    /// rather than simply not draw.
    private static let hideMapCSS = """
    #map { visibility: hidden !important; }
    #hud { display: none !important; }
    html, body { background: #12141a !important; }
    """

    /// Open the menu as soon as it exists. The button is in the markup from the
    /// start but the app only wires it up once the map is ready, so this waits
    /// for the panel to actually respond rather than clicking once and hoping.
    private static let openMenuJS = """
    (function () {
      var style = document.createElement('style');
      style.textContent = `\(hideMapCSS)`;
      document.documentElement.appendChild(style);

      var tries = 0;
      var timer = setInterval(function () {
        var menu = document.getElementById('layers-menu');
        var button = document.getElementById('layers-btn');
        if (menu && !menu.hidden) { clearInterval(timer); return; }
        if (button) button.click();
        if (++tries > 60) clearInterval(timer);
      }, 100);
    })();
    """

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The user's own server, and its session should survive being
        // backgrounded — so the persistent store, not a private one.
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.openMenuJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.07, green: 0.078, blue: 0.102, alpha: 1)

        // The cookie has to be in the store before the first request, or the
        // site answers with its own login form to someone already signed in.
        Task { @MainActor in
            await adoptCookies(webView)
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != url || context.coordinator.reloadToken != reloadToken
        else { return }
        context.coordinator.loadedURL = url
        context.coordinator.reloadToken = reloadToken
        Task { @MainActor in
            await adoptCookies(webView)
            webView.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(loadedURL: url, reloadToken: reloadToken)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL
        var reloadToken: Int

        init(loadedURL: URL, reloadToken: Int) {
            self.loadedURL = loadedURL
            self.reloadToken = reloadToken
        }
    }
}
