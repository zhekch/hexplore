// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import Foundation

/// Whether the address you typed is a Sporra server, and whether it is up.
///
/// The Settings tab used to answer that only by implication: you typed an
/// address, went to the Map tab, and either the site appeared or a web view sat
/// there being white. Everything in between — a typo, a server that is down, a
/// tailnet you are not on, something else answering on that port — looked the
/// same from here.
///
/// So it asks. `GET /api/health` is unauthenticated, because this runs *before*
/// there is a session and "wrong address" and "signed out" are different
/// problems that used to be one message.
///
/// ## A 200 is not enough
///
/// On a home network an address with nothing at the other end is rare; an
/// address with the *wrong thing* at the other end is not — a router's admin
/// page, a NAS, some other container on the same box. All of them answer 200 to
/// something. So the check is the body: `{"app": "sporra"}`, and anything else
/// is reported as its own state, in its own colour. "It answered, but it is not
/// your map" is a different sentence from "it did not answer", and it points at
/// a different mistake.
@MainActor
final class ServerCheck: ObservableObject {

    static let shared = ServerCheck()

    enum State: Equatable {
        /// No address to check yet.
        case unset
        case checking
        /// A Sporra server, and the build it is running.
        case connected(version: String?)
        /// Something answered, and it is not this.
        case notSporra
        /// It answered with a status that is not a success.
        case http(Int)
        /// It did not answer. Carries whatever the system said about why.
        case unreachable(String)
    }

    @Published private(set) var state: State = .unset

    private let session: URLSession
    /// The check in flight, so a view that appears twice does not start two.
    private var probe: Task<Void, Never>?

    private init() {
        let config = URLSessionConfiguration.ephemeral
        // Short, because this is a question with a person waiting for the
        // answer — not a background upload that can afford to be patient.
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        // Never a cached answer: the whole value of this is that it describes
        // right now.
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(configuration: config)
    }

    /// Ask again. Safe to call from `onAppear` and from a button alike.
    func check() {
        probe?.cancel()
        guard let base = AppSettings.shared.baseURL,
              let url = URL(string: "/api/health", relativeTo: base) else {
            state = .unset
            return
        }
        state = .checking
        probe = Task { [weak self] in
            let next = await Self.ask(url, using: self?.session ?? .shared)
            guard !Task.isCancelled else { return }
            self?.state = next
        }
    }

    private static func ask(_ url: URL, using session: URLSession) async -> State {
        do {
            let (data, response) = try await session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { return .http(status) }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard (json?["app"] as? String) == "sporra" else { return .notSporra }
            return .connected(version: json?["version"] as? String)
        } catch let error as URLError {
            // The code as well as the sentence: "could not connect to the
            // server" is true of a dozen different mistakes, and `-1004` is the
            // part somebody can search for.
            return .unreachable("\(error.localizedDescription) (\(error.errorCode))")
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}

extension ServerCheck.State {
    /// What the row says.
    var label: String {
        switch self {
        case .unset: return "No address yet"
        case .checking: return "Checking…"
        case .connected(let version): return version.map { "Connected · \($0)" } ?? "Connected"
        case .notSporra: return "Received invalid response"
        case .http(let code): return "Disconnected · HTTP \(code)"
        case .unreachable(let why): return "Disconnected · \(why)"
        }
    }

    /// An SF Symbol, or nil while there is nothing to say.
    var symbol: String? {
        switch self {
        case .unset: return nil
        case .checking: return nil
        case .connected: return "checkmark.circle.fill"
        case .notSporra: return "exclamationmark.triangle.fill"
        case .http, .unreachable: return "xmark.circle.fill"
        }
    }
}
