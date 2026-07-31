import Foundation
import Metal
import MetalPerformanceShaders
import simd

/// One lit cell, ready to paint.
public struct BlobDisc: Sendable {
    /// Centre in sheet pixels, origin top-left.
    public var center: SIMD2<Float>
    /// Radius in sheet pixels.
    public var radius: Float
    /// Straight (non-premultiplied) RGBA, 0…1.
    public var color: SIMD4<Float>

    public init(center: SIMD2<Float>, radius: Float, color: SIMD4<Float>) {
        self.center = center
        self.radius = radius
        self.color = color
    }
}

/// The blob sheet, rendered on the GPU.
///
/// The pipeline is the one in `src/blob-canvas.js`'s `paint()`, step for step:
/// paint every lit cell as a disc, then repeat *blur → re-cut at a fixed alpha*
/// `BlobShaping.rounds` times, then feather the finished shape by a fixed number
/// of screen pixels with no cut afterwards.
///
/// The blur merges neighbouring cells and blends their colours; taking a contour
/// afterwards keeps the blob the size it should be while every dent narrower
/// than the blur fills in and every corner sharper than the blur rounds off.
/// Repeating it relaxes the outline without inflating it — the cells never grow.
public final class BlobRenderer {

    public enum Failure: Error, CustomStringConvertible {
        case noDevice
        case noShaderLibrary(String)
        case pipelineFailed(String)

        public var description: String {
            switch self {
            case .noDevice: "No Metal device — this needs a real GPU."
            case .noShaderLibrary(let why): "Could not load BlobShaders.metal: \(why)"
            case .pipelineFailed(let why): "Could not build a render pipeline: \(why)"
            }
        }
    }

    public let device: MTLDevice
    private let queue: MTLCommandQueue
    private let discPipeline: MTLRenderPipelineState
    private let cutPipeline: MTLRenderPipelineState
    private let copyPipeline: MTLRenderPipelineState
    private let sampler: MTLSamplerState

    /// Intermediates are 16-bit float rather than the 8-bit the canvas is stuck
    /// with. It costs memory and buys headroom: the sheet is blurred, re-cut and
    /// blurred again, and quantising to 256 levels between each of those steps
    /// is where banding in a soft gradient comes from.
    private static let workFormat = MTLPixelFormat.rgba16Float
    /// What is handed out — MapLibre wants 8-bit RGBA.
    public static let outputFormat = MTLPixelFormat.rgba8Unorm

    public init(device: MTLDevice? = nil) throws {
        guard let device = device ?? MTLCreateSystemDefaultDevice() else {
            throw Failure.noDevice
        }
        self.device = device

        guard let queue = device.makeCommandQueue() else {
            throw Failure.noDevice
        }
        self.queue = queue

        let library: MTLLibrary
        do {
            library = try device.makeDefaultLibrary(bundle: Bundle.module)
        } catch {
            throw Failure.noShaderLibrary(String(describing: error))
        }

        func pipeline(
            vertex: String,
            fragment: String,
            blending: Bool,
            format: MTLPixelFormat
        ) throws -> MTLRenderPipelineState {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: vertex)
            descriptor.fragmentFunction = library.makeFunction(name: fragment)
            let attachment = descriptor.colorAttachments[0]!
            attachment.pixelFormat = format
            if blending {
                // Premultiplied source-over: the discs arrive already
                // premultiplied from the fragment shader, so overlapping cells
                // composite the way they do on the canvas.
                attachment.isBlendingEnabled = true
                attachment.rgbBlendOperation = .add
                attachment.alphaBlendOperation = .add
                attachment.sourceRGBBlendFactor = .one
                attachment.sourceAlphaBlendFactor = .one
                attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
                attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            do {
                return try device.makeRenderPipelineState(descriptor: descriptor)
            } catch {
                throw Failure.pipelineFailed("\(vertex)/\(fragment): \(error)")
            }
        }

        discPipeline = try pipeline(
            vertex: "disc_vertex", fragment: "disc_fragment",
            blending: true, format: Self.workFormat
        )
        cutPipeline = try pipeline(
            vertex: "quad_vertex", fragment: "cut_fragment",
            blending: false, format: Self.workFormat
        )
        copyPipeline = try pipeline(
            vertex: "quad_vertex", fragment: "copy_fragment",
            blending: false, format: Self.outputFormat
        )

        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        // Clamped, so the blur at the sheet's rim reads the rim rather than
        // wrapping the far side of the map into it.
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else {
            throw Failure.pipelineFailed("sampler")
        }
        self.sampler = sampler
    }

    // MARK: - Rendering

    /// Paint, blur, cut, feather.
    ///
    /// - Parameters:
    ///   - discs: every lit cell in the padded viewport, in sheet pixels.
    ///   - size: the sheet's size in pixels.
    ///   - unit: a cell's on-screen radius in sheet pixels — the unit every
    ///     blur except the feather is measured in.
    ///   - edge: the final cut's ramp width, in units of a cell.
    ///     `BlobShaping.edge` for the single-colour wash, `.heatEdge` for a heat
    ///     map.
    ///   - featherPx: the closing blur, in sheet pixels.
    /// - Returns: an 8-bit premultiplied RGBA texture.
    public func render(
        discs: [BlobDisc],
        size: (width: Int, height: Int),
        unit: Double,
        edge: Double,
        featherPx: Double
    ) -> MTLTexture? {
        guard size.width > 0, size.height > 0 else { return nil }

        var front = makeTexture(size: size, format: Self.workFormat)
        var back = makeTexture(size: size, format: Self.workFormat)
        guard var sheet = front, var scratch = back else { return nil }

        guard let commands = queue.makeCommandBuffer() else { return nil }

        paintDiscs(discs, into: sheet, size: size, commands: commands)

        // blur → re-cut, twice. Later rounds work on an already-smooth shape, so
        // they need less blur; intermediate rounds cut tightly, because a soft
        // cut halfway through would only get blurred again and lose the
        // definition the next round needs.
        for round in 0..<BlobShaping.rounds {
            let sigma = BlobShaping.clampedSigma(BlobShaping.sigma(round: round, unit: unit))
            blur(sigma: sigma, from: sheet, to: scratch, commands: commands)

            let roundEdge = BlobShaping.edge(round: round, final: edge)
            cut(edge: roundEdge, from: scratch, to: sheet, commands: commands)
        }

        // The feather is measured in screen pixels rather than in cells, so the
        // fade from colour to map is the same width at every zoom — everything
        // above is measured in cells, and a cell's on-screen size swings 3×
        // within a zoom level. Nothing is re-cut afterwards.
        if featherPx > 0.5 {
            blur(sigma: featherPx, from: sheet, to: scratch, commands: commands)
            swap(&sheet, &scratch)
        }

        guard let output = makeTexture(size: size, format: Self.outputFormat, readable: true)
        else { return nil }
        copy(from: sheet, to: output, commands: commands)

        #if os(macOS)
        // Managed memory needs telling that the GPU wrote to it.
        if let blit = commands.makeBlitCommandEncoder() {
            blit.synchronize(resource: output)
            blit.endEncoding()
        }
        #endif

        commands.commit()
        commands.waitUntilCompleted()

        // Keep ARC from reaping the pair mid-flight on a debug build.
        front = nil
        back = nil
        return output
    }

    private func paintDiscs(
        _ discs: [BlobDisc],
        into target: MTLTexture,
        size: (width: Int, height: Int),
        commands: MTLCommandBuffer
    ) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store

        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        defer { encoder.endEncoding() }
        guard !discs.isEmpty else { return }

        encoder.setRenderPipelineState(discPipeline)
        encoder.setVertexBytes(
            discs, length: MemoryLayout<BlobDisc>.stride * discs.count, index: 0
        )
        var sheetSize = SIMD2<Float>(Float(size.width), Float(size.height))
        encoder.setVertexBytes(&sheetSize, length: MemoryLayout<SIMD2<Float>>.stride, index: 1)
        encoder.drawPrimitives(
            type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: discs.count
        )
    }

    private func blur(
        sigma: Double,
        from source: MTLTexture,
        to destination: MTLTexture,
        commands: MTLCommandBuffer
    ) {
        // A real Gaussian rather than three box passes — see the note at the top
        // of BlobShaders.metal. MPS picks its own tap strategy per sigma, which
        // is the part that keeps a blur of a whole cell affordable.
        let gaussian = MPSImageGaussianBlur(device: device, sigma: Float(sigma))
        gaussian.edgeMode = .clamp
        gaussian.encode(commandBuffer: commands, sourceTexture: source, destinationTexture: destination)
    }

    private func cut(
        edge: Double,
        from source: MTLTexture,
        to destination: MTLTexture,
        commands: MTLCommandBuffer
    ) {
        guard let curve = makeCurveTexture(edge: edge) else { return }

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = destination
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store

        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(cutPipeline)
        encoder.setFragmentTexture(source, index: 0)
        encoder.setFragmentTexture(curve, index: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
    }

    private func copy(
        from source: MTLTexture,
        to destination: MTLTexture,
        commands: MTLCommandBuffer
    ) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = destination
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store

        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(copyPipeline)
        encoder.setFragmentTexture(source, index: 0)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
    }

    // MARK: - Resources

    private func makeTexture(
        size: (width: Int, height: Int),
        format: MTLPixelFormat,
        readable: Bool = false
    ) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: format,
            width: size.width,
            height: size.height,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead, .shaderWrite]
        // The intermediates never leave the GPU; the finished sheet has to be
        // read back to become an image, so it gets memory the CPU can see.
        if readable {
            #if os(macOS)
            descriptor.storageMode = .managed
            #else
            descriptor.storageMode = .shared
            #endif
        } else {
            descriptor.storageMode = .private
        }
        return device.makeTexture(descriptor: descriptor)
    }

    /// The finished sheet as premultiplied 8-bit RGBA, row-major, no padding.
    ///
    /// This is what becomes the image handed to MapLibre, and what the tests
    /// assert on.
    public func renderPixels(
        discs: [BlobDisc],
        size: (width: Int, height: Int),
        unit: Double,
        edge: Double,
        featherPx: Double
    ) -> [UInt8]? {
        guard let texture = render(
            discs: discs, size: size, unit: unit, edge: edge, featherPx: featherPx
        ) else { return nil }

        var pixels = [UInt8](repeating: 0, count: size.width * size.height * 4)
        pixels.withUnsafeMutableBytes { raw in
            texture.getBytes(
                raw.baseAddress!,
                bytesPerRow: size.width * 4,
                from: MTLRegionMake2D(0, 0, size.width, size.height),
                mipmapLevel: 0
            )
        }
        return pixels
    }

    /// `BlobShaping.alphaCurve` as a 256-wide 1-D texture. Sampled linearly, so
    /// the shader reads a smooth version of exactly the table the JavaScript
    /// quantises to 256 steps.
    func makeCurveTexture(edge: Double) -> MTLTexture? {
        let curve = BlobShaping.alphaCurve(edge: edge)

        let descriptor = MTLTextureDescriptor()
        descriptor.textureType = .type1D
        descriptor.pixelFormat = .r8Unorm
        descriptor.width = curve.count
        descriptor.usage = .shaderRead
        #if os(macOS)
        descriptor.storageMode = .managed
        #else
        descriptor.storageMode = .shared
        #endif

        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        curve.withUnsafeBytes { bytes in
            texture.replace(
                region: MTLRegionMake1D(0, curve.count),
                mipmapLevel: 0,
                withBytes: bytes.baseAddress!,
                bytesPerRow: curve.count
            )
        }
        return texture
    }
}
