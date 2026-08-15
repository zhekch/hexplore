# HexPlore for macOS

**The Mac hosts the web app rather than replacing it.** The window is the site
itself, unmodified — its map, its menu, its import dialogs, its sync connectors,
its login. Settings (⌘,) is the little this app knows that the site does not:
which server to open, what this Mac records about where it has been, and how to
forget both.

It is a port of [HexPlore for iOS](../HexPlore-IOS/README.md), and deliberately
the same program: the same web view, the same borrowed session, the same
uploader, the same photo bridge. This file is about the places where a Mac is
not a phone, because those are the only places the two differ and the rest is
already written down next door.

[ARCHITECTURE.md](../ARCHITECTURE.md) at the repo root is the reference for *why*
anything works the way it does.

---

## What is different from the phone, and why

Four things, and only the first is a feature decision.

| | |
| --- | --- |
| **No Apple Health** | HealthKit does not exist on macOS. There is no framework to link and no store to read, so the section is *absent* rather than present and disabled |
| **Location is off by default** | It is off on the phone too, but here it stays off for a second reason — see below |
| **Settings is a window, not a tab** | ⌘, is where a Mac keeps settings. The phone's two tabs are what a phone has |
| **One gallery window, reused** | The phone's gallery is a full-screen modal; a window is not modal, so a second click has to do something |
| **"My location" is served by the app** | WebKit here grants the permission and then never delivers a position — see below |

### The map's own locate button, and why the app has to answer it

On the phone this needs nothing: iOS WebKit asks the app for permission and then
delivers positions, so the site's locate button works untouched. **On macOS it
does not**, and the failure is silent in the worst way — the button spins for
ever rather than failing, because `getCurrentPosition` fires *neither* callback
and MapLibre is left waiting on a promise nothing ever settles.

Measured in a `WKWebView` on macOS 27, against an https origin, with location
authorised: WebKit **does** call
`webView(_:requestGeolocationPermissionFor:initiatedByFrame:decisionHandler:)`,
the app grants it, and then the page times out with no position. Granting is not
the problem; there is simply nothing behind it.

**And below macOS 27 the question cannot even be asked.** That delegate method
is `API_AVAILABLE(macos(27.0))`, so on the macOS 14 this app supports there is
no way for a web view to be granted geolocation at all. Anything resting on
WebKit would have worked on one OS version out of fourteen.

So `LocationBridge` answers instead. The app already had CoreLocation, the
entitlement and the authorisation — everything the page needed was on this side
the whole time. A user script replaces `navigator.geolocation` with a shim
backed by a message handler before the page's first line runs, so MapLibre asks
the standard question and gets a standard answer.

Two things worth knowing about it. **Nothing in `src/` knows it exists** — unlike
the photo and save bridges, which the web app calls deliberately, this one is
invisible to the site, which keeps the site free of a special case for one host.
And **`watchPosition` is a poll**, once every five seconds, rather than a
subscription pushed from native: a Mac does not move between fixes often enough
for the difference to show, and the shim's `maximumAge` handling makes a repeat
ask nearly free.

### There is no beam, because there is no compass

The site draws a cone out of the blue dot showing which way you are facing. It
comes from a magnetometer, a Mac does not have one, and that is the whole of the
story — `src/heading.js` takes a heading only from a reading that says it is
absolute, so on this window nothing is drawn and nothing is missing.

Worth stating rather than leaving to be discovered, because there is a delegate
method next door that looks like the answer and is not: WebKit's
`requestDeviceOrientationAndMotionPermission…`, which the iPhone app implements,
is `API_UNAVAILABLE(macos)`. There is no permission to grant here and nothing
behind it if there were. This is the one difference on the list that costs
nothing to work around, because there is no workaround to want.

### Apple Health is gone, and the workouts are not

The iPhone app's third section reads workouts that carry an `HKWorkoutRoute`.
There is no HealthKit on macOS, so that section, `HealthSync.swift`, the
`/api/device/workouts` and `/api/device/health/reset` calls and the two HealthKit
entitlements are all simply not here.

**Workouts still reach your map.** From the phone, which has Health; and from
Strava and Komoot on the site's own sync screen, which this window reaches like
any other client. Nothing about the map's data is lost by this app not existing
on the platform that cannot do it.

### Location is off by default, and worth understanding before turning it on

Off is the default on the phone as well — nothing is recorded until you pick how
often. Here it stays off for a reason the phone does not have:

**A Mac records only while HexPlore is running.** macOS does not relaunch an app
for a location event and does not wake a sleeping machine to take a fix, so
there is no equivalent of the phone's "swiped away and still logging". The
significant-change monitor is still used — it is the cheapest cadence and it is
what *Only when I go somewhere* means — but on iOS its real job is relaunching a
terminated app, and here it cannot do that.

So: **quit HexPlore and nothing is recorded**; close the window and it keeps
going, which is why the app stays in the Dock with no windows open. A closed lid
is asleep, and asleep is not anywhere.

That makes this genuinely useful on a laptop you travel with and close to
pointless on a desktop that never moves — a machine that has not left the room
would file the same cell every minute for years. Hence off, and hence a switch
you turn on deliberately.

**One line from the iPhone app is deliberately not ported.**
`allowsBackgroundLocationUpdates = true` is what keeps the phone's logger alive
through a suspend. CoreLocation's own header says: *"Setting this property to YES
when UIBackgroundModes does not include location is a fatal error."* There is no
`UIBackgroundModes` on macOS to include it in, so copying that line would crash
the app the moment tracking was switched on. `LocationLogger.apply()` says so at
the point where the temptation is.

**And macOS has one location grant, not two.**
`kCLAuthorizationStatusAuthorizedWhenInUse` is `API_UNAVAILABLE(macos)` — naming
it will not compile. So there is no when-in-use step to ask for first, no
escalation prompt to follow it with, and no "Set to While Using the App" warning
to show: `requestAlwaysAuthorization()` is the whole question.

### Settings is a window

Same sections, same order, minus Health. `Settings { }` in `HexPloreApp.swift`,
which is what puts it behind ⌘, and in the app menu where every other Mac app
keeps it.

### One gallery window, reused

On iOS the gallery is a full-screen modal: the map is behind it and cannot be
tapped, so the phone's "refuse a second tap while the first is in flight" guard
is invisible and correct. A window is not modal — the map stays right there,
clickable — so the same rule would mean clicking a second photograph and having
*nothing happen*.

So `PhotoGalleryWindowController` is a singleton that changes what it is showing,
which is also what makes a gallery cheap here: paging *is* changing what it is
showing, and it was already doing that. Clicking a point opens the whole group —
← and → walk it, so does a two-finger swipe, and the title bar says "Photo 3 of
12" because a Mac says that sort of thing in the title bar.

It opens **as big as the screen allows**, which is the other thing a Mac has
that a phone does not: room. It used to be 980 × 700 wherever it was put, which
is most of a laptop screen and a postage stamp on a desk display — a photograph
drawn at a third of the size of the screen being used to look at it, with black
on every side. It takes the whole of `visibleFrame` now (`screenShare`, 1.0),
floored at the old size for a screen too small to take a share of.

`visibleFrame` is the screen less the menu bar and the Dock, so this is still a
window with the system visible around it rather than full screen: no separate
Space, no menu bar sliding away, and ⌘` still gets you back to the map behind
it. The frame is set as a *frame* and not as a content rect — the title bar
belongs to the window, and a content rect the height of the screen makes a
window taller than the screen it opens on — and centred in `visibleFrame`
rather than by `center()`, which measures against the whole screen and at this
size puts half a title bar under the menu bar.

Whatever size you then choose is remembered as before. The autosave name is
versioned with the sizing policy (`HexPlorePhotoViewerFull`), because a saved
frame beats the one a window was just given: without retiring the old name, a
new default would apply to nobody who had ever opened the window before.

Stills and videos share the window rather than having one each, which they used
to. Two windows made one group into two galleries: press → past the last
photograph before a clip and the window you were in had nothing to say. Now the
content swaps — a scroll view around an image, or an `AVPlayerView` — and the
same → moves between them. There is no `AVAudioSession` here and none is wanted:
that is the phone's problem, a ring switch that silences anything an app has not
declared to be the point.

## Everything else is the same, on purpose

- **The web view is the app.** Same `WKWebView`, same persistent
  `websiteDataStore` — so the session survives a quit, and so does the service
  worker's registration and its Cache Storage, which is the whole of how offline
  works here with no Swift written for it.
- **Signing in happens in the web view**, and the uploader borrows that session
  by copying the site's cookies into `HTTPCookieStorage` after every page load.
  There is no native login and there should not be one.
- **The photo bridge is unchanged.** `PhotoBridge` answers the same four
  questions on the same `hexplorePhotos` channel, indices are still stamped with
  a scan number, and `localIdentifier`s still never cross to the page. The
  page's test for the app is the presence of the message handler, not a
  user-agent string — which is why the same `src/photos.js` finds a library here
  without being told which platform it is talking to.
- **Fixes go to disk before they go anywhere**, in `FixQueue`, and leave only on
  a 200.
- **Saving an exported picture is native, and has to be.** `a.download` — the
  one line every browser saves the export with — does nothing whatever in a
  `WKWebView`: the anchor is created, clicked and ignored, with no file and no
  error, so both apps used to say "Saved …" and save nothing. `SaveBridge`
  answers the same kind of message `PhotoBridge` does; the page detects it by
  the handler's presence and falls back to the anchor in a browser. This app
  writes to **Downloads**, where the browser it stands in for would have; the
  iPhone app saves to the **photo library**, because a phone has no filesystem
  anybody looks at.

### One thing it does *not* claim to be

The User-Agent tag is **`HexploreMac`**, deliberately not the phone's
`HexploreiOS`. `server/index.js` keys a layout on that string (`IOS_CLIENT`) —
the button cluster clearing a tab bar, the attribution moving out from under a
status bar. A window has neither, so this app wants the ordinary desktop page,
and the way to ask for it is to not claim to be a phone.

It is still sent, on the User-Agent and as `X-Hexplore-Client`, so a server log
can tell this app's traffic from a browser's and from the phone's.

**There is no safe-area push either**, and for the same kind of reason: the
window has a title bar, so the web view starts below it and the `env(…, 0px)`
defaults in `src/style.css` are already right. That is also why the title bar is
not hidden for a full-bleed map — `.hud` sits 20 px from the top left, which is
exactly where the traffic lights would be.

## A known wart: cells arrive labelled `iphone`

If you turn location logging on, the cells this Mac contributes are filed under
the source **`iphone`** — `DEVICE_SOURCE` in `server/index.js` is a constant, and
`/api/device/fixes` is shared with the phone.

Nothing is broken by it: the *device list* is right, because that is keyed on the
device id and carries this machine's name and `platform: "macOS 27.0"`. It is
only the source label on the cells, and only in the sources list and the "colour
by type" legend.

It was left alone on purpose rather than missed. Fixing it means teaching the
shared server endpoint to pick a source from the platform and adding a label in
`src/locations.js` — a change to the code path the **phone's** logger runs
through, for a cosmetic label on a switch that is off by default. Worth doing
deliberately, with a `SERVER_VERSION` bump, rather than as a side effect of
adding a Mac app.

Photos are unaffected: they land as `apple-photos`, which is as true of a Mac as
of a phone.

## Running it

Open `HexPlore.xcodeproj`, ⌘R. There is nothing to fetch — no Swift package
dependencies, no MapLibre, nothing to resolve — so the first build is seconds
rather than minutes.

From a terminal:

```sh
xcodebuild -project HexPlore-macOS/HexPlore.xcodeproj -scheme HexPlore \
  -derivedDataPath ~/Library/Caches/HexPloreMac-build build
```

The scheme is **shared and checked in**, so that command works from a fresh
clone without opening Xcode first — which is the one place this project
deliberately differs in shape from the iOS one.

Two things this machine needs, both inherited from the iOS project's notes:

- **`DEVELOPER_DIR`** — `xcode-select` here points at the Command Line Tools
  rather than at Xcode, so `xcodebuild` is not found. Either
  `export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` for one
  command, or `sudo xcode-select -s /Applications/Xcode-beta.app` properly.
- **A derived-data path outside `~/Documents`** — the repo sits in a synced
  folder, the sync attaches extended attributes to everything, and codesigning
  refuses to touch a file carrying them (*"resource fork, Finder information, or
  similar detritus not allowed"*).

### Deployment target

**macOS 14.0, and every feature works at 14.0** — including the locate button,
which is the whole reason `LocationBridge` exists rather than a dependency on
the macOS 27 permission API.

Verified rather than declared, and in two ways. The built binary reports
`minos 14.0` and the shipped `Info.plist` says `LSMinimumSystemVersion 14.0`; and
the build itself is the guarantee that nothing newer is called unguarded, since
Swift's availability checking and `CLANG_WARN_UNGUARDED_AVAILABILITY =
YES_AGGRESSIVE` make an unprotected call to a later API a build failure rather
than a crash on somebody's older Mac. The one macOS 27 API left in the source —
`requestGeolocationPermissionFor` — is `@available`-guarded and is now belt to
the bridge's braces rather than the mechanism.

14.0 is what `SettingsLink` and the single-`Window` scene want; going lower would
buy a fallback path for each in exchange for supporting a Mac that cannot run the
current OS anyway.

It is set in one place: `MACOSX_DEPLOYMENT_TARGET` in the project, in both Debug
and Release.

### Signing and the sandbox

The app is **sandboxed** with the hardened runtime on, which the iPhone app does
not have to ask for because iOS gives it no choice. `HexPlore.entitlements` asks
for exactly four things: the sandbox itself, `network.client` (outbound only —
nothing listens), the photo library, and location.

The practical consequence: `FixQueue` writes into
`~/Library/Containers/com.zhekch.HexPlore/`, not the shared Application Support.
Deleting that container is "Clean cache" plus forgetting anything recorded and
not yet sent.

`DEVELOPMENT_TEAM` is set to the same team as the iOS project, so ⌘R works as-is
on this machine. Change `PRODUCT_BUNDLE_IDENTIFIER` if the identifier is ever
taken.

### The one genuinely surprising thing

Like the iOS project, this uses **file-system synchronized groups** — **a
`.swift` file dropped into `HexPlore-macOS/HexPlore/` is part of the app
automatically**. No "add to target" step, no dialog, no chance of the old failure
where a file exists on disk, appears in the sidebar, and is silently not
compiled.

## Layout

```
HexPlore-macOS/
  HexPlore.xcodeproj        the project you open (with a shared scheme)
  Info.plist                the keys that cannot be build settings
  HexPlore.entitlements     sandbox, network, photos, location
  HexPlore/                 the app itself — anything here is compiled, automatically
    HexPloreApp.swift       the entry point, the Settings scene, the quit hook
    ContentView.swift       the window: the web app, or "no server yet"
    WebPanel.swift          the web view that is the window
    SettingsView.swift      the app's own settings
    AppSettings.swift       the server address, and signing out
    TrackingSettings.swift  how often to record, and this Mac's identity
    LocationLogger.swift    CoreLocation, and what a Mac cannot promise
    PhotoLibrary.swift      reading the photo library — the only file that does
    PhotoSync.swift         sending where the photographs were taken
    PhotoBridge.swift       answering the map when it asks for the photographs
    PhotoViewer.swift       the gallery window — photographs and videos
    ServerCheck.swift       is that address a Hexplore server, and is it up
    LocationBridge.swift    the position the page's locate button cannot get
    SaveBridge.swift        writing an exported picture to Downloads
    FixQueue.swift          what has been recorded but not yet accepted
    SyncClient.swift        the uploads, and the session they borrow
```

**There is no `HexploreCore`.** The iOS project keeps that package — the hex
lattice, the blob curve and a Metal blur — and its own README explains that the
app does not link it and it is kept because it is cheap to keep. Copying an
unused package into a second project would be the part of that bargain with none
of the reason. It is one `swift test` away in `HexPlore-IOS/`, and it is
platform-independent, so nothing is lost by not duplicating it here.

## Tests

There are none in this project, and that is the same position the iOS app is in:
the app target is a web view and a handful of settings, and the maths that is
worth testing lives in `HexploreCore` next door and is tested there.

```sh
HexPlore-IOS/Tools/test-core.sh     # 34 tests, on this Mac, about a second
npm test                            # the server and the web app, at the repo root
```
