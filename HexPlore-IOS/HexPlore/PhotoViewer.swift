import UIKit

/// One photograph, full screen, at its own size.
///
/// The card in the web view already shows the picture — scaled to the card,
/// which is the right size for a card and not for looking at. Full screen is
/// worth doing for the original, and the original is several megabytes that the
/// page would then be holding a second copy of, in base64, having already been
/// handed one. So the same answer as the video next door: it is shown here
/// rather than sent there.
///
/// Deliberately small. `QLPreviewController` would give this for free and wants
/// a file URL, which for a `PHAsset` means exporting a copy to disk first —
/// slower, and it leaves the copy behind. A scroll view around an image view is
/// the whole of what this needs: pinch to zoom, double-tap, drag to pan, and a
/// close button.
final class PhotoViewerController: UIViewController {

    private let image: UIImage
    private let scroll = UIScrollView()
    private let imageView = UIImageView()

    init(image: UIImage) {
        self.image = image
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
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
        // Six times is roughly where a 12-megapixel photograph runs out of
        // pixels on a phone screen, which is the point past which zooming is
        // magnifying the compression rather than the picture.
        scroll.maximumZoomScale = 6
        scroll.contentInsetAdjustmentBehavior = .never
        view.addSubview(scroll)

        imageView.image = image
        imageView.frame = scroll.bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The whole picture, its own shape, on a black field — the same thing
        // Photos does, and the only framing that never crops.
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        scroll.addSubview(imageView)

        let zoom = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        zoom.numberOfTapsRequired = 2
        imageView.addGestureRecognizer(zoom)

        addCloseButton()
    }

    /// The way out. A gesture alone would not do: this is presented over a web
    /// view, and there is no navigation bar to inherit a back button from.
    private func addCloseButton() {
        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = .white
        close.backgroundColor = UIColor(white: 0, alpha: 0.45)
        close.frame = CGRect(x: 16, y: view.safeAreaInsets.top + 12, width: 40, height: 40)
        close.layer.cornerRadius = 20
        close.addTarget(self, action: #selector(dismissSelf), for: .touchUpInside)
        // Pinned by hand rather than by constraints, because it is one button and
        // this file is deliberately not a layout.
        close.autoresizingMask = [.flexibleRightMargin, .flexibleBottomMargin]
        view.addSubview(close)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // The close button is placed before the insets are known — a full-screen
        // presentation reports them afterwards — so it is put right here.
        view.subviews.compactMap { $0 as? UIButton }.first?.frame.origin.y = view.safeAreaInsets.top + 12
    }

    @objc private func dismissSelf() {
        dismiss(animated: true)
    }

    /// Double tap zooms in where you tapped, and again to come back — the
    /// gesture everyone already has for this.
    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
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
    }
}
