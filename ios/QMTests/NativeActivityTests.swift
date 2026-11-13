import XCTest

@testable import QM

final class NativeActivityTests: XCTestCase {
  func testNonObjectPayloadReportsDecodingFailure() {
    let source = #"{"createdAt":1,"kind":"UserMessage","body":"broken"}"#
    XCTAssertThrowsError(try JSONDecoder().decode(Item.self, from: Data(source.utf8)))
  }

  func testActivityPreservesUnknownStructuredFieldsAndExactIdentifiers() throws {
    let source = #"""
      {"seq":12,"createdAt":1000,"truncated":true,"kind":"ToolResult","tool":"sandbox","callId":"call-12","body":{"result":[true,0,"<script>not executed</script>"],"action":"exec","stdout":"hello\nworld","stderr":"warning","code":1,"future":{"id":9007199254740993,"active":false,"empty":null}}}
      """#
    let entry = try JSONDecoder().decode(Item.self, from: Data(source.utf8))
    XCTAssertEqual(entry.truncated, true)
    let details = try XCTUnwrap(entry.details)
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
      #"{"createdAt":1,"kind":"ToolResult","callId":"call-1","body":{"error":{"message":"denied","code":403},"args":{"command":"pwd"}}}"#
    let entry = try JSONDecoder().decode(Item.self, from: Data(source.utf8))
    XCTAssertFalse(entry.succeeded)
    XCTAssertTrue(try XCTUnwrap(entry.details).formatted.contains("denied"))
    XCTAssertEqual(NativeActivityDetails.fields(entry.details).map(\.key), ["args", "error"])
  }
  func testInlineWorkPairsInterleavedToolsByCallIdentity() throws {
    let source = #"""
      [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"one","tool":"files","body":{"action":"read"}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Checking the result.","body":{}},{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"two","tool":"web","body":{"action":"search"}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"one","body":{"ok":true}},{"seq":5,"createdAt":5,"kind":"ToolResult","callId":"two","body":{"ok":false}},{"seq":6,"createdAt":6,"kind":"Reasoning","hidden":true,"text":"Hidden","body":{}},{"seq":7,"createdAt":7,"kind":"Reasoning","text":"Redacted","body":{"redacted":true}},{"seq":8,"createdAt":8,"kind":"Reasoning","text":"   ","body":{}}]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let work = NativeWorkItem.items(items)
    XCTAssertEqual(work.count, 3)
    XCTAssertEqual(work[0].title, "files · read")
    XCTAssertEqual(work[0].result?.seq, 4)
    XCTAssertFalse(work[0].failed)
    XCTAssertTrue(work[1].isThinking)
    XCTAssertTrue(work[2].failed)
  }

  func testInlineWorkBelongsToItsReplyAndNeverLeaksIntoNextTurn() throws {
    let source = #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"one","text":"First","body":{}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"First thought","body":{}},{"seq":3,"createdAt":3,"kind":"AgentMessage","text":"First answer","body":{}},{"seq":4,"createdAt":4,"kind":"UserMessage","turnId":"two","text":"Second","body":{}},{"seq":5,"createdAt":5,"kind":"AgentMessage","text":"Second answer","body":{}}]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages[1].activity.map(\.seq), [2])
    XCTAssertTrue(messages[3].activity.isEmpty)
    XCTAssertEqual(messages.map(\.text), ["First", "First answer", "Second", "Second answer"])
  }

  func testActivityAfterDeliveredPostStaysWithTheSameTurn() throws {
    let source = #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"one","text":"First","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"Delivered"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"post","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"ToolCall","callId":"read","tool":"files","body":{"action":"read"}},{"seq":5,"createdAt":5,"kind":"ToolResult","callId":"read","body":{"ok":true}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"Delivered","body":{}},{"seq":7,"createdAt":7,"kind":"UserMessage","turnId":"two","text":"Second","body":{}},{"seq":8,"createdAt":8,"kind":"AgentMessage","text":"","body":{}},{"seq":9,"createdAt":9,"kind":"UserMessage","turnId":"three","text":"Third","body":{}},{"seq":10,"createdAt":10,"kind":"AgentMessage","text":"Third answer","body":{}}]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(
      messages.map(\.text), ["First", "Delivered", "", "Second", "Third", "Third answer"])
    XCTAssertEqual(messages[1].activity.map(\.seq), [2, 3])
    XCTAssertEqual(messages[2].activity.map(\.seq), [4, 5])
    XCTAssertTrue(messages[5].activity.isEmpty)
    let timeline = NativeChatTimeline(messages: messages, items: items)
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
        Item.self,
        from: Data(
          #"{"createdAt":1,"kind":"ToolCall","tool":"sandbox","callId":"call-1","body":{"action":"exec","purpose":"Check build"}}"#
            .utf8))
      let output = try JSONDecoder().decode(
        Item.self,
        from: Data(
          "{\"kind\":\"ToolResult\",\"createdAt\":2,\"callId\":\"call-1\",\"body\":\(payload)}".utf8))
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
      [{"createdAt":1,"kind":"ToolCall","tool":"mcp_call","callId":"call-1","body":{"mcpServer":"github","args":{"repo":"qm"}}},{"createdAt":2,"kind":"ToolCall","tool":"slack_post_message","callId":"call-2","body":{}},{"createdAt":3,"kind":"ToolCall","tool":"web","callId":"call-3","body":{"request":{"url":"https://api.notion.so/v1/pages"}}},{"createdAt":4,"kind":"ToolCall","tool":"web","callId":"call-4","body":{"url":"https://example.org/status"}},{"createdAt":5,"kind":"ToolCall","tool":"execute","callId":"call-5","body":{"purpose":"Reviewing GitHub issues"}},{"createdAt":6,"kind":"ToolCall","tool":"execute","callId":"call-6","body":{"purpose":"Checking linear complexity"}}]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let work = NativeWorkItem.items(items)
    XCTAssertEqual(
      work.map { $0.service?.name }, ["GitHub", "Slack", "Notion", "example.org", nil, nil])
    XCTAssertEqual(
      work.map { $0.service?.logo }, ["github", "slack", "notion", nil, nil, nil])
  }

  func testAgentContextUsesResolvedConversationIdentityAndLeavesAggregateWorkUnlinked() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"open","tool":"subagents","body":{"action":"open"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"open","tool":"subagents","body":{"action":"open","sessionId":"opened-agent","title":"Audit"}},{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"send","tool":"subagents","body":{"action":"send_message","target":"Audit"}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"send","tool":"subagents","body":{"action":"send_message","sessionId":"opened-agent","delivered":true}},{"seq":5,"createdAt":5,"kind":"ToolResult","tool":"subagents","callId":"call-5","body":{"action":"read","sessionId":"other-agent","status":"returned"}},{"seq":6,"createdAt":6,"kind":"ToolResult","tool":"subagents","callId":"call-6","body":{"action":"read","children":2}},{"seq":7,"createdAt":7,"kind":"ToolCall","tool":"subagents","callId":"call-7","body":{"action":"wait"}},{"seq":8,"createdAt":8,"kind":"ToolResult","tool":"subagents","callId":"call-8","body":{"action":"open","error":"Unavailable"}},{"seq":9,"createdAt":9,"kind":"ToolResult","tool":"files","callId":"call-9","body":{"sessionId":"unrelated"}}]
        """#.utf8))
    XCTAssertEqual(
      NativeWorkItem.items(items).map(\.agentSessionID),
      ["opened-agent", "opened-agent", "other-agent", nil, nil, nil, nil])
  }

  func testAgentActivityNamesTheSpawnedTaskAndWaitingAction() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"spawn","tool":"subagents","body":{"action":"open","name":"UI audit"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"spawn","body":{"ok":true}},{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"wait","tool":"subagents","body":{"action":"wait"}}]
        """#.utf8))
    let pending = try XCTUnwrap(NativeWorkItem.items([items[0]]).first)
    XCTAssertEqual(pending.label(active: true), "Starting UI audit")
    let completed = NativeWorkItem.items(items)
    XCTAssertEqual(completed[0].label(active: true), "Started UI audit")
    XCTAssertEqual(completed[1].label(active: true), "Waiting for agents")
    XCTAssertTrue(completed.allSatisfy(\.opensAgents))
  }

  func testWorkLabelsPreferPurposeAndFallBackToToolAndAction() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"ToolCall","tool":"files","callId":"call-1","body":{"action":"read","path":"docs/SPEC.md"}},{"seq":2,"createdAt":2,"kind":"ToolCall","tool":"sandbox","callId":"call-2","body":{"action":"exec","purpose":"Check build"}},{"seq":3,"createdAt":3,"kind":"ToolCall","tool":"sandbox","callId":"call-3","body":{"action":"exec","command":"pwd\nls"}},{"seq":4,"createdAt":4,"kind":"ToolCall","tool":"mcp_call","callId":"call-4","body":{"mcpServer":"github","action":"search_issues"}},{"seq":5,"createdAt":5,"kind":"ToolCall","callId":"failed","tool":"files","body":{"action":"read"}},{"seq":6,"createdAt":6,"kind":"ToolResult","callId":"failed","body":{"ok":false}}]
        """#.utf8))
    let work = NativeWorkItem.items(items)
    XCTAssertEqual(
      work.map { $0.label(active: true) },
      ["Reading SPEC.md", "Check build", "pwd", "GitHub · search issues", "Reading file · Failed"])
    XCTAssertEqual(work[0].label(active: false), "Reading SPEC.md · Unconfirmed")
  }

  func testToolPreviewIncludesRecordedSearchAndRequestTargets() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"seq":1,"createdAt":1,"kind":"ToolCall","tool":"mcp_call","callId":"call-1","body":{"mcpServer":"github","action":"search_issues","args":{"query":"is:open label:bug"}}},
          {"seq":2,"createdAt":2,"kind":"ToolCall","tool":"mcp_call","callId":"call-2","body":{"mcpServer":"slack","action":"history","channel":"#release"}},
          {"seq":3,"createdAt":3,"kind":"ToolCall","tool":"web","callId":"call-3","body":{"action":"fetch","url":"https://example.org/status"}},
          {"seq":4,"createdAt":4,"kind":"ToolCall","tool":"files","callId":"call-4","body":{"action":"read","path":"docs/SPEC.md","purpose":"Check the current spec"}}
        ]
        """#.utf8))
    XCTAssertEqual(
      NativeWorkItem.items(items).map { $0.label(active: true) },
      [
        "GitHub · search issues · is:open label:bug", "Slack · history · #release",
        "example.org · fetch · https://example.org/status", "Check the current spec",
      ])
  }

}
