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
    XCTAssertEqual(history.entries.count, 5)
    XCTAssertEqual(history.earlierEntries, 7)
    let messages = chatMessages(history.entries)
    XCTAssertEqual(messages.map(\.text), ["Check the file", "Here is the report"])
    XCTAssertEqual(messages.map(\.runID), ["turn", "turn"])
    XCTAssertEqual(messages.first?.speaker, "Alice")
    XCTAssertEqual(messages.first?.slackTimestamp, "100.1")
    XCTAssertEqual(messages.last?.activity.map(\.type), ["thinking", "tool_call", "tool_result"])
    XCTAssertEqual(history.entries[1].payload?.thinking, "Checking the contents")
    XCTAssertEqual(history.entries[2].payload?.command, "cat report.txt")
    XCTAssertEqual(history.entries[2].payload?.callId, "read")
    XCTAssertEqual(history.entries[2].payload?.details?["step"]?["index"], .number(2))
    XCTAssertEqual(history.entries[3].payload?.details?["result"]?.string, "File contents")
    XCTAssertEqual(history.entries[3].payload?.details?["count"], .number(1))
    XCTAssertEqual(history.entries.last?.itemKind, "AgentMessage")
    XCTAssertEqual(history.entries.last?.seq, 5)
    XCTAssertEqual(history.entries.last?.createdAt, 5000)
  }

  func testLegacyEntriesTranscriptStillDecodesWithoutChangingPresentation() throws {
    let history = try decode(
      Transcript.self,
      [
        "entries": [
          ["type": "user", "seq": 1, "createdAt": 1000, "payload": ["text": "Question"]],
          ["type": "assistant", "seq": 2, "createdAt": 2000, "payload": ["text": "Answer"]],
        ],
        "earlierEntries": 4,
      ])
    XCTAssertEqual(chatMessages(history.entries).map(\.text), ["Question", "Answer"])
    XCTAssertEqual(history.earlierEntries, 4)
    XCTAssertNil(history.entries.first?.itemKind)
  }

  func testItemsEnvelopeIsAuthoritativeAndInvalidHistoryStillFails() throws {
    let history = try decode(
      Transcript.self,
      ["items": [], "entries": [["type": "invalid"]], "earlierItems": 3, "earlierEntries": 99])
    XCTAssertTrue(history.entries.isEmpty)
    XCTAssertEqual(history.earlierEntries, 3)
    XCTAssertThrowsError(try decode(Transcript.self, ["session": NSNull()]))
    XCTAssertThrowsError(try decode(Transcript.self, ["items": NSNull(), "entries": []]))
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
    XCTAssertEqual(run.activity?.map(\.type), ["text_start", "thinking", "tool_call"])
    XCTAssertEqual(event.run?.activity?.map(\.id), run.activity?.map(\.id))
    XCTAssertEqual(run.activity?.first?.payload?.details?["streamOffset"], .number(2))
    XCTAssertEqual(run.activity?.last?.payload?.details?["path"]?.string, "report.txt")
    XCTAssertEqual(run.activity?.last?.itemKind, "ToolCall")
  }

  func testNarrationDeliveredFilesAndToolOutputKeepTheirVariants() throws {
    let entries = try decode(
      [Entry].self,
      [
        item("AgentMessage", text: "Working", columns: ["variant": "narration"]),
        item(
          "AgentMessage", seq: 2, body: ["files": [["name": "report.txt", "artifactId": "file"]]],
          columns: ["variant": "files_delivered"]),
        item(
          "ToolResult", seq: 3, body: ["output": ["bytes": 10], "ok": false],
          columns: ["callId": "read", "tool": "execute", "blobSha": "blob", "isError": true]),
      ])
    XCTAssertEqual(entries.map(\.type), ["text", "delivery", "tool_result"])
    XCTAssertEqual(entries[1].payload?.files?.first?.artifactId, "file")
    XCTAssertEqual(entries[2].payload?.details?["output"]?["bytes"], .number(10))
    XCTAssertEqual(entries[2].payload?.details?["output"]?["blob"]?.string, "blob")
    XCTAssertFalse(try XCTUnwrap(entries[2].payload).succeeded)
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
    let messages = chatMessages(history.entries)
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
    XCTAssertEqual(history.entries[2].payload?.requestId, "approval")
    XCTAssertEqual(history.entries[4].payload?.details?["errorCode"]?.string, "turn_failure")
    XCTAssertEqual(messages.last?.role, "error")
    XCTAssertEqual(messages.last?.text, "The response failed")
  }

  func testExpandedActivityAcceptsCurrentAndLegacyEnvelopes() throws {
    let current = try decode(
      TranscriptEntryResponse.self,
      [
        "item": item(
          "ToolResult", text: "Full output", body: ["ok": true],
          columns: ["callId": "read", "tool": "execute"])
      ])
    let legacy = try decode(
      TranscriptEntryResponse.self,
      [
        "entry": [
          "type": "tool_result", "seq": 1, "createdAt": 1000,
          "payload": ["result": "Full output", "ok": true, "callId": "read", "tool": "execute"],
        ]
      ])
    XCTAssertEqual(current.entry.id, legacy.entry.id)
    XCTAssertEqual(
      current.entry.payload?.details?["result"], legacy.entry.payload?.details?["result"])
    XCTAssertEqual(current.entry.itemKind, "ToolResult")
    XCTAssertNil(legacy.entry.itemKind)
    XCTAssertThrowsError(try decode(TranscriptEntryResponse.self, [:]))
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
          item("AgentMessage", seq: 3, body: ["text": "Preserved body text"]),
        ]
      ])
    let messages = chatMessages(history.entries)
    XCTAssertEqual(messages.map(\.text), ["Visible attachment", "Preserved body text"])
    XCTAssertEqual(messages.first?.files.first?.artifactId, "report")
  }
}
