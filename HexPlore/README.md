# HexPlore for iOS

**The phone hosts the web app rather than replacing it.** The Map tab is the
site itself, unmodified — its map, its menu, its import dialogs, its sync
connectors, its login. The Settings tab is the little this app knows that the
site does not: which server to open, and how to forget it.

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
  HexPlore/                 the app itself — anything here is compiled, automatically
    HexPloreApp.swift       the entry point (@main)
    ContentView.swift       the two tabs
    WebPanel.swift          the web view that is the Map tab
    SettingsView.swift      the app's own settings
    AppSettings.swift       the server address, and signing out
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

The app is five small files. That is the point of hosting the site rather than
rewriting it.

## The core package

`HexploreCore` is **not used by the app**, and is kept anyway.

It holds the hex lattice ported from `src/hexgrid.js` and verified against
vectors generated by running that JavaScript, the blob shaping curve checked
against the real `alphaLut`, and a working Metal blur pipeline — 34 tests, all
passing, none of them needing a simulator.

The reason to keep it is not a future native map. It is that **the one thing an
iOS app can do that a web app categorically cannot is record your location in the
background**, and a logger that turns fixes into cells needs exactly this: the
lattice, and the id format the server keys on. When that gets built, it is
already here and already correct.

If it is ever genuinely dead, `git rm -r HexPlore/HexploreCore` and drop the
local package reference. It is not dead yet.

## Dependencies

**One**, and it is local: `HexploreCore`, referenced by relative path.

There is no MapLibre. An earlier version linked
`maplibre-gl-native-distribution` to draw the map natively; when the map became
the web view, a map renderer the app never calls was several megabytes of binary
and a dependency to keep pinned, for nothing. It was removed rather than left in
place. The web view's map is MapLibre GL JS, served from your own machine like
the rest of the site.

## Running the tests

26 tests, three suites, and three ways to run them.

```sh
HexPlore/Tools/test-core.sh          # on this Mac — about a second
HexPlore/Tools/test-core.sh --ios    # on the iOS Simulator — about a minute
```

The Mac run is the one to use while working: no simulator to boot, no signing,
no Xcode. The `--ios` run is the one that proves the code works where it is
going to run — the same 26 tests, with the GPU ones exercising the simulator's
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
to open, and how to forget it. Everything about your *map* stays on the Map tab,
where a laptop finds it in the same place. Duplicating any of it natively would
mean two screens that have to agree.

**Neither side derives anything.** Trips, coverage and the calendar are worked
out once by the server (`server/derive.js`), so a phone and a laptop cannot
disagree about them — see "Derived on the server, once" in ARCHITECTURE.md.

### Two details that are easy to get wrong

**The web view stops above the tab bar.** The site stacks its own buttons —
geolocate, menu, pencil — in the bottom-right corner on a phone, and its CSS has
no `safe-area-inset` handling at all. Anything drawn under the bottom of the page
covers those buttons rather than sitting beside them, so SwiftUI is left to inset
the view. One line, and it costs nothing; teaching the page about a tab bar would
mean editing its CSS for a host it should not have to know about.

**The tab bar is pinned to dark.** The site is dark — its login card, its menu,
three of its four basemaps — and a tab bar that followed the system into light
mode put a white strip under all of it, which read as a bar belonging to some
other app.

## Signing in

In the web view, using the site's own login, because there is no native session
to keep in step with it. Sign out from the Settings tab: there is nothing native
to end, so it throws away the cookies and stored data the web view keeps, which
is the same thing.

## What is not here yet

1. **Background location.** The one thing a web app categorically cannot do, and
   the reason for this app to exist beyond convenience. `HexploreCore` already
   holds the lattice and the id format a logger would need.
2. **Offline.** The web view needs the server; there is no cached shell.
3. **A home-screen presence beyond the icon** — widgets, Live Activities, share
   sheet.

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
