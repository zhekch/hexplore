// swift-tools-version: 6.0
import PackageDescription

// The parts of the app that are maths rather than interface: the hex lattice,
// and in time the blob geometry and the API models.
//
// It is a package rather than more files in the app target for one reason —
// `swift test` runs it on the Mac in a second, with no simulator, no signing
// and no Xcode. The pure core is exactly the part that most needs testing and
// least needs a device.
let package = Package(
    name: "SporraCore",
    // iOS 16 is the app's floor, so the core has to reach at least that far
    // back. MapLibre itself goes to 12, and nothing here needs anything newer:
    // the Metal and Metal Performance Shaders calls the blob renderer makes have
    // all been available since iOS 10.
    //
    // macOS is here only so `swift test` can run the maths and the GPU pipeline
    // on the Mac, with no simulator involved.
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "SporraCore", targets: ["SporraCore"]),
    ],
    targets: [
        .target(name: "SporraCore"),
        .testTarget(name: "SporraCoreTests", dependencies: ["SporraCore"]),
    ]
)
