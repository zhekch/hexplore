// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members.
import Combine
import Foundation
import HexploreCore
import WebKit

/// Who is signed in, and everything their map is made of.
///
/// One object for both, because they change together: signing in loads the
/// cells, signing out throws them away, and no view should be able to see one
/// without the other.
@MainActor
final class Session: ObservableObject {

    enum State: Equatable {
        case unconfigured   // no server address yet
        case checking
        case signedOut(String?)
        case signedIn(String)
    }

    @Published private(set) var state: State = .unconfigured
    @Published private(set) var cells: [Cell] = []
    @Published private(set) var sources: [String] = []
    @Published private(set) var loadingCells = false
    @Published private(set) var loadError: String?

    private var api: HexploreAPI?

    var isSignedIn: Bool { if case .signedIn = state { return true }; return false }

    var username: String? {
        if case .signedIn(let name) = state { return name }
        return nil
    }

    // MARK: - Server

    /// Point at a server and find out whether we are already signed in to it.
    func use(baseURL: URL?) async {
        guard let baseURL else {
            api = nil
            state = .unconfigured
            cells = []
            return
        }
        // Re-pointing at the same server must not throw away a live session.
        if api?.baseURL == baseURL, isSignedIn { return }

        api = HexploreAPI(baseURL: baseURL)
        state = .checking
        do {
            if let name = try await api?.currentUser() {
                state = .signedIn(name)
                await loadCells()
            } else {
                state = .signedOut(nil)
            }
        } catch {
            // Not "sign in" — "this address is not answering". Said in those
            // words, because the two look identical from the outside and only
            // one of them is fixed by typing a password.
            state = .signedOut("Could not reach \(baseURL.host ?? "the server"). \(error.localizedDescription)")
        }
    }

    // MARK: - Signing in

    func signIn(username: String, password: String) async {
        guard let api else { return }
        state = .checking
        do {
            let name = try await api.signIn(username: username, password: password)
            state = .signedIn(name)
            await loadCells()
        } catch {
            state = .signedOut(error.localizedDescription)
        }
    }

    func signOut() async {
        await api?.signOut()
        cells = []
        sources = []
        state = .signedOut(nil)
    }

    // MARK: - The map

    func loadCells() async {
        guard let api, isSignedIn else { return }
        loadingCells = true
        loadError = nil
        defer { loadingCells = false }

        do {
            let payload = try await api.cells()
            // Parsed rather than trusted: an id the maths cannot read is not a
            // cell, and turning it into 0/0/0 would put a hexagon in the
            // Atlantic rather than admit the problem.
            var seen = Set<Cell>()
            var parsed: [Cell] = []
            parsed.reserveCapacity(payload.rows.count)
            for row in payload.rows {
                guard let cell = HexGrid.parse(cellId: row.id) else { continue }
                // One row per (cell, source), so the same cell arrives more than
                // once when two apps both saw you there.
                if seen.insert(cell).inserted { parsed.append(cell) }
            }
            cells = parsed
            sources = payload.sources
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: - The web view's half of the session

    /// Hand the session cookie to the web view's own store.
    ///
    /// `WKWebView` keeps cookies separately from `URLSession`, so without this
    /// the Settings tab would show a login form to someone who has just signed
    /// in on the map tab. Copying the cookie across is the difference between
    /// one sign-in and two.
    func adoptCookies(into webView: WKWebView) async {
        guard let host = api?.baseURL.host else { return }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.domain.contains(host) {
            await store.setCookie(cookie)
        }
    }
}
