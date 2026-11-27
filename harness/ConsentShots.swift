import SwiftUI
import XCTest

@testable import QM

@MainActor
final class ConsentShots: XCTestCase {
  func testConsentScreen() throws {
    UserDefaults.standard.removeObject(forKey: AIConsent.key)
    try shoot(AIConsentScreen {}, "after-consent")
    try shoot(AIConsentScreen {}, "after-consent-dark", dark: true)
  }
  func testConsentSettings() throws {
    UserDefaults.standard.set(true, forKey: AIConsent.key)
    try shoot(NavigationStack { AIConsentSettings() }, "after-ai-data-sharing")
  }
}
