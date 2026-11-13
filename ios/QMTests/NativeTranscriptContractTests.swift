import XCTest

@testable import QM

final class NativeTranscriptContractTests: XCTestCase {
  private func item(
    _ kind: String, seq: Int = 1, text: String? = nil,
    body: [String: Any] = [:], columns: [String: Any] = [:]
  ) -> [String: Any] {
    var row: [String: Any] = [
      "kind": kind, "sessionId": "conversation", "seq": seq, "createdAt": seq * 1000,
      "turnId": "turn", "body": body,
    ]
    row["text"] = text.map { $0 as Any } ?? NSNull()
    row.merge(columns) { _, column in column }
    return row
  }

  private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
  }

  func testItemsTranscriptPreservesMessagesToolsReasoningAndPagination() throws {
    let history = try decode(
      Transcript.self,
      [
        "items": [
          item(
            "UserMessage", text: "Check the file", body: ["name": "Alice"],
            columns: ["externalId": "100.1", "author": "alice"]),
          item("Reasoning", seq: 2, text: "Checking the contents", body: ["type": "thinking"]),
          item(
            "ToolCall", seq: 3, body: ["command": "cat report.txt", "purpose": "Read report"],
            columns: ["callId": "read", "tool": "execute", "step": 2]),
          item(
            "ToolResult", seq: 4, text: "File contents", body: ["ok": true, "count": 1],
            columns: ["callId": "read", "tool": "execute", "isError": false]),
          item("AgentMessage", seq: 5, text: "Here is the report"),
        ],
        "earlierItems": 7,
        "session": ["id": "conversation", "scopeId": "personal:alice", "threadRef": "web:chat"],
      ])
    XCTAssertEqual(history.items.count, 5)
    XCTAssertEqual(history.earlierItems, 7)
    let messages = chatMessages(history.items)
    XCTAssertEqual(messages.map(\.text), ["Check the file", "Here is the report"])
    XCTAssertEqual(messages.map(\.runID), ["turn", "turn"])
    XCTAssertEqual(messages.first?.speaker, "Alice")
    XCTAssertEqual(messages.first?.slackTimestamp, "100.1")
    XCTAssertEqual(
      messages.last?.activity.map(\.presentationRole), ["thinking", "tool_call", "tool_result"])
    XCTAssertEqual(history.items[1].text, "Checking the contents")
    XCTAssertEqual(history.items[2].body?.command, "cat report.txt")
    XCTAssertEqual(history.items[2].callId, "read")
    XCTAssertEqual(history.items[2].step, 2)
    XCTAssertEqual(history.items[3].text, "File contents")
    XCTAssertEqual(history.items[3].details?["count"], .number(1))
    XCTAssertEqual(history.items.last?.kind, "AgentMessage")
    XCTAssertEqual(history.items.last?.seq, 5)
    XCTAssertEqual(history.items.last?.createdAt, 5000)
  }

  func testItemsEnvelopeIsAuthoritativeAndInvalidHistoryStillFails() throws {
    XCTAssertThrowsError(try decode(Transcript.self, ["session": NSNull()]))
    XCTAssertThrowsError(try decode(Transcript.self, ["items": NSNull()]))
    var malformed = item("AgentMessage", text: "Answer")
    malformed.removeValue(forKey: "createdAt")
    XCTAssertThrowsError(try decode(Transcript.self, ["items": [malformed]]))
    malformed = item("ToolCall", body: ["command": "pwd"])
    XCTAssertThrowsError(try decode(Transcript.self, ["items": [malformed]]))
    malformed = item("UserMessage", text: "Question", columns: ["hidden": "false"])
    XCTAssertThrowsError(try decode(Transcript.self, ["items": [malformed]]))
  }

  func testWrappedRunActivityAndStreamSnapshotsUseTheSameItemProjection() throws {
    let activity: [[String: Any]] = [
      [
        "marker": "text_start", "seq": 1, "createdAt": 1000, "phase": "commentary",
        "streamOffset": 2,
      ],
      ["item": item("Reasoning", seq: 2, text: "Checking")],
      [
        "item": item(
          "ToolCall", seq: 3, body: ["path": "report.txt"],
          columns: ["callId": "read", "tool": "file"])
      ],
    ]
    let run = try decode(Run.self, ["status": "running", "activity": activity])
    let event = try decode(
      StreamEvent.self,
      ["type": "CUSTOM", "name": "run", "value": ["status": "running", "activity": activity]])
    XCTAssertEqual(run.activity?.map(\.presentationRole), ["text_start", "thinking", "tool_call"])
    XCTAssertEqual(event.run?.activity?.map(\.id), run.activity?.map(\.id))
    XCTAssertEqual(run.activity?.first?.details?["streamOffset"], .number(2))
    XCTAssertEqual(run.activity?.last?.details?["path"]?.string, "report.txt")
    XCTAssertEqual(run.activity?.last?.kind, "ToolCall")
  }

  func testNarrationDeliveredFilesAndToolOutputKeepTheirVariants() throws {
    let items = try decode(
      [Item].self,
      [
        item("AgentMessage", text: "Working", columns: ["variant": "narration"]),
        item(
          "AgentMessage", seq: 2, body: ["files": [["name": "report.txt", "artifactId": "file"]]],
          columns: ["variant": "files_delivered"]),
        item(
          "ToolResult", seq: 3, body: ["output": ["bytes": 10], "ok": false],
          columns: ["callId": "read", "tool": "execute", "blobSha": "blob", "isError": true]),
      ])
    XCTAssertEqual(items.map(\.presentationRole), ["text", "delivery", "tool_result"])
    XCTAssertEqual(items[1].body?.files?.first?.artifactId, "file")
    XCTAssertEqual(items[2].details?["output"]?["bytes"], .number(10))
    XCTAssertEqual(items[2].details?["blobSha"]?.string, "blob")
    XCTAssertFalse(items[2].succeeded)
  }

  func testSteeringApprovalRevisionAndErrorMetadataRemainVisible() throws {
    let history = try decode(
      Transcript.self,
      [
        "items": [
          item("UserMessage", text: "Original", columns: ["externalId": "100.1"]),
          item("SteeringMessage", seq: 2, text: "Also check this", body: ["ts": "100.2"]),
          item(
            "ElicitationResponse", seq: 3, body: ["command": "publish", "scope": "session"],
            columns: ["elicitId": "approval", "approved": false]),
          item("Retraction", seq: 4, body: ["action": "edited", "ts": "100.1", "text": "Updated"]),
          item(
            "Error", seq: 5, text: "The response failed", columns: ["errorCode": "turn_failure"]),
        ]
      ])
    let messages = chatMessages(history.items)
    XCTAssertEqual(messages.count, 5)
    XCTAssertTrue(messages[0].edited)
    XCTAssertTrue(messages[1].steered)
    XCTAssertEqual(messages[1].slackTimestamp, "100.2")
    guard case .approval(let approved, let command, let scope) = messages[2].notice else {
      return XCTFail("Approval decision is missing")
    }
    XCTAssertFalse(approved)
    XCTAssertEqual(command, "publish")
    XCTAssertEqual(scope, "session")
    XCTAssertEqual(history.items[2].elicitId, "approval")
    XCTAssertEqual(history.items[4].details?["errorCode"]?.string, "turn_failure")
    XCTAssertEqual(messages.last?.role, "error")
    XCTAssertEqual(messages.last?.text, "The response failed")
  }

  func testExpandedActivityUsesCurrentEnvelope() throws {
    let current = try decode(
      TranscriptItemResponse.self,
      [
        "item": item(
          "ToolResult", text: "Full output", body: ["ok": true],
          columns: ["callId": "read", "tool": "execute"])
      ])
    XCTAssertEqual(current.item.text, "Full output")
    XCTAssertEqual(current.item.kind, "ToolResult")
    XCTAssertThrowsError(try decode(TranscriptItemResponse.self, [:]))
  }

  func testNullTextDoesNotEraseBodyFieldsAndHiddenMessagesStayHidden() throws {
    let history = try decode(
      Transcript.self,
      [
        "items": [
          item("UserMessage", text: "Hidden", columns: ["hidden": true]),
          item(
            "UserMessage", seq: 2,
            body: [
              "display": "Visible attachment",
              "attachments": [
                ["name": "report.txt", "artifactId": "report"]
              ],
            ]),
          item("AgentMessage", seq: 3, text: "Recorded answer"),
        ]
      ])
    let messages = chatMessages(history.items)
    XCTAssertEqual(messages.map(\.text), ["Visible attachment", "Recorded answer"])
    XCTAssertEqual(messages.first?.files.first?.artifactId, "report")
  }
}
