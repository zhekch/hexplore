# HexPlore for iOS

**The phone hosts the web app rather than replacing it.** The Map tab is the
site itself, unmodified — its map, its menu, its import dialogs, its sync
connectors, its login. The Settings tab is the little this app knows that the
site does not: which server to open, how this phone records where it has been,
and how to forget both.

That second one is the reason to install this rather than add the site to your
home screen. Everything else here a browser could do; **recording your location
with the screen off is the one thing a web app categorically cannot**, and
[Recording where you have been](#recording-where-you-have-been) is what it took.

That is a deliberate reversal. An earlier version of this drew the map natively
with MapLibre and fetched cells itself, and it was a great deal of machinery to
arrive back where the browser already was — a second implementation of the same
screen, able to disagree with the first. What survives from it is
[HexploreCore](#the-core-package), which is worth keeping for a reason that has
nothing to do with drawing maps.

The web app is the product; this is a way to carry it.
[ARCHITECTURE.md](../ARCHITECTURE.md) at the repo root is the reference for *why*
anything works the way it does.

---

## If you have never opened Xcode

Six words that mean something specific, and knowing them makes the rest of the
window make sense.

| | |
| --- | --- |
| **Project** (`HexPlore.xcodeproj`) | The bundle you open. It is a directory, not a file, and everything below lives inside it |
| **Target** | A thing that gets built. This project has one: the `HexPlore` app |
| **Scheme** | A saved answer to "build what, how, and then do what" — the dropdown at the top of the window |
| **Destination** | What it runs on: a simulator, or your own iPhone. The other half of that dropdown |
| **DerivedData** | Where build products go. Never in the repo, always safe to delete — deleting it is the standard first move when Xcode starts lying to you |
| **Package** | A dependency. This project has two, and they arrive differently — see below |

**⌘R** runs, **⌘B** builds, **⌘.** stops, **⌘⇧K** cleans.

## Running it

### In the simulator

Open `HexPlore.xcodeproj`, pick any iPhone in the dropdown at the top, press
**⌘R**. The first build fetches MapLibre (~25 MB) and takes a few minutes; after
that it is seconds. Nothing needs signing and there is no Apple Developer
account involved.

From a terminal, the same thing:

```sh
xcodebuild -project HexPlore/HexPlore.xcodeproj -scheme HexPlore \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

### On your own iPhone

Three one-time steps, and the second is the one nobody guesses:

1. **Set a team.** Select the project in the sidebar → the `HexPlore` target →
   **Signing & Capabilities** → **Team**. Add your Apple ID if it is not listed.
   The project ships with no team set, because a team is personal and does not
   belong in a repo.
2. **Turn on Developer Mode on the phone.** iOS 16 and later hide it until you
   have tried to install something: **Settings → Privacy & Security → Developer
   Mode**, on, and the phone restarts.
3. **Trust yourself.** After the first install, **Settings → General → VPN &
   Device Management** → your Apple ID → Trust. Until you do, the app is on the
   home screen and refuses to open.

Plug the phone in, pick it in the destination dropdown, ⌘R.

**With a free Apple ID** the app expires after **seven days** and you re-run ⌘R
to renew it; a paid Developer account makes it a year. If signing complains that
the bundle identifier is taken, change `PRODUCT_BUNDLE_IDENTIFIER` — it must be
unique across everyone using free provisioning.

Worth knowing: **"my location" needs HTTPS**, and so does anything that talks to
the server, so a phone build wants the map served over `tailscale serve` rather
than plain `http://` on the LAN.

## Deployment target

**iOS 16.0.** Verified rather than declared — the built binary reports
`minos 16.0` and the shipped `Info.plist` says `MinimumOSVersion 16.0`.

Nothing in the app wants anything newer. MapLibre itself supports iOS 12; the
Metal and Metal Performance Shaders calls the blob renderer makes have been
available since iOS 10. Xcode 27 will not accept a target below 15.0, so 16 is
close to the floor the toolchain allows anyway.

If you ever need to move it, it is set in two places that must agree:
`IPHONEOS_DEPLOYMENT_TARGET` in the project (both Debug and Release), and
`platforms:` in `HexploreCore/Package.swift`.

### The one genuinely surprising thing

This project uses **file-system synchronized groups**, which is new and is not
how Xcode worked for its first twenty years. It means **a `.swift` file dropped
into `HexPlore/HexPlore/` is part of the app automatically** — no "add to
target" step, no dialog, no chance of the old failure where a file exists on
disk, appears in the sidebar, and is silently not compiled.

The practical consequence: you can create Swift files from a terminal or an
editor and Xcode simply has them.

## Layout

```
HexPlore/
  HexPlore.xcodeproj        the project you open
  Info.plist                one key that cannot be a build setting — see below
  HexPlore.entitlements     reading Apple Health, and being woken for it
  HexPlore/                 the app itself — anything here is compiled, automatically
    HexPloreApp.swift       the entry point (@main), and the background-launch hook
    ContentView.swift       the two tabs
    WebPanel.swift          the web view that is the Map tab
    SettingsView.swift      the app's own settings
    AppSettings.swift       the server address, and signing out
    TrackingSettings.swift  how often to record, and this phone's identity
    LocationLogger.swift    CoreLocation, with the screen off
    HealthSync.swift        workouts that carry a route
    PhotoLibrary.swift      reading the photo library — the only file that does
    PhotoSync.swift         sending where the photographs were taken
    PhotoBridge.swift       answering the map when it asks for the photographs
    FixQueue.swift          what has been recorded but not yet accepted
    SyncClient.swift        the uploads, and the session they borrow
  HexploreCore/             a local Swift package: the maths, with tests
    Sources/HexploreCore/
      HexGrid.swift         the hex lattice — a port of src/hexgrid.js
      CellGeometry.swift    reading cell ids, hexagon corners, zoom → level
      BlobShaping.swift     the blob tuning and the alpha cut curve
      Blob/                 the Metal blur pipeline
    Tests/                  including the generated fixtures
  Tools/
    gen-hex-vectors.mjs     regenerates the hex fixtures from the JavaScript
    gen-blob-vectors.mjs    regenerates the blob fixtures from the JavaScript
    test-core.sh            runs the package tests
```

Five files are the web view and its settings. The rest are the logger and the
photo library, and they are the whole of what a browser could not have done.

## The core package

`HexploreCore` is **not used by the app**, and is kept anyway.

It holds the hex lattice ported from `src/hexgrid.js` and verified against
vectors generated by running that JavaScript, the blob shaping curve checked
against the real `alphaLut`, and a working Metal blur pipeline — 34 tests, all
passing, none of them needing a simulator.

**The reason given here used to be the background logger, and that turned out to
be wrong.** The argument was that a logger has to turn fixes into cells and would
therefore need the lattice and the id format the server keys on. The logger now
exists and needs neither, because it sends **fixes** and the server folds them —
the same `pointsToCells()` that reads an imported GPX, the same `mergeRow` that
takes in a Home Assistant poll.

That is not a detail, it is the same rule as
[Derived on the server, once](../ARCHITECTURE.md#derived-on-the-server-once): a
second implementation of what counts as a visit would not fail loudly when it
disagreed with the first, it would produce a phone and a laptop that quietly
believe different things about the same afternoon. Folding on the device would
have bought a slightly smaller payload and cost the one definition.

So the honest position is that the package is finished, correct, tested work for
a native map nobody currently wants — and the case for keeping it is now only
that it is cheap to keep and expensive to rewrite. If it is ever genuinely dead,
`git rm -r HexPlore/HexploreCore` and drop the local package reference.

### The app target no longer links it

"Not used by the app" used to be true of the *source* and false of the *build*:
the app target linked the package, so building the app built the package, and
building the package compiled `Blob/BlobShaders.metal`. Xcode 26 moved the Metal
compiler out of the base install into a separately downloaded component, so from
that release onwards a plain `xcodebuild` of the app failed — on a shader that no
line of the app executes, for a renderer nothing calls.

The link bought nothing to weigh against that. No file in `HexPlore/` imports
`HexploreCore`; the link was the last trace of the native map. So the product
dependency is gone from the target and the app builds with no Metal in the graph
at all.

**The package itself has not moved.** The local package reference is still in the
project, so Xcode still shows it, and `Tools/test-core.sh` is untouched — all 34
tests still run in about a second on the Mac, the GPU ones included, because
`swift test` compiles the shader for macOS quite happily. It is only the
iOS-destination build that wanted the component. Whenever the native renderer is
wanted, add the product back to the target and run
`xcodebuild -downloadComponent MetalToolchain` once.

## Dependencies

**None that the app links.** `HexploreCore` is in the project, by relative path,
and the app target does not depend on it — see
[The app target no longer links it](#the-app-target-no-longer-links-it).

There is no MapLibre. An earlier version linked
`maplibre-gl-native-distribution` to draw the map natively; when the map became
the web view, a map renderer the app never calls was several megabytes of binary
and a dependency to keep pinned, for nothing. It was removed rather than left in
place. The web view's map is MapLibre GL JS, served from your own machine like
the rest of the site.

## Running the tests

34 tests, four suites, and three ways to run them.

```sh
HexPlore/Tools/test-core.sh          # on this Mac — about a second
HexPlore/Tools/test-core.sh --ios    # on the iOS Simulator — about a minute
```

The Mac run is the one to use while working: no simulator to boot, no signing,
no Xcode. The `--ios` run is the one that proves the code works where it is
going to run — the same 34 tests, with the GPU ones exercising the simulator's
Metal stack rather than the Mac's. Both are expected to pass; if only one fails,
that difference is the interesting part.

**In Xcode, open the package, not the project.** `File → Open →
`HexPlore/HexploreCore/Package.swift`` gives you the test navigator, inline
results and ⌘U. Pressing ⌘U on `HexPlore.xcodeproj` does nothing useful and says
so — a package dependency's test targets are not built by the app's scheme, and
wiring them in by hand does not work either ("no test bundles available to
test"). That is the tooling being consistent rather than a gap to paper over:
the app target has no tests of its own, and the core's tests do not want a
simulator.

Two environment workarounds are baked into the script because this machine needs
both:

- **`DEVELOPER_DIR`** — `xcode-select` here points at the Command Line Tools
  rather than at Xcode, so `swift test` cannot find an iOS toolchain. The script
  overrides it for one command. To fix it properly instead:
  `sudo xcode-select -s /Applications/Xcode-beta.app`
- **A scratch path outside `~/Documents`** — the repo sits in a synced folder,
  the sync attaches extended attributes to everything, and codesigning refuses
  to touch a file carrying them (*"resource fork, Finder information, or similar
  detritus not allowed"*). Build products go to `~/Library/Caches` instead.

There is a third requirement the script cannot work around. From Xcode 26 the
**Metal toolchain is a separate download**, and `HexploreCore` now contains a
`.metal` file, so the package will not build without it:

```sh
xcodebuild -downloadComponent MetalToolchain
```

The symptom if it is missing is *"cannot execute tool 'metal' due to missing
Metal Toolchain"*, and SwiftPM reports it as a failure to read a `.dia` file,
which is not a clue. It is a one-time install.

### What the tests actually assert

Not much is hand-written, and that is the point.

A cell id is a key the server **already holds rows under**. A port that is one
column out at some latitude does not draw a slightly wrong map — it fails to find
the map at all. So the expectations are not numbers anyone typed: the two
generators in `Tools/` run the JavaScript that wrote the database and emit its
answers as Swift fixtures. The port is correct exactly insofar as it reproduces
them.

Re-run the generators after touching `src/hexgrid.js` or the blob constants:

```sh
node HexPlore/Tools/gen-hex-vectors.mjs
node HexPlore/Tools/gen-blob-vectors.mjs
```

**One real difference between the two languages**, and it is invisible until it
bites: `Math.round` rounds a half toward +∞ — `Math.round(-2.5)` is `-2` — where
Swift's `.rounded()` rounds a half away from zero and gives `-3`. They disagree
only exactly on a cell boundary, which is precisely where a map gets clicked.
`HexGrid.jsRound` reproduces the JavaScript and has a test of its own.

## How the two tabs divide the work

**Map** is the web app. All of it, unmodified — the map, the menu, editing, the
import dialogs, the sync connectors, statistics, backups, and its own login.
Nothing is injected and nothing is hidden, which is the point: a bug here is a
bug there, and a fix there is a fix here.

**Settings** is the little this app knows that the site does not — which server
to open, how this phone records where it has been, and how to forget both.
Everything else about your *map* stays on the Map tab, where a laptop finds it in
the same place. Duplicating any of it natively would mean two screens that have
to agree.

The tracking settings look like they belong on the Map tab with the other sync
connectors, and they would, except that **a schedule stored on the server could
not wake a sleeping phone**. The timer runs here or it does not run. What the
server does keep is the result: Sync → *Your phone* on a laptop lists this
handset, what it has sent and when it last spoke.

### The server knows which client asked

The web view appends `HexploreiOS` to its User-Agent, and `server/index.js`
serves `index.html` with `data-client="ios"` on the `<html>` tag when it sees it
(`IOS_CLIENT`, `indexForClient`). The rewritten copy is cached like the original
and carries its own etag suffix, so a browser and the app can never be handed
each other's.

Doing it on the server rather than in a script is what makes the layout right on
the **first paint**. A class added after the page boots means watching the
buttons jump.

It marks a viewport, not an account: nothing about the data differs. What it
buys is the handful of rules at the end of `src/style.css` — the button cluster
clearing the tab bar, and the attribution moving out from under the status bar.

**Neither side derives anything that needs a gazetteer.** Trips and coverage are
worked out once by the server (`server/derive.js`) and both clients render what
they are given, so a phone and a laptop cannot disagree about them — see "Derived
on the server, once" in ARCHITECTURE.md. What stays client-side is the arithmetic
that needs no dataset (which days have anything on them, what happened on one),
over the same server-derived trips.

### Edge to edge, without losing the buttons

The map runs under the status bar and under the tab bar, which is how a map
should look. The site's own buttons — geolocate, menu, pencil — stack in the
bottom-right corner on a phone, so drawing over that corner would bury them.

They stay put because the app **hands the page its own geometry**:
`WebViewController.pushSafeArea()` sets `--safe-t/r/b/l` on the root element from
`view.safeAreaInsets`, and every viewport-anchored rule in `src/style.css` adds
them.

**`env(safe-area-inset-*)` does not work here, and it took measuring to find
out.** With the map drawn edge to edge the controller's
`view.safeAreaInsets.bottom` is a correct **83** — tab bar plus home indicator —
and the scroll view adjusts by the same 83, and the page still read
`env(safe-area-inset-bottom)` as `0px`. Every button stayed in the corner it was
meant to move out of, `viewport-fit=cover` was present, and nothing on the Swift
side looked wrong. A `#if DEBUG` readback in `didFinish` prints what the page
actually ends up with; it is there because reasoning about this was wrong twice.

The CSS still *defaults* these variables to `env()`, which is what a real
browser uses. So the same rules give mobile Safari its notch and home-indicator
handling — which it never had — and the app simply overrides them with numbers
it can measure.

Measured after the change: `--safe-b` is `83px` and the button cluster's computed
`bottom` is `105px`, clear of the tab bar.

**The tab bar is pinned to dark.** The site is dark — its login card, its menu,
three of its four basemaps — and a tab bar that followed the system into light
mode put a white strip under all of it, which read as a bar belonging to some
other app.

### Location, for the page's own button

Separate from the logger below, and worth keeping separate: this is only about
the blue dot the *web app* draws. The page's "my location" button needs two
things the page cannot arrange for itself.

**Permission**, which only the app can ask for: `NSLocationWhenInUseUsageDescription`
in `Info.plist`, and a `requestWhenInUseAuthorization()` the first time the map
is on screen. It is asked then rather than when the button is pressed because
before iOS 27 a web view has no way to tell the app it wants a position — and a
permission still undetermined at the moment of the press is a button that does
nothing. On iOS 27 and later `requestGeolocationPermissionFor` is also
implemented, and grants without a second dialog: your own map asking, on a
server you run, having already been through the system prompt once.

**A secure context**, which is not negotiable and not ours to grant.
`navigator.geolocation` is refused outright over plain `http://192.168.x.x`
however the permissions are set — https or `localhost` only. One more reason for
`tailscale serve`.

## Signing in

In the web view, using the site's own login, because there is no native session
to keep in step with it.

The uploader has none either — **it borrows that one**. After every page load the
web view's cookies are copied into `HTTPCookieStorage`, which is the jar
`URLSession` reaches for unasked, and that is the whole of the app's
authentication. When the session ends, a 401 says so on the Settings tab; nothing
native can mend it, and signing in on the Map tab does.

Sign out from the Settings tab. It now throws away four things rather than one:
the web view's cookies and storage, the borrowed copy of the session, anything
recorded but not yet sent, and how far Health had been read. Leaving any of them
would mean a signed-out phone that went on uploading, or queued fixes landing in
whichever account signed in next.

## Recording where you have been

Settings → **Location** → *Update*. Off by default; nothing is recorded until you
pick how often.

| | |
| --- | --- |
| **Off** | Nothing. The Map tab still works, and so does its locate button |
| **Only when I go somewhere** | Significant-change monitoring alone. Roughly half a kilometre, whenever iOS feels like it, off radios the phone is already listening to — no measurable battery cost |
| **Every hour** … **Every minute** | Standard updates, throttled to the interval you picked |

### Two services, and only one of them is about precision

**Significant-change monitoring runs at every setting**, including the ones named
in minutes. It is not there for its fixes — it is coarse and arrives when iOS
decides. It is there because it is **the only location service that relaunches a
terminated app**, and it is the whole difference between a logger and a
logger-until-you-swipe-it-away. `AppDelegate.didFinishLaunchingWithOptions` is
the hook that catches that launch; SwiftUI has none, because at that moment there
is no window and no scene.

**Standard updates** run on top of it for the interval settings, and are what
those settings actually mean.

### The fixes are coarse on purpose

`desiredAccuracy` is `kCLLocationAccuracyHundredMeters` at every setting, which
is not a compromise. **A cell is about 900 m across**, so a ten-metre fix and a
hundred-metre fix land in the same hexagon and produce the identical map. What
they do not cost the same is power: a hundred metres can be answered from wifi
and cell towers, and ten cannot be answered without the GPS chip. Asking for
precision the app then throws away would be spending your battery on rounding
error.

`distanceFilter` is scaled with the cadence — 100 m at *every minute*, 500 m at
*every hour* — so a phone sitting on a desk costs nothing at any setting: the
fixes it would deliver are the ones the throttle would discard anyway, and the
cheapest fix is the one never taken.

### The one line that is easy to leave out

```swift
manager.pausesLocationUpdatesAutomatically = false
```

With the default, iOS pauses updates when it decides you have stopped moving —
and then does not resume them. The documented remedy is for the app to notice and
restart, which an app that has been suspended for six hours is in no position to
do. What it looks like from the outside is a logger that works for an afternoon
and then silently stops, forever, with no error anywhere.

### Nothing is lost to a bad connection

Recorded fixes go to a file (`FixQueue`, in Application Support) **before the
delegate method returns**, and leave it only when the server has answered 200. A
week in a cellar costs disk and nothing else. Application Support rather than
Caches, because the system empties Caches under pressure and this is the one
thing here that cannot be re-derived.

Re-sending is expected rather than exceptional — a 200 lost on the way back is
indistinguishable from a timeout — and the server makes it harmless with a
per-device cursor. See
[The phone itself](../ARCHITECTURE.md#the-phone-itself).

### Permissions

When-in-use is asked for first and **Always** second, when you turn tracking on.
Asking for Always outright is allowed and is a worse question: iOS shows one
dialog with the strongest option in it and people say no. The two-step ask
arrives after the app has visibly done something with location.

If the answer ends up being "While Using the App", the Settings tab says so
rather than leaving a switch on over silence.

## Workouts from Apple Health

Settings → **Apple Health** → *Sync workouts*.

**Only the ones that went somewhere.** The filter is not a list of activity types
— it is whether the workout carries an `HKWorkoutRoute`, which is Health's own
answer to the same question and is right about the cases a type list gets wrong.
An indoor cycle has no route; an open-water swim does. Each one that does becomes
cells *and* a saved route, exactly as a Strava activity does.

Health is read from and never written to. The reasoning about ids, anchors and
the barometer's ascent is in
[Workouts out of Apple Health](../ARCHITECTURE.md#workouts-out-of-apple-health).

### A route is not one line

A workout's route is one undifferentiated stream of locations however many times
the recording stopped, so it has to be cut into the parts actually recorded —
otherwise a pause is drawn as a straight line across the gap and counted as
distance. Apple's Fitness app draws that stretch dotted; this map does not draw
it at all, which is the same answer in the register the rest of it uses.

**The cut is not done here.** It needs only latitude, longitude and a clock,
which every source has, so it lives in `splitOnGaps` in `src/routes.js` and
applies to a Strava ride and a Komoot tour exactly as much — both had the same
bug. Doing it on the phone as well would be two definitions of a pause, quietly
disagreeing.

What `HealthSync` does keep is `maxAccuracyM` (100 m), because accuracy is the
one thing that cannot travel: it is a property of the fix as CoreLocation hands
it over, and it is gone by the time the point is a pair of numbers on the wire.
A watch with GPS lock does not produce a 1.5 km fix, so one is a glitch.

### Re-reading it

Settings → Apple Health → **Re-read from the start**. Drops the cells and lines
Health put on the map, forgets which workouts have been seen, clears this
phone's query anchor, and reads the lot again. It is the only way to correct a
workout that was stored from a bad reading, because the remembered ids that stop
a re-send double-counting also stop a correction landing. Files, Home Assistant,
Strava and this phone's own logger are untouched.

### The capability, and free provisioning

`HexPlore.entitlements` asks for three keys. Two are the HealthKit capability
itself; the third, `…healthkit.background-delivery`, is what lets iOS wake the
app when a workout is saved rather than making you remember to open it.

**If signing with a free Apple ID ever refuses that third key, delete it.** The
cost is only the wake-up: workouts are still picked up whenever the app is
opened, and whenever a location update wakes it — `LocationLogger` runs a Health
sync opportunistically for exactly that reason, and because a Watch that finishes
a ride out of range of the phone saves it hours later and quietly.

## Offline

**There is nothing native here, and that is the finding.** The site registers a
service worker (`public/sw.js`), WebKit has run service workers in a `WKWebView`
since iOS 14, and `configuration.websiteDataStore = .default()` — set in
`WebPanel.swift` so the *session* survives a relaunch — is also what persists the
worker's registration and its Cache Storage. So the app opens with no server, on
the map you last saw, having written no Swift for it.

What is cached and what is not is decided in one place for every client; see
**The offline shell** in [ARCHITECTURE.md](../ARCHITECTURE.md). The short version:
the app shell and the 8.5 MB of town and boundary data are kept indefinitely
(they are content-hashed, so a hit cannot be wrong), the last answer to each
`/api/…` read is kept as a fallback, basemap tiles are deliberately not kept, and
signing out drops the lot.

Offline is **view-only**, and the site already knew how to say so: the "cannot
reach the server" banner appears and edits queue rather than claiming to have
saved.

The alternative was to bundle the built site into the IPA. It would have worked
and it is the worse answer — a copy of the web app inside the app is a second
copy that can disagree with the server's, which is the trade this whole project
exists to refuse.

## Photos

Settings → **Photos** → *Sync photo locations*.

A photo knows where it was taken, so the library is a record of everywhere you
have been with a camera. **Only the coordinate and the date are read** —
`PHAsset` carries both as metadata, so no photograph is opened, nothing is
fetched from iCloud, and no image leaves the phone. Eighty thousand of them read
in a second or two, because it is a database query rather than a file walk.

Each read **replaces** the last rather than adding to it, which no other source
here does: a library is the whole answer to "where have I taken a picture", so a
photo deleted from it is a claim withdrawn. That is also what lets it take over
cleanly from the old file-derived import, which is now deprecated.

**"Limited" access is called out**, because a library you have picked twenty
photos from is not a smaller map, it is a wrong one, and nothing else on the
screen would tell you.

### And seeing them, which is the other half

Map tab → the layers menu → **Photos**. A point wherever you have taken one,
gathered into a counted group where they pile up, and the picture itself when you
tap it.

This is the one thing the app does *for* the page rather than beside it, and the
only reason it is native is that it has to be: a web view cannot open a photo
library, and the server has never held anything but the coordinates. So the page
asks over a `WKScriptMessageHandlerWithReply` channel (`PhotoBridge`), gets back
`[lat, lng, t]` per photograph, and afterwards names one by its index into that
list — the `localIdentifier`s stay on this side, and every answer is stamped with
a scan number so an index can never be resolved against a library that has moved
on. A picture is fetched one at a time, only when tapped, and crosses as a
`data:` URL sized to the card. The switch does not appear in a browser, because
`window.webkit.messageHandlers.hexplorePhotos` is not there to answer.

It is deliberately **not** gated on *Sync photo locations* above. Looking at
where your photographs were taken and uploading those places are two different
decisions, and this one asks for photo permission on its own account.

"Open in Photos" opens the Photos app and not the photograph, because iOS has no
public way to open a particular asset — see the note on `PhotoLibrary.openInPhotos`.

## What is not here yet

1. **A home-screen presence beyond the icon** — widgets, Live Activities, share
   sheet.
2. **Anything the logger could infer.** It does not fill in the ground between
   two fixes, guess at a route, or use visit monitoring to name a place. A gap in
   the data stays a gap on the map, which is the honest answer for a map whose
   whole claim is *I was here*.

### Why there is a Metal blur in a repo with no native map

`HexploreCore/Blob` is finished work for a renderer nothing currently calls. It
is kept because the argument behind it is about the *web app's* performance on a
phone, and that argument outlived the native map — if it is ever worth acting on,
the pipeline is written and tested.

Where a browser has no `CanvasRenderingContext2D.filter`, the web app blurs the
sheet in JavaScript: `blurRgba` in `src/blob-canvas.js` runs a premultiply pass,
three rounds of separable box blur in both directions, and an unpremultiply,
over the whole sheet, per repaint.

That code is already about as good as JavaScript gets: separable, running sums,
cost independent of radius. When well-written code is still the bottleneck, the
ceiling is real rather than a mistake to optimise away.

The consequence is priced into `blob-canvas.js:38`: with a native blur the sheet
is rendered at up to **device ratio 3**, and without one it is capped at **1.5**,
explicitly because every extra pixel is then paid for six times over. That is a
2× resolution difference decided entirely by whether the blur is native.

**Whether that cap currently applies on iOS is worth measuring rather than
assuming.** ARCHITECTURE.md states that Safari has never shipped canvas
`filter`, and that may now be out of date — WebKit landed an implementation in
2024, though MDN still lists the property as "limited availability". It does not
matter to the code, which settles it at runtime: `nativeBlur()` (blob-canvas.js:112)
blurs a test rectangle and reads a pixel back, because assigning `ctx.filter`
where it is unsupported merely creates an ordinary property and the obvious
feature test lies. **The probe is the authority — check it on the actual device
before quoting the 2× anywhere.**

The Metal case does not rest on that question either way. On the GPU the blur is
close to free, a true Gaussian is available rather than three box passes
approximating one, and the whole `getImageData`/`putImageData` round trip through
CPU memory disappears. The box passes exist because their cost does not grow with
radius *on a CPU*; there is no reason to reproduce that approximation on hardware
built for the thing it approximates.
