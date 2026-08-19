import Foundation

/// The domains this build is allowed to treat as its own, and the reason the app
/// has an offline copy on some phones and not others.
///
/// ## What this is for
///
/// On iOS — and only on iOS — a `WKWebView` is given service workers and Cache
/// Storage **only for app-bound domains**: the list under `WKAppBoundDomains` in
/// Info.plist. For anything else the registration simply never happens. There is
/// no exception, no console message, and nothing in `navigator.serviceWorker`
/// that reads any differently; the storage directories the worker would live in
/// are never created, and that is the whole of the evidence.
///
/// So an app pointed at an undeclared server works — every day, perfectly —
/// until the first time it is opened with no network, and then shows an empty
/// rectangle. That is not the offline shell failing. It is the offline shell
/// never having existed.
///
/// macOS has no such rule. The same code, the same server and the same web view
/// configuration register a worker and fill its caches there, which is why this
/// took a simulator to find: everything that could be tested on a Mac passed.
///
/// ## Why it cannot be a setting
///
/// The list is read out of Info.plist by WebKit, not by this app, so it is fixed
/// when the app is built. A server address typed in Settings afterwards cannot
/// get into it. For an app that is compiled by the person who runs the server
/// that is a fair trade — you already have the project open — but it does mean
/// **the address has to be in two places**, and the Settings tab says so when
/// they disagree rather than leaving you to find out at an airport.
///
/// ## Adding yours
///
/// In `sporra-ios/Info.plist`:
///
/// ```xml
/// <key>WKAppBoundDomains</key>
/// <array>
///     <string>sporra.your-tailnet.ts.net</string>
/// </array>
/// ```
///
/// Hosts only — no scheme, no port, no path — at most ten of them, and each one
/// covers its subdomains. Rebuild, and the next launch with a network builds the
/// offline copy.
enum AppBoundDomains {

    /// What Info.plist declares, lowercased. Empty when the key is absent, which
    /// is the shipped default: an app that has not been told which server is
    /// yours cannot guess, and the alternative — declaring somebody else's — is
    /// worse than declaring nothing.
    static var declared: [String] {
        let raw = Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") as? [String]
        return (raw ?? []).map { $0.lowercased() }
    }

    /// Whether this address is one WebKit will keep an offline copy for.
    ///
    /// Matched the way WebKit matches it: the host itself, or any subdomain of
    /// a declared domain. A port is not part of the comparison — `WKAppBoundDomains`
    /// has no notion of one — so a server on `:3001` is covered by its bare host.
    static func covers(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased(), !declared.isEmpty else { return false }
        return declared.contains { host == $0 || host.hasSuffix(".\($0)") }
    }
}
