import AVKit
import UIKit

/// The whole group, full screen, swiped through the way the library is.
///
/// A tap on the map is a tap on a *group* — forty pictures of one dinner are one
/// point at every zoom there is, which is the whole reason the card has a strip
/// along the bottom. The viewer used to ignore that and show the single
/// photograph it had been handed, so looking at the forty meant closing it,
/// finding the next 54px thumbnail, and opening it again. Forty times.
///
/// ## There is no system dialog that does this
///
/// It is the obvious thing to want and it does not exist. `PHPickerViewController`
/// is a *picker*: it shows the library so you can choose from it and hands back
/// what you chose, and it cannot be pointed at a subset.
/// `QLPreviewController` genuinely does page through a list of items with the
/// system's own gestures — and it wants file URLs, which for a `PHAsset` means
/// exporting every item in the group to disk first. That is slow, it is several
/// gigabytes for a holiday, and it leaves the copies behind. And nothing public
/// opens Photos.app at a given asset, which is written up at the foot of
/// ``PhotoLibrary``.
///
/// So the gallery is ours, and it is about a hundred lines: a
/// `UIPageViewController` in `.scroll` mode is the paging, and each page is a
/// scroll view around an image — or, for a video, the system player. What the
/// system would have given us for free was never the paging; it was the
/// *fetching*, and that is exactly the part we already had.
///
/// ## Presented, and still swipe-to-dismiss
///
/// Inherited whole from the single-photograph viewer this replaces, because two
/// goes at it were already wrong in opposite directions. `.fullScreen` filled
/// the screen and could not be swiped away, which is how every photograph on
/// this device is closed. A page sheet swiped away and was not full screen:
/// inset at the top, rounded at the corners, with the map showing through them —
/// for a photograph, a frame around a frame.
///
/// So it is full screen *and* it swipes: `.overFullScreen` keeps the map behind
/// it rather than tearing it out, and `dismissPan` moves the pages with your
/// finger, fades the black as it goes, and either dismisses or springs back on
/// release.
///
/// The one thing that had to be added for the gallery is that the dismissal is
/// **downwards only**, and now genuinely has to be: sideways belongs to the
/// paging. `gestureRecognizerShouldBegin` refuses anything that is not more down
/// than across, which leaves the page view's own scroll view to take it.
///
/// ## A video is closed the same way
///
/// It used to be the one page that could not be: the whole gesture was refused
/// while a player was on the page, on the argument that a drag from the bottom
/// of the screen is a scrub. Only the bottom of it is — the transport bar is a
/// pill down there and nothing else in the frame belongs to the player — so the
/// refusal now covers `videoControlsBand` rather than the video, and everything
/// above it closes the gallery the way a photograph does.
///
/// ## Whose close button
///
/// The system player brings its own, and on iOS 26 it brings it to the top
/// left — exactly where this one is, so a video opened in the gallery showed
/// two × buttons of different sizes overlapping, which read as one drawn wrong.
/// There is no way to ask `AVPlayerViewController` for its controls without
/// that button, and no reason to want two, so ours steps aside for the pages
/// that have one and comes back for the pages that do not.
final class PhotoGalleryController: UIViewController {

    /// How far down it has to be thrown to let go of it. Either distance or
    /// speed will do: a slow deliberate drag and a quick flick are both "close
    /// this", and requiring both makes the gesture feel sticky.
    private static let dismissDistance: CGFloat = 120
    private static let dismissSpeed: CGFloat = 900

    /// How much of the bottom of a video belongs to the player rather than to
    /// the gallery, measured up from the bottom edge.
    ///
    /// Enough for the transport pill, the button above it and the gap around
    /// both. Deliberately generous: the cost of it being too big is a strip of
    /// video that has to be dragged from slightly higher up, and the cost of it
    /// being too small is a scrub that closes the gallery — which loses your
    /// place in a group of three hundred.
    static let videoControlsBand: CGFloat = 180

    /// …and the same at the top, below the safe area: the player's close
    /// button, its routing button and its volume control. Read by the page as
    /// well as by the dismissal, so that "where the player's own controls are"
    /// is written down once.
    static let videoChromeBand: CGFloat = 64

    /// The gap between pages, which is a black gutter you only see mid-swipe.
    /// Without it the edge of one photograph touches the edge of the next and
    /// two unrelated pictures read as one.
    private static let pageGap: CGFloat = 24

    private let items: [PhotoLibrary.Located]
    private var at: Int

    private let pager = UIPageViewController(
        transitionStyle: .scroll,
        navigationOrientation: .horizontal,
        options: [.interPageSpacing: PhotoGalleryController.pageGap]
    )
    private let close = UIButton(type: .system)
    private let counter = UILabel()

    init(items: [PhotoLibrary.Located], at: Int) {
        self.items = items
        self.at = min(max(0, at), max(0, items.count - 1))
        super.init(nibName: nil, bundle: nil)
        // `.overFullScreen` rather than `.fullScreen`: the difference is that the
        // presenting view — the map — is left in place underneath instead of
        // being removed, which is what lets the black fade to it while the
        // pictures are being dragged away. Both are edge to edge.
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        addChild(pager)
        pager.view.frame = view.bounds
        pager.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pager.view.backgroundColor = .clear
        pager.dataSource = self
        pager.delegate = self
        view.addSubview(pager.view)
        pager.didMove(toParent: self)
        pager.setViewControllers([page(at: at)], direction: .forward, animated: false)

        let drag = UIPanGestureRecognizer(target: self, action: #selector(dismissPan))
        drag.delegate = self
        view.addGestureRecognizer(drag)

        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = .white
        close.backgroundColor = UIColor(white: 0, alpha: 0.45)
        close.frame = CGRect(x: 16, y: 16, width: 40, height: 40)
        close.layer.cornerRadius = 20
        close.addTarget(self, action: #selector(dismissSelf), for: .touchUpInside)
        close.autoresizingMask = [.flexibleRightMargin, .flexibleBottomMargin]
        view.addSubview(close)

        // "3 of 12", which is the one thing a gallery has to say that a single
        // picture does not: how much of the group is behind and ahead of you.
        // Left out entirely for a group of one, where it would be "1 of 1".
        counter.textAlignment = .center
        counter.font = .systemFont(ofSize: 13, weight: .medium)
        counter.textColor = UIColor(white: 1, alpha: 0.85)
        counter.frame = CGRect(x: 72, y: 16, width: view.bounds.width - 144, height: 40)
        counter.autoresizingMask = [.flexibleWidth, .flexibleBottomMargin]
        counter.isHidden = items.count < 2
        view.addSubview(counter)
        refreshCounter()
        refreshChrome()
    }

    /// Whether the page on screen is a video, which is the whole of what the
    /// gallery's own chrome and its dismiss gesture need to know about it.
    private var onVideo: Bool {
        items.indices.contains(at) && items[at].isVideo
    }

    /// Ours or the player's — see the note at the top. Called wherever `at`
    /// moves, because that is the only thing that changes the answer.
    private func refreshChrome() {
        close.isHidden = onVideo
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        close.frame.origin.y = view.safeAreaInsets.top + 12
        counter.frame.origin.y = close.frame.origin.y
    }

    private func page(at index: Int) -> PhotoPageController {
        PhotoPageController(item: items[index], index: index)
    }

    private func refreshCounter() {
        counter.text = "\(at + 1) of \(items.count)"
    }

    @objc private func dismissSelf() {
        dismiss(animated: true)
    }

    // MARK: - Dragging it away

    @objc private func dismissPan(_ gesture: UIPanGestureRecognizer) {
        let move = gesture.translation(in: view)
        switch gesture.state {
        case .changed:
            // Sideways travel is followed but not resisted — the picture goes
            // where the finger goes, or the gesture feels like it is arguing.
            let down = max(0, move.y)
            pager.view.transform = CGAffineTransform(translationX: move.x, y: move.y)
            // Both the black behind and the chrome fade with the distance, so
            // by the time it leaves there is nothing left to animate out.
            let progress = min(1, down / (view.bounds.height * 0.6))
            view.backgroundColor = UIColor(white: 0, alpha: 1 - progress * 0.85)
            close.alpha = 1 - progress * 2
            counter.alpha = close.alpha
        case .ended, .cancelled:
            let thrown = gesture.velocity(in: view).y > Self.dismissSpeed
            if move.y > Self.dismissDistance || thrown {
                dismiss(animated: true)
                return
            }
            // Changed your mind: back where it was, with a spring, because a
            // linear return reads as a snap and a snap reads as a refusal.
            UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.82,
                           initialSpringVelocity: 0.4) {
                self.pager.view.transform = .identity
                self.view.backgroundColor = .black
                self.close.alpha = 1
                self.counter.alpha = 1
            }
        default:
            break
        }
    }
}

// MARK: - Which page is next

extension PhotoGalleryController: UIPageViewControllerDataSource, UIPageViewControllerDelegate {

    func pageViewController(
        _ controller: UIPageViewController,
        viewControllerBefore viewController: UIViewController
    ) -> UIViewController? {
        guard let page = viewController as? PhotoPageController, page.index > 0 else { return nil }
        return self.page(at: page.index - 1)
    }

    func pageViewController(
        _ controller: UIPageViewController,
        viewControllerAfter viewController: UIViewController
    ) -> UIViewController? {
        guard let page = viewController as? PhotoPageController,
              page.index + 1 < items.count
        else { return nil }
        return self.page(at: page.index + 1)
    }

    /// Where the swipe actually landed.
    ///
    /// Read off the page that is on screen rather than counted, because a swipe
    /// that is begun and abandoned calls none of this with `transitionCompleted`
    /// — and a counter kept by addition would then be one out for the rest of
    /// the session.
    func pageViewController(
        _ controller: UIPageViewController,
        didFinishAnimating finished: Bool,
        previousViewControllers: [UIViewController],
        transitionCompleted completed: Bool
    ) {
        guard completed, let page = controller.viewControllers?.first as? PhotoPageController
        else { return }
        at = page.index
        refreshCounter()
        refreshChrome()
        // A video left playing on a page nobody is looking at is a soundtrack
        // from nowhere. The page that has arrived starts itself; see
        // `viewDidAppear` there.
        for old in previousViewControllers.compactMap({ $0 as? PhotoPageController }) {
            old.pause()
        }
    }
}

extension PhotoGalleryController: UIGestureRecognizerDelegate {
    /// The drag is a dismissal only while it is downwards and the picture is at
    /// rest. Sideways is the paging, and once a photograph is zoomed in, panning
    /// is how you look around it — taking either away would break something you
    /// use more often than you close this.
    ///
    /// On a video the one thing to keep clear of is the player's own transport
    /// bar, where a drag is a scrub. That is a strip along the bottom rather
    /// than the whole page, which is what this used to treat it as.
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer else { return true }
        guard (pager.viewControllers?.first as? PhotoPageController)?.isAtRest ?? true else {
            return false
        }
        if onVideo, pan.location(in: view).y > view.bounds.height - Self.videoControlsBand {
            return false
        }
        let move = pan.velocity(in: view)
        return move.y > 0 && abs(move.y) > abs(move.x)
    }
}

/// One item of the group: a photograph you can zoom, or a video you can play.
///
/// A page rather than a viewer, so it owns none of the chrome — the close
/// button, the counter and the dismissal all belong to the gallery around it,
/// which is the only thing that knows where in the group you are.
///
/// It fetches its **own** picture, when it is created, which for
/// `UIPageViewController` in `.scroll` mode is a moment before it can be seen.
/// The alternative — the gallery fetching the group — is a holiday's worth of
/// full-size images for a tap on one of them.
final class PhotoPageController: UIViewController {

    let index: Int

    private let item: PhotoLibrary.Located
    private let scroll = UIScrollView()
    private let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private var player: VideoPlayerController?

    /// A gesture that does nothing, and is here so that another one does not.
    ///
    /// `AVPlayerViewController` reads a horizontal drag anywhere across the
    /// video as a **scrub**. On a page of a gallery that is the paging gesture,
    /// so swiping towards the next clip seeked the current one instead — and
    /// the further you swiped the further back you went.
    ///
    /// There is no property that turns that off on its own. `requiresLinearPlayback`
    /// would, and takes the scrubber and the skip buttons with it, which is a
    /// worse trade than the bug. What there *is* is the recognition graph: this
    /// pan is attached to the player's own view, begins only on a sideways drag
    /// across the video itself, and declares — through
    /// `shouldBeRequiredToFailBy` — that every recognizer inside the player must
    /// wait for it. So on a sideways drag the player's own gestures never begin,
    /// and on everything else this one fails immediately and they behave exactly
    /// as they did.
    ///
    /// It claims nothing else: the paging scroll view and the gallery's own
    /// dismissal are not the player's, so they are not asked to wait, and it
    /// recognises alongside them.
    private var seekBlock: UIPanGestureRecognizer?

    /// Whether a downward drag on this page means "close the gallery".
    ///
    /// No, once a photograph is zoomed in — the drag is how you look around it.
    /// A video has nothing to zoom and so is always at rest: where its own
    /// controls are is the gallery's question, and it answers it by position
    /// rather than by refusing the page outright (see `videoControlsBand`).
    var isAtRest: Bool {
        scroll.zoomScale <= scroll.minimumZoomScale
    }

    init(item: PhotoLibrary.Located, index: Int) {
        self.item = item
        self.index = index
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        scroll.frame = view.bounds
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.delegate = self
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.minimumZoomScale = 1
        // Six times is roughly where a phone screen runs out of photograph,
        // which is the point past which zooming magnifies the compression.
        scroll.maximumZoomScale = 6
        scroll.contentInsetAdjustmentBehavior = .never
        // The drag belongs to the gallery's dismissal until the picture is
        // zoomed in; after that it belongs to the picture. Without this the two
        // fight over every downward swipe and neither happens cleanly.
        scroll.alwaysBounceVertical = false
        // Off for a video: the player fills this page instead, and a scroll view
        // over the system's controls eats the taps meant for them.
        scroll.isHidden = item.isVideo
        view.addSubview(scroll)

        imageView.frame = scroll.bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The whole picture, its own shape, on a black field — what Photos does,
        // and the only framing that never crops.
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        scroll.addSubview(imageView)

        let zoom = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        zoom.numberOfTapsRequired = 2
        imageView.addGestureRecognizer(zoom)

        spinner.color = .white
        spinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        spinner.autoresizingMask = [.flexibleTopMargin, .flexibleBottomMargin,
                                    .flexibleLeftMargin, .flexibleRightMargin]
        spinner.startAnimating()
        view.addSubview(spinner)

        Task { await load() }
    }

    /// The picture, or the player, whenever it turns up.
    ///
    /// Both can take seconds — an original that lives in iCloud is the common
    /// case for anything more than a few months old, and Photos does the
    /// fetching. Which is why the page exists before its content does: a swipe
    /// that lands on a blank screen is a swipe that has visibly worked, and a
    /// swipe that does nothing until the bytes arrive is one you make twice.
    private func load() async {
        if item.isVideo {
            guard let playerItem = await PhotoLibrary.playerItem(id: item.id) else {
                return failed()
            }
            spinner.stopAnimating()
            let controller = VideoPlayerController()
            controller.player = AVPlayer(playerItem: playerItem)
            addChild(controller)
            controller.view.frame = view.bounds
            controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            controller.view.backgroundColor = .clear
            view.insertSubview(controller.view, belowSubview: spinner)
            controller.didMove(toParent: self)
            player = controller
            // See `seekBlock`. Added to the player's view rather than to this
            // one, because what it has to outrank is the player's own gestures
            // and a recognizer only outranks the ones it shares a touch with.
            let block = UIPanGestureRecognizer(target: self, action: #selector(swallowSeek))
            block.delegate = self
            // The touches still reach the player. Only its *recognizers* are
            // held back, and a tap on the video should go on showing and hiding
            // the controls the way it always has.
            block.cancelsTouchesInView = false
            controller.view.addGestureRecognizer(block)
            seekBlock = block
            // Only if this is the page being looked at: the fetch can outlive
            // the swipe that started it, in either direction.
            if onScreen { controller.player?.play() }
            return
        }

        let image = await PhotoLibrary.fullImage(id: item.id)
        spinner.stopAnimating()
        guard let image else { return failed() }
        imageView.image = image
    }

    /// Whether this page is the one being looked at.
    ///
    /// **Not `view.window != nil`**, which was the first answer and is wrong
    /// here: `UIPageViewController` in `.scroll` mode puts the neighbouring
    /// pages into its own scroll view ahead of the swipe that reaches them, so
    /// they have a window while being entirely off screen — and a video that
    /// starts on one of those is a soundtrack from nowhere. The appearance
    /// callbacks are the only thing that means "on screen", so they are what
    /// this is.
    private var onScreen = false

    /// Nothing to show and nothing to explain it with.
    ///
    /// The single-photograph viewer closed itself here, which was right when the
    /// viewer *was* the photograph. In a gallery it is not: closing the whole
    /// group because one of forty could not be fetched throws away the other
    /// thirty-nine. So the page says so and stays, and the swipe past it works.
    private func failed() {
        spinner.stopAnimating()
        let label = UILabel()
        label.text = item.isVideo
            ? "This video could not be played."
            : "This one is still in iCloud and could not be fetched just now."
        label.textColor = UIColor(white: 1, alpha: 0.7)
        label.font = .systemFont(ofSize: 15)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.frame = view.bounds.insetBy(dx: 32, dy: 0)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onScreen = true
        player?.player?.play()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        onScreen = false
        player?.player?.pause()
    }

    /// Stop, for a page that has been swiped away from.
    ///
    /// Belt and braces beside `viewDidDisappear` above, which is the one that
    /// usually does it. A swipe begun and abandoned moves a page on and off
    /// screen without either of them ever being the *current* page, and the two
    /// sequences are not identical on every version of UIKit — a video left
    /// playing to nobody is worse than a redundant pause.
    func pause() {
        player?.player?.pause()
    }

    /// The gesture that exists to be recognised and not to act. See `seekBlock`.
    @objc private func swallowSeek(_ gesture: UIPanGestureRecognizer) {}

    /// Double tap zooms in where you tapped, and again to come back.
    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        guard imageView.image != nil else { return }
        if scroll.zoomScale > scroll.minimumZoomScale {
            scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
            return
        }
        let point = gesture.location(in: imageView)
        let scale = scroll.maximumZoomScale / 2
        let size = CGSize(width: scroll.bounds.width / scale, height: scroll.bounds.height / scale)
        scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                               width: size.width, height: size.height), animated: true)
    }
}

extension PhotoPageController: UIGestureRecognizerDelegate {

    /// Only across the video, and only sideways.
    ///
    /// The two bands are where the player's own controls are (see
    /// `videoControlsBand` and `videoChromeBand`), and a drag that starts on the
    /// scrubber is a scrub — that is the one horizontal drag on this page that
    /// really is the player's. Everywhere else the picture is the whole screen
    /// and sideways means the next clip.
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer, pan === seekBlock else { return true }
        let y = pan.location(in: view).y
        guard y > view.safeAreaInsets.top + PhotoGalleryController.videoChromeBand,
              y < view.bounds.height - PhotoGalleryController.videoControlsBand
        else { return false }
        let move = pan.velocity(in: view)
        return abs(move.x) > abs(move.y)
    }

    /// Everything inside the player waits for it — and nothing outside does.
    func gestureRecognizer(
        _ gesture: UIGestureRecognizer,
        shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool {
        guard gesture === seekBlock, let playerView = player?.view else { return false }
        return other.view?.isDescendant(of: playerView) ?? false
    }

    /// …and it shares with everything else, or claiming the drag away from the
    /// player would take it away from the paging as well, which is the thing
    /// this exists to let happen.
    func gestureRecognizer(
        _ gesture: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        gesture === seekBlock
    }
}

extension PhotoPageController: UIScrollViewDelegate {
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    /// Keep it in the middle while it is smaller than the screen. Without this a
    /// zoomed-out picture sticks to the top-left corner, which looks like a
    /// layout bug rather than a picture.
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        let extraX = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        let extraY = max(0, (scrollView.bounds.height - scrollView.contentSize.height) / 2)
        scrollView.contentInset = UIEdgeInsets(top: extraY, left: extraX, bottom: extraY, right: extraX)
        // Zoomed in, the drag belongs to the picture; zoomed out, it belongs to
        // the gallery's dismiss gesture.
        scrollView.alwaysBounceVertical = scrollView.zoomScale > scrollView.minimumZoomScale
    }
}
