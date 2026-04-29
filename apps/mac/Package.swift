// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OasisEcho",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OasisEcho", targets: ["OasisEcho"])
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "2.0.0")
    ],
    targets: [
        .executableTarget(
            name: "OasisEcho",
            dependencies: [
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts")
            ],
            path: "Sources/OasisEcho"
        )
    ]
)
