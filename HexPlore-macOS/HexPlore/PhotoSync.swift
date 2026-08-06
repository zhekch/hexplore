// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `@Published` is Combine's.
import Combine
import Foundation
import Photos

/// Where your photo library says you have been.
///
/// The oldest trick in this map and, until the app existed, the clumsiest to
/// use. A photo carries the coordinate it was taken at, so a library is a record
/// of everywhere you have been with a camera in your hand — which for most
/// people is a better record of the last decade than anything they deliberately
/// kept. Getting at it used to mean running a command over an export and
/// importing the file it produced. The library is *on this Mac*. There is no
/// reason to go via a file at all.
///
/// ## Nothing is read but two numbers and a date
///
/// `PHAsset` carries `location` and `creationDate` as metadata, so this never
/// opens an image, never asks for image data, never touches iCloud, and cannot
/// download anything. A library of eighty thousand photographs is read in a
/// second or two because it is a database query, not a file walk. What leaves
/// the machine is a list of `[lat, lng, t]` — the same shape a location fix
/// takes, folded by the same code on the other side. The overlay that shows a
/// photograph opens it here, for the card in front of you, and no image is
/// uploaded by anything in this app.
///
/// ## It replaces rather than adds
///
/// Every other source is a partial account of a period, so folding it in is
/// right. A library is not a period: it is the whole answer to "where have I
/// taken a picture", and a photo deleted from it is a claim withdrawn. So a scan
/// sends the library entire and the server replaces what it held — which is also
/// what lets this take over cleanly from the old file-derived import.
///
/// **Which is worth a thought before turning it on beside a phone.** Both send
/// the whole library and the server keeps one answer per device, so a Mac and an
/// iPhone are two devices and two independent replacements. If they see the same
/// iCloud library that is merely redundant; if the Mac holds a decade of camera
/// imports the phone never saw, this is the one that knows about them.
///
/// ## Uploading is not the same decision as looking
///
/// The map's photo overlay reads the same library through ``PhotoBridge``, and
/// it does not consult the switch below. Wanting to see where your photographs
/// were taken and wanting those places to become part of your map are two
/// different questions, and only one of them is asked here.
@MainActor
final class PhotoSync: NSObject, ObservableObject {

    static let shared = PhotoSync()

    /// A rescan is cheap to *read* and not cheap to send, and a library does not
    /// change much in an hour. The observer below is the real trigger.
    private static let gap: TimeInterval = 6 * 3600

    @Published private(set) var scanning = false

    private var lastRun: Date?
    private var observing = false

    private override init() { super.init() }

    var isAuthorized: Bool {
        PhotoLibrary.authorization == .authorized
    }

    /// Whether the answer is "only some of them" — worth saying out loud, because
    /// a limited library is not a smaller map, it is a wrong one, and nothing
    /// else about the screen would tell you.
    var isLimited: Bool {
        PhotoLibrary.authorization == .limited
    }

    var isDenied: Bool {
        let status = PhotoLibrary.authorization
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
    ///
    /// The reading itself is ``PhotoLibrary/located(limit:)``, shared with the
    /// map overlay so that what counts as a geotagged photograph is decided in
    /// one place. What is left here is the wire shape and the order.
    private func geotagged() -> [[Double]] {
        // Sent oldest first: `pointsToCells` reads its input as one timeline, and
        // a stay is a run of fixes in the same cell. The library comes back
        // newest first, which is how the ceiling drops the oldest corner rather
        // than the most recent decade.
        PhotoLibrary.located()
            .sorted { $0.t < $1.t }
            .map { [$0.lat, $0.lng, Double($0.t)] }
    }
}

extension PhotoSync: PHPhotoLibraryChangeObserver {
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in await PhotoSync.shared.scanIfDue() }
    }
}
