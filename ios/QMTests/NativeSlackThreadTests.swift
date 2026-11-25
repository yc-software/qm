import XCTest

@testable import QM

final class NativeSlackThreadTests: XCTestCase {
  func testStacksRepeatSlackSpeakersFromTranscriptItems() throws {
    let json = """
      [
        {"kind":"UserMessage","seq":1,"createdAt":1,"text":"a","externalId":"1.1",
         "body":{"name":"eve","speakerId":"eve@x","overheard":true}},
        {"kind":"UserMessage","seq":2,"createdAt":2,"text":"b","externalId":"1.2",
         "body":{"name":"eve","speakerId":"eve@x","overheard":true}},
        {"kind":"UserMessage","seq":3,"createdAt":3,"text":"c","body":{"name":"ann"}}
      ]
      """
    let items = try JSONDecoder().decode([Item].self, from: Data(json.utf8))
    let messages = chatMessages(items, surface: "slack")
    XCTAssertEqual(messages.map(\.speakerID), ["eve@x", "eve@x", nil])
    XCTAssertEqual(NativeSlackThreadLayout(messages).continued, [messages[1].id])
    XCTAssertEqual(messages.map(NativeSlackThreadLayout.shows), [true, true, false])
    XCTAssertFalse(
      NativeSlackThreadLayout.shows(ChatMessage(id: "activity", role: "assistant", text: "")))
  }
}
