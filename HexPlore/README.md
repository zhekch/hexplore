# HexPlore for iOS

The native port. Early — the map draws and the maths underneath it is done and
tested, and everything above that is still the web app's job.

The web app is the product; this is a second front end onto the same server.
[ARCHITECTURE.md](../ARCHITECTURE.md) at the repo root is still the reference for
*why* anything works the way it does, and this port is expected to agree with it
rather than to reinvent it.

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
  HexPlore/                 the app itself — anything here is compiled, automatically
    HexPloreApp.swift       the entry point (@main)
    ContentView.swift       the root view
    MapView.swift           MapLibre, wrapped for SwiftUI
    Basemap.swift           the four basemaps from src/main.js's STYLES table
  HexploreCore/             a local Swift package: the maths, with tests
    Sources/HexploreCore/
      HexGrid.swift         the hex lattice — a port of src/hexgrid.js
      BlobShaping.swift     the blob tuning and the alpha cut curve
    Tests/                  including the generated fixtures
  Tools/
    gen-hex-vectors.mjs     regenerates the hex fixtures from the JavaScript
    gen-blob-vectors.mjs    regenerates the blob fixtures from the JavaScript
    test-core.sh            runs the package tests on the Mac
```

**Why the core is a separate package.** `swift test` runs it on the Mac in about
a second — no simulator, no signing, no Xcode. The pure maths is exactly the part
that most needs testing and least needs a device, and keeping it out of the app
target is what makes that possible.

## Dependencies

Two, and they are different kinds:

- **MapLibre Native** (`maplibre-gl-native-distribution`, pinned at 6.28.0) —
  fetched from GitHub. It is the *same renderer* as the web app's MapLibre GL
  JS: same styles, same source and layer model, spelled `MLN…` instead. What you
  know from `src/main.js` transfers almost directly.
- **HexploreCore** — the local package above, referenced by relative path.

`Package.resolved` is committed on purpose. It pins the exact MapLibre a build
used, which is what an app wants (a library would not).

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

**Map** is native. A map is the one thing a phone does better than a web view:
the gestures, the GPU, and eventually the background location a browser cannot
have at all.

**Settings** is the web app's own menu, in a web view. The import dialogs, the
sync connectors, the backup schedule and the statistics are some nine thousand
lines of interface that already work against this same server, and rebuilding
them in SwiftUI would be a great deal of effort for a screen that looks the same.

Loading the site plainly would give you a second map behind the settings you came
for, so the web view injects a stylesheet that takes the map surface off screen
and a script that opens the menu. **That is a stopgap rather than a design.** The
honest version is a mode the web app itself supports — it already reads
`?debuglevels`, so a `?panel=settings` that boots without a map would be a small
change there and would delete the injection entirely.

**Neither side derives anything.** Trips, coverage and the calendar are worked
out once by the server (`server/derive.js`), so this app and the browser cannot
disagree about them — see "Derived on the server, once" in ARCHITECTURE.md.

## Signing in

Once, natively. `POST /api/login` answers with a `sid` cookie, `URLSession`
stores it, and `Session.adoptCookies` copies it into the web view's own store —
`WKWebView` keeps cookies separately, so without that step the Settings tab would
show a login form to somebody who had just signed in on the Map tab.

## What is ported

- **The hex lattice** (`HexGrid`) — projection, cell resolution, roll-up to
  coarser levels, column wrapping at the antimeridian, and the canonical
  `"{level}/{col}/{row}"` id the server keys on.
- **Cell geometry** — reading a stored id back, the six corners of a cell, and
  the same zoom → level mapping `levelForZoom` uses in `src/main.js`, so the
  phone and the laptop show the same coarseness at the same place.
- **The blob shaping curve** (`BlobShaping`) and **the Metal renderer**
  (`BlobRenderer`) — written and tested, not yet on the map.
- **The API client** — sign in, and fetch cells, trips and statistics.
- **The map** — MapLibre with the Dark and Light basemaps, drawing your visited
  cells.

## What is not, in the order it probably wants doing

1. **The blob look.** Cells currently draw as hexagons — which is the web app's
   own vector fallback for browsers without canvas filters, so it is a real
   rendering rather than a placeholder, but it is not the poured-ink look. The
   Metal pipeline is written; what is missing is feeding its output to an
   `MLNImageSource` pinned to the viewport, which is what the canvas source does
   in the browser.
2. **Colouring modes.** Only the single accent wash. Visits, first seen and type
   all need the per-cell history the API already returns.
3. **Terrain and Satellite.** Both are built at load time by rewriting somebody
   else's style JSON (`src/basemap.js`). `MLNMapView.styleJSON` makes this
   perfectly possible; the rewriting is what is missing. They declare themselves
   unavailable rather than silently falling back to Dark.
4. **The two vector levels** — regions and countries, and the crossfades between
   them.
5. **Editing.** The map is read-only here.
6. **Background location.** The one thing the web app categorically cannot do,
   and the strongest reason for this app to exist at all.

### Why Metal, specifically

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
