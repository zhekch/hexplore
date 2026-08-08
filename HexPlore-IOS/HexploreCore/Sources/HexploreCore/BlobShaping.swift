import Foundation

/// The shaping half of the blob pipeline — the Swift port of the tuning
/// constants and the alpha transfer curve in `src/blob-canvas.js`.
///
/// Visited cells are hexagons in storage but never look like it. Each lit cell
/// is painted as a disc, the sheet is blurred, and the shape is then **re-cut at
/// a fixed alpha level**. The blur merges neighbouring cells and blends their
/// colours; taking a contour afterwards keeps the blob the size it should be
/// while every dent narrower than the blur fills in and every corner sharper
/// than the blur rounds off.
///
/// This type owns the part of that which is arithmetic rather than pixels: the
/// constants, and `alphaCurve`, which is the curve the Metal shader samples.
/// Keeping it here rather than inside the renderer means it can be tested on the
/// Mac against the JavaScript, with no GPU involved.
public enum BlobShaping {

    // MARK: - Tuning
    //
    // Documented at length in src/blob-canvas.js and ARCHITECTURE.md. Changing
    // one here changes only the iOS app; the two are meant to agree.

    /// Blur sigma as a fraction of a cell's on-screen radius. The knob that
    /// decides "cells with soft corners" against "one poured shape".
    public static let blur = 1.0

    /// How many blur → re-cut rounds. Two is enough to lose the lattice.
    public static let rounds = 2

    /// Later rounds work on an already-smooth shape, so they need less blur.
    /// Only the first round gets the full sigma; every one after it is scaled by
    /// this.
    public static let laterRoundBlur = 0.62

    /// The sigma for a given round, in sheet pixels.
    ///
    /// - Parameter unit: a cell's on-screen radius in sheet pixels.
    public static func sigma(round: Int, unit: Double) -> Double {
        unit * blur * (round == 0 ? 1 : laterRoundBlur)
    }

    /// Which edge width a round cuts at.
    ///
    /// Intermediate rounds exist to shape the outline, so they cut tightly — a
    /// soft cut halfway through would only get blurred again and lose the
    /// definition the next round needs. Only the last cut is the visible rim,
    /// which is why the edge knob means "how gradually the blob dissolves into
    /// the map" and nothing else.
    public static func edge(round: Int, final: Double) -> Double {
        round == rounds - 1 ? final : shapingEdge
    }

    /// The alpha taken as the blob's edge. Cutting near half alpha is what keeps
    /// the smoothed shape the same size as the cells underneath: lower inflates
    /// it, higher eats thin ribbons.
    public static let level = 0.3

    /// The band's low end can never reach zero. Without the floor a wide band
    /// starts below zero and lifts *every* pixel — including the empty ones — to
    /// a visible alpha, washing the whole sheet and drawing its straight
    /// rectangular edge across the map.
    public static let alphaFloor = 0.05

    /// Width of the alpha ramp on the final cut, in units of a cell.
    public static let edge = 0.3
    /// The heat maps want a tighter rim: there every pixel of ramp is also a
    /// fade toward transparent, so a wide edge makes the outermost cells read as
    /// a lower value than they hold.
    ///
    /// The band runs from ``level`` − edge to ``level`` + edge, so anything near
    /// 0.6 against a level of 0.3 clamps to very nearly the whole alpha range
    /// and stops being a cut at all — which is what the wide value this shipped
    /// with did, and why the heat maps read as fog rather than as data.
    public static let heatEdge = 0.2
    /// The band the intermediate shaping rounds run at. Not a look knob.
    public static let shapingEdge = 0.1

    /// The final feather, in screen pixels rather than in cells. Everything else
    /// here works in units of a cell, and a cell's on-screen size swings 3×
    /// within a zoom level — so this last blur is measured in pixels instead,
    /// and the fade from colour to map is the same width at every zoom.
    ///
    /// A cell's radius on screen is between 2.2 and 6.7 points at every level —
    /// that is what the zoom ladder is for — so the heat feather is held to the
    /// wash's one point rather than to the five it shipped with, which was wider
    /// than the cell it was feathering and ran after the last cut with nothing
    /// left to firm it up again.
    public static let featherPx = 1.0
    public static let heatFeatherPx = 1.0

    /// How opaque the sheet sits on the basemap.
    public static let alpha = 0.3
    public static let heatAlpha = 0.5

    /// Cells are painted as discs, not hexagons: a disc has no orientation, so
    /// the silhouette can never give the lattice away. The six neighbours sit
    /// √3·R away, so a radius above 0.87·R makes them overlap — comfortably
    /// above that, or diagonal neighbours pinch into a string of beads.
    public static let cellRadius = 0.9

    /// Smallest a cell is ever drawn, in sheet pixels. Anything under a pixel
    /// rasterises at partial alpha and the level-set cut then deletes it, which
    /// is how a pinned fine level used to vanish as you zoomed out.
    public static let minCellPx = 0.85

    // MARK: - Cells with nothing around them

    /// The cut cannot keep a feature narrower than the blur, and one cell is
    /// narrower than the blur: a disc of 0.9·R blurred by a sigma of 1·R peaks
    /// at about a third of full alpha, barely over ``level``, and the second
    /// round finishes it off. Measured across the zoom ladder, a lone cell came
    /// out between alpha 0.00 and 0.08 where any cluster came out at 1.00 — so
    /// an isolated cell was not faint, it was erased, and lowering the level to
    /// rescue it would inflate every blob on the map instead.
    ///
    /// So a cell the blur would eat is drawn at the size the cut can hold: this
    /// many cell radii, floored at ``sparseMinPx`` for the coarse sheets where a
    /// multiple of almost nothing is still almost nothing.
    ///
    /// The caller decides which discs these apply to, because it is the only
    /// side that knows the lattice. Only cells with at most
    /// ``sparseNeighbours`` lit neighbours qualify, which is what keeps this
    /// from being a global inflation: every cell along the edge of a real blob
    /// has at least two, so no blob changes shape.
    public static let sparseNeighbours = 1
    public static let sparseGrow = 1.9
    public static let sparseMinPx = 2.0

    // MARK: - The cut

    /// The alpha transfer curve: a smoothstep centred on ``level``.
    ///
    /// Below the band a pixel is outside the blob, above it it is inside, and
    /// the band itself is the rim. Returns 256 bytes, indexed by the blurred
    /// alpha — the same lookup table the JavaScript builds, and the table the
    /// Metal shader uploads as a 1-D texture.
    ///
    /// - Parameter edge: half-width of the ramp, in units of a cell.
    public static func alphaCurve(edge: Double) -> [UInt8] {
        let lo = max(alphaFloor, level - edge) * 255
        // Capped at full alpha as well, so a wide ramp lengthens the fade
        // instead of leaving the blob's core translucent.
        let hi = min(255, max(lo + 1, (level + edge) * 255))

        var curve = [UInt8](repeating: 0, count: 256)
        for a in 0..<256 {
            let t = min(1, max(0, (Double(a) - lo) / (hi - lo)))
            // smoothstep, then JavaScript's rounding — see HexGrid.jsRound.
            curve[a] = UInt8(HexGrid.jsRound(255 * t * t * (3 - 2 * t)))
        }
        // A pixel with no alpha at all stays empty whatever the curve says.
        curve[0] = 0
        return curve
    }

    /// The blur radius the three box passes approximate for a given sigma.
    ///
    /// The JavaScript blurs on the CPU with three box passes because their cost
    /// does not grow with the radius, and three of them approximate a Gaussian
    /// closely enough that nothing can tell. The Metal side uses a real Gaussian
    /// instead — on a GPU there is no reason to approximate the thing you were
    /// approximating *towards* — so this exists to describe the CPU path rather
    /// than to drive the GPU one.
    public static func boxRadius(sigma: Double) -> Int {
        max(1, Int(HexGrid.jsRound(((4 * sigma * sigma + 1).squareRoot() - 1) / 2)))
    }

    /// Sigma is clamped before any blur runs, in both implementations.
    public static func clampedSigma(_ sigma: Double) -> Double {
        min(90, max(0.5, sigma))
    }
}
