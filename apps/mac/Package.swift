// swift-tools-version:6.0
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
            path: "Sources/OasisEcho",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OasisEchoTests",
            dependencies: ["OasisEcho"],
            path: "Tests/OasisEchoTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
