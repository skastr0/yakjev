// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "YakjevGraphCore",
  products: [.library(name: "YakjevGraphCore", targets: ["YakjevGraphCore"])],
  targets: [
    .target(name: "YakjevGraphCore", path: "ios/Core"),
    .testTarget(name: "YakjevGraphCoreTests", dependencies: ["YakjevGraphCore"], path: "Tests"),
  ]
)
