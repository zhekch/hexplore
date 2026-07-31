import Testing
import Foundation

@testable import HexploreCore

/// The hex maths, checked against the JavaScript that wrote the database.
///
/// Two kinds of assertion, and the difference matters:
///
/// **Integers are exact.** A column, a row, a cell id — these are keys the
/// server already holds rows under. One out is not a small error, it is a
/// different cell, so nothing here is allowed a tolerance.
///
/// **Doubles get a tight tolerance.** `atanh`, `sinh` and `atan` come from the
/// platform's libm in Swift and from the JavaScript engine's own implementation
/// in node, and the two are permitted to disagree in the last bit. The
/// tolerances below are far tighter than that difference could ever grow to,
/// and far tighter than anything that could move a cell: 1e-6 m on a world
/// 40,075 km wide is a micrometre.
@Suite("Hex grid")
struct HexGridTests {

    /// A micrometre, on a world 40,075 km across.
    static let mercatorTolerance = 1e-6
    /// Well under a millimetre of ground.
    static let degreeTolerance = 1e-11

    @Test("the constants are the ones the JavaScript computes")
    func constants() {
        #expect(HexGrid.maxLevel == HexGridVectors.Constants.maxLevel)
        #expect(HexGrid.baseCols == HexGridVectors.Constants.baseCols)
        #expect(abs(HexGrid.world - HexGridVectors.Constants.world) < Self.mercatorTolerance)
        #expect(abs(HexGrid.radius0 - HexGridVectors.Constants.radius0) < Self.mercatorTolerance)
    }

    @Test("every level has the radius and column count the JavaScript gives it")
    func levels() {
        for level in HexGridVectors.levels {
            #expect(
                HexGrid.columns(level: level.level) == level.cols,
                "columns at level \(level.level)"
            )
            #expect(
                abs(HexGrid.radius(level: level.level) - level.radius) < Self.mercatorTolerance,
                "radius at level \(level.level)"
            )
        }
    }

    @Test("the forward Mercator projection agrees")
    func projection() {
        for place in HexGridVectors.projections {
            #expect(
                abs(HexGrid.mercatorX(lng: place.lng) - place.x) < Self.mercatorTolerance,
                "mercatorX for \(place.name)"
            )
            #expect(
                abs(HexGrid.mercatorY(lat: place.lat) - place.y) < Self.mercatorTolerance,
                "mercatorY for \(place.name)"
            )
        }
    }

    @Test("and so does the inverse")
    func inverseProjection() {
        for point in HexGridVectors.inverses {
            #expect(
                abs(HexGrid.longitude(x: point.x) - point.lng) < Self.degreeTolerance,
                "longitude at x=\(point.x)"
            )
            #expect(
                abs(HexGrid.latitude(y: point.y) - point.lat) < Self.degreeTolerance,
                "latitude at y=\(point.y)"
            )
        }
    }

    /// The assertion the whole port stands on.
    @Test("a point resolves to exactly the cell the JavaScript resolves it to")
    func pointToCell() {
        for vector in HexGridVectors.pointCells {
            let cell = HexGrid.pointToCell(
                level: vector.level,
                x: HexGrid.mercatorX(lng: vector.lng),
                y: HexGrid.mercatorY(lat: vector.lat)
            )
            #expect(
                cell.col == vector.col && cell.row == vector.row,
                "\(vector.name) at level \(vector.level): got (\(cell.col), \(cell.row)), expected (\(vector.col), \(vector.row))"
            )
        }
    }

    /// The string the server keys on. Everything else can be re-derived; this
    /// is the one value that has to match rows already written.
    @Test("the canonical cell id string matches the server's key")
    func cellIds() {
        for vector in HexGridVectors.cellIds {
            let id = HexGrid.cellId(level: vector.level, lat: vector.lat, lng: vector.lng)
            #expect(id == vector.id, "\(vector.name) at level \(vector.level)")
        }
    }

    @Test("a cell resolves back to its centre")
    func cellCenters() {
        for vector in HexGridVectors.centers {
            let centre = HexGrid.cellCenter(level: vector.level, col: vector.col, row: vector.row)
            #expect(
                abs(centre.x - vector.x) < Self.mercatorTolerance,
                "centre x at level \(vector.level) (\(vector.col), \(vector.row))"
            )
            #expect(
                abs(centre.y - vector.y) < Self.mercatorTolerance,
                "centre y at level \(vector.level) (\(vector.col), \(vector.row))"
            )
        }
    }

    /// The roll-up. Getting this wrong means a visited cell fails to light the
    /// country it is in, which looks like missing data rather than a bug.
    @Test("a cell rolls up to the same parent")
    func parents() {
        for vector in HexGridVectors.parents {
            let parent = HexGrid.parent(level: vector.level, col: vector.col, row: vector.row)
            #expect(
                parent.col == vector.parentCol && parent.row == vector.parentRow,
                "parent of level \(vector.level) (\(vector.col), \(vector.row)): got (\(parent.col), \(parent.row)), expected (\(vector.parentCol), \(vector.parentRow))"
            )
        }
    }

    /// The antimeridian case, and the one place a naive Swift `%` differs.
    @Test("columns wrap the way the JavaScript wraps them, including negatives")
    func normalizedColumns() {
        for vector in HexGridVectors.normalizedColumns {
            #expect(
                HexGrid.normalizedColumn(vector.col, vector.n) == vector.expected,
                "normalizedColumn(\(vector.col), \(vector.n))"
            )
        }
    }

    /// Pinned separately from the lattice vectors because it is the single
    /// behaviour a Swift port is most likely to get wrong without ever noticing.
    @Test("a half rounds toward +∞, as Math.round does")
    func halfRoundsTowardPositiveInfinity() {
        for vector in HexGridVectors.roundings {
            #expect(
                HexGrid.jsRound(vector.input) == vector.expected,
                "jsRound(\(vector.input))"
            )
        }
    }

    /// The reason the helper exists at all. If this ever starts passing with
    /// `.rounded()` substituted, the port has stopped agreeing with the data.
    @Test("Swift's own rounding would disagree, which is why jsRound exists")
    func swiftRoundingWouldDisagree() {
        #expect((-2.5).rounded() == -3, "Swift rounds a half away from zero")
        #expect(HexGrid.jsRound(-2.5) == -2, "JavaScript rounds a half toward +∞")
        #expect((-2.5).rounded() != HexGrid.jsRound(-2.5))
    }
}
