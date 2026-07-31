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
    name: "HexploreCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "HexploreCore", targets: ["HexploreCore"]),
    ],
    targets: [
        .target(name: "HexploreCore"),
        .testTarget(name: "HexploreCoreTests", dependencies: ["HexploreCore"]),
    ]
)
