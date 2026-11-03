import XCTest

@testable import QM

final class NativeServerContractTests: XCTestCase {
  func testInboxFeedDecodesWithoutMigrationField() throws {
    let json = #"{"selected":[],"available":[],"items":[],"total":0}"#
    let feed = try JSONDecoder().decode(NativeInboxFeed.self, from: Data(json.utf8))
    XCTAssertEqual(feed.total, 0)
    XCTAssertNil(feed.nextCursor)
  }

  func testSentChatTextIsTrimmedToServerLimitAndReported() throws {
    func email(_ body: String) throws -> NativeSentEmail {
      let object: [String: Any] = [
        "id": "m", "threadId": "t", "to": "a@example.com", "subject": "s", "sentAt": 1,
        "body": body,
      ]
      return try JSONDecoder().decode(
        NativeSentEmail.self, from: JSONSerialization.data(withJSONObject: object))
    }
    let short = try email("hello")
    XCTAssertFalse(short.chatTrimmed)
    XCTAssertEqual(short.chatText, "hello")
    let exact = try email(String(repeating: "a", count: NativeSentEmail.chatLimit))
    XCTAssertFalse(exact.chatTrimmed)
    XCTAssertEqual(exact.chatText.utf16.count, NativeSentEmail.chatLimit)
    let long = try email(String(repeating: "😀", count: NativeSentEmail.chatLimit))
    XCTAssertTrue(long.chatTrimmed)
    XCTAssertLessThanOrEqual(long.chatText.utf16.count, NativeSentEmail.chatLimit)
    XCTAssertGreaterThan(long.chatText.utf16.count, NativeSentEmail.chatLimit - 2)
    XCTAssertTrue(long.chatSource.hasPrefix(long.chatText))
    let straddling = try email(String(repeating: "a", count: NativeSentEmail.chatLimit - 1) + "😀b")
    XCTAssertTrue(straddling.chatTrimmed)
    XCTAssertEqual(
      straddling.chatText, String(repeating: "a", count: NativeSentEmail.chatLimit - 1))
  }
}
