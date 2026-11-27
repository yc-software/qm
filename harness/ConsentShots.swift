import SwiftUI
import XCTest

@testable import QM

@MainActor
final class ConsentShots: XCTestCase {
  override func setUp() { UserDefaults.standard.removeObject(forKey: AIConsent.key) }
  func testConsentSheet() throws {
    try shoot(
      QMTheme.paper.ignoresSafeArea().sheet(isPresented: .constant(true)) { AIConsentSheet() },
      "after-consent-sheet")
    try shoot(
      QMTheme.paper.ignoresSafeArea().sheet(isPresented: .constant(true)) { AIConsentSheet() },
      "after-consent-sheet-dark", dark: true)
  }
  func testConsentSettings() throws {
    UserDefaults.standard.set(true, forKey: AIConsent.key)
    try shoot(NavigationStack { AIConsentSettings() }, "after-ai-data-sharing")
  }
}
