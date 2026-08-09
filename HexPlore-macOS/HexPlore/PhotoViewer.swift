import AVKit
import AppKit

/// The whole group, in one window, walked with the arrow keys.
///
/// A click on the map is a click on a *group* — forty pictures of one dinner are
/// one point at every zoom there is, which is why the card has a strip along its
/// bottom. The window used to show the single item it had been handed, so
/// looking at the forty meant closing it, finding the next thumbnail and opening
/// it again. Forty times.
///
/// ## There is no system dialog that does this
///
/// It is the obvious thing to want and it does not exist on either platform.
/// `PHPickerViewController` is a *picker*: it shows the library so you can
/// choose from it, and cannot be pointed at a subset. Quick Look genuinely does
/// page through a list with the system's own gestures — and wants file URLs,
/// which for a `PHAsset` means exporting every item in the group to disk first:
/// slow, several gigabytes for a holiday, and it leaves the copies behind. And
/// nothing public opens Photos.app at a given asset, which is written up at the
/// foot of ``PhotoLibrary``.
///
/// What the system would have given us was never the paging; it was the
/// *fetching*, and that is the part we already had.
///
/// ## One window, reused, rather than one per photograph
///
/// This is where the Mac deliberately behaves differently from the phone, and it
/// is not a preference. On iOS the gallery is a full-screen modal: the map is
/// *behind* it and cannot be tapped, so "refuse a second tap while the first is
/// in flight" is invisible and right. A window is not modal. The map stays right
/// there, clickable, so the same rule would mean clicking a second group and
/// having nothing whatever happen.
///
/// So the window is a singleton that changes what it is showing, which is also
/// what makes a gallery cheap here: paging *is* changing what it is showing, and
/// it was already doing that.
///
/// ## Stills and videos in the same window
///
/// They used to have one each, which made the group two galleries — press → past
/// the last photograph before a clip and the window you were in had nothing to
/// say. Now the content swaps: a scroll view around an image view for a
/// photograph, an `AVPlayerView` for a video, and the same → moves between them.
/// A video is not transferred to the page for any of this — see
/// [the note below](#Why-the-video-does-not-go-to-the-page).
@MainActor
final class PhotoGalleryWindowController: NSWindowController, NSWindowDelegate {

    static let shared = PhotoGalleryWindowController()

    /// How much of the screen a photograph opens on.
    ///
    /// It used to be 980 × 700 wherever it was opened, which on a laptop is most
    /// of the screen and on anything bigger is a postage stamp in the middle of
    /// it — the picture drawn at a third of the size of the display it is being
    /// looked at on, with black on every side. A photograph is the whole point
    /// of this window and there is nothing else in it to make room for.
    ///
    /// All of it, then. `visibleFrame` is the screen less the menu bar and the
    /// Dock, so "all of it" is still a window you can see the edges of the
    /// system around, and still not full screen — no separate Space, no menu
    /// bar sliding away, and ⌘` still gets you back to the map behind it.
    private static let screenShare: CGFloat = 1.0

    /// The smallest it will open at, for a screen too small to take a share of.
    private static let leastSize = NSSize(width: 980, height: 700)

    private let scroll = PagingScrollView()
    private let imageView = NSImageView()
    private let playerView = AVPlayerView()
    private let spinner = NSProgressIndicator()

    private var items: [PhotoLibrary.Located] = []
    private var at = 0
    /// Which showing this is. Checked on the far side of every fetch: a picture
    /// that arrives after you have pressed → twice belongs to a window that has
    /// moved on, and putting it up would be the wrong photograph.
    private var showing = 0

    private init() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.leastSize),
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
        // Set as a *frame* rather than as the content rect it was created with:
        // the title bar belongs to the window, so a content rect the height of
        // the screen makes a window taller than the screen it opens on. And
        // centred here rather than by `center()`, which measures against the
        // whole screen — at this size that is half a title bar under the menu
        // bar. `visibleFrame` is the screen less the menu bar and the Dock, so
        // its own middle is the only middle that means anything.
        //
        // No screen at all is a Mac with the lid shut and an external display
        // asleep. It keeps the size it was created with.
        if let room = NSScreen.main?.visibleFrame {
            let size = NSSize(
                width: max(Self.leastSize.width, room.width * Self.screenShare),
                height: max(Self.leastSize.height, room.height * Self.screenShare)
            )
            window.setFrame(
                NSRect(
                    x: room.midX - size.width / 2,
                    y: room.midY - size.height / 2,
                    width: size.width,
                    height: size.height
                ),
                display: false
            )
        }
        // The name is versioned with the sizing policy above, and that is the
        // whole of the policy ever taking effect: a saved frame beats the one a
        // window was just given, so every machine that has opened this window
        // before would go on opening it at whatever the old default left behind.
        // Retiring the name retires that memory. Whatever size is chosen from
        // here is remembered under this one as usual.
        window.setFrameAutosaveName("HexPlorePhotoViewerFull")
        super.init(window: window)
        window.delegate = self
        build(in: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    private func build(in window: NSWindow) {
        let content = GalleryView()
        content.onCancel = { [weak self] in self?.close() }
        content.onStep = { [weak self] step in self?.step(step) }
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

        playerView.frame = content.bounds
        playerView.autoresizingMask = [.width, .height]
        playerView.controlsStyle = .inline
        playerView.showsFullScreenToggleButton = true
        playerView.allowsPictureInPicturePlayback = true
        playerView.isHidden = true
        content.addSubview(playerView)

        spinner.style = .spinning
        spinner.controlSize = .large
        spinner.isDisplayedWhenStopped = false
        spinner.frame = NSRect(x: content.bounds.midX - 16, y: content.bounds.midY - 16, width: 32, height: 32)
        spinner.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        content.addSubview(spinner)
    }

    /// Bring the window up on one of a group, before its content exists.
    func present(items: [PhotoLibrary.Located], at index: Int) {
        self.items = items
        at = min(max(0, index), max(0, items.count - 1))
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        // The content view is what the arrow keys and the swipe arrive at, and a
        // window whose first responder is somewhere else answers neither.
        window?.makeFirstResponder(window?.contentView)
        NSApp.activate()
        show()
    }

    /// One step along the group, from a key or a swipe. Silent at the ends
    /// rather than wrapping: a gallery that loops has no ends, and then the
    /// count in the title is the only way to know where you are.
    private func step(_ by: Int) {
        let next = at + by
        guard items.indices.contains(next) else { return }
        at = next
        show()
    }

    /// Whatever is at `at` — a picture, or a player.
    private func show() {
        let mine = showing + 1
        showing = mine
        guard items.indices.contains(at) else { return }
        let item = items[at]

        // A fresh player rather than swapping the item into the old one: a
        // player that has finished sits at the end of its timeline, and reusing
        // it means the next video opens already over.
        playerView.player?.pause()
        playerView.player = nil
        playerView.isHidden = true
        imageView.image = nil
        scroll.magnification = 1
        scroll.isHidden = item.isVideo
        spinner.startAnimation(nil)
        retitle()

        Task {
            if item.isVideo {
                let playerItem = await PhotoLibrary.playerItem(id: item.id)
                guard mine == showing else { return }
                spinner.stopAnimation(nil)
                guard let playerItem else { return failed() }
                playerView.isHidden = false
                let player = AVPlayer(playerItem: playerItem)
                playerView.player = player
                player.play()
                return
            }
            let image = await PhotoLibrary.fullImage(id: item.id)
            guard mine == showing else { return }
            spinner.stopAnimation(nil)
            guard let image else { return failed() }
            imageView.image = image
        }
    }

    /// "Photo", or "Photo 3 of 12" — the one thing a gallery has to say that a
    /// single picture does not, and the title bar is where a Mac says it.
    private func retitle() {
        let what = items.indices.contains(at) && items[at].isVideo ? "Video" : "Photo"
        window?.title = items.count < 2 ? what : "\(what) \(at + 1) of \(items.count)"
    }

    /// Nothing to show and nothing to explain it with.
    ///
    /// The single-photograph window closed itself here, which was right when the
    /// window *was* the photograph. In a gallery it is not: closing the whole
    /// group because one of forty could not be fetched throws away the other
    /// thirty-nine. So the title says so and the arrows still work.
    private func failed() {
        window?.title = items.indices.contains(at) && items[at].isVideo
            ? "This video could not be played"
            : "Still in iCloud — could not be fetched just now"
    }

    /// Closing the window stops the sound. Without this the video goes on
    /// playing to nobody, which is a genuinely startling thing for an app to do.
    func windowWillClose(_ notification: Notification) {
        showing += 1
        playerView.player?.pause()
        playerView.player = nil
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

// MARK: - Why the video does not go to the page
//
// Everything else the overlay shows crosses the bridge as bytes, and for a video
// that is the wrong shape of answer at every size. A minute of 4K is ~350 MB;
// base64 makes it 470 MB of JavaScript string. The alternatives are worse than
// they look:
//
// - **A `WKURLSchemeHandler`** could stream it properly, range requests and all
//   — and the site's own Content-Security-Policy would refuse to load it, so it
//   would also mean widening `media-src` for the app's benefit.
// - **A local HTTP server** in the app has the same policy problem plus mixed
//   content, because the page is https and `127.0.0.1` is not.
// - **Transcoding** to something small enough to inline spends seconds and disk
//   to arrive at a worse copy of a file that is already on the machine.
//
// So the video is not transferred at all. `AVPlayerView` gets the asset's own
// player item: full quality, no copy, the system's own controls, scrubbing,
// AirPlay and picture-in-picture for free, and iCloud originals fetched by
// Photos itself rather than by us. The page's part is one message; it has no URL
// for the video and never sees a byte of it.
//
// There is no `AVAudioSession` here and none is wanted. That is the phone's
// problem — a ring switch that silences anything declared "incidental", which is
// what an app that sets no category gets. A Mac has no such switch and no such
// default, so a video plays with its sound the moment it is given one.

/// A scroll view that gives a sideways swipe back.
///
/// Without this the swipe below would work everywhere in the window except over
/// the photograph, which is all of it. An `NSScrollView` handles `scrollWheel`
/// whether or not it has anything to scroll — and at natural size it has
/// nothing, so the gesture was being swallowed by a view with no use for it.
/// Zoomed in it keeps them: then a sideways scroll is how you look at the right
/// hand side of the picture.
private final class PagingScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        guard magnification <= minMagnification,
              abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
        else { return super.scrollWheel(with: event) }
        // The superview, which is the gallery's content view.
        nextResponder?.scrollWheel(with: event)
    }
}

/// The content view: Escape closes it, and the arrows walk the group.
///
/// ⌘W is free — the window is titled and the app has a Close item — but Escape
/// is how every full-bleed picture on this machine is dismissed, and nothing
/// hands it over. Nor does anything hand over ← and →, which is how every
/// gallery on this machine is walked.
private final class GalleryView: NSView {
    var onCancel: (() -> Void)?
    var onStep: ((Int) -> Void)?

    /// How much sideways scrolling counts as one step, in points. A trackpad
    /// reports a swipe as a stream of small deltas, so this accumulates rather
    /// than testing each one — and resets on a change of direction, or a long
    /// slow drag would step twice on the way back.
    private static let swipeStep: CGFloat = 60
    private var swiped: CGFloat = 0

    /// Whether this gesture has already been spent on a photograph.
    ///
    /// One swipe is one picture. Accumulating alone is not that: a firm flick
    /// arrives as a burst of deltas and then a second of *momentum*, and both
    /// keep clearing `swipeStep`, so a group scrolled on past a dozen
    /// photographs for as long as the coasting lasted. What is wanted is the
    /// thing every gallery on this machine does — one gesture, one step.
    private var spent = false

    override var acceptsFirstResponder: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func keyDown(with event: NSEvent) {
        // The arrow keys arrive as key codes rather than characters, and these
        // two are the only ones this view has an opinion about.
        switch event.keyCode {
        case 123: onStep?(-1) // ←
        case 124: onStep?(1) // →
        default: super.keyDown(with: event)
        }
    }

    override func scrollWheel(with event: NSEvent) {
        let dx = event.scrollingDeltaX
        // Sideways only, and only when it is plainly sideways: a two-finger
        // scroll down a tall photograph drifts left and right, and a gallery
        // that changes picture because of that is unusable.
        guard abs(dx) > abs(event.scrollingDeltaY) else {
            swiped = 0
            return super.scrollWheel(with: event)
        }
        // Coasting after the fingers have gone. It is the same photograph's
        // swipe still arriving, and it has already been answered. AppKit saying
        // so is the whole reason this is exact here and a heuristic on the web,
        // where a wheel event will not say which part of a gesture it is.
        guard event.momentumPhase.isEmpty else { return }
        // A new gesture, whatever the last one did.
        if event.phase.contains(.began) {
            swiped = 0
            spent = false
        }
        guard !spent else { return }
        if (dx > 0) != (swiped > 0) { swiped = 0 }
        swiped += dx
        guard abs(swiped) >= Self.swipeStep else { return }
        // Natural scrolling: pushing the content left brings in what is to the
        // right of it, which is the next one.
        onStep?(swiped > 0 ? -1 : 1)
        swiped = 0
        // Spent for the rest of *this* gesture — but only if there is one. A
        // wheel with detents reports no phase at all, and each notch of it is
        // already a separate deliberate movement: locking on the first would
        // mean a mouse could turn one page and never another.
        spent = !event.phase.isEmpty
    }
}
