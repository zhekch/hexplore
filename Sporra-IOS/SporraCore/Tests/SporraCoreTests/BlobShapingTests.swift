import Testing

@testable import SporraCore

/// The blob shaping curve, checked against the real `alphaLut` in
/// src/blob-canvas.js.
///
/// This is the function that decides where a blob's edge is. A Metal shader
/// that disagrees with it by a few percent does not look like a bug — it looks
/// like slightly different blobs, which is the kind of wrong that ships.
@Suite("Blob shaping")
struct BlobShapingTests {

    @Test("the tuning constants match the JavaScript")
    func constants() {
        #expect(BlobShaping.blur == BlobVectors.Constants.blur)
        #expect(BlobShaping.rounds == BlobVectors.Constants.rounds)
        #expect(BlobShaping.level == BlobVectors.Constants.level)
        #expect(BlobShaping.alphaFloor == BlobVectors.Constants.alphaFloor)
        #expect(BlobShaping.edge == BlobVectors.Constants.edge)
        #expect(BlobShaping.heatEdge == BlobVectors.Constants.heatEdge)
        #expect(BlobShaping.featherPx == BlobVectors.Constants.featherPx)
        #expect(BlobShaping.heatFeatherPx == BlobVectors.Constants.heatFeatherPx)
        #expect(BlobShaping.alpha == BlobVectors.Constants.alpha)
        #expect(BlobShaping.heatAlpha == BlobVectors.Constants.heatAlpha)
    }

    /// All 256 entries, for each of the three edge widths the app uses. The
    /// whole curve rather than samples of it, because the interesting failures
    /// are at the ends of the ramp rather than in the middle.
    @Test("the single-colour curve matches entry for entry")
    func singleCurve() {
        expectCurve(edge: BlobShaping.edge, matches: BlobVectors.singleLut, named: "single")
    }

    @Test("and so does the heat curve")
    func heatCurve() {
        expectCurve(edge: BlobShaping.heatEdge, matches: BlobVectors.heatLut, named: "heat")
    }

    @Test("and the tight band the shaping rounds run at")
    func shapingCurve() {
        expectCurve(edge: BlobShaping.shapingEdge, matches: BlobVectors.shapingLut, named: "shaping")
    }

    /// The same expectations again as loose samples, so a failure names the
    /// input that broke rather than reporting one mismatched array.
    @Test("sampled points of every curve")
    func samples() {
        for sample in BlobVectors.samples {
            let curve = BlobShaping.alphaCurve(edge: sample.edge)
            #expect(
                Int(curve[sample.input]) == sample.expected,
                "alphaCurve(edge: \(sample.edge))[\(sample.input)]"
            )
        }
    }

    /// The floor is the rule that keeps the sheet's rectangular edge off the
    /// map, so it gets its own assertion rather than being implied by the curve.
    @Test("an empty pixel stays empty however wide the ramp is opened")
    func emptyStaysEmpty() {
        for edge in [0.1, 0.3, 0.6, 1.0, 5.0] {
            let curve = BlobShaping.alphaCurve(edge: edge)
            #expect(curve[0] == 0, "edge \(edge) must leave alpha 0 alone")
        }
    }

    /// Monotonic, because a transfer curve that dips would carve a ring out of
    /// the rim of every blob.
    @Test("the curve never goes backwards")
    func monotonic() {
        for edge in [BlobShaping.edge, BlobShaping.heatEdge, BlobShaping.shapingEdge] {
            let curve = BlobShaping.alphaCurve(edge: edge)
            // Index 0 is forced to zero, so the run starts at 1.
            for a in 2..<256 {
                #expect(curve[a] >= curve[a - 1], "edge \(edge) dipped at \(a)")
            }
        }
    }

    @Test("the box radius the CPU path derives from sigma")
    func boxRadius() {
        // Pinned so the CPU description stays honest if anyone reads it as the
        // GPU's radius. sqrt(4s^2+1) - 1 over 2, rounded, floored at 1.
        #expect(BlobShaping.boxRadius(sigma: 0.5) == 1)
        #expect(BlobShaping.boxRadius(sigma: 1) == 1)
        #expect(BlobShaping.boxRadius(sigma: 4) == 4)
        #expect(BlobShaping.boxRadius(sigma: 10) == 10)
    }

    @Test("sigma is clamped before any blur runs")
    func sigmaClamp() {
        #expect(BlobShaping.clampedSigma(0) == 0.5)
        #expect(BlobShaping.clampedSigma(1000) == 90)
        #expect(BlobShaping.clampedSigma(3) == 3)
    }

    private func expectCurve(edge: Double, matches expected: [UInt8], named name: String) {
        let curve = BlobShaping.alphaCurve(edge: edge)
        #expect(curve.count == expected.count)
        for a in 0..<min(curve.count, expected.count) where curve[a] != expected[a] {
            Issue.record("\(name) curve differs at \(a): got \(curve[a]), expected \(expected[a])")
        }
    }
}
