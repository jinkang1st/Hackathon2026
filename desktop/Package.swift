// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MessageGuard",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "MessageGuard", targets: ["MessageGuard"])],
    targets: [
        .target(name: "MessageGuardCore"),
        .executableTarget(name: "MessageGuard", dependencies: ["MessageGuardCore"]),
        .testTarget(name: "MessageGuardCoreTests", dependencies: ["MessageGuardCore"])
    ]
)
