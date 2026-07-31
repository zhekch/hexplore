#include <metal_stdlib>
using namespace metal;

// The blob sheet, on the GPU.
//
// The web app does this on the CPU, and on iOS it does it in JavaScript —
// Safari has never shipped CanvasRenderingContext2D.filter, so `blurRgba` in
// src/blob-canvas.js runs a premultiply pass, three rounds of separable box
// blur in both directions, and an unpremultiply, over the whole sheet, per
// repaint. That cost is why blob-canvas.js:38 caps the sheet at device ratio
// 1.5 where a browser with a native blur gets 3.
//
// Two deliberate differences from the JavaScript, both of them because this is
// a GPU and that was not:
//
//   * The blur is a real Gaussian (MPSImageGaussianBlur), not three box passes.
//     The box passes exist because their cost does not grow with the radius on
//     a CPU; they are approximating a Gaussian, and there is no reason to
//     reproduce the approximation on hardware built for the real thing.
//
//   * Nothing is premultiplied or unpremultiplied in a pass of its own. The
//     discs are blended straight into a premultiplied target, which is the
//     space the blur wants anyway, so two full passes over the sheet simply
//     stop existing.
//
// What is NOT different is the shape: the alpha cut samples the same curve
// `BlobShaping.alphaCurve` builds, which is tested against the real alphaLut in
// src/blob-canvas.js.

// MARK: - Discs

// Cells are painted as discs, not hexagons: a disc has no orientation, so the
// silhouette can never give the lattice away.
struct DiscInstance {
    float2 center;   // sheet pixels, origin top-left
    float  radius;   // sheet pixels
    float4 color;    // straight (non-premultiplied) RGBA, 0…1
};

struct DiscVaryings {
    float4 position [[position]];
    float2 local;      // -1…1 across the quad, so length() is the disc's own radius
    float4 color;
    float  radiusPx;
};

vertex DiscVaryings disc_vertex(uint vid [[vertex_id]],
                                uint iid [[instance_id]],
                                constant DiscInstance *discs [[buffer(0)]],
                                constant float2 &sheetSize [[buffer(1)]])
{
    // A unit quad as a 4-vertex triangle strip.
    float2 corner = float2((vid & 1) ? 1.0 : -1.0, (vid & 2) ? 1.0 : -1.0);

    DiscInstance disc = discs[iid];
    float2 posPx = disc.center + corner * disc.radius;

    float2 ndc = (posPx / sheetSize) * 2.0 - 1.0;
    ndc.y = -ndc.y;   // the sheet counts y downward; Metal's clip space counts up

    DiscVaryings out;
    out.position = float4(ndc, 0.0, 1.0);
    out.local = corner;
    out.color = disc.color;
    out.radiusPx = disc.radius;
    return out;
}

fragment float4 disc_fragment(DiscVaryings in [[stage_in]])
{
    float dist = length(in.local);

    // One sheet pixel of antialiasing, expressed in the quad's own units. The
    // whole sheet is about to be blurred by roughly a cell, so this matters
    // less than it looks — but a hard-edged disc smaller than a few pixels
    // aliases into a square, and MIN_CELL_PX exists precisely because cells do
    // get that small.
    float aa = max(1.0 / max(in.radiusPx, 1.0), 1e-4);
    float alpha = (1.0 - smoothstep(1.0 - aa, 1.0, dist)) * in.color.a;

    // Premultiplied, to be blended with (one, oneMinusSourceAlpha).
    return float4(in.color.rgb * alpha, alpha);
}

// MARK: - Full-sheet passes

struct QuadVaryings {
    float4 position [[position]];
    float2 uv;
};

vertex QuadVaryings quad_vertex(uint vid [[vertex_id]])
{
    float2 corner = float2((vid & 1) ? 1.0 : -1.0, (vid & 2) ? 1.0 : -1.0);

    QuadVaryings out;
    out.position = float4(corner, 0.0, 1.0);
    out.uv = float2((corner.x + 1.0) * 0.5, 1.0 - (corner.y + 1.0) * 0.5);
    return out;
}

// The level-set re-cut.
//
// Only the alpha channel is decided here; the blurred — and therefore blended —
// colours survive untouched, which is what lets neighbouring cells of different
// shades flow into one another. `curve` is BlobShaping.alphaCurve uploaded as a
// 256-wide 1-D texture, sampled linearly, so the shader gets a smooth reading
// of exactly the table the JavaScript quantises to 256 steps.
fragment float4 cut_fragment(QuadVaryings in [[stage_in]],
                             texture2d<float> src [[texture(0)]],
                             texture1d<float> curve [[texture(1)]],
                             sampler samp [[sampler(0)]])
{
    float4 premultiplied = src.sample(samp, in.uv);
    float alpha = premultiplied.a;

    // An empty pixel stays empty however wide the ramp is opened — the rule
    // that keeps the sheet's own rectangular edge off the map.
    if (alpha <= 0.0) {
        return float4(0.0);
    }

    float3 straight = premultiplied.rgb / alpha;
    float mapped = curve.sample(samp, alpha).r;

    return float4(straight * mapped, mapped);
}

/// Straight copy, for the final feather where nothing is re-cut: the tail is
/// left as the blur made it, so it fades out with correct colours all the way
/// down to nothing.
fragment float4 copy_fragment(QuadVaryings in [[stage_in]],
                              texture2d<float> src [[texture(0)]],
                              sampler samp [[sampler(0)]])
{
    return src.sample(samp, in.uv);
}
