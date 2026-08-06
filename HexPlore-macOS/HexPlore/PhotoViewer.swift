import AVKit
import AppKit

/// One photograph, big, and one video, playing — each in a window of its own.
///
/// The card in the web view already shows the picture, scaled to the card, which
/// is the right size for a card and not for looking at. So the same answer as
/// the phone gives: it is shown here rather than sent there, because the only
/// version worth opening properly is one the page would then be holding a second
/// copy of — once as bytes and once as base64.
///
/// ## One window, reused, rather than one per photograph
///
/// This is the one place the Mac deliberately behaves differently from the
/// phone, and it is not a preference. On iOS the viewer is a full-screen modal:
/// the map is *behind* it and cannot be tapped, so "refuse a second tap while
/// the first is in flight" is invisible and right. A window is not modal. The
/// map stays right there, clickable, so the same rule would mean clicking a
/// second photograph and having nothing whatever happen — the app looking
/// broken, in exchange for a guard against a problem a window does not have.
///
/// So the window is a singleton that changes what it is showing. Click another
/// point and this one comes forward with the new picture in it, which is what a
/// Mac app does and what the Finder's own preview does.
///
/// Deliberately small: `QLPreviewController` would give this for free and wants
/// a file URL, which for a `PHAsset` means exporting a copy to disk first —
/// slower, and it leaves the copy behind. A scroll view around an image view is
/// the whole of what this needs.
@MainActor
final class PhotoViewerWindowController: NSWindowController {

    static let shared = PhotoViewerWindowController()

    private let scroll = NSScrollView()
    private let imageView = NSImageView()
    private let spinner = NSProgressIndicator()

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Photo"
        // A photograph is looked at against black, which is also the only
        // framing that never argues with the picture.
        window.backgroundColor = .black
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        // The window outlives every close, because it is reused. Without this
        // the second photograph is sent to a deallocated window and the app
        // stops here.
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("HexPlorePhotoViewer")
        super.init(window: window)
        build(in: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private func build(in window: NSWindow) {
        let content = CancellableView()
        content.onCancel = { [weak self] in self?.close() }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor
        window.contentView = content

        scroll.frame = content.bounds
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        // Pinch on a trackpad, and ⌘+/− , for nothing. Six times is roughly
        // where a screen runs out of photograph, which is the point past which
        // zooming magnifies the compression.
        scroll.allowsMagnification = true
        scroll.minMagnification = 1
        scroll.maxMagnification = 6
        content.addSubview(scroll)

        imageView.frame = scroll.bounds
        imageView.autoresizingMask = [.width, .height]
        // The whole picture, its own shape, on a black field — what Photos does.
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.animates = false
        scroll.documentView = imageView

        let zoom = NSClickGestureRecognizer(target: self, action: #selector(doubleClicked))
        zoom.numberOfClicksRequired = 2
        imageView.addGestureRecognizer(zoom)

        spinner.style = .spinning
        spinner.controlSize = .large
        spinner.isDisplayedWhenStopped = false
        spinner.frame = NSRect(x: content.bounds.midX - 16, y: content.bounds.midY - 16, width: 32, height: 32)
        spinner.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        content.addSubview(spinner)
    }

    /// Bring the window up empty and spinning, before the picture exists.
    ///
    /// Presenting only once the image had arrived meant that clicking a
    /// photograph did nothing at all for as long as the fetch took — seconds,
    /// for an original living in iCloud. Now the window is up immediately, which
    /// reads as the app responding rather than thinking.
    func present() {
        imageView.image = nil
        scroll.magnification = 1
        spinner.startAnimation(nil)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// The picture, whenever it turns up.
    func show(image: NSImage?) {
        spinner.stopAnimation(nil)
        guard let image else {
            // Nothing to show and nothing to explain it with — an empty black
            // window reads as broken, so it closes itself rather than sitting
            // there.
            close()
            return
        }
        imageView.image = image
        window?.title = "Photo"
    }

    /// Double click zooms in, and again to come back.
    @objc private func doubleClicked(_ gesture: NSClickGestureRecognizer) {
        guard imageView.image != nil else { return }
        if scroll.magnification > scroll.minMagnification {
            scroll.animator().magnification = scroll.minMagnification
            return
        }
        let point = gesture.location(in: scroll.contentView)
        scroll.setMagnification(scroll.maxMagnification / 2, centeredAt: point)
    }
}

/// Playing one video, over in a window of its own.
///
/// ## Why the video does not go to the page
///
/// Everything else the overlay shows crosses the bridge as bytes, and for a
/// video that is the wrong shape of answer at every size. A minute of 4K is
/// ~350 MB; base64 makes it 470 MB of JavaScript string. The alternatives are
/// worse than they look:
///
/// - **A `WKURLSchemeHandler`** could stream it properly, range requests and
///   all — and the site's own Content-Security-Policy would refuse to load it,
///   so it would also mean widening `media-src` for the app's benefit.
/// - **A local HTTP server** in the app has the same policy problem plus mixed
///   content, because the page is https and `127.0.0.1` is not.
/// - **Transcoding** to something small enough to inline spends seconds and disk
///   to arrive at a worse copy of a file that is already on the machine.
///
/// So the video is not transferred at all. `AVPlayerView` gets the asset's own
/// player item: full quality, no copy, the system's own controls, scrubbing,
/// AirPlay and picture-in-picture for free, and iCloud originals fetched by
/// Photos itself rather than by us. The page's part is one message; it has no
/// URL for the video and never sees a byte of it.
@MainActor
final class VideoWindowController: NSWindowController, NSWindowDelegate {

    static let shared = VideoWindowController()

    private let playerView = AVPlayerView()

    private init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Video"
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("HexPloreVideoViewer")
        super.init(window: window)
        window.delegate = self

        playerView.frame = window.contentView?.bounds ?? .zero
        playerView.autoresizingMask = [.width, .height]
        playerView.controlsStyle = .inline
        playerView.showsFullScreenToggleButton = true
        playerView.allowsPictureInPicturePlayback = true
        window.contentView = playerView
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func play(item: AVPlayerItem) {
        // A fresh player rather than swapping the item into the old one: a
        // player that has finished sits at the end of its timeline, and reusing
        // it means the next video opens already over.
        playerView.player?.pause()
        let player = AVPlayer(playerItem: item)
        playerView.player = player
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
        player.play()
    }

    /// Closing the window stops the sound. Without this the video goes on
    /// playing to nobody, which is a genuinely startling thing for an app to do.
    func windowWillClose(_ notification: Notification) {
        playerView.player?.pause()
        playerView.player = nil
    }
}

/// A content view that closes its window on Escape.
///
/// ⌘W is free — the window is titled and the app has a Close item — but Escape
/// is how every full-bleed picture on this machine is dismissed, and nothing
/// hands it over.
private final class CancellableView: NSView {
    var onCancel: (() -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
