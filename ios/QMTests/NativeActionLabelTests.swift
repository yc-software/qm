import SwiftUI
import UIKit
import XCTest

@testable import QM

@MainActor
final class NativeActionLabelTests: XCTestCase {
  func testCompactLabelsFitNavigationBarAtLargestAccessibilitySize() throws {
    for title in ["Save", "Create", "Restore", "Review", "Approve", "Return"] {
      for busy in [false, true] {
        let renderer = ImageRenderer(
          content: NativeActionLabel(
            title: title, busyTitle: "Saving changes to this connection", busy: busy, compact: true
          )
          .font(.body)
          .environment(\.dynamicTypeSize, .accessibility5)
          .environment(\.scenePhase, .inactive))
        renderer.proposedSize = ProposedViewSize(width: 120, height: nil)
        renderer.scale = 1

        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertLessThanOrEqual(image.size.width, 120)
        XCTAssertGreaterThan(image.size.height, 0)
        XCTAssertLessThanOrEqual(image.size.height, 32, "\(title), busy: \(busy)")
      }
    }
  }

  func testFormLabelWrapsItsBusyTitleAtLargestAccessibilitySize() throws {
    var heights: [CGFloat] = []
    for busy in [false, true] {
      let renderer = ImageRenderer(
        content: NativeActionLabel(
          title: "Save", busyTitle: "Saving changes to this connection", busy: busy
        )
        .font(.body)
        .environment(\.dynamicTypeSize, .accessibility5)
        .environment(\.scenePhase, .inactive))
      renderer.proposedSize = ProposedViewSize(width: 220, height: nil)
      renderer.scale = 1

      let image = try XCTUnwrap(renderer.uiImage)
      XCTAssertGreaterThan(image.size.width, 0)
      XCTAssertLessThanOrEqual(image.size.width, 220)
      XCTAssertGreaterThan(image.size.height, 44)
      heights.append(image.size.height)
    }
    XCTAssertGreaterThan(heights[1], heights[0] * 2)
  }
}
