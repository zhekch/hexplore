import CoreLocation
import Foundation
import WebKit

/// Where the page's "my location" button gets its position, on a Mac.
///
/// ## Why the browser's own geolocation is not used
///
/// It does not work here, and that was measured rather than assumed. In a
/// `WKWebView` on macOS the page is a secure context, WebKit *does* ask the app
/// for permission — `requestGeolocationPermissionFor` is called, and granted —
/// and then no position ever arrives. `getCurrentPosition` fires neither
/// callback, which is why the map's locate button span for ever instead of
/// failing: MapLibre waits on a promise that is never settled, and a spinner
/// with no timeout is what "nothing came back" looks like.
///
/// **And below macOS 27 it cannot work at all**, whatever WebKit does with the
/// position: `webView:requestGeolocationPermissionForOrigin:…` is
/// `API_AVAILABLE(macos(27.0))`, so on the macOS 14 this app supports there is
/// no way for a web view to be granted the permission in the first place. A fix
/// that depended on WebKit would work on one OS version out of fourteen.
///
/// So the position comes from here. The app already has CoreLocation, already
/// has the entitlement, and already asks for the authorization — everything the
/// page needed was on this side of the bridge the whole time.
///
/// ## The page is not asked to cooperate
///
/// Unlike ``PhotoBridge`` and ``SaveBridge``, which the web app knows about and
/// calls deliberately, nothing in `src/` knows this exists. A user script
/// replaces `navigator.geolocation` with a shim backed by this handler before
/// the first line of the page runs, so MapLibre's control — and anything else
/// asking the standard question — gets a standard answer. That keeps the site
/// free of a special case for one host, which is the same bargain the rest of
/// this app strikes.
///
/// The iPhone app needs none of this: iOS WebKit delivers positions perfectly
/// well, which is why the same page works there untouched.
@MainActor
final class LocationBridge: NSObject, WKScriptMessageHandlerWithReply, CLLocationManagerDelegate {

    /// The name the shim posts to. Both halves are in this file, so this name
    /// does not have to agree with anything in `src/`.
    static let name = "hexploreLocation"

    static let shared = LocationBridge()

    /// A fix this old is still worth answering with while a fresh one is found.
    /// The page asks for its own `maximumAge`; this is the ceiling on it.
    private static let staleAfter: TimeInterval = 120

    /// How long to wait for CoreLocation before admitting nothing is coming. A
    /// Mac positions itself from wifi, which is usually immediate and is not
    /// always — and the one failure this whole file exists to remove is a wait
    /// with no end.
    private static let timeout: TimeInterval = 15

    private let manager = CLLocationManager()
    /// Everyone waiting on the fix currently being fetched. One request at a
    /// time: `requestLocation()` is one-shot, and a second call while the first
    /// is in flight cancels it.
    private var waiting: [(Any?, String?) -> Void] = []
    private var last: CLLocation?
    private var timeoutTask: Task<Void, Never>?

    private override init() {
        super.init()
        manager.delegate = self
        // Better than the logger's hundred metres. A blob is 900 m across and a
        // fix that coarse is fine for *recording* where you were; this is the
        // dot saying where you are now, which someone is looking at against a
        // street.
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    // MARK: - The page asking

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["ask"] as? String {
        case "once":
            break

        case "state":
            // Asked by the introduction, which wants to know whether this has
            // already been granted *without* raising a prompt to find out.
            //
            // `navigator.permissions.query({name: "geolocation"})` cannot
            // answer that here. It reports on the WebKit permission, and this
            // host does not use the WebKit permission — the whole file exists
            // because that road does not work — so the page was told "prompt"
            // by a browser with no idea that CoreLocation had said yes long
            // ago, and the replay offered to ask for something it already had.
            replyHandler(["ok": true, "state": Self.wire(manager.authorizationStatus)], nil)
            return

        default:
            replyHandler(["ok": false, "error": "unavailable", "message": "unknown request"], nil)
            return
        }

        // `maximumAge` in milliseconds, as the web API states it. A control
        // watching your position asks repeatedly, and answering a five-second
        // -old question with a five-second-old fix is both correct and free.
        let maxAge = min(Self.staleAfter, ((body["maximumAge"] as? Double) ?? 0) / 1000)
        if let last, -last.timestamp.timeIntervalSinceNow <= maxAge {
            replyHandler(Self.wire(last), nil)
            return
        }

        switch manager.authorizationStatus {
        case .notDetermined:
            // Raise the prompt, and say so plainly rather than leaving the page
            // waiting on an answer that depends on a dialog.
            LocationLogger.shared.requestAuthorizationIfNeeded()
            replyHandler([
                "ok": false, "error": "denied",
                "message": "HexPlore has not been given permission to use your location yet.",
            ], nil)
            return
        case .denied, .restricted:
            replyHandler([
                "ok": false, "error": "denied",
                "message": "Location is turned off for HexPlore. Settings ▸ Location says where to turn it on.",
            ], nil)
            return
        default:
            break
        }

        waiting.append(replyHandler)
        guard waiting.count == 1 else { return } // one already in flight
        manager.requestLocation()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.timeout))
            guard let self, !Task.isCancelled else { return }
            self.deliver([
                "ok": false, "error": "timeout",
                "message": "No position came back in time.",
            ])
        }
    }

    // MARK: - CoreLocation answering

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        last = fix
        deliver(Self.wire(fix))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Unlike the logger's, this one reports `locationUnknown` too: somebody
        // is watching a spinner, and "could not work out where you are" is the
        // answer they are waiting for.
        deliver(["ok": false, "error": "unavailable", "message": error.localizedDescription])
    }

    /// Answer everyone waiting, once, and stop the clock.
    private func deliver(_ payload: [String: Any]) {
        timeoutTask?.cancel()
        timeoutTask = nil
        let all = waiting
        waiting = []
        for reply in all { reply(payload, nil) }
    }

    /// An authorization status, in the Permissions API's three words.
    ///
    /// The page already has code that reads `"granted"`, `"denied"` and
    /// `"prompt"` — that is what `navigator.permissions` speaks — so answering
    /// in the same vocabulary means the one caller that needs this needs no
    /// special case for the Mac beyond having asked here in the first place.
    private static func wire(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .denied, .restricted: return "denied"
        default: return "granted"
        }
    }

    /// A `CLLocation` in the shape `GeolocationPosition` wants.
    private static func wire(_ l: CLLocation) -> [String: Any] {
        var out: [String: Any] = [
            "ok": true,
            "lat": l.coordinate.latitude,
            "lng": l.coordinate.longitude,
            // The web API's `accuracy` is a radius in metres and may not be
            // null; CoreLocation gives -1 for "no idea", which is not a radius.
            "accuracy": l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : 1000,
            // Milliseconds, because `GeolocationPosition.timestamp` is.
            "t": l.timestamp.timeIntervalSince1970 * 1000,
        ]
        // Every one of these is optional in the API and negative here when
        // CoreLocation has nothing to say, so an absent key is the honest
        // translation of an invalid reading rather than a made-up zero.
        if l.verticalAccuracy >= 0 {
            out["altitude"] = l.altitude
            out["altitudeAccuracy"] = l.verticalAccuracy
        }
        if l.course >= 0 { out["heading"] = l.course }
        if l.speed >= 0 { out["speed"] = l.speed }
        return out
    }

    // MARK: - The half that runs in the page

    /// Replaces `navigator.geolocation` before the page's first line runs.
    ///
    /// A shim rather than a patch to the site, because the site is right as it
    /// stands: it asks the standard question, and it is this host that cannot
    /// answer it. Installed at document start so MapLibre reads the replacement
    /// rather than the original — `GeolocateControl` captures nothing early,
    /// but anything that did would otherwise capture the broken one.
    ///
    /// `watchPosition` is a poll rather than a subscription. The alternative is
    /// pushing updates from native into the page, which needs a second channel
    /// and a lifetime to manage; a Mac is not moving between fixes often enough
    /// for the difference to be visible, and `maximumAge` above makes a repeat
    /// ask nearly free.
    static let userScript = """
    (function () {
      var host = window.webkit
        && window.webkit.messageHandlers
        && window.webkit.messageHandlers.\(name);
      if (!host) return;

      function position(r) {
        return {
          coords: {
            latitude: r.lat,
            longitude: r.lng,
            accuracy: r.accuracy,
            altitude: 'altitude' in r ? r.altitude : null,
            altitudeAccuracy: 'altitudeAccuracy' in r ? r.altitudeAccuracy : null,
            heading: 'heading' in r ? r.heading : null,
            speed: 'speed' in r ? r.speed : null
          },
          timestamp: r.t
        };
      }

      function failure(r) {
        var code = r && r.error === 'denied' ? 1 : r && r.error === 'timeout' ? 3 : 2;
        return {
          code: code,
          message: (r && r.message) || 'Location is unavailable.',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3
        };
      }

      function once(ok, bad, options) {
        var maximumAge = options && options.maximumAge ? options.maximumAge : 0;
        host.postMessage({ ask: 'once', maximumAge: maximumAge }).then(
          function (r) {
            if (r && r.ok) { if (ok) ok(position(r)); }
            else if (bad) bad(failure(r));
          },
          function (e) { if (bad) bad(failure({ message: String(e) })); }
        );
      }

      var nextId = 1;
      var timers = {};

      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        enumerable: true,
        value: {
          getCurrentPosition: function (ok, bad, options) { once(ok, bad, options); },
          watchPosition: function (ok, bad, options) {
            var id = nextId++;
            once(ok, bad, options);
            // Its own `maximumAge` if it gave one, so a watcher that wants
            // fresh readings gets them and one that does not is answered from
            // the last fix.
            timers[id] = setInterval(function () { once(ok, bad, options); }, 5000);
            return id;
          },
          clearWatch: function (id) {
            clearInterval(timers[id]);
            delete timers[id];
          }
        }
      });
    })();
    """
}
