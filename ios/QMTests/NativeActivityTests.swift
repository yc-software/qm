import XCTest

@testable import QM

final class NativeActivityTests: XCTestCase {
  func testNonObjectPayloadReportsDecodingFailure() {
    let source = #"{"type":"user","createdAt":1,"payload":"broken"}"#
    XCTAssertThrowsError(try JSONDecoder().decode(Entry.self, from: Data(source.utf8)))
  }

  func testActivityPreservesUnknownStructuredFieldsAndExactIdentifiers() throws {
    let source = #"""
      {"type":"tool_result","seq":12,"createdAt":1000,"truncated":true,"payload":{
        "tool":"sandbox","action":"exec","stdout":"hello\nworld","stderr":"warning",
        "code":1,"future":{"id":9007199254740993,"active":false,"empty":null},
        "result":[true,0,"<script>not executed</script>"]}}
      """#
    let entry = try JSONDecoder().decode(Entry.self, from: Data(source.utf8))
    XCTAssertEqual(entry.truncated, true)
    let details = try XCTUnwrap(entry.payload?.details)
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
      #"{"type":"tool_result","createdAt":1,"payload":{"error":{"message":"denied","code":403},"args":{"command":"pwd"}}}"#
    let entry = try JSONDecoder().decode(Entry.self, from: Data(source.utf8))
    XCTAssertFalse(try XCTUnwrap(entry.payload).succeeded)
    XCTAssertTrue(try XCTUnwrap(entry.payload?.details).formatted.contains("denied"))
    XCTAssertEqual(entry.payload?.details?.fields.map(\.key), ["args", "error"])
  }
  func testInlineWorkPairsInterleavedToolsByCallIdentity() throws {
    let source = #"""
      [
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"callId":"one","tool":"files","action":"read"}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"Checking the result."}},
        {"type":"tool_call","seq":3,"createdAt":3,"payload":{"callId":"two","tool":"web","action":"search"}},
        {"type":"tool_result","seq":4,"createdAt":4,"payload":{"callId":"one","ok":true}},
        {"type":"tool_result","seq":5,"createdAt":5,"payload":{"callId":"two","ok":false}},
        {"type":"thinking","seq":6,"createdAt":6,"payload":{"thinking":"Hidden","hidden":true}},
        {"type":"thinking","seq":7,"createdAt":7,"payload":{"thinking":"Redacted","redacted":true}},
        {"type":"thinking","seq":8,"createdAt":8,"payload":{"thinking":"   "}}
      ]
      """#
    let entries = try JSONDecoder().decode([Entry].self, from: Data(source.utf8))
    let items = NativeWorkItem.items(entries)
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
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"First","runId":"one"}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"First thought"}},
        {"type":"assistant","seq":3,"createdAt":3,"payload":{"text":"First answer"}},
        {"type":"user","seq":4,"createdAt":4,"payload":{"text":"Second","runId":"two"}},
        {"type":"assistant","seq":5,"createdAt":5,"payload":{"text":"Second answer"}}
      ]
      """#
    let entries = try JSONDecoder().decode([Entry].self, from: Data(source.utf8))
    let messages = chatMessages(entries)
    XCTAssertEqual(messages[1].activity.map(\.seq), [2])
    XCTAssertTrue(messages[3].activity.isEmpty)
    XCTAssertEqual(messages.map(\.text), ["First", "First answer", "Second", "Second answer"])
  }

  func testActivityAfterDeliveredPostStaysWithTheSameTurn() throws {
    let source = #"""
      [
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"First","runId":"one"}},
        {"type":"tool_call","seq":2,"createdAt":2,"payload":{"callId":"post","action":"post","text":"Delivered"}},
        {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}},
        {"type":"tool_call","seq":4,"createdAt":4,"payload":{"callId":"read","tool":"files","action":"read"}},
        {"type":"tool_result","seq":5,"createdAt":5,"payload":{"callId":"read","ok":true}},
        {"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"Delivered"}},
        {"type":"user","seq":7,"createdAt":7,"payload":{"text":"Second","runId":"two"}},
        {"type":"assistant","seq":8,"createdAt":8,"payload":{"text":""}},
        {"type":"user","seq":9,"createdAt":9,"payload":{"text":"Third","runId":"three"}},
        {"type":"assistant","seq":10,"createdAt":10,"payload":{"text":"Third answer"}}
      ]
      """#
    let entries = try JSONDecoder().decode([Entry].self, from: Data(source.utf8))
    let messages = chatMessages(entries)
    XCTAssertEqual(
      messages.map(\.text), ["First", "Delivered", "", "Second", "Third", "Third answer"])
    XCTAssertEqual(messages[1].activity.map(\.seq), [2, 3])
    XCTAssertEqual(messages[2].activity.map(\.seq), [4, 5])
    XCTAssertTrue(messages[5].activity.isEmpty)
    let timeline = NativeChatTimeline(messages: messages, entries: entries)
    let labels = timeline.items.map { item -> String in
      switch item.content {
      case .message(let message): message.text
      case .work(let work): work.title
      case .reasoning(let block): block.text
      }
    }
    XCTAssertEqual(
      labels, ["First", "post", "Delivered", "files · read", "Second", "Third", "Third answer"])
  }

  func testToolStatesMatchExecutionAndApprovalSemantics() throws {
    func item(_ payload: String, result: Bool = true) throws -> NativeWorkItem {
      let call = try JSONDecoder().decode(
        Entry.self,
        from: Data(
          #"{"type":"tool_call","createdAt":1,"payload":{"tool":"sandbox","action":"exec","purpose":"Check build"}}"#
            .utf8))
      let output = try JSONDecoder().decode(
        Entry.self,
        from: Data(
          "{\"type\":\"tool_result\",\"createdAt\":2,\"payload\":\(payload)}".utf8))
      return NativeWorkItem(entry: call, result: result ? output : nil)
    }
    XCTAssertEqual(try item(#"{"timedOut":true}"#).state(active: false), .failed)
    XCTAssertEqual(try item(#"{"quarantined":true}"#).state(active: false), .failed)
    XCTAssertEqual(try item(#"{"blocked":"needs_approval"}"#).state(active: false), .approval)
    let completed = try item(#"{"isError":true,"code":1,"timedOut":false,"stdout":"test failure"}"#)
    XCTAssertEqual(completed.state(active: false), .complete)
    XCTAssertEqual(completed.label(active: false), "Check build · exit 1")
    let missing = try item("{}", result: false)
    XCTAssertEqual(missing.state(active: true), .running)
    XCTAssertEqual(missing.state(active: false), .unconfirmed)
    XCTAssertEqual(missing.state(active: false, turnFailed: true), .failed)
    XCTAssertEqual(missing.label(active: false), "Check build · Unconfirmed")
  }

  func testActivityIdentifiesServiceFromRecordedCallAndRequestURL() throws {
    let source = #"""
      [
        {"type":"tool_call","createdAt":1,"payload":{"tool":"mcp_call","mcpServer":"github","args":{"repo":"qm"}}},
        {"type":"tool_call","createdAt":2,"payload":{"tool":"slack_post_message"}},
        {"type":"tool_call","createdAt":3,"payload":{"tool":"web","request":{"url":"https://api.notion.so/v1/pages"}}},
        {"type":"tool_call","createdAt":4,"payload":{"tool":"web","url":"https://example.org/status"}},
        {"type":"tool_call","createdAt":5,"payload":{"tool":"execute","purpose":"Reviewing GitHub issues"}},
        {"type":"tool_call","createdAt":6,"payload":{"tool":"execute","purpose":"Checking linear complexity"}}
      ]
      """#
    let entries = try JSONDecoder().decode([Entry].self, from: Data(source.utf8))
    let items = NativeWorkItem.items(entries)
    XCTAssertEqual(
      items.map { $0.service?.name }, ["GitHub", "Slack", "Notion", "example.org", nil, nil])
    XCTAssertEqual(
      items.map { $0.service?.logo }, ["github", "slack", "notion", nil, nil, nil])
  }

  func testAgentContextUsesResolvedConversationIdentityAndLeavesAggregateWorkUnlinked() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"subagents","action":"open","callId":"open"}},
          {"type":"tool_result","seq":2,"createdAt":2,"payload":{"tool":"subagents","action":"open","callId":"open","sessionId":"opened-agent","title":"Audit"}},
          {"type":"tool_call","seq":3,"createdAt":3,"payload":{"tool":"subagents","action":"send_message","callId":"send","target":"Audit"}},
          {"type":"tool_result","seq":4,"createdAt":4,"payload":{"tool":"subagents","action":"send_message","callId":"send","sessionId":"opened-agent","delivered":true}},
          {"type":"tool_result","seq":5,"createdAt":5,"payload":{"tool":"subagents","action":"read","sessionId":"other-agent","status":"returned"}},
          {"type":"tool_result","seq":6,"createdAt":6,"payload":{"tool":"subagents","action":"read","children":2}},
          {"type":"tool_call","seq":7,"createdAt":7,"payload":{"tool":"subagents","action":"wait"}},
          {"type":"tool_result","seq":8,"createdAt":8,"payload":{"tool":"subagents","action":"open","error":"Unavailable"}},
          {"type":"tool_result","seq":9,"createdAt":9,"payload":{"tool":"files","sessionId":"unrelated"}}
        ]
        """#.utf8))
    XCTAssertEqual(
      NativeWorkItem.items(entries).map(\.agentSessionID),
      ["opened-agent", "opened-agent", "other-agent", nil, nil, nil, nil])
  }

  func testAgentActivityNamesTheSpawnedTaskAndWaitingAction() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"subagents","action":"open","name":"UI audit","callId":"spawn"}},
          {"type":"tool_result","seq":2,"createdAt":2,"payload":{"callId":"spawn","ok":true}},
          {"type":"tool_call","seq":3,"createdAt":3,"payload":{"tool":"subagents","action":"wait","callId":"wait"}}
        ]
        """#.utf8))
    let pending = try XCTUnwrap(NativeWorkItem.items([entries[0]]).first)
    XCTAssertEqual(pending.label(active: true), "Starting UI audit")
    let completed = NativeWorkItem.items(entries)
    XCTAssertEqual(completed[0].label(active: true), "Started UI audit")
    XCTAssertEqual(completed[1].label(active: true), "Waiting for agents")
    XCTAssertTrue(completed.allSatisfy(\.opensAgents))
  }

  func testWorkLabelsPreferPurposeAndFallBackToToolAndAction() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"files","action":"read","path":"docs/SPEC.md"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"sandbox","action":"exec","purpose":"Check build"}},
          {"type":"tool_call","seq":3,"createdAt":3,"payload":{"tool":"sandbox","action":"exec","command":"pwd\nls"}},
          {"type":"tool_call","seq":4,"createdAt":4,"payload":{"tool":"mcp_call","mcpServer":"github","action":"search_issues"}},
          {"type":"tool_call","seq":5,"createdAt":5,"payload":{"tool":"files","action":"read","callId":"failed"}},
          {"type":"tool_result","seq":6,"createdAt":6,"payload":{"callId":"failed","ok":false}}
        ]
        """#.utf8))
    let items = NativeWorkItem.items(entries)
    XCTAssertEqual(
      items.map { $0.label(active: true) },
      ["Reading SPEC.md", "Check build", "pwd", "GitHub · search issues", "Reading file · Failed"])
    XCTAssertEqual(items[0].label(active: false), "Reading SPEC.md · Unconfirmed")
  }

  func testToolPreviewIncludesRecordedSearchAndRequestTargets() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"mcp_call","mcpServer":"github","action":"search_issues","args":{"query":"is:open label:bug"}}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"mcp_call","mcpServer":"slack","action":"history","channel":"#release"}},
          {"type":"tool_call","seq":3,"createdAt":3,"payload":{"tool":"web","action":"fetch","url":"https://example.org/status"}},
          {"type":"tool_call","seq":4,"createdAt":4,"payload":{"tool":"files","action":"read","path":"docs/SPEC.md","purpose":"Check the current spec"}}
        ]
        """#.utf8))
    XCTAssertEqual(
      NativeWorkItem.items(entries).map { $0.label(active: true) },
      [
        "GitHub · search issues · is:open label:bug", "Slack · history · #release",
        "example.org · fetch · https://example.org/status", "Check the current spec",
      ])
  }

}
