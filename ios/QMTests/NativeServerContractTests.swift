import XCTest

@testable import QM

final class NativeServerContractTests: XCTestCase {
  func testFeatureRolloutUsesServerFlagList() throws {
    let json = #"""
      {"featureFlags":[
        {"featureName":"swarms","label":"Swarms","personalOnly":true,"enabledScopes":["personal:a"]},
        {"featureName":"team_scopes","label":"Team scopes","enabledScopes":[]},
        {"featureName":"future_flag","enabledScopes":[],"updatedAt":1,"updatedBy":"x"}
      ]}
      """#
    let flags = try XCTUnwrap(
      JSONDecoder().decode(NativeAdminFlags.Configuration.self, from: Data(json.utf8)).featureFlags)
    XCTAssertEqual(flags.map(\.featureName), ["swarms", "team_scopes", "future_flag"])
    XCTAssertEqual(flags.map(\.title), ["Swarms", "Team scopes", "future flag"])
    XCTAssertTrue(flags[0].accepts("personal:b"))
    XCTAssertFalse(flags[0].accepts("org:o"))
    XCTAssertTrue(flags[1].accepts("org:o"))
  }

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
  }
}
