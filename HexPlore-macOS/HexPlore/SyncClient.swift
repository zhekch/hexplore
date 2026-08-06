import Foundation
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
/// session one, and an app reopened a week later still has it. A session cookie
/// would be dropped at every launch and syncing would quietly never work —
/// which is the sort of thing that looks like a networking bug for a week.
///
/// When the session does end, nothing here can mend it: a 401 is reported up to
/// the Settings window, which says to open the map and sign in.
@MainActor
final class SyncClient {

    static let shared = SyncClient()

    /// One push at a time, and never more than this many fixes in it. A laptop
    /// catching up after a fortnight abroad has thousands to send, so it goes in
    /// bites that fit — the queue survives between them, and the next push
    /// carries on.
    private static let batchSize = 2000

    /// Uploads are cheap and radios are not. This stops the one-minute setting
    /// turning into a POST a minute on a tethered connection.
    private static let minGap: TimeInterval = 5 * 60

    private let session: URLSession
    private var flushing = false
    private var lastFlush: Date?

    private init() {
        let config = URLSessionConfiguration.default
        // The shared jar, which is where the web view's cookies are copied to.
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        // Quitting waits on this. Sitting out a 60-second default against a
        // server that is not there spends all of it and then some.
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
            case .signedOut: return "Signed out. Open the map window and sign in."
            case .http(let code, let message): return message ?? "The server answered \(code)."
            }
        }
    }

    // MARK: - Sending what has been recorded

    /// Push whatever is queued, oldest first, until it is gone.
    ///
    /// `force` skips the rate gap — the Settings window's own button, and the
    /// moment the app is quitting, are both worth a push regardless of when the
    /// last one was.
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

        // No `beginBackgroundTask` here, and none wanted: that exists to buy an
        // iOS app seconds it is about to be suspended out of. A Mac app that is
        // running is running. The one moment that genuinely ends is quitting,
        // and `AppDelegate.applicationShouldTerminate` holds the door for that.

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
                // Everything stays queued. The next push tries again, and a
                // fortnight offline costs nothing but disk.
                settings.status.lastError = error.localizedDescription
                return
            }
        }
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

    // MARK: - The request itself

    @discardableResult
    private func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let base = AppSettings.shared.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw SyncError.noServer
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The same tag the web view carries, so a server log can tell this app's
        // own traffic from the page's — and this app's from the phone's.
        request.setValue(WebViewController.userAgentTag, forHTTPHeaderField: "X-Hexplore-Client")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

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
    /// `HTTPCookieStorage` would mean a machine that had signed out went on
    /// uploading, which is the one thing "sign out" has to mean.
    static func forgetSession() {
        for cookie in HTTPCookieStorage.shared.cookies ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }
}
