import SwiftUI
import XCTest

@testable import QM

@MainActor
final class ConsentShots: XCTestCase {
  let workspace = URL(string: "https://qm.example.com")!
  func testConsentScreen() throws {
    UserDefaults.standard.removeObject(forKey: AIConsent.key)
    try shoot(AIConsentScreen(workspace: workspace) {}, "after-consent")
    try shoot(AIConsentScreen(workspace: workspace) {}, "after-consent-dark", dark: true)
  }
  func testConsentSettings() throws {
    UserDefaults.standard.set(workspace.absoluteString, forKey: AIConsent.key)
    try shoot(NavigationStack { AIConsentSettings(workspace: workspace) }, "after-ai-data-sharing")
  }
}
