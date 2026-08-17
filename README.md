# Sporra

An interactive world map covered in a hexagonal grid, where you mark the places
you've been. Cells are hexagons in storage but never look like it — they're
blurred and re-cut into soft blobs that flow together, so a map of your life
reads as spilled ink rather than a spreadsheet.

Point it at your location history and it fills itself in.

## The three pieces

| | |
|---|---|
| **[Sporra-webserver/](Sporra-webserver/README.md)** | The web app and its Node/SQLite server. This is the product; the other two are ways to carry it. |
| **[Sporra-IOS/](Sporra-IOS/README.md)** | An iPhone app that hosts the web app in a web view and adds the one thing a browser cannot do: record where you have been with the screen off. |
| **[Sporra-macOS/](Sporra-macOS/README.md)** | The same program on a Mac. Its README is written as a diff against the iOS one, because the places the two differ are the only interesting part. |

They live in one repo because they are one program. The apps are web views over
the same site, the Swift hex-grid maths in `SporraCore` is checked against the
JavaScript that defines it, and a change to the shape of the app usually lands
in more than one folder at once.

## Just want to run it?

You only need the first folder. Node 20+ is the one requirement.

```sh
git clone https://github.com/zhekch/sporra.git
cd sporra/Sporra-webserver
npm install
npm run dev
```

Open <http://localhost:5173> and register an account — **the first account on an
empty database is always allowed**, and registration closes itself afterwards.
[Sporra-webserver/README.md](Sporra-webserver/README.md) covers running it
for real, getting your location history in, and the configuration.

Nothing in the two app folders is needed to run the server, and nothing there is
downloaded separately — together they are about 450 KB, next to the ~18 MB of
map data the server itself ships with.

## Working on it rather than using it?

[ARCHITECTURE.md](ARCHITECTURE.md) is the long version — why the grid is what it
is, how the blobs are drawn, the security model, and a number of approaches that
were tried and abandoned for reasons that are not visible from the code alone.
Read it before changing anything non-trivial.

## Licence

[Apache 2.0](LICENSE).
