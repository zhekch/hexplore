import Foundation

/// A cell as the server names it: `"{level}/{col}/{row}"`.
public struct Cell: Hashable, Sendable {
    public let level: Int
    public let col: Int
    public let row: Int

    public init(level: Int, col: Int, row: Int) {
        self.level = level
        self.col = col
        self.row = row
    }

    public var id: String { HexGrid.cellId(level: level, col: col, row: row) }
}

extension HexGrid {

    /// Read back an id the server stored. Returns nil for anything that is not
    /// one, because a malformed id must not silently become cell 0/0/0 in the
    /// Atlantic.
    public static func parse(cellId: String) -> Cell? {
        let parts = cellId.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let level = Int(parts[0]),
              let col = Int(parts[1]),
              let row = Int(parts[2]),
              level >= 0, level <= maxLevel
        else { return nil }
        return Cell(level: level, col: col, row: row)
    }

    /// The six corners of a cell, in longitude/latitude, wound once around.
    ///
    /// Flat-top, so two corners sit level with the centre and the top and bottom
    /// of the hexagon are edges — which is why the first vertex is at angle 0
    /// rather than at 30°.
    public static func corners(level: Int, col: Int, row: Int) -> [(lng: Double, lat: Double)] {
        let r = radius(level: level)
        let centre = cellCenter(level: level, col: col, row: row)
        return (0..<6).map { step in
            let angle = Double(step) * Double.pi / 3
            let x = centre.x + r * cos(angle)
            let y = centre.y + r * sin(angle)
            return (longitude(x: x), latitude(y: y))
        }
    }

    public static func corners(of cell: Cell) -> [(lng: Double, lat: Double)] {
        corners(level: cell.level, col: cell.col, row: cell.row)
    }

    // MARK: - Which level a zoom is showing

    /// Zoom at which level 0 — the grid exactly as stored — is the right one.
    public static let level0Zoom = 10.0

    /// Each grid level is 3× wider than the one below it, so they are log2(3)
    /// map-zoom levels apart.
    public static let levelStep = log2(3.0)

    /// The level a given map zoom should draw, matching `levelForZoom` in
    /// src/main.js.
    ///
    /// Capped at ``maxLevel`` rather than at the web app's country level: the
    /// two coarsest steps there are polygons — cantons, then countries — and
    /// neither of those datasets is on the phone yet.
    public static func levelForZoom(_ zoom: Double) -> Int {
        let raw = ((level0Zoom - zoom) / levelStep - 1e-9).rounded(.up)
        return min(Double(maxLevel), max(0, raw)).isFinite ? Int(min(Double(maxLevel), max(0, raw))) : 0
    }

    /// Roll a stored cell up to a coarser level, one step at a time.
    ///
    /// Deliberately repeated `parent` calls rather than one point-location at
    /// the target level: the two genuinely disagree for about a fifth of cells,
    /// because a cell centre near a coarse hex's corner does not always land in
    /// the hex that contains its own parent. The web app rolls up, so this rolls
    /// up, and the two maps light the same ground.
    public static func rollUp(_ cell: Cell, to level: Int) -> Cell {
        guard level > cell.level else { return cell }
        var current = cell
        while current.level < level {
            let up = parent(level: current.level, col: current.col, row: current.row)
            current = Cell(level: current.level + 1, col: up.col, row: up.row)
        }
        return current
    }
}
