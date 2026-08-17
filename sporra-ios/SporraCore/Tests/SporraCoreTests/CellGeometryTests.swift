import Foundation
import Testing

@testable import SporraCore

/// Reading a stored cell id back, and turning it into something drawable.
///
/// The id is the contract with the server and the polygon is what you actually
/// see, so between them these are the two ways the map can be wrong without
/// anything crashing: a cell in the wrong place, or a cell that is not there.
@Suite("Cell geometry")
struct CellGeometryTests {

    @Test("an id round-trips through parsing")
    func parseRoundTrip() {
        for (level, col, row) in [(0, 1076, 6668), (4, 321, 7), (2, 0, -1), (1, 17_333, 12_345)] {
            let id = HexGrid.cellId(level: level, col: col, row: row)
            let cell = HexGrid.parse(cellId: id)
            #expect(cell?.level == level, "\(id)")
            #expect(cell?.row == row, "\(id)")
            #expect(cell?.id == id, "the id it reports is the id it came from")
        }
    }

    /// A malformed id must not quietly become a cell — 0/0/0 is in the Atlantic,
    /// and a hexagon there is harder to explain than a missing one.
    @Test("nonsense is not a cell")
    func parseRejectsNonsense() {
        for bad in ["", "0", "0/1", "0/1/2/3", "a/1/2", "0/x/2", "0/1/y", "9/1/2", "-1/1/2"] {
            #expect(HexGrid.parse(cellId: bad) == nil, "accepted \(bad)")
        }
    }

    @Test("a cell has six corners, all one radius from its centre")
    func cornersAreAHexagon() {
        let level = 0
        let cell = HexGrid.parse(cellId: "0/1076/6668")!
        let corners = HexGrid.corners(of: cell)
        #expect(corners.count == 6)

        let centre = HexGrid.cellCenter(level: level, col: cell.col, row: cell.row)
        let r = HexGrid.radius(level: level)
        for corner in corners {
            let x = HexGrid.mercatorX(lng: corner.lng)
            let y = HexGrid.mercatorY(lat: corner.lat)
            let distance = ((x - centre.x) * (x - centre.x) + (y - centre.y) * (y - centre.y)).squareRoot()
            // Round-tripping through lng/lat and back costs a little precision;
            // a millimetre on a cell 900 m across is not a shape anyone can see.
            #expect(abs(distance - r) < 0.001, "corner \(distance) m from centre, radius \(r)")
        }
    }

    /// Flat-top, not pointy-top. Two corners level with the centre, and the top
    /// and bottom of the hexagon are edges — get this the wrong way round and
    /// every cell is rotated 30° against the ones the web app draws.
    @Test("the hexagons are flat-topped")
    func flatTopped() {
        let cell = HexGrid.parse(cellId: "0/1076/6668")!
        let centre = HexGrid.cellCenter(level: 0, col: cell.col, row: cell.row)
        let corners = HexGrid.corners(of: cell).map {
            (x: HexGrid.mercatorX(lng: $0.lng), y: HexGrid.mercatorY(lat: $0.lat))
        }
        let level = corners.filter { abs($0.y - centre.y) < 0.001 }
        #expect(level.count == 2, "a flat-top hexagon has exactly two corners level with its centre")
    }

    /// Rolled up one step at a time, because a single point-location at the
    /// target level genuinely disagrees for about a fifth of cells — and the web
    /// app rolls up, so this has to.
    @Test("rolling up is repeated parenting, not one long jump")
    func rollUpMatchesRepeatedParent() {
        for id in ["0/1076/6668", "0/2000/3000", "0/0/0", "0/52001/-40"] {
            let cell = HexGrid.parse(cellId: id)!
            for target in 1...HexGrid.maxLevel {
                var walked = cell
                for _ in cell.level..<target {
                    let up = HexGrid.parent(level: walked.level, col: walked.col, row: walked.row)
                    walked = Cell(level: walked.level + 1, col: up.col, row: up.row)
                }
                let rolled = HexGrid.rollUp(cell, to: target)
                #expect(rolled == walked, "\(id) to level \(target)")
            }
        }
    }

    @Test("rolling up to its own level or below leaves a cell alone")
    func rollUpIsIdempotentDownwards() {
        let cell = HexGrid.parse(cellId: "2/500/400")!
        #expect(HexGrid.rollUp(cell, to: 2) == cell)
        #expect(HexGrid.rollUp(cell, to: 0) == cell)
    }

    /// Taken from the same expression in src/main.js, run in node — the levels
    /// have to change at the same zooms in both apps or the phone shows a
    /// coarser map than the laptop at the same place.
    @Test("the level a zoom asks for matches the web app")
    func levelForZoomMatchesTheWebApp() {
        let expected: [(zoom: Double, level: Int)] = [
            (0, 4), (1, 4), (2, 4), (3, 4), (3.66, 4), (3.7, 4), (4, 4), (5, 4), (5.05, 4),
            (6, 3), (6.5, 3), (6.83, 3),
            (7, 2), (8, 2),
            (8.42, 1), (9, 1), (9.5, 1),
            (10, 0), (11, 0), (14, 0), (18, 0),
        ]
        for case let (zoom, level) in expected {
            #expect(HexGrid.levelForZoom(zoom) == level, "zoom \(zoom)")
        }
    }

    @Test("and it never leaves the levels that exist")
    func levelForZoomStaysInRange() {
        for zoom in stride(from: -5.0, through: 25.0, by: 0.25) {
            let level = HexGrid.levelForZoom(zoom)
            #expect(level >= 0 && level <= HexGrid.maxLevel, "zoom \(zoom) gave \(level)")
        }
    }
}
