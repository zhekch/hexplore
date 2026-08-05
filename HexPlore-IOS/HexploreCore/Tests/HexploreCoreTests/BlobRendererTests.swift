import Metal
import Testing
import simd

@testable import HexploreCore

/// The Metal blob pipeline, rendered headlessly on whatever GPU is running the
/// tests.
///
/// These are behavioural rather than pixel-exact against the JavaScript, and
/// deliberately so: the GPU path uses a real Gaussian where the canvas uses
/// three box passes approximating one, so the two agree in shape and not bit
/// for bit. What must hold exactly is the *cut* — the curve that decides where
/// an edge is — and that is pinned in `BlobShapingTests` against the real
/// `alphaLut`.
///
/// Skipped rather than failed where there is no GPU, so the maths suites still
/// run on a machine that has none.
@Suite("Blob renderer")
struct BlobRendererTests {

    static let sheet = (width: 256, height: 256)

    private func makeRenderer() throws -> BlobRenderer? {
        guard MTLCreateSystemDefaultDevice() != nil else { return nil }
        return try BlobRenderer()
    }

    /// Alpha at a pixel, from the premultiplied RGBA the renderer hands back.
    private func alpha(_ pixels: [UInt8], _ x: Int, _ y: Int) -> Int {
        Int(pixels[(y * Self.sheet.width + x) * 4 + 3])
    }

    @Test("it builds its pipelines and shaders at all")
    func pipelinesCompile() throws {
        guard try makeRenderer() != nil else { return }
    }

    /// The shape test: a cluster of cells in the middle must come out solid in
    /// the middle and empty at the rim, with the sheet's own corners untouched.
    /// A cut that inflated the blob would light the corners; one that ate it
    /// would leave the centre dim.
    @Test("a cluster of cells is solid in the middle and empty at the edges")
    func clusterIsSolidInTheMiddle() throws {
        guard let renderer = try makeRenderer() else { return }

        let unit = 12.0
        var discs: [BlobDisc] = []
        for dx in -1...1 {
            for dy in -1...1 {
                discs.append(
                    BlobDisc(
                        center: SIMD2(
                            Float(128 + dx * Int(unit * 1.5)),
                            Float(128 + dy * Int(unit * 1.7))
                        ),
                        radius: Float(unit * BlobShaping.cellRadius),
                        color: SIMD4(0.38, 0.67, 1.0, 1.0)
                    )
                )
            }
        }

        let pixels = try #require(
            renderer.renderPixels(
                discs: discs,
                size: Self.sheet,
                unit: unit,
                edge: BlobShaping.edge,
                featherPx: BlobShaping.featherPx
            )
        )

        #expect(alpha(pixels, 128, 128) > 200, "the middle of a cluster should be solid")
        #expect(alpha(pixels, 2, 2) == 0, "the sheet's corner should be untouched")
        #expect(alpha(pixels, 253, 253) == 0, "and the opposite corner too")
    }

    /// The rule that keeps the sheet's rectangular edge off the map: an empty
    /// sheet must come back completely empty, however wide the ramp is opened.
    /// This is the failure the ALPHA_FLOOR clamp exists to prevent, and it is
    /// visible as a tinted rectangle over the whole map rather than as a subtle
    /// difference.
    @Test("nothing lit means nothing drawn, at every edge width")
    func emptySheetStaysEmpty() throws {
        guard let renderer = try makeRenderer() else { return }

        for edge in [BlobShaping.edge, BlobShaping.heatEdge, 1.0] {
            let pixels = try #require(
                renderer.renderPixels(
                    discs: [],
                    size: Self.sheet,
                    unit: 12,
                    edge: edge,
                    featherPx: BlobShaping.featherPx
                )
            )
            let lit = pixels.enumerated().filter { $0.offset % 4 == 3 && $0.element > 0 }
            #expect(lit.isEmpty, "edge \(edge) tinted \(lit.count) empty pixels")
        }
    }

    /// A blob must not grow just because the rim was softened. This is the whole
    /// point of cutting at a fixed alpha level rather than simply blurring:
    /// "the cells never grow, the outline just relaxes".
    ///
    /// Measured on a cluster rather than on one cell, deliberately. The blur
    /// sigma is a whole cell radius and it runs twice, so a *lone* disc comes
    /// out genuinely faint — by hand, about 116/255 at its peak — and the
    /// JavaScript does the same thing to it. Testing inflation on that case
    /// would be testing two properties at once and blaming the wrong one.
    @Test("a softer edge does not inflate the blob")
    func softEdgeDoesNotInflate() throws {
        guard let renderer = try makeRenderer() else { return }

        let unit = 12.0
        let discs = (-1...1).flatMap { dx in
            (-1...1).map { dy in
                BlobDisc(
                    center: SIMD2(
                        Float(128 + dx * Int(unit * 1.5)),
                        Float(128 + dy * Int(unit * 1.7))
                    ),
                    radius: Float(unit * BlobShaping.cellRadius),
                    color: SIMD4(1, 1, 1, 1)
                )
            }
        }

        func litPixels(edge: Double) throws -> Int {
            let pixels = try #require(
                renderer.renderPixels(
                    discs: discs, size: Self.sheet, unit: unit, edge: edge, featherPx: 0
                )
            )
            return stride(from: 3, to: pixels.count, by: 4).count { pixels[$0] > 128 }
        }

        let tight = try litPixels(edge: 0.1)
        let soft = try litPixels(edge: BlobShaping.heatEdge)

        #expect(tight > 0, "a cluster should draw something solid")
        // The soft rim spreads the ramp, so the half-alpha contour moves a
        // little — but it must stay the same shape, not balloon.
        #expect(Double(soft) < Double(tight) * 1.6, "soft: \(soft), tight: \(tight)")
    }

    /// The companion to the above: a single cell must still leave a mark, even
    /// though two rounds of blurring by a whole cell radius take it well below
    /// full strength. Faint is correct here; invisible would not be.
    @Test("one lone cell still draws something")
    func loneCellSurvives() throws {
        guard let renderer = try makeRenderer() else { return }

        let unit = 12.0
        let pixels = try #require(
            renderer.renderPixels(
                discs: [
                    BlobDisc(
                        center: SIMD2(128, 128),
                        radius: Float(unit * BlobShaping.cellRadius),
                        color: SIMD4(1, 1, 1, 1)
                    )
                ],
                size: Self.sheet,
                unit: unit,
                edge: BlobShaping.edge,
                featherPx: BlobShaping.featherPx
            )
        )

        #expect(alpha(pixels, 128, 128) > 0, "a lone cell should not vanish entirely")
        #expect(alpha(pixels, 2, 2) == 0, "and it should not reach the corner")
    }

    /// The curve texture is the shader's only input that decides shape, so it
    /// has to carry exactly what the tested Swift curve produces.
    @Test("the curve uploaded to the GPU is the curve the tests pinned")
    func curveTextureMatches() throws {
        guard let renderer = try makeRenderer() else { return }

        let edge = BlobShaping.edge
        let texture = try #require(renderer.makeCurveTexture(edge: edge))
        #expect(texture.width == 256)

        var readback = [UInt8](repeating: 0, count: 256)
        readback.withUnsafeMutableBytes { raw in
            texture.getBytes(
                raw.baseAddress!,
                bytesPerRow: 256,
                from: MTLRegionMake1D(0, 256),
                mipmapLevel: 0
            )
        }

        #expect(readback == BlobShaping.alphaCurve(edge: edge))
    }
}
