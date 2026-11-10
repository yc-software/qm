import XCTest

@testable import QM

final class NativeActivityTests: XCTestCase {
  func testUnfamiliarItemsDoNotRejectTranscript() throws {
    let source = #"""
      {"items":[
        {"kind":"Wake","createdAt":1,"wakeCause":"cron","body":{"text":"notice"}},
        {"kind":"FutureKind","createdAt":2,"body":{"value":["notice",{"code":1}]}},
        {"kind":"RuntimeChange","createdAt":3,"body":null},
        {"kind":"UserMessage","createdAt":4,"text":"Continue","body":{}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    XCTAssertEqual(transcript.items.count, 4)
    XCTAssertEqual(
      transcript.items[1].details,
      .object(["value": .array([.string("notice"), .object(["code": .number(1)])])]))
    XCTAssertNil(transcript.items[2].body)
    XCTAssertEqual(chatMessages(transcript.items).map(\.text), ["Continue"])
  }

  func testActivityPreservesUnknownStructuredFieldsAndExactIdentifiers() throws {
    let source = #"""
      {"kind":"ToolResult","seq":12,"createdAt":1000,"truncated":true,"tool":"sandbox","body":{"action":"exec","stdout":"hello\nworld","stderr":"warning","code":1,"future":{"id":9007199254740993,"active":false,"empty":null},"result":[true,0,"<script>not executed</script>"]}}
      """#
    let item = try JSONDecoder().decode(Item.self, from: Data(source.utf8))
    XCTAssertEqual(item.truncated, true)
    let details = try XCTUnwrap(item.details)
    let values = Dictionary(uniqueKeysWithValues: details.fields.map { ($0.key, $0.value) })
    XCTAssertEqual(values["code"], .number(1))
    XCTAssertEqual(values["stdout"]?.formatted, "hello\nworld")
    XCTAssertEqual(
      values["future"],
      .object([
        "id": .number(9_007_199_254_740_993), "active": .bool(false), "empty": .null,
      ]))
    XCTAssertEqual(
      values["result"], .array([.bool(true), .number(0), .string("<script>not executed</script>")]))
    let roundTrip = try JSONDecoder().decode(
      NativeActivityValue.self, from: JSONEncoder().encode(details))
    XCTAssertEqual(roundTrip, details)
  }

  func testStructuredErrorIsInspectableWithoutChangingDeliveryFailureDetection() throws {
    let source =
      #"{"kind":"ToolResult","createdAt":1,"body":{"error":{"message":"denied","code":403},"args":{"command":"pwd"}}}"#
    let item = try JSONDecoder().decode(Item.self, from: Data(source.utf8))
    XCTAssertFalse(item.succeeded)
    XCTAssertTrue(try XCTUnwrap(item.details).formatted.contains("denied"))
    XCTAssertEqual(item.details?.fields.map(\.key), ["args", "error"])
  }
  func testInlineWorkPairsInterleavedToolsByCallIdentity() throws {
    let source = #"""
      [
        {"kind":"ToolCall","seq":1,"createdAt":1,"callId":"one","tool":"files","body":{"action":"read"}},
        {"kind":"Reasoning","seq":2,"createdAt":2,"text":"Checking the result.","body":{}},
        {"kind":"ToolCall","seq":3,"createdAt":3,"callId":"two","tool":"web","body":{"action":"search"}},
        {"kind":"ToolResult","seq":4,"createdAt":4,"callId":"one","body":{"ok":true}},
        {"kind":"ToolResult","seq":5,"createdAt":5,"callId":"two","body":{"ok":false}},
        {"kind":"Reasoning","seq":6,"createdAt":6,"text":"Hidden","body":{"hidden":true}},
        {"kind":"Reasoning","seq":7,"createdAt":7,"text":"Redacted","body":{"redacted":true}},
        {"kind":"Reasoning","seq":8,"createdAt":8,"text":"   ","body":{}}
      ]
      """#
    let activity = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let items = NativeWorkItem.items(activity)
    XCTAssertEqual(items.count, 3)
    XCTAssertEqual(items[0].title, "files · read")
    XCTAssertEqual(items[0].result?.seq, 4)
    XCTAssertFalse(items[0].failed)
    XCTAssertTrue(items[1].isThinking)
    XCTAssertTrue(items[2].failed)
  }

  func testInlineWorkBelongsToItsReplyAndNeverLeaksIntoNextTurn() throws {
    let source = #"""
      [
        {"kind":"UserMessage","seq":1,"createdAt":1,"text":"First","turnId":"one","body":{}},
        {"kind":"Reasoning","seq":2,"createdAt":2,"text":"First thought","body":{}},
        {"kind":"AgentMessage","seq":3,"createdAt":3,"text":"First answer","body":{}},
        {"kind":"UserMessage","seq":4,"createdAt":4,"text":"Second","turnId":"two","body":{}},
        {"kind":"AgentMessage","seq":5,"createdAt":5,"text":"Second answer","body":{}}
      ]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages[1].activity.map(\.seq), [2])
    XCTAssertTrue(messages[3].activity.isEmpty)
    XCTAssertEqual(messages.map(\.text), ["First", "First answer", "Second", "Second answer"])
  }

  func testActivityAfterDeliveredPostStaysWithTheSameTurn() throws {
    let source = #"""
      [
        {"kind":"UserMessage","seq":1,"createdAt":1,"text":"First","turnId":"one","body":{}},
        {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"post","body":{"action":"post","text":"Delivered"}},
        {"kind":"ToolResult","seq":3,"createdAt":3,"callId":"post","body":{"ok":true}},
        {"kind":"ToolCall","seq":4,"createdAt":4,"callId":"read","tool":"files","body":{"action":"read"}},
        {"kind":"ToolResult","seq":5,"createdAt":5,"callId":"read","body":{"ok":true}},
        {"kind":"AgentMessage","seq":6,"createdAt":6,"text":"Delivered","body":{}},
        {"kind":"UserMessage","seq":7,"createdAt":7,"text":"Second","turnId":"two","body":{}},
        {"kind":"AgentMessage","seq":8,"createdAt":8,"text":"","body":{}},
        {"kind":"UserMessage","seq":9,"createdAt":9,"text":"Third","turnId":"three","body":{}},
        {"kind":"AgentMessage","seq":10,"createdAt":10,"text":"Third answer","body":{}}
      ]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages.map(\.text), ["First", "Delivered", "Second", "Third", "Third answer"])
    XCTAssertEqual(messages[1].activity.map(\.seq), [2, 3, 4, 5])
    XCTAssertTrue(messages[4].activity.isEmpty)
  }

  func testToolStatesMatchExecutionAndApprovalSemantics() throws {
    func item(_ body: String, isError: Bool = false, result: Bool = true) throws -> NativeWorkItem {
      let call = try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"kind":"ToolCall","createdAt":1,"tool":"sandbox","body":{"action":"exec","purpose":"Check build"}}"#
            .utf8))
      let output = try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"kind":"ToolResult","createdAt":2,"isError":\#(isError),"body":\#(body)}"#.utf8))
      return NativeWorkItem(entry: call, result: result ? output : nil)
    }
    XCTAssertEqual(try item(#"{"timedOut":true}"#).state(active: false), .failed)
    XCTAssertEqual(try item(#"{"quarantined":true}"#).state(active: false), .failed)
    XCTAssertEqual(try item(#"{"blocked":"needs_approval"}"#).state(active: false), .approval)
    let completed = try item(
      #"{"code":1,"timedOut":false,"stdout":"test failure"}"#, isError: true)
    XCTAssertEqual(completed.state(active: false), .complete)
    XCTAssertEqual(completed.label(active: false), "Check build · exit 1")
    let missing = try item("{}", result: false)
    XCTAssertEqual(missing.state(active: true), .running)
    XCTAssertEqual(missing.state(active: false), .unconfirmed)
    XCTAssertEqual(missing.state(active: false, turnFailed: true), .failed)
    XCTAssertEqual(missing.label(active: false), "Check build · Unconfirmed")
  }

}
