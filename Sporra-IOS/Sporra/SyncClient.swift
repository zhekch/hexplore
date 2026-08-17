import Foundation
import UIKit
import WebKit

/// Talking to the server from Swift rather than from the page.
///
/// ## Signing in is still the web app's job
///
/// There is no native login and there should not be one — a second session to
/// keep in step with the first is the bug, not the feature. So this borrows the
/// one the web view already has: after every page load `WebPanel` copies the
/// site's cookies into `HTTPCookieStorage.shared`, which is the jar
/// `URLSession` reaches for without being asked and which persists across
/// launches on its own.
///
/// That it persists at all is a property of the server: `sessionCookie()` in
/// `server/index.js` sets `Max-Age`, so `sid` is a dated cookie rather than a
/// session one, and a phone relaunched into the background at 4 a.m. by a
/// location event still has it. A session cookie would be dropped at every
/// launch and background syncing would quietly never work — which is the sort
/// of thing that looks like a networking bug for a week.
///
/// When the session does end, nothing here can mend it: a 401 is reported up to
/// the Settings tab, which says to open the Map tab and sign in.
@MainActor
final class SyncClient {

    static let shared = SyncClient()

    /// One push at a time, and never more than this many fixes in it. A phone
    /// catching up after a fortnight has thousands to send and a background
    /// wake is seconds long, so it goes in bites that fit — the queue survives
    /// between them, and the next wake carries on.
    private static let batchSize = 2000

    /// Uploads are cheap and radios are not. A wake happens at most once per
    /// cadence anyway; this stops the one-minute setting turning into a POST a
    /// minute on a cellular connection.
    private static let minGap: TimeInterval = 5 * 60

    private let session: URLSession
    private var flushing = false
    private var lastFlush: Date?

    private init() {
        let config = URLSessionConfiguration.default
        // The shared jar, which is where the web view's cookies are copied to.
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        // A background wake is short. Waiting out a 60-second default on a
        // server that is not there spends all of it.
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    enum SyncError: LocalizedError {
        case noServer
        case signedOut
        case http(Int, String?)

        var errorDescription: String? {
            switch self {
            case .noServer: return "No server set."
            case .signedOut: return "Signed out. Open the Map tab and sign in."
            case .http(let code, let message): return message ?? "The server answered \(code)."
            }
        }
    }

    // MARK: - Sending what has been recorded

    /// Push whatever is queued, oldest first, until it is gone.
    ///
    /// `force` skips the rate gap — the Settings tab's own button, and the
    /// moment the app goes to the background, are both worth a push regardless
    /// of when the last one was.
    func flush(force: Bool = false) async {
        guard !flushing else { return }
        let settings = TrackingSettings.shared
        guard FixQueue.shared.count > 0 else {
            settings.status.pending = 0
            return
        }
        if !force, let last = lastFlush, Date().timeIntervalSince(last) < Self.minGap { return }

        flushing = true
        defer {
            flushing = false
            settings.status.pending = FixQueue.shared.count
        }

        // A background wake is granted seconds; asking for time is what turns
        // that into enough for a round trip. Without it a push started as the
        // app is suspended is cancelled halfway, which the server sees as a
        // request that never arrived and the phone sees as a failure — and then
        // both are right and nothing moves.
        let task = UIApplication.shared.beginBackgroundTask(withName: "sporra.push")
        defer { UIApplication.shared.endBackgroundTask(task) }

        while FixQueue.shared.count > 0 {
            let batch = FixQueue.shared.head(limit: Self.batchSize)
            do {
                _ = try await post("/api/device/fixes", body: [
                    "device": settings.deviceHeader,
                    "fixes": batch.map(\.wire),
                ])
                // Only now: a fix leaves the queue when the server has it, not
                // when it has been sent.
                FixQueue.shared.drop(batch.count)
                lastFlush = Date()
                settings.status.lastPush = Date()
                settings.status.lastError = nil
                settings.status.signedOut = false
            } catch SyncError.signedOut {
                settings.status.signedOut = true
                settings.status.lastError = SyncError.signedOut.errorDescription
                return
            } catch {
                // Everything stays queued. The next wake tries again, and a
                // week in a cellar costs nothing but disk.
                settings.status.lastError = error.localizedDescription
                return
            }
        }
    }

    /// Send workouts from Apple Health. Returns how many the server took in —
    /// the ones it already had are not an error, they are the normal answer.
    @discardableResult
    func send(workouts: [[String: Any]]) async throws -> Int {
        guard !workouts.isEmpty else { return 0 }
        let settings = TrackingSettings.shared
        var taken = 0
        // A ride is thousands of points; a year of them in one body is tens of
        // megabytes and a server that stops answering the map while it parses.
        for chunk in stride(from: 0, to: workouts.count, by: 20).map({
            Array(workouts[$0..<min($0 + 20, workouts.count)])
        }) {
            let reply = try await post("/api/device/workouts", body: [
                "device": settings.deviceHeader,
                "workouts": chunk,
            ])
            taken += (reply["taken"] as? Int) ?? 0
        }
        settings.status.workoutsSent += taken
        return taken
    }

    /// Send the whole photo library, which is the only way it can be sent: the
    /// server replaces what it held, and a library split across requests would
    /// be several independent counts merged into a wrong one with no moment at
    /// which "what it no longer mentions" was knowable.
    ///
    /// 200,000 coordinates is about 6 MB — a decade of enthusiastic photography,
    /// and a single request.
    @discardableResult
    func send(photos: [[Double]]) async throws -> Int {
        guard !photos.isEmpty else { return 0 }
        let reply = try await post("/api/device/photos", body: [
            "device": TrackingSettings.shared.deviceHeader,
            "photos": photos,
        ])
        return (reply["photos"] as? Int) ?? 0
    }

    /// Take one source off the map entirely — its cells, its routes and whatever
    /// was remembering how far it had got.
    func forget(source: String) async throws {
        _ = try await post("/api/sources/delete", body: ["source": source])
    }

    /// Throw away everything Apple Health has put on the map, both ends of it,
    /// so the next sync reads the whole history again from a clean sheet.
    ///
    /// Both ends in one call is the point. Clearing only the server leaves this
    /// phone's query anchor saying "all caught up" and nothing is ever re-sent;
    /// clearing only the anchor re-sends workouts the server already knows and
    /// it answers "known" to every one of them.
    func resetHealth() async throws {
        _ = try await post("/api/device/health/reset", body: [:])
        HealthSync.forgetAnchor()
        TrackingSettings.shared.status.workoutsSent = 0
    }

    // MARK: - Where am I standing

    /// One airport, as much of it as is worth putting in a sentence.
    struct Airport {
        let name: String
        let city: String
        /// What identifies it for the cooldown — the ICAO code, which every
        /// entry has, falling back to the name for the handful that do not.
        let key: String
    }

    /// Which airport this point is standing in, or nil for none.
    ///
    /// The dataset lives on the server (`server/airport-at.js`) because this
    /// phone has no copy of 5,272 airports and should not carry one. Asked by
    /// `FlightWatch`, and only when a fix has moved far enough to have changed
    /// the answer.
    func airport(lat: Double, lng: Double) async throws -> Airport? {
        var items = URLComponents()
        items.queryItems = [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lng", value: String(lng)),
        ]
        let reply = try await get("/api/airport?\(items.percentEncodedQuery ?? "")")
        guard let found = reply["airport"] as? [String: Any] else { return nil }
        let name = (found["name"] as? String) ?? ""
        let icao = (found["icao"] as? String) ?? ""
        return Airport(name: name, city: (found["city"] as? String) ?? "", key: icao.isEmpty ? name : icao)
    }

    // MARK: - The request itself

    private func get(_ path: String) async throws -> [String: Any] {
        guard let base = AppSettings.shared.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw SyncError.noServer
        }
        var request = URLRequest(url: url)
        request.setValue(WebViewController.userAgentTag, forHTTPHeaderField: "X-Sporra-Client")
        return try await run(request)
    }

    @discardableResult
    private func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let base = AppSettings.shared.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw SyncError.noServer
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The same tag the web view carries, so a server log can tell the app's
        // own traffic from the page's.
        request.setValue(WebViewController.userAgentTag, forHTTPHeaderField: "X-Sporra-Client")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await run(request)
    }

    /// Send it, and turn the two answers that mean something into errors that
    /// say so. Shared by `get` and `post` because a 401 has to be recognised
    /// identically either way — it is the one status the Settings tab has words
    /// for, and the one nothing here can mend.
    private func run(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status == 401 { throw SyncError.signedOut }
        guard (200..<300).contains(status) else {
            throw SyncError.http(status, json?["error"] as? String)
        }
        return json ?? [:]
    }

    // MARK: - Borrowing the session

    /// Copy the site's cookies out of the web view and into the jar
    /// `URLSession` uses.
    ///
    /// Called after every page load, because that is when the interesting
    /// change happens — you have just signed in — and because a copy taken once
    /// at launch would be the copy from before you did.
    static func adoptWebViewCookies() async {
        let host = AppSettings.shared.baseURL?.host
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        for cookie in cookies where host == nil || cookie.domain.hasSuffix(host!) {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    /// Signing out: throw the borrowed session away too.
    ///
    /// `AppSettings.signOut()` clears what the *web view* keeps, which used to
    /// be the whole story. It is not any more — leaving a copy of `sid` in
    /// `HTTPCookieStorage` would mean a phone that had signed out went on
    /// uploading, which is the one thing "sign out" has to mean.
    static func forgetSession() {
        for cookie in HTTPCookieStorage.shared.cookies ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }
}
