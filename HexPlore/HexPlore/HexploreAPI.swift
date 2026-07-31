import Foundation

/// The client for your own server.
///
/// Session-cookie authentication, exactly as the browser does it: `POST
/// /api/login` answers with a `sid` cookie and every later request carries it.
/// The cookie is `HttpOnly`, which is a rule about scripts rather than about
/// HTTP clients — `URLSession` stores and sends it without being asked.
///
/// The store is shared on purpose, because the Settings tab's web view needs the
/// same session: signing in twice on one device, once natively and once in a web
/// view, is not a login flow, it is a bug with a form in front of it. See
/// `Session.adoptCookies`.
struct HexploreAPI {

    let baseURL: URL

    enum Failure: LocalizedError {
        case notSignedIn
        case http(Int, String?)
        case badResponse

        var errorDescription: String? {
            switch self {
            case .notSignedIn:
                "Signed out."
            case .http(401, _):
                "That username and password did not match."
            case .http(429, _):
                "Too many attempts. Try again shortly."
            case .http(let code, let message):
                message ?? "The server answered \(code)."
            case .badResponse:
                "The server sent something this app could not read."
            }
        }
    }

    // MARK: - Session

    @discardableResult
    func signIn(username: String, password: String) async throws -> String {
        let body = ["username": username, "password": password]
        let out: [String: String] = try await send("/api/login", method: "POST", body: body)
        return out["username"] ?? username
    }

    /// Who the stored cookie belongs to.
    ///
    /// Throws rather than answering nil, and the difference matters: a 401 means
    /// *sign in*, and anything else means *this address is not answering*. Told
    /// apart they are two different things to do about it; collapsed into nil
    /// they are one screen that says "sign in" at somebody who has mistyped a
    /// hostname, which is the worst kind of wrong — it looks like it works.
    func currentUser() async throws -> String? {
        do {
            let out: [String: String] = try await send("/api/me")
            return out["username"]
        } catch Failure.http(401, _) {
            return nil
        }
    }

    func signOut() async {
        _ = try? await sendIgnoringBody("/api/logout", method: "POST")
    }

    // MARK: - Data

    /// Every visited cell, in the compact form the server stores.
    func cells() async throws -> CellsPayload {
        try await send("/api/cells")
    }

    /// Trips, derived on the server so this app and the browser cannot disagree.
    func trips() async throws -> TripsPayload {
        try await send("/api/trips")
    }

    /// Ground covered, days carried, and where the cells came from.
    func stats() async throws -> StatsPayload {
        try await send("/api/stats")
    }

    // MARK: - Transport

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> T {
        let data = try await sendIgnoringBody(path, method: method, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure.badResponse
        }
    }

    @discardableResult
    private func sendIgnoringBody(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            // The server's errors are `{ "error": "…" }` and are written to be
            // read by a person, so they are worth showing rather than replacing
            // with a status code.
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw Failure.http(http.statusCode, message)
        }
        return data
    }
}

// MARK: - Payloads

/// `GET /api/cells` — sources are interned, so a row names one by index.
struct CellsPayload: Decodable {
    let sources: [String]
    let rows: [CellRow]
}

/// `[cell_id, sourceIndex, addedAt, firstAt, lastAt, hits, fixes]`.
///
/// A heterogeneous array rather than an object, which is how it is stored and
/// sent — for a map of tens of thousands of cells the difference between this
/// and named fields is megabytes.
struct CellRow: Decodable {
    let id: String
    let sourceIndex: Int
    let addedAt: Int
    let firstAt: Int
    let lastAt: Int
    let hits: Int
    let fixes: Int

    init(from decoder: any Decoder) throws {
        var container = try decoder.unkeyedContainer()
        id = try container.decode(String.self)
        sourceIndex = try container.decode(Int.self)
        addedAt = try container.decode(Int.self)
        firstAt = try container.decode(Int.self)
        lastAt = try container.decode(Int.self)
        hits = try container.decode(Int.self)
        // Older imports predate the column, so the array is one shorter.
        fixes = (try? container.decode(Int.self)) ?? 0
    }
}

struct TripsPayload: Decodable {
    let trips: [Trip]
    let home: Home?

    struct Home: Decodable {
        let lng: Double
        let lat: Double
        let name: String?
    }
}

/// Only the fields this app shows. The server sends more, and `Decodable`
/// ignoring the rest is what lets the two move independently.
struct Trip: Decodable, Identifiable {
    let id: String
    let name: String?
    let start: Int
    let end: Int
    let days: Int
}

struct StatsPayload: Decodable {
    let cells: Int
    let km2: Double
    let worldPct: Double
    let days: Int
    let streakDays: Int
    let countries: [Country]

    struct Country: Decodable, Identifiable {
        let id: String
        let cells: Int
        let km2: Double
        let pct: Double
    }
}
