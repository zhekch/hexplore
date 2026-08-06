// `UIKit` for the JPEG encoder and the one door out to the Photos app; `Photos`
// for everything else here.
import CoreLocation
import Foundation
import Photos
import UIKit

/// Lets exactly one caller through, and tells it so.
///
/// For the one hazard `withCheckedContinuation` has: resuming twice is a crash,
/// not a second answer, and `PHImageManager` will call a result handler more
/// than once for some combinations of options. A captured `var` would say the
/// same thing in fewer lines and is precisely the thing stricter concurrency
/// checking refuses, so the flag is given a lock and a name instead.
private nonisolated final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false

    func close() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if closed { return false }
        closed = true
        return true
    }
}

/// Reading the photo library — the only place in this app that opens `Photos`.
///
/// Two things want it and they want different amounts of it. ``PhotoSync`` sends
/// the coordinates to the server and never needs to know which photograph a
/// coordinate came from. ``PhotoBridge`` draws them on the map, where tapping a
/// point has to produce the picture — so it needs the asset's identity kept.
///
/// The enumeration used to live inside the uploader, which was right while it
/// was the only caller. It is here now so that "what counts as a geotagged
/// photo" is answered once: a filter that disagreed between the two would put a
/// point on the map the sync did not count, or the other way about, and nothing
/// would say which was wrong.
///
/// ## `nonisolated`, and it has to be
///
/// This target builds with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`, so
/// everything unannotated here would be main-actor isolated — including the walk
/// over the whole library. `PhotoBridge` runs that walk inside a
/// `Task.detached` precisely so a map on screen does not freeze for a second
/// while it happens, and without this keyword the hop back to the main actor
/// would undo exactly that, silently. The compiler does say so, as a warning
/// today and an error under the Swift 6 language mode.
///
/// The two members that touch `UIApplication` are annotated back, because those
/// genuinely do belong to the main actor.
nonisolated enum PhotoLibrary {

    /// One photograph, as much of it as leaves this file.
    struct Located {
        /// `PHAsset.localIdentifier`. Never crosses the bridge to the page — see
        /// the note on ``PhotoBridge``.
        let id: String
        let lat: Double
        let lng: Double
        /// Unix seconds. A photo with no date is dropped rather than dated now.
        let t: Int
    }

    /// The most photographs either caller will look at.
    ///
    /// Matches `MAX_PHOTO_FIXES` on the server, and the map's own ceiling is the
    /// same number deliberately: a library that reached the map but not the
    /// server, or the reverse, would be two different answers to "where have you
    /// taken a picture" with nothing to say which one to believe.
    static let ceiling = 200_000

    static var authorization: PHAuthorizationStatus {
        // `.readWrite` is the *read* level — Photos has no read-only one, and
        // this app never writes. `.addOnly` is the write-only level, which is
        // the opposite of what is wanted.
        PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    /// Whether the library can be read at all. `.limited` counts: it is a
    /// smaller library rather than a closed one, and the map says so out loud.
    static var isReadable: Bool {
        authorization == .authorized || authorization == .limited
    }

    /// Ask, once, and wait for the answer.
    ///
    /// The map overlay asks for itself rather than leaning on the sync switch:
    /// looking at your photographs on a map and uploading where they were taken
    /// are two different decisions, and someone who has made only the first one
    /// should still get an overlay.
    @discardableResult
    static func authorize() async -> PHAuthorizationStatus {
        if authorization != .notDetermined { return authorization }
        return await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                continuation.resume(returning: status)
            }
        }
    }

    /// Every asset that knows where it was, newest first.
    ///
    /// Newest first so a library over the ceiling loses its oldest corner rather
    /// than its most recent decade. There is no predicate for "has a location" —
    /// `PHAsset.location` is not a queryable property — so the filter is the
    /// loop, which is also why this reads the whole library however few photos
    /// carry a coordinate.
    ///
    /// It is still fast: `location` and `creationDate` are metadata, so nothing
    /// here opens an image, asks for image data or touches iCloud. Eighty
    /// thousand photographs take a second or two because this is a database
    /// query rather than a file walk.
    ///
    /// ## `stillsOnly`, and why the two callers disagree
    ///
    /// A video knows where it was taken exactly as a photograph does, so for the
    /// **uploader** it is the same evidence and is counted: you were there, and
    /// what the camera was recording at the time is beside the point.
    ///
    /// For the **overlay** it is not, and the difference is the whole of what the
    /// overlay does. `requestImage` on a video hands back its poster frame, so a
    /// video appeared as a photograph that could not be played — a point you can
    /// tap and be misled by. Playing it is not a small thing to add: a video is
    /// tens of megabytes and cannot cross the bridge as a data URL at all. So the
    /// map leaves them out and says how many photographs it has, which is true,
    /// rather than showing stills that lie about what they are.
    ///
    /// `mediaType` *is* a queryable property, so this costs nothing — unlike the
    /// location filter above it, the database does it.
    static func located(limit: Int = ceiling, stillsOnly: Bool = false) -> [Located] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeHiddenAssets = false
        if stillsOnly {
            options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        }
        let assets = PHAsset.fetchAssets(with: options)

        var out: [Located] = []
        out.reserveCapacity(min(assets.count, 4096))
        assets.enumerateObjects { asset, _, stop in
            guard let where_ = asset.location else { return }
            let c = where_.coordinate
            guard CLLocationCoordinate2DIsValid(c), c.latitude != 0 || c.longitude != 0 else { return }
            // A photo with no date is a photo that could have been taken any
            // time, and a visit with no date is not a visit — the server counts
            // stays by the clock. `modificationDate` is not a fallback: it is
            // when the file was edited, which is a fact about the file.
            guard let taken = asset.creationDate else { return }
            out.append(Located(
                id: asset.localIdentifier,
                // Five decimals is about a metre, which is finer than any
                // camera's fix and coarser than the file it came from. The map
                // and the server are handed the same rounding for the same
                // reason: it is the precision the number actually has.
                lat: (c.latitude * 1e5).rounded() / 1e5,
                lng: (c.longitude * 1e5).rounded() / 1e5,
                t: Int(taken.timeIntervalSince1970)
            ))
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }

    /// One photograph as JPEG bytes, at most `px` on its longest side.
    ///
    /// This is the one call in the app that opens an image, and it happens only
    /// when a point on the map has been tapped. `isNetworkAccessAllowed` is on
    /// because a photo from four years ago is usually not on the phone any more
    /// — refusing to fetch it would make the overlay work for this month and
    /// mysteriously not for the rest of the library.
    ///
    /// `@concurrent` because `nonisolated async` is not enough on its own under
    /// this target's approachable-concurrency setting: such a function runs on
    /// whichever actor called it, and the caller is the main one. The encode and
    /// the base64 of a 1600 px JPEG are tens of milliseconds, and the card's
    /// strip asks for four dozen of them in a row.
    @concurrent
    static func jpeg(id: String, px: Int) async -> (data: Data, width: Int, height: Int)? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            return nil
        }
        let options = PHImageRequestOptions()
        // One request, one answer. `.opportunistic` — the default — calls the
        // handler twice, with a blurred placeholder and then the real image, and
        // a continuation resumed twice is a crash rather than a second picture.
        // The degraded check below is belt and braces for the same hazard.
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false

        let size = CGSize(width: px, height: px)
        let once = Latch()
        let image: UIImage? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: .aspectFit, options: options
            ) { image, _ in
                // Whatever arrives first is the answer, degraded or not. The
                // tempting alternative — ignore anything flagged degraded and
                // wait for the good one — turns a callback that never comes into
                // a card that says "loading" forever, and a slightly soft
                // photograph is a far better failure than a hang.
                if once.close() { continuation.resume(returning: image) }
            }
        }
        guard let image, let data = image.jpegData(compressionQuality: 0.82) else { return nil }
        // The *pixel* dimensions, not `image.size`, which is in points and would
        // describe a 1200 px thumbnail as 400 wide on a 3× phone. The page uses
        // this to give the picture its shape before the bytes have decoded.
        let cg = image.cgImage
        return (data, cg?.width ?? Int(image.size.width), cg?.height ?? Int(image.size.height))
    }

    // MARK: - There is no way out to Photos, and there was never going to be
    //
    // This briefly offered an "Open in Photos" button. It is gone, and the note
    // is here so it does not come back.
    //
    // iOS has no public way to open one particular asset. `photos-redirect://`
    // opens the Photos app — undocumented, but it works — and that is all it
    // does: it lands wherever Photos was last, not on the photograph you tapped.
    // The schemes that look like they take an identifier
    // (`photos-navigation://…?assetUuid=`) are private and do not answer one.
    //
    // A button labelled "Open in Photos" that opens Photos at something else is
    // a button that lies about what it does, and on a real library that is worse
    // than no button: you tap it *because* you want that picture in the Photos
    // app, and you arrive somewhere unrelated with your place on the map gone.
    // The card shows the picture, which is what the button was mostly wanted
    // for. If Apple ever ships a real deep link, this is the place for it.
}
