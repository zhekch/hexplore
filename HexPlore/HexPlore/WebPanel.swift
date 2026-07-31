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
/// **It deliberately does not extend under the tab bar.** The web app's own
/// chrome — the geolocate button, the menu, the pencil — stacks in the
/// bottom-right corner on a phone, and its CSS has no `safe-area-inset` handling
/// at all, so anything drawn over the bottom of the page covers buttons rather
/// than sitting beside them. Letting SwiftUI inset the view is one line and
/// costs nothing; making the page aware of a tab bar would mean editing its CSS
/// for a host it should not have to know about.
struct WebPanel: UIViewRepresentable {

    let url: URL
    /// Bumped to force a reload — changing the server, or asking for one.
    let reloadToken: Int

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The persistent store, so the session survives the app being closed.
        // Signing in every launch would be its own reason not to use this.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = false
        // The page is a full-bleed dark map; bouncing past it shows white.
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.07, green: 0.078, blue: 0.102, alpha: 1)

        context.coordinator.loaded = Load(url: url, token: reloadToken)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let wanted = Load(url: url, token: reloadToken)
        // Only when it actually changed. A web view that reloads whenever any
        // nearby state updates loses whatever you had typed into it — and this
        // one holds the import dialogs.
        guard context.coordinator.loaded != wanted else { return }
        context.coordinator.loaded = wanted
        webView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    struct Load: Equatable {
        let url: URL
        let token: Int
    }

    final class Coordinator {
        var loaded: Load?
    }
}
