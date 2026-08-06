import UIKit

/// One photograph, big, in front of the map.
///
/// The card in the web view already shows the picture — scaled to the card,
/// which is the right size for a card and not for looking at. So the same answer
/// as the video next door: it is shown here rather than sent there, because the
/// only version worth going full screen for is one the page would then be
/// holding a second copy of.
///
/// ## Presented as a sheet, on purpose
///
/// It was `.fullScreen` first, and that was wrong for one reason worth more than
/// the extra few points of screen: a sheet can be **swiped down to dismiss**,
/// which is how every photograph on the phone is closed, and which the video
/// player beside it already gives. `.automatic` is a page sheet on iPhone, so
/// this is the system's gesture rather than an imitation of it, and the map is
/// visible behind — you can see where you are while you look.
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
        // `.automatic`, which is a page sheet here — see the note above. Set
        // explicitly so that reading this file tells you what it is.
        modalPresentationStyle = .automatic
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
        // Or the sheet's own dismiss gesture and the scroll view fight over
        // every downward drag, and the picture jitters instead of either
        // happening. The scroll view only wants the drag once it is zoomed in.
        scroll.alwaysBounceVertical = false
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
