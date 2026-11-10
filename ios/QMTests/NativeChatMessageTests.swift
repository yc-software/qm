import SwiftUI
import XCTest

@testable import QM

@MainActor
final class NativeChatMessageTests: XCTestCase {
  func testLongPromptRemainsFullyVisible() throws {
    let renderer = ImageRenderer(
      content: NativeChatMessageView(
        message: ChatMessage(
          id: "prompt", role: "user",
          text: String(repeating: "A longer prompt paragraph.\n\n", count: 20)),
        client: APIClient(baseURL: URL(string: "https://example.test")!),
        showSpeaker: false, user: "test"
      )
      .frame(width: 320))
    renderer.scale = 1
    let image = try XCTUnwrap(renderer.uiImage)
    XCTAssertGreaterThan(image.size.height, 600)
  }

  func testLongAssistantReplyRemainsFullyVisible() throws {
    let renderer = ImageRenderer(
      content: NativeChatMessageView(
        message: ChatMessage(
          id: "reply", role: "assistant",
          text: String(repeating: "A complete answer paragraph.\n\n", count: 20)),
        client: APIClient(baseURL: URL(string: "https://example.test")!),
        showSpeaker: false, user: "test"
      )
      .frame(width: 320))
    renderer.scale = 1
    let image = try XCTUnwrap(renderer.uiImage)
    XCTAssertGreaterThan(image.size.height, 600)
    XCTAssertEqual(image.size.width, 320)
  }
}
