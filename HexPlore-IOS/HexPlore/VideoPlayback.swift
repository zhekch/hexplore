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
///
/// ## It is counted, because two players can overlap
///
/// A gallery of clips has more than one player alive at a time: swiping from one
/// video to the next builds the incoming page before the outgoing one is torn
/// down, and UIKit's appearance callbacks arrive in that order — the new page's
/// `viewWillAppear` before the old page's `viewDidDisappear`. A plain
/// begin/end pair would therefore *deactivate the session under a video that
/// had just started*, which is the original silent-video bug wearing a
/// different hat and only on the second clip.
///
/// So it is a count, and the session is only handed back when the last player
/// has gone.
@MainActor
enum PlaybackAudio {

    private static var players = 0

    /// Claim the session, out loud, for as long as a video is on screen.
    static func begin() {
        players += 1
        guard players == 1 else { return }
        let session = AVAudioSession.sharedInstance()
        // `try?` throughout: every one of these can fail on a phone that is on a
        // call or has just been handed to CarPlay, and a video that plays
        // without sound is a far better outcome than one that refuses to open.
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
    }

    /// Hand it back, and let whatever was playing before resume.
    static func end() {
        players = max(0, players - 1)
        guard players == 0 else { return }
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation
        )
    }
}

/// The system player, with the sound turned on and given back again.
///
/// A subclass for four lines, because they have to happen either side of an
/// appearance this file does not own. It is added as a child of a page of
/// ``PhotoGalleryController``, and it goes away when that page is swiped past or
/// the gallery is closed — neither of which is a callback anybody hands over. A
/// view controller does know when it has appeared and when it has gone.
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
