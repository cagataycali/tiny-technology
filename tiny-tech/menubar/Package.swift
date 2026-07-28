// swift-tools-version: 6.0
import PackageDescription

// tiny-menubar — the menu-bar half of the tray protocol (src/tray.ts).
//
// Two targets on purpose. Everything that can be wrong — decoding a reply,
// checking the protocol version, deciding what the menu says — lives in
// TinyMenuKit, which imports no AppKit and is therefore testable by `swift test`
// with no window server, no status item, and no running daemon. The executable
// is the thin part: an NSStatusItem that renders what the library decided.
let package = Package(
  name: "tiny-menubar",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "tiny-menubar", targets: ["tiny-menubar"]),
    .library(name: "TinyMenuKit", targets: ["TinyMenuKit"]),
  ],
  targets: [
    .target(name: "TinyMenuKit"),
    .executableTarget(name: "tiny-menubar", dependencies: ["TinyMenuKit"]),
    .testTarget(name: "TinyMenuKitTests", dependencies: ["TinyMenuKit"]),
  ]
)
