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

  func testSendPathResponsesTolerateMissingFields() throws {
    let submission = try JSONDecoder().decode(
      Submission.self,
      from: Data(#"{"status":"pending_approval","pendingApprovals":[{"requestId":"a"},{"command":"x"}]}"#.utf8))
    XCTAssertEqual(submission.pendingApprovals?.map(\.requestId), ["a"])
    XCTAssertEqual(submission.pendingApprovals?.first?.command, "")

    let list = try JSONDecoder().decode(
      ConversationList.self,
      from: Data(#"{"sessions":[{"id":"s","scopeId":"personal:a","threadRef":"web:a:1"},{"id":"broken"}]}"#.utf8))
    XCTAssertEqual(list.sessions.map(\.id), ["s"])

    let transcript = try JSONDecoder().decode(
      Transcript.self,
      from: Data(#"{"items":[{"kind":"UserMessage","createdAt":1},{"kind":"AgentMessage"}],"pins":[{"id":"p"}]}"#.utf8))
    XCTAssertEqual(transcript.items.count, 1)
    XCTAssertEqual(transcript.pins?.first?.addedBy, "")

    let run = try JSONDecoder().decode(
      Run.self, from: Data(#"{"status":"running","input":{"text":"hi"},"activity":[{"marker":"text_start"}]}"#.utf8))
    XCTAssertNil(run.input)
    XCTAssertFalse(run.isFinished)
  }

  func testDecodingFailureNamesMissingKey() {
    XCTAssertEqual(
      try APIClient.decode(ApprovalList.self, from: Data(#"{}"#.utf8), path: "test").approvals.count,
      0)
    XCTAssertThrowsError(
      try APIClient.decode(Approval.self, from: Data(#"{"command":"x"}"#.utf8), path: "test")
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("requestId"))
    }
  }
}
