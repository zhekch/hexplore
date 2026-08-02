// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import CoreLocation
import Foundation
import Photos

/// Where your photo library says you have been.
///
/// The oldest trick in this map and, until now, the clumsiest to use. A photo
/// carries the coordinate it was taken at, so a library is a record of
/// everywhere you have been with a camera in your hand — which for most people
/// is a better record of the last decade than anything they deliberately kept.
/// Getting at it used to mean running a command over an export and importing the
/// file it produced. The library is *on this phone*. There is no reason to go
/// via a file at all.
///
/// ## Nothing is read but two numbers and a date
///
/// `PHAsset` carries `location` and `creationDate` as metadata, so this never
/// opens an image, never asks for image data, never touches iCloud, and cannot
/// download anything. A library of eighty thousand photographs is read in a
/// second or two because it is a database query, not a file walk. What leaves
/// the phone is a list of `[lat, lng, t]` — the same shape a location fix takes,
/// folded by the same code on the other side.
///
/// ## It replaces rather than adds
///
/// Every other source is a partial account of a period, so folding it in is
/// right. A library is not a period: it is the whole answer to "where have I
/// taken a picture", and a photo deleted from it is a claim withdrawn. So a scan
/// sends the library entire and the server replaces what it held — which is also
/// what lets this take over cleanly from the old file-derived import.
@MainActor
final class PhotoSync: NSObject, ObservableObject {

    static let shared = PhotoSync()

    /// Matches `MAX_PHOTO_FIXES` on the server. Past this the library is sent
    /// truncated rather than refused, newest first — see `scan`.
    private static let maxPhotos = 200_000

    /// A rescan is cheap to *read* and not cheap to send, and a library does not
    /// change much in an hour. The observer below is the real trigger.
    private static let gap: TimeInterval = 6 * 3600

    @Published private(set) var scanning = false

    private var lastRun: Date?
    private var observing = false

    private override init() { super.init() }

    var isAuthorized: Bool {
        PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized
    }

    /// Whether the answer is "only some of them" — worth saying out loud, because
    /// a limited library is not a smaller map, it is a wrong one, and nothing
    /// else about the screen would tell you.
    var isLimited: Bool {
        PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited
    }

    var isDenied: Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .denied || status == .restricted
    }

    /// Turn the switch on or off. Asks for permission the first time.
    func apply() {
        guard TrackingSettings.shared.syncPhotos else { return }
        // `.readWrite` is the *read* level — Photos has no read-only one, and
        // this app never writes. `.addOnly` would be the write-only level, which
        // is the opposite of what is wanted.
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
            Task { @MainActor in
                self?.watch()
                await self?.scan()
            }
        }
    }

    /// Rescan when the library changes — a holiday's photos land in one go, and
    /// the map should not wait for the next time the app is opened.
    private func watch() {
        guard !observing, isAuthorized || isLimited else { return }
        observing = true
        PHPhotoLibrary.shared().register(self)
    }

    func scanIfDue() async {
        guard TrackingSettings.shared.syncPhotos else { return }
        if let last = lastRun, Date().timeIntervalSince(last) < Self.gap { return }
        await scan()
    }

    /// Read every geotagged photo and send the lot.
    func scan() async {
        guard TrackingSettings.shared.syncPhotos, !scanning else { return }
        guard isAuthorized || isLimited else { return }
        scanning = true
        defer { scanning = false }
        lastRun = Date()

        let photos = geotagged()
        // Refused rather than obeyed at the other end too, and worth saying here
        // as well: an empty answer from a library that is still indexing after a
        // restore would otherwise read as "you have been nowhere".
        guard !photos.isEmpty else {
            TrackingSettings.shared.status.lastError =
                "No photos with a location were found, so nothing was changed."
            return
        }

        do {
            let taken = try await SyncClient.shared.send(photos: photos)
            TrackingSettings.shared.status.photosSent = taken
            TrackingSettings.shared.status.lastPhotoScan = Date()
            TrackingSettings.shared.status.lastError = nil
        } catch SyncClient.SyncError.signedOut {
            TrackingSettings.shared.status.signedOut = true
        } catch {
            TrackingSettings.shared.status.lastError = error.localizedDescription
        }
    }

    /// Every asset that knows where it was, as `[lat, lng, t]`.
    private func geotagged() -> [[Double]] {
        let options = PHFetchOptions()
        // Newest first, so a library over the ceiling loses its oldest corner
        // rather than its most recent decade. There is no predicate for "has a
        // location" — `PHAsset.location` is not a queryable property — so the
        // filter is the loop below.
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeHiddenAssets = false
        let assets = PHAsset.fetchAssets(with: options)

        var out: [[Double]] = []
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
            out.append([
                (c.latitude * 1e5).rounded() / 1e5,
                (c.longitude * 1e5).rounded() / 1e5,
                Double(Int(taken.timeIntervalSince1970)),
            ])
            if out.count >= Self.maxPhotos { stop.pointee = true }
        }
        // Sent oldest first: `pointsToCells` reads its input as one timeline, and
        // a stay is a run of fixes in the same cell.
        out.sort { $0[2] < $1[2] }
        return out
    }
}

extension PhotoSync: PHPhotoLibraryChangeObserver {
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in await PhotoSync.shared.scanIfDue() }
    }
}
