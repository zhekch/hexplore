import CoreLocation
import Foundation
import HealthKit
import UIKit

/// Workouts out of Apple Health — the ones that went somewhere.
///
/// Health is where everything ends up. A ride recorded on a Watch, a walk from
/// Fitness+, a run from a third-party app that also writes there: they are all
/// already on this phone, already finished, already carrying their route. Going
/// out to somebody's API for them would be a round trip to fetch what is in the
/// next process along.
///
/// ## Only the ones with geography
///
/// Most workouts are not places. A gym session, a swim in a pool, twenty minutes
/// of rowing on a machine — Health records them all and none of them is
/// somewhere anyone went. The filter is not a heuristic about the activity type:
/// it is whether the workout carries an `HKWorkoutRoute`, which is Health's own
/// answer to the same question and is right about the cases a type list would
/// get wrong. An indoor cycle has no route; an open-water swim does.
///
/// ## Sending the same one twice is expected, not exceptional
///
/// The query anchor is a fast path and nothing more. It is lost on reinstall,
/// and Health hands back an *edited* old workout as readily as a new one, so
/// "have I sent this?" cannot be answered by remembering how far we got. The
/// server remembers the ids instead (`device_workouts`), which makes re-sending
/// cheap and exact — and that in turn is what lets this give up halfway through
/// a first sync of eight years of rides without losing its place.
@MainActor
final class HealthSync {

    static let shared = HealthSync()

    /// A first sync can be years of workouts and each one is a separate pass
    /// through Health's route storage.
    ///
    /// Bounded per run **in the background only**, where the app is given
    /// seconds rather than minutes and being killed mid-way is normal. In the
    /// foreground there is no such limit and no reason to invent one: you have
    /// pressed Sync now and are watching it, and eight years of rides arriving
    /// forty at a time over the following fortnight is not a feature.
    private static let maxPerBackgroundRun = 40

    /// Opportunistic syncs, from a location wake. The observer below is the real
    /// trigger; this is the safety net for a Watch that saves a ride hours later,
    /// out of range of the phone.
    private static let opportunisticGap: TimeInterval = 30 * 60

    // --- What a route point has to be, to be believed ---------------------------
    // A workout's route arrives as one undifferentiated stream of locations, and
    // taking it at face value draws two things that never happened: a straight
    // line across a pause, and a straight line out to wherever the watch thought
    // it was before it got a GPS lock.
    //
    // Apple's own Fitness app draws the first of those as a *dotted* line, which
    // is the whole argument in one design decision — it knows it did not record
    // that part. This app has a stronger version of the same rule already
    // written down: nothing is inferred, and the ground between two fixes is not
    // filled in, guessed at or drawn. A pause is exactly that ground.

    /// Worse than this and the fix is a glitch, not a coarse reading.
    ///
    /// The logger has a *setting* for this and this does not, and the difference
    /// is real. A phone in your pocket genuinely does spend the day on
    /// cell-tower fixes, so how much of that you want is a matter of taste. A
    /// watch recording a walk has GPS lock — a 1,500 m fix in the middle of one
    /// is not a vague reading of where you were, it is the last place the watch
    /// knew about before it locked on. Keeping one drew a 16.7 km line from Thun
    /// across a 1.17 km walk in Gümligen.
    private static let maxAccuracyM: CLLocationDistance = 100

    /// A pause is a gap in time *and* in space, and it takes both to be one.
    ///
    /// Time alone is wrong: the thinning below already drops the fixes you make
    /// while standing still, so five minutes outside a café is legitimately one
    /// long gap between two points six metres apart. Distance alone is wrong: a
    /// descent covers 150 m in under ten seconds. Together they mean the
    /// recorder was not watching for the part in between — which is precisely
    /// when a line between them would be an invention.
    private static let pauseSec: TimeInterval = 60
    private static let pauseM: CLLocationDistance = 150

    /// And the jump nobody made, whatever the clock claims. 30 m/s is 108 km/h,
    /// comfortably past a fast descent and well short of anything a person does
    /// under their own power.
    private static let maxSpeedMS: Double = 30

    /// Five metres between kept points, and five decimal places on each.
    ///
    /// Both come from the other end rather than from taste: the server
    /// simplifies with a 6 m tolerance (`ROUTE_EPSILON_M`) and rounds
    /// coordinates to 1e-5 (`cleanGeom`), so everything dropped here is
    /// something it was going to drop anyway. What it saves is real — a 1 Hz
    /// recording of a two-hour ride is 7,200 points, most of them the seconds
    /// spent at traffic lights.
    private static let thinM: CLLocationDistance = 5

    private let store = HKHealthStore()
    private var observer: HKObserverQuery?
    private var running = false
    private var lastRun: Date?

    private enum Keys {
        static let anchor = "health.anchor"
        static let sent = "health.sentIds"
    }

    /// Workouts already dealt with under the anchor we are still holding.
    ///
    /// This exists because the anchor is all or nothing. A background run takes
    /// forty workouts and cannot save the anchor — there are more behind them —
    /// so the next run's query offers the same list again, and without this it
    /// would take the same forty for ever and never reach the forty-first.
    ///
    /// Emptied the moment the anchor moves, because at that point the anchor
    /// says everything this was saying.
    private var sentIds: Set<String> = []

    private init() {
        sentIds = Set(UserDefaults.standard.stringArray(forKey: Keys.sent) ?? [])
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Ask for permission and start (or stop) watching. Called when the switch
    /// is thrown, and at every launch to re-arm the observer.
    func apply() {
        guard isAvailable else { return }
        guard TrackingSettings.shared.syncWorkouts else {
            if let observer {
                store.stop(observer)
                self.observer = nil
            }
            store.disableBackgroundDelivery(for: .workoutType()) { _, _ in }
            return
        }

        let types: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        store.requestAuthorization(toShare: [], read: types) { [weak self] _, _ in
            // Read permission never reports itself: for privacy, Health answers
            // the same whether you said yes or no, and the only way to find out
            // is to ask for data and see. So there is nothing to branch on here
            // — a refusal shows up as a sync that finds no workouts, which is
            // what the Settings tab says.
            Task { @MainActor in
                self?.watch()
                await self?.sync()
            }
        }
    }

    /// Wake the app when a workout is saved.
    ///
    /// This is why the HealthKit capability needs Background Delivery ticked. A
    /// ride finishes, the Watch syncs it over, and the app gets a moment of
    /// runtime to send it — without which "sync my activities" would mean
    /// "remember to open the app".
    private func watch() {
        guard observer == nil else { return }
        store.enableBackgroundDelivery(for: .workoutType(), frequency: .hourly) { _, _ in }
        let query = HKObserverQuery(sampleType: .workoutType(), predicate: nil) { [weak self] _, completion, _ in
            Task { @MainActor in
                await self?.sync()
                // Not optional. iOS stops delivering to an app that does not
                // acknowledge, and it does so silently.
                completion()
            }
        }
        observer = query
        store.execute(query)
    }

    func syncIfDue() async {
        guard TrackingSettings.shared.syncWorkouts else { return }
        if let last = lastRun, Date().timeIntervalSince(last) < Self.opportunisticGap { return }
        await sync()
    }

    /// One pass: what is new, what of it went somewhere, and send that.
    func sync() async {
        guard isAvailable, TrackingSettings.shared.syncWorkouts, !running else { return }
        running = true
        defer {
            running = false
            TrackingSettings.shared.status.lastWorkoutScan = Date()
        }
        lastRun = Date()

        let found: (workouts: [HKWorkout], anchor: HKQueryAnchor?)
        do {
            found = try await newWorkouts()
        } catch {
            TrackingSettings.shared.status.lastError = error.localizedDescription
            return
        }

        // Oldest first, so giving up halfway leaves a contiguous history rather
        // than a scattering of whatever happened to fit.
        let ordered = found.workouts
            .sorted { $0.startDate < $1.startDate }
            .filter { !sentIds.contains($0.uuid.uuidString) }
        let limit = UIApplication.shared.applicationState == .active
            ? Int.max
            : Self.maxPerBackgroundRun
        let batch = Array(ordered.prefix(limit))
        let drained = batch.count == ordered.count

        var payload: [[String: Any]] = []
        for workout in batch {
            guard let wire = await wireForm(of: workout) else { continue }
            payload.append(wire)
        }

        do {
            try await SyncClient.shared.send(workouts: payload)
            TrackingSettings.shared.status.lastError = nil
            // Everything in the batch, not only what produced a payload: a
            // workout with no route has still been dealt with, and reading its
            // routes to find that out again on every run is the expensive part.
            markSent(batch.map(\.uuid.uuidString))
            // The anchor moves only when the query has nothing left to offer.
            // Saved early it is history skipped for ever, which is the one
            // failure here that nobody would ever notice.
            if drained, let anchor = found.anchor {
                save(anchor)
                markSent([], reset: true)
            }
        } catch SyncClient.SyncError.signedOut {
            TrackingSettings.shared.status.signedOut = true
        } catch {
            TrackingSettings.shared.status.lastError = error.localizedDescription
        }
    }

    // MARK: - Reading Health

    private func newWorkouts() async throws -> (workouts: [HKWorkout], anchor: HKQueryAnchor?) {
        let store = self.store
        let anchor = savedAnchor()
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: .workoutType(),
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit,
            ) { _, samples, _, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [HKWorkout] ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    /// A workout as `/api/device/workouts` reads it, or nil if it went nowhere.
    private func wireForm(of workout: HKWorkout) async -> [String: Any]? {
        let routes = (try? await routeSamples(of: workout)) ?? []
        guard !routes.isEmpty else { return nil }

        var segments: [[[Double]]] = []
        for route in routes {
            guard let locations = try? await locations(in: route) else { continue }
            // One route sample can yield several lines: a workout paused three
            // times is four of them.
            segments.append(contentsOf: lines(from: locations))
        }
        guard !segments.isEmpty else { return nil }

        var wire: [String: Any] = [
            "id": workout.uuid.uuidString,
            "sport": Self.sport(for: workout.workoutActivityType),
            "start": Int(workout.startDate.timeIntervalSince1970),
            "end": Int(workout.endDate.timeIntervalSince1970),
            "segments": segments,
        ]
        // The barometer's answer, which is a better number than anything
        // derivable from GPS altitude. When Health does not offer one the server
        // works it out from the line, exactly as it does for an imported file.
        if let ascent = workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity {
            wire["elevUp"] = ascent.doubleValue(for: .meter())
        }
        return wire
    }

    private func routeSamples(of workout: HKWorkout) async throws -> [HKWorkoutRoute] {
        let store = self.store
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil,
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: samples as? [HKWorkoutRoute] ?? [])
            }
            store.execute(query)
        }
    }

    private func locations(in route: HKWorkoutRoute) async throws -> [CLLocation] {
        let store = self.store
        return try await withCheckedThrowingContinuation { continuation in
            var collected: [CLLocation] = []
            // A route query calls back many times and a continuation may be
            // resumed exactly once, so the two have to be reconciled by hand.
            var settled = false
            let query = HKWorkoutRouteQuery(route: route) { query, locations, done, error in
                guard !settled else { return }
                if let error {
                    settled = true
                    store.stop(query)
                    continuation.resume(throwing: error)
                    return
                }
                collected.append(contentsOf: locations ?? [])
                if done {
                    settled = true
                    continuation.resume(returning: collected)
                }
            }
            store.execute(query)
        }
    }

    // MARK: - Trimming

    /// One route's locations → the lines actually worth drawing.
    ///
    /// Plural, and that is the point. A route is one stream of locations however
    /// many times the workout was paused, so this is where a pause becomes two
    /// lines rather than one line with a lie in the middle of it. See the
    /// constants above for what counts as a pause and why it takes two
    /// measurements to say so.
    private func lines(from locations: [CLLocation]) -> [[[Double]]] {
        var out: [[[Double]]] = []
        var current: [[Double]] = []
        var previous: CLLocation?

        func flush() {
            // Two points is the least that can be a line. A lone survivor is a
            // glitch that happened to pass the accuracy test, and dropping it
            // here keeps it out of the *cells* as well — the server takes a
            // workout's points from the segments it is given, not from
            // everything that arrived in the request.
            if current.count >= 2 { out.append(current) }
            current = []
        }

        for location in locations {
            let accuracy = location.horizontalAccuracy
            // A negative accuracy is CoreLocation handing over a coordinate it
            // does not believe in.
            guard accuracy >= 0, accuracy <= Self.maxAccuracyM else { continue }

            if let previous {
                let metres = location.distance(from: previous)
                let seconds = location.timestamp.timeIntervalSince(previous.timestamp)
                let paused = seconds > Self.pauseSec && metres > Self.pauseM
                let teleported = seconds > 0 && metres / seconds > Self.maxSpeedMS
                if paused || teleported {
                    flush()
                } else if metres < Self.thinM {
                    // Too close to the last *kept* point to be worth carrying.
                    // Measuring from the kept one rather than the last one seen
                    // is also what stops a long stand-still reading as a pause:
                    // the clock runs on, but the distance never opens up.
                    continue
                }
            }

            previous = location
            current.append([
                (location.coordinate.longitude * 1e5).rounded() / 1e5,
                (location.coordinate.latitude * 1e5).rounded() / 1e5,
                Double(Int(location.timestamp.timeIntervalSince1970)),
            ])
        }
        flush()
        return out
    }

    // MARK: - What Health calls it, and what this app calls it

    /// Health's activity types, in words `canonicalSport` in `src/routes.js`
    /// already knows.
    ///
    /// Sent as the lower-case synonym rather than the finished label so there is
    /// still exactly one place that decides how an activity is spelled — the
    /// same place a Komoot "racebike" and a Strava "Ride" go through. Anything
    /// not listed is sent blank and the server guesses from pace and distance,
    /// which is the existing answer for a file that did not say.
    private static func sport(for type: HKWorkoutActivityType) -> String {
        switch type {
        case .walking: return "walking"
        case .running: return "running"
        case .cycling: return "cycling"
        case .hiking: return "hiking"
        case .swimming: return "swimming"
        case .downhillSkiing: return "downhill ski"
        case .crossCountrySkiing: return "cross-country ski"
        case .snowboarding: return "snowboarding"
        case .rowing: return "rowing"
        case .paddleSports, .waterSports: return "paddling"
        case .sailing: return "sailing"
        case .surfingSports: return "surfing"
        case .climbing: return "climbing"
        case .equestrianSports: return "riding"
        case .skatingSports: return "skating"
        case .golf: return "golf"
        case .wheelchairWalkPace, .wheelchairRunPace: return "wheelchair"
        default: return ""
        }
    }

    // MARK: - The anchor

    private func savedAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: Keys.anchor) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func save(_ anchor: HKQueryAnchor) {
        guard let data = try? NSKeyedArchiver.archivedData(
            withRootObject: anchor, requiringSecureCoding: true,
        ) else { return }
        UserDefaults.standard.set(data, forKey: Keys.anchor)
    }

    private func markSent(_ ids: [String], reset: Bool = false) {
        sentIds = reset ? [] : sentIds.union(ids)
        UserDefaults.standard.set(Array(sentIds), forKey: Keys.sent)
    }

    /// Signing out forgets where we got to, so signing in as somebody else does
    /// not silently inherit this account's progress through Health.
    static func forgetAnchor() {
        UserDefaults.standard.removeObject(forKey: Keys.anchor)
        UserDefaults.standard.removeObject(forKey: Keys.sent)
        shared.sentIds = []
    }
}
