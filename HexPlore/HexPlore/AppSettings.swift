// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import Foundation
import WebKit

/// The handful of things this app knows that the web app does not.
///
/// Which is deliberately almost nothing: where the server is, and whether to
/// reload it. Everything else — who you are, what your map looks like, what you
/// have imported — belongs to the site and is stored on the server, where both
/// this and a laptop can see it.
@MainActor
final class AppSettings: ObservableObject {

    /// The address you open Hexplore at.
    ///
    /// HTTPS everywhere except your own network: `Info.plist` allows plain
    /// `http` to local names only, so `192.168.1.10:3001` works at home and
    /// anything on the public internet has to be `https`. `tailscale serve` in
    /// front of `npm start` is the way in from outside, and browser geolocation
    /// needs a secure origin regardless.
    @Published var serverURL: String {
        didSet {
            guard serverURL != oldValue else { return }
            UserDefaults.standard.set(serverURL, forKey: Keys.serverURL)
            reloadToken += 1
        }
    }

    /// Bumped to make the web view load again.
    @Published private(set) var reloadToken = 0

    private enum Keys {
        static let serverURL = "serverURL"
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: Keys.serverURL) ?? ""
    }

    /// The server address as something loadable, or nil while it is empty or
    /// malformed. A bare hostname is assumed to be https.
    var baseURL: URL? {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: withScheme), url.host != nil else { return nil }
        return url
    }

    var isConfigured: Bool { baseURL != nil }

    func reload() {
        reloadToken += 1
    }

    /// Sign out, by forgetting what the site remembers.
    ///
    /// There is no native session to end — the web app holds it — so this throws
    /// away the cookies and storage the web view keeps, which is the same thing
    /// as signing out and is the only account action this app is in a position
    /// to offer.
    func signOut() async {
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types)
        await store.removeData(ofTypes: types, for: records)
        reloadToken += 1
    }
}
