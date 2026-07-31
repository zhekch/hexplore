import SwiftUI
import WebKit

/// The web app, in a web view.
///
/// The menu, the import dialogs, the sync connectors and the backup schedule are
/// some nine thousand lines of interface that already work and are already
/// tested by being used. Rebuilding them in SwiftUI to reach the same server
/// would be a great deal of effort for a screen that looks the same, so this
/// tab is the real thing.
///
/// The map is *not* in here — that is the native tab. This is the surfaces where
/// the browser is as good a host as the phone, and the browser already has them.
///
/// Two things to know about `WKWebView`:
///
///   * **It has its own cookie store**, separate from `URLSession`. So signing in
///     here does not sign the native side in, and vice versa. While the native
///     side has no API client that costs nothing; when it gets one, the two will
///     have to be joined deliberately rather than by accident.
///   * **It refuses plain `http://`** under App Transport Security. That is a
///     reason to put the server behind `tailscale serve` rather than a reason to
///     weaken the app.
struct WebPanel: UIViewRepresentable {

    let url: URL
    @Binding var reloadToken: Int

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The site is the user's own server and wants its session to survive
        // being backgrounded, so this is deliberately the persistent store
        // rather than a private one.
        configuration.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        // The page is a full-bleed dark map UI; letting it bounce past its own
        // background shows white above the fold.
        webView.scrollView.bounces = false
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Reload only when the address actually changed or the user asked, not
        // on every SwiftUI state change — a web view that reloads whenever
        // anything nearby updates loses whatever you had typed into it.
        if context.coordinator.loadedURL != url || context.coordinator.reloadToken != reloadToken {
            context.coordinator.loadedURL = url
            context.coordinator.reloadToken = reloadToken
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
