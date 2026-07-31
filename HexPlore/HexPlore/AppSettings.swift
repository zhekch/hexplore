// `Combine` explicitly, not by way of SwiftUI: this target turns on
// MemberImportVisibility, which stops a transitive import from lending its
// members — and `@Published` and `ObservableObject` are Combine's, not
// SwiftUI's.
import Combine
import Foundation
import SwiftUI

/// Where this app's server lives, and the handful of things the app itself
/// remembers.
///
/// `ObservableObject` rather than `@Observable`, because the deployment target
/// is iOS 16 and the macro is 17.
final class AppSettings: ObservableObject {

    /// The address you open Hexplore at.
    ///
    /// **It has to be HTTPS in practice.** App Transport Security refuses plain
    /// `http://` unless the app ships an exception, browser geolocation needs a
    /// secure origin anyway, and `tailscale serve` in front of `npm start`
    /// gives you an HTTPS URL reachable only from your own devices — which is
    /// what README.md already recommends for a phone.
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Keys.serverURL) }
    }

    private enum Keys {
        static let serverURL = "serverURL"
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: Keys.serverURL) ?? ""
    }

    /// The server URL as something you can actually make a request to, or nil
    /// while it is empty or malformed.
    var baseURL: URL? {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: withScheme), url.host != nil else { return nil }
        return url
    }

    var isConfigured: Bool { baseURL != nil }
}
