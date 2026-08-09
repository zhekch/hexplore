// `AVFAudio` explicitly for `AVAudioSession`: this target turns on
// MemberImportVisibility, so a framework reached through another framework's
// re-export does not lend its members.
import AVFAudio
import AVKit
import UIKit

/// Turning the sound on, which is not the same as playing the video.
///
/// A video from the library played silently on every phone, and the reason is
/// that nothing here had ever said what the audio was *for*. An app that never
/// sets a category gets `.soloAmbient`, whose defining property is that the ring
/// switch silences it — which is right for a game's background music and wrong
/// for a thing somebody has just pressed play on. It is not a volume bug and not
/// a Photos bug: the audio was working exactly as declared, and what was
/// declared was "incidental".
///
/// `.playback` is the category for media that *is* the point: it survives the
/// ring switch and it keeps playing when the screen locks. `.moviePlayback` is
/// the mode that comes with it, and it is what routes the sound the way a video
/// player's sound is expected to be routed.
///
/// The session is given back on the way out, and that matters more than it
/// looks: `.playback` is not mixable, so opening one video stops whatever the
/// phone was playing. Deactivating with `.notifyOthersOnDeactivation` is what
/// tells the music app it may carry on — without it the video ends, the player
/// closes, and the album you were listening to simply never comes back.
enum PlaybackAudio {

    /// Claim the session, out loud, for as long as a video is on screen.
    static func begin() {
        let session = AVAudioSession.sharedInstance()
        // `try?` throughout: every one of these can fail on a phone that is on a
        // call or has just been handed to CarPlay, and a video that plays
        // without sound is a far better outcome than one that refuses to open.
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
    }

    /// Hand it back, and let whatever was playing before resume.
    static func end() {
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation
        )
    }
}

/// The system player, with the sound turned on and given back again.
///
/// A subclass for two lines, because the two lines have to happen either side of
/// a presentation this file does not own: `PhotoLibrary.play(id:)` presents it,
/// the user dismisses it by swiping, and there is no callback for that. A view
/// controller does know when it has gone.
final class VideoPlayerController: AVPlayerViewController {

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        PlaybackAudio.begin()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Stopped rather than left paused: a player that is off screen and still
        // holding its item is a video that resumes when picture-in-picture hands
        // it back to a viewer nobody is in any more.
        player?.pause()
        PlaybackAudio.end()
    }
}

/// One photograph, big, in front of the map.
///
/// The card in the web view already shows the picture — scaled to the card,
/// which is the right size for a card and not for looking at. So the same answer
/// as the video next door: it is shown here rather than sent there, because the
/// only version worth going full screen for is one the page would then be
/// holding a second copy of.
///
/// ## Full screen, and still swipe-to-dismiss
///
/// Two goes at this were wrong in opposite directions. `.fullScreen` filled the
/// screen and could not be swiped away, which is how every photograph on this
/// device is closed. A page sheet swiped away and was not full screen: inset at
/// the top, rounded at the corners, with the map showing through them — for a
/// photograph, a frame around a frame.
///
/// So it is full screen *and* it swipes, which is what Photos itself does and is
/// not something the system hands over: `.overFullScreen` keeps the map behind
/// it rather than tearing it out, and `dismissPan` moves the picture with your
/// finger, fades the black as it goes, and either dismisses or springs back on
/// release. A gesture that follows the finger and can be changed of mind about
/// is the whole difference between this and a swipe that is really a button.
///
/// ## It opens before the picture does
///
/// Presenting only once the image had arrived meant that tapping a photograph
/// did nothing at all for as long as the fetch took — seconds, for an original
/// living in iCloud — and then a viewer appeared mid-animation. Now the sheet
/// comes up immediately with a spinner in it and the picture lands when it
/// lands, which is what every other app does and reads as the app responding
/// rather than thinking.
///
/// Deliberately small: `QLPreviewController` would give this for free and wants
/// a file URL, which for a `PHAsset` means exporting a copy to disk first —
/// slower, and it leaves the copy behind. A scroll view around an image view is
/// the whole of what this needs: pinch, double-tap, drag, and a close button.
final class PhotoViewerController: UIViewController {

    private let scroll = UIScrollView()
    private let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let close = UIButton(type: .system)

    init() {
        super.init(nibName: nil, bundle: nil)
        // `.overFullScreen` rather than `.fullScreen`: the difference is that the
        // presenting view — the map — is left in place underneath instead of
        // being removed, which is what lets the black fade to it while the
        // picture is being dragged away. Both are edge to edge.
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

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
        // The drag belongs to the dismiss gesture until the picture is zoomed
        // in; after that it belongs to the picture. Without this the two fight
        // over every downward swipe and neither happens cleanly.
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)

        let drag = UIPanGestureRecognizer(target: self, action: #selector(dismissPan))
        drag.delegate = self
        view.addGestureRecognizer(drag)

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

        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = .white
        close.backgroundColor = UIColor(white: 0, alpha: 0.45)
        close.frame = CGRect(x: 16, y: 16, width: 40, height: 40)
        close.layer.cornerRadius = 20
        close.addTarget(self, action: #selector(dismissSelf), for: .touchUpInside)
        close.autoresizingMask = [.flexibleRightMargin, .flexibleBottomMargin]
        view.addSubview(close)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        close.frame.origin.y = view.safeAreaInsets.top + 12
    }

    /// The picture, whenever it turns up.
    func show(image: UIImage?) {
        spinner.stopAnimating()
        guard let image else {
            // Nothing to show and nothing to explain it with — an empty black
            // sheet reads as broken, so it closes itself rather than sitting
            // there.
            dismiss(animated: true)
            return
        }
        imageView.image = image
    }

    @objc private func dismissSelf() {
        dismiss(animated: true)
    }

    // MARK: - Dragging it away

    /// How far down it has to be thrown to let go of it. Either distance or
    /// speed will do: a slow deliberate drag and a quick flick are both "close
    /// this", and requiring both makes the gesture feel sticky.
    private static let dismissDistance: CGFloat = 120
    private static let dismissSpeed: CGFloat = 900

    @objc private func dismissPan(_ gesture: UIPanGestureRecognizer) {
        let move = gesture.translation(in: view)
        switch gesture.state {
        case .changed:
            // Sideways travel is followed but not resisted — the picture goes
            // where the finger goes, or the gesture feels like it is arguing.
            let down = max(0, move.y)
            scroll.transform = CGAffineTransform(translationX: move.x, y: move.y)
            // Both the black behind and the chrome fade with the distance, so
            // by the time it leaves there is nothing left to animate out.
            let progress = min(1, down / (view.bounds.height * 0.6))
            view.backgroundColor = UIColor(white: 0, alpha: 1 - progress * 0.85)
            close.alpha = 1 - progress * 2
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
                self.scroll.transform = .identity
                self.view.backgroundColor = .black
                self.close.alpha = 1
            }
        default:
            break
        }
    }

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

extension PhotoViewerController: UIGestureRecognizerDelegate {
    /// The drag is only a dismissal while the picture is at rest. Once it is
    /// zoomed in, panning is how you look around it, and taking that away would
    /// make a zoomed photograph impossible to read.
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer else { return true }
        guard scroll.zoomScale <= scroll.minimumZoomScale else { return false }
        // Downwards only, and more down than sideways — otherwise every attempt
        // to flick sideways closes it.
        let move = pan.velocity(in: view)
        return move.y > 0 && abs(move.y) > abs(move.x)
    }
}

extension PhotoViewerController: UIScrollViewDelegate {
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    /// Keep it in the middle while it is smaller than the screen. Without this a
    /// zoomed-out picture sticks to the top-left corner, which looks like a
    /// layout bug rather than a picture.
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        let extraX = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        let extraY = max(0, (scrollView.bounds.height - scrollView.contentSize.height) / 2)
        scrollView.contentInset = UIEdgeInsets(top: extraY, left: extraX, bottom: extraY, right: extraX)
        // Zoomed in, the drag belongs to the picture; zoomed out, it belongs to
        // the sheet's dismiss gesture.
        scrollView.alwaysBounceVertical = scrollView.zoomScale > scrollView.minimumZoomScale
    }
}
