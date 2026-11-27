import SwiftUI
import XCTest

@testable import QM

@MainActor
func shoot<V: View>(_ view: V, _ name: String, dark: Bool = false) throws {
  let size = CGSize(width: 820, height: 1180)  // iPad Air 11-inch, portrait
  let window = UIWindow(frame: CGRect(origin: .zero, size: size))
  window.overrideUserInterfaceStyle = dark ? .dark : .light
  window.rootViewController = UIHostingController(rootView: view)
  window.makeKeyAndVisible()
  RunLoop.main.run(until: Date().addingTimeInterval(2))
  let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
    _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
  }
  let dir = URL(fileURLWithPath: "/tmp/qm-consent-shots")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  try image.pngData()!.write(to: dir.appendingPathComponent(name + ".png"))
  window.isHidden = true
}

@MainActor
final class SettingsShots: XCTestCase {
  func testSettings() throws {
    let client = APIClient(baseURL: URL(string: "https://qm.example.com")!)
    let identity = Identity(user: "reviewer", companyName: "Y Combinator", displayName: "App Reviewer")
    try shoot(
      NavigationStack { NativeSettingsView(client: client, identity: identity) },
      ProcessInfo.processInfo.environment["SHOT_PREFIX", default: "x"] + "-settings")
  }
}
