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
| **One photo window, reused** | The phone's viewer is a full-screen modal; a window is not modal, so a second click has to do something |

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

### One photo window, reused

On iOS the viewer is a full-screen modal: the map is behind it and cannot be
tapped, so the phone's "refuse a second tap while the first is in flight" guard
is invisible and correct. A window is not modal — the map stays right there,
clickable — so the same rule would mean clicking a second photograph and having
*nothing happen*.

So `PhotoViewerWindowController` is a singleton that changes what it is showing.
Click another point and the window comes forward with the new picture in it.
Same for video and `VideoWindowController`.

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

**macOS 14.0.** Verified rather than declared — the built binary reports
`minos 14.0` and the shipped `Info.plist` says `LSMinimumSystemVersion 14.0`.

Nothing here wants anything newer except `requestGeolocationPermissionFor`,
which is macOS 27 and is `@available`-guarded. 14.0 is what `SettingsLink` and
the single-`Window` scene want, and going lower would buy a fallback path for
each in exchange for supporting a Mac that cannot run the current OS anyway.

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
    PhotoViewer.swift       the photo window and the video window
    ServerCheck.swift       is that address a Hexplore server, and is it up
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
