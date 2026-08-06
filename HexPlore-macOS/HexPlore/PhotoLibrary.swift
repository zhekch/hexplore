// `AppKit` for the image the library hands back and the JPEG encoder, `AVKit`
// for the player item, `Photos` for everything else here.
import AVKit
import AppKit
import CoreLocation
import Foundation
import Photos

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

/// Carries one AppKit object from a Photos callback to the main actor.
///
/// `NSImage` and `AVPlayerItem` are not `Sendable`, and resuming a continuation
/// with either of them is the compiler correctly pointing out that it cannot
/// prove what happens next. What happens next is that it is handed to a window
/// on the main actor and never touched again from anywhere else, which is the
/// part the compiler cannot see and this box asserts.
///
/// The iPhone app needs none of this because `UIImage` is `Sendable`; `NSImage`
/// is mutable in ways `UIImage` is not, and is not.
private nonisolated struct Handoff<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// Reading the photo library — the only place in this app that opens `Photos`.
///
/// Two things want it and they want different amounts of it. ``PhotoSync`` sends
/// the coordinates to the server and never needs to know which photograph a
/// coordinate came from. ``PhotoBridge`` draws them on the map, where clicking a
/// point has to produce the picture — so it needs the asset's identity kept.
///
/// Keeping the walk here is what makes "what counts as a geotagged photo" one
/// answer rather than two: a filter that disagreed between the two would put a
/// point on the map the sync did not count, or the other way about, and nothing
/// would say which was wrong.
///
/// ## The library is the Mac's own
///
/// Photos on a Mac holds the System Photo Library, which for most people is the
/// same iCloud library the phone shows — so this reads the same photographs the
/// iPhone app would, minus anything that has not finished syncing down. Where it
/// differs is that a Mac library is often the *bigger* one: everything imported
/// from a camera over the years, which never went near a phone.
///
/// ## `nonisolated`, and it has to be
///
/// This target builds with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`, so
/// everything unannotated here would be main-actor isolated — including the walk
/// over the whole library. `PhotoBridge` runs that walk inside a `Task.detached`
/// precisely so a map on screen does not freeze for a second while it happens,
/// and without this keyword the hop back to the main actor would undo exactly
/// that, silently.
///
/// The members that put a window on screen are annotated back, because those
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
        /// Whether it moves. The map draws it the same either way; the card
        /// offers it a play button, and playing it happens over here — see
        /// ``play(id:)``.
        let isVideo: Bool
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
    /// Videos are in it, marked. A video knows where it was taken exactly as a
    /// photograph does, so it is a point on the map for the same reason and
    /// evidence for the uploader for the same reason. What differs is only what
    /// clicking it does — see ``play(id:)``.
    static func located(limit: Int = ceiling) -> [Located] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeHiddenAssets = false
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
                t: Int(taken.timeIntervalSince1970),
                isVideo: asset.mediaType == .video
            ))
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }

    /// One photograph as JPEG bytes, at most `px` on its longest side.
    ///
    /// This is the one call in the app that opens an image, and it happens only
    /// when a point on the map has been clicked. `isNetworkAccessAllowed` is on
    /// because a photo from four years ago may well not be on this machine any
    /// more — refusing to fetch it would make the overlay work for this month
    /// and mysteriously not for the rest of the library.
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
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false

        let size = CGSize(width: px, height: px)
        let once = Latch()
        // Encoded inside the handler rather than after it, which is the shape
        // the phone's version does not need: `NSImage` is not `Sendable`, so
        // sending one back through the continuation would be asking the
        // compiler to take something on trust for no reason. Bytes are bytes.
        return await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: .aspectFit, options: options
            ) { image, _ in
                // Whatever arrives first is the answer, degraded or not. The
                // tempting alternative — ignore anything flagged degraded and
                // wait for the good one — turns a callback that never comes into
                // a card that says "loading" forever, and a slightly soft
                // photograph is a far better failure than a hang.
                if once.close() { continuation.resume(returning: encodeJPEG(image)) }
            }
        }
    }

    /// An `NSImage` from Photos as JPEG bytes, and the size it really is.
    ///
    /// The *pixel* dimensions off the `CGImage`, not `image.size`, which is in
    /// points and would describe a 1200 px thumbnail as 400 wide on a 3× screen.
    /// The page uses this to give the picture its shape before the bytes have
    /// decoded.
    private static func encodeJPEG(_ image: NSImage?) -> (data: Data, width: Int, height: Int)? {
        guard let image,
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
            return nil
        }
        return (data, cg.width, cg.height)
    }

    // MARK: - Showing one properly

    /// The longest side to ask for when showing one big.
    ///
    /// **Not `PHImageManagerMaximumSize`**, which was the first answer on the
    /// phone and was a bad one: a recent iPhone photograph is 48 megapixels,
    /// which is an image of about 190 MB once decoded. A Mac has the memory to
    /// survive that and still no reason to spend it — 3,000 px is nine
    /// megapixels, sharper than a Retina display at 1× and still sharp several
    /// stops into the zoom, at about a twentieth of the cost.
    private static let viewPixels: CGFloat = 3000

    /// Put a photograph in a window, big.
    ///
    /// The window is shown **first** and handed the picture when it arrives.
    /// Waiting meant a click did nothing at all for as long as an iCloud fetch
    /// took and then produced a window mid-animation; this way it is up
    /// immediately, spinning, which is what every other app does.
    @MainActor
    static func view(id: String) async -> Bool {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        else { return false }

        let viewer = PhotoViewerWindowController.shared
        viewer.present()

        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false

        let once = Latch()
        let size = CGSize(width: viewPixels, height: viewPixels)
        let arrived: Handoff<NSImage?> = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: .aspectFit, options: options
            ) { image, _ in
                if once.close() { continuation.resume(returning: Handoff(image)) }
            }
        }
        // Handed over even when it is nil: the viewer closes itself rather than
        // being left as a black window with a spinner that never stops.
        viewer.show(image: arrived.value)
        return true
    }

    // MARK: - Playing a video

    /// Play one, in its own window. See ``VideoWindowController`` for why it is
    /// shown this way rather than handed to the page.
    @MainActor
    static func play(id: String) async -> Bool {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
              asset.mediaType == .video
        else { return false }

        let options = PHVideoRequestOptions()
        // An original that lives in iCloud is the common case for anything more
        // than a few months old, and Photos does the fetching.
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic

        let once = Latch()
        let arrived: Handoff<AVPlayerItem?> = await withCheckedContinuation { continuation in
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                if once.close() { continuation.resume(returning: Handoff(item)) }
            }
        }
        guard let item = arrived.value else { return false }
        VideoWindowController.shared.play(item: item)
        return true
    }

    // MARK: - There is no way out to Photos, and there was never going to be
    //
    // This briefly offered an "Open in Photos" button on the phone. It is gone,
    // and the note travels with the code so it does not come back.
    //
    // Neither system has a public way to open one particular asset. On iOS
    // `photos-redirect://` opens the Photos app and lands wherever Photos was
    // last; on macOS the same is true of opening the application. A button
    // labelled "Open in Photos" that opens Photos at something else is a button
    // that lies about what it does, and that is worse than no button: you press
    // it *because* you want that picture, and you arrive somewhere unrelated
    // with your place on the map gone. The card shows the picture, which is what
    // the button was mostly wanted for. If Apple ever ships a real deep link,
    // this is the place for it.
}
