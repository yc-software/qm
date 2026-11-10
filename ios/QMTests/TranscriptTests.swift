import XCTest

@testable import QM

final class TranscriptTests: XCTestCase {
  func testServerTranscriptWithNullColumnsShowsTheFailedTurn() throws {
    let source = #"""
      {"items":[
        {"sessionId":"s","seq":0,"createdAt":1,"turnId":"0b7f6c2e-0000-4000-8000-000000000001","kind":"UserMessage","author":"a","callId":null,"elicitId":null,"wakeCause":null,"errorCode":null,"text":"Question","tool":null,"step":null,"variant":null,"isError":null,"hidden":null,"externalId":null,"throughSeq":null,"approved":null,"blobSha":null,"body":{"speakerId":"a"},"truncated":true},
        {"sessionId":"s","seq":1,"createdAt":2,"turnId":"0b7f6c2e-0000-4000-8000-000000000001","kind":"Error","author":null,"callId":null,"elicitId":null,"wakeCause":null,"errorCode":"turn_failure","text":"Model provider API error","tool":null,"step":null,"variant":null,"isError":null,"hidden":null,"externalId":null,"throughSeq":null,"approved":null,"blobSha":null,"body":{}}
       ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(messages.map(\.role), ["user", "error"])
    XCTAssertEqual(messages.map(\.text), ["Question", "Model provider API error"])
    XCTAssertFalse(
      hasRecordedRunReply(transcript.items, runID: "0b7f6c2e-0000-4000-8000-000000000001"))
  }

  func testSuccessfulPostReconcilesCompletedFallbackBeforeTerminalHistoryArrives() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Question","turnId":"A","body":{}},
          {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"p","tool":"surface","body":{"action":"post","text":"Answer"}},
          {"kind":"ToolResult","seq":3,"createdAt":3,"callId":"p","tool":"surface","body":{"ok":true}}
        ]
        """#.utf8))
    let messages = presentedChatMessages(
      items,
      runs: [
        ChatRunPresentation(id: "A", runID: "A", reply: "Internal final summary", finished: true)
      ],
      activeRunID: nil)
    XCTAssertEqual(messages.map(\.text), ["Question", "Answer"])
    XCTAssertTrue(hasRecordedRunReply(items, runID: "A"))
    XCTAssertFalse(hasRecordedRunReply(items, runID: "B"))
    XCTAssertFalse(hasRecordedRunReply(Array(items.prefix(2)), runID: "A"))
  }

  func testAttachmentOnlyHistoryKeepsFallbackWithoutDuplicatingActivity() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Question","turnId":"A","body":{}},
          {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"attachment","tool":"attach","body":{}},
          {"kind":"ToolResult","seq":3,"createdAt":3,"callId":"attachment","tool":"attach","body":{"ok":true,"files":[{"name":"report.txt","artifactId":"report"}]}},
          {"kind":"Reasoning","seq":4,"createdAt":4,"text":"Summarizing the report","body":{}}
        ]
        """#.utf8))
    let messages = presentedChatMessages(
      Array(items.prefix(3)),
      runs: [
        .init(
          id: "A", runID: "A", reply: "Answer", finished: true, activity: Array(items.dropFirst())
        )
      ],
      activeRunID: nil)
    XCTAssertEqual(messages.filter { $0.text == "Answer" }.count, 1)
    XCTAssertEqual(messages.flatMap(\.files).map(\.name), ["report.txt"])
    XCTAssertEqual(messages.flatMap(\.activity).compactMap(\.seq), [2, 3, 4])
  }

  func testFailedAndUnmatchedPostsDoNotSuppressTheRunReply() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Question","turnId":"A","body":{}},
          {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"failed","body":{"action":"post","text":"Answer"}},
          {"kind":"ToolResult","seq":3,"createdAt":3,"callId":"failed","body":{"ok":false}},
          {"kind":"ToolResult","seq":4,"createdAt":4,"callId":"unmatched","body":{"ok":true}},
          {"kind":"UserMessage","seq":5,"createdAt":5,"text":"Next","turnId":"B","body":{}},
          {"kind":"ToolCall","seq":6,"createdAt":6,"callId":"next","body":{"action":"post","text":"Answer"}},
          {"kind":"ToolResult","seq":7,"createdAt":7,"callId":"next","body":{"ok":true}}
        ]
        """#.utf8))
    XCTAssertFalse(hasRecordedRunReply(items, runID: "A"))
    XCTAssertTrue(hasRecordedRunReply(items, runID: "B"))
  }

  func testApprovalReceiptsStayChronologicalWithoutConsumingActivityOrDelivery() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Run tests","turnId":"run","body":{}},
          {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"execute","tool":"execute","body":{}},
          {"kind":"ElicitationResponse","seq":3,"createdAt":3,"elicitId":"approval","approved":true,"body":{"command":"npm test","scope":"session"}},
          {"kind":"AgentMessage","seq":4,"createdAt":4,"text":"Passed","body":{}},
          {"kind":"ElicitationResponse","seq":5,"createdAt":5,"approved":false,"body":{"command":"Another action"}},
          {"kind":"AgentMessage","seq":6,"createdAt":6,"variant":"files_delivered","body":{"files":[{"name":"result.txt","artifactId":"result"}]}}
        ]
        """#.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages.map(\.role), ["user", "notice", "assistant", "notice"])
    guard case .approval(let approved, let command, let scope) = messages[1].notice else {
      return XCTFail("Approval receipt missing")
    }
    XCTAssertTrue(approved)
    XCTAssertEqual(command, "npm test")
    XCTAssertEqual(scope, "session")
    XCTAssertTrue(messages[1].activity.isEmpty)
    XCTAssertEqual(messages[2].activity.count, 1)
    XCTAssertEqual(messages[2].files.first?.name, "result.txt")
    XCTAssertEqual(NativeForkPoint.points(items).count, 2)
    guard case .approval(let denied, _, _) = messages[3].notice else {
      return XCTFail("Denial receipt missing")
    }
    XCTAssertFalse(denied)
  }

  func testSlackRevisionsPreserveTheOriginalAndBadgeOnlyTheMatchingMessage() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Ship Friday","externalId":"100.1","body":{"name":"Alice"}},
          {"kind":"UserMessage","seq":2,"createdAt":2,"text":"Another message","externalId":"100.2","body":{}},
          {"kind":"Retraction","seq":3,"createdAt":3,"body":{"action":"edited","ts":"100.1","text":"Ship Monday","name":"Alice"}},
          {"kind":"Retraction","seq":4,"createdAt":4,"body":{"action":"deleted","ts":"100.1","name":"Alice"}},
          {"kind":"Retraction","seq":5,"createdAt":5,"body":{"action":"deleted","ts":"outside-window"}}
        ]
        """#.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages.count, 5)
    XCTAssertEqual(messages[0].text, "Ship Friday")
    XCTAssertTrue(messages[0].edited)
    XCTAssertTrue(messages[0].deleted)
    XCTAssertFalse(messages[1].edited)
    XCTAssertFalse(messages[1].deleted)
    guard case .revision(let action, let speaker, let text) = messages[2].notice else {
      return XCTFail("Edit note missing")
    }
    XCTAssertEqual(action, "edited")
    XCTAssertEqual(speaker, "Alice")
    XCTAssertEqual(text, "Ship Monday")
    XCTAssertEqual(messages.last?.role, "notice")
  }

  func testSubagentWakeBecomesLinkedNoticeAndMalformedWakeRemainsText() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"<wake reason=\"subagent\" name=\"Research &amp; Analysis\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>","body":{"display":"[subagent Research: final answer]"}},
          {"kind":"UserMessage","seq":2,"createdAt":2,"text":"<wake reason=\"subagent\">ordinary incomplete text","body":{}}
        ]
        """#.utf8))
    let messages = chatMessages(items)
    guard case .subagent(let mail) = messages[0].notice else {
      return XCTFail("Subagent reference missing")
    }
    XCTAssertEqual(mail.sessionID, "child")
    XCTAssertEqual(mail.title, "Research & Analysis")
    XCTAssertEqual(mail.status, "finished")
    XCTAssertEqual(messages[0].role, "notice")
    XCTAssertEqual(messages[1].role, "user")
    XCTAssertEqual(messages[1].text, "<wake reason=\"subagent\">ordinary incomplete text")
  }

  func testSubagentTurnCannotReuseAttachmentReferencesFromThePreviousTurn() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Start","body":{}},
          {"kind":"AgentMessage","seq":2,"createdAt":2,"text":"Report","body":{"attachments":[{"name":"report.png","artifactId":"old"}]}},
          {"kind":"ElicitationResponse","seq":3,"createdAt":3,"approved":true,"body":{"command":"Continue"}},
          {"kind":"AgentMessage","seq":4,"createdAt":4,"text":"Same turn [report](attachment://report.png)","body":{}},
          {"kind":"UserMessage","seq":5,"createdAt":5,"text":"<wake reason=\"subagent\" name=\"Research\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>","body":{}},
          {"kind":"AgentMessage","seq":6,"createdAt":6,"text":"New turn [report](attachment://report.png)","body":{}}
        ]
        """#.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages.last!.referencedFiles.isEmpty)
  }

  func testSteeringAfterAPostDoesNotDuplicateTheDeliveredReply() throws {
    let source = #"""
      [
        {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Start","turnId":"run","body":{}},
        {"kind":"ToolCall","seq":2,"createdAt":2,"callId":"post","body":{"action":"post","text":"Delivered answer"}},
        {"kind":"SteeringMessage","seq":3,"createdAt":3,"text":"Steer before delivery","body":{}},
        {"kind":"ToolResult","seq":4,"createdAt":4,"callId":"post","body":{"ok":true}},
        {"kind":"SteeringMessage","seq":5,"createdAt":5,"text":"Steer after delivery","body":{}},
        {"kind":"AgentMessage","seq":6,"createdAt":6,"text":"Delivered answer","body":{}}
      ]
      """#
    let items = try JSONDecoder().decode([Item].self, from: Data(source.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(
      messages.map(\.text),
      ["Start", "Steer before delivery", "Delivered answer", "Steer after delivery"])
    XCTAssertEqual(messages.filter(\.steered).count, 2)
    XCTAssertTrue(messages.allSatisfy { $0.runID == "run" })
  }

  func testRunInputReconciliationUsesIdentityInsteadOfRepeatedText() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Again","turnId":"first","body":{}}]"#
          .utf8)
    )
    let first = RunInput(runId: "first", seq: 1, text: "Again", createdAt: 1, attachments: nil)
    let second = RunInput(runId: "second", seq: nil, text: "Again", createdAt: 2, attachments: nil)
    let runs = [
      ChatRunPresentation(id: "first", runID: "first", input: first),
      ChatRunPresentation(id: "second", runID: "second", input: second),
    ]
    let messages = presentedChatMessages(items, runs: runs, activeRunID: "second")
    XCTAssertEqual(messages.map(\.text), ["Again", "Again"])
    XCTAssertEqual(messages.map(\.runID), ["first", "second"])
  }

  func testQueuedInputOnlyJoinsTranscriptWhenItsRunStarts() {
    let input = RunInput(runId: "next", seq: nil, text: "Queued", createdAt: 2, attachments: nil)
    let runs = [ChatRunPresentation(id: "next", runID: "next", input: input)]
    XCTAssertTrue(
      presentedChatMessages([], runs: runs, activeRunID: nil, queuedRunIDs: ["next"]).isEmpty)
    XCTAssertTrue(presentedChatMessages([], runs: runs, activeRunID: "previous").isEmpty)
    XCTAssertEqual(
      presentedChatMessages([], runs: runs, activeRunID: "next").map(\.text), ["Queued"])
  }

  func testUnrecordedReplyRemainsBetweenItsInputAndSuccessor() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"First","turnId":"first","body":{}},{"kind":"UserMessage","seq":3,"createdAt":3,"text":"Next","turnId":"next","body":{}}]"#
          .utf8))
    let runs = [ChatRunPresentation(id: "first", runID: "first", reply: "Answer", finished: true)]
    XCTAssertEqual(
      presentedChatMessages(items, runs: runs, activeRunID: "next").map(\.text),
      ["First", "Answer", "Next"])
  }

  func testRecordedReplyAtomicallyReplacesFallbackAndInputSnapshot() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"First","turnId":"first","body":{}},{"kind":"AgentMessage","seq":2,"createdAt":2,"text":"Answer","body":{}}]"#
          .utf8))
    let input = RunInput(runId: "first", seq: 1, text: "First", createdAt: 1, attachments: nil)
    let runs = [
      ChatRunPresentation(
        id: "first", runID: "first", input: input, reply: "Answer", finished: true)
    ]
    XCTAssertEqual(
      presentedChatMessages(items, runs: runs, activeRunID: nil).map(\.text), ["First", "Answer"])
  }

  func testAttachmentReferencesStayWithTheirTurnAndUseLatestDeliveredVersion() throws {
    let source = #"""
      {"items":[
        {"kind":"UserMessage","seq":0,"createdAt":1,"text":"Create a report","body":{}},
        {"kind":"ToolResult","seq":1,"createdAt":1,"tool":"attach","body":{"ok":true,"files":[{"name":"report.png","artifactId":"old"}]}},
        {"kind":"ToolResult","seq":2,"createdAt":1,"tool":"attach","body":{"ok":true,"files":[{"name":"report.png","artifactId":"new"}]}},
        {"kind":"AgentMessage","seq":3,"createdAt":1,"text":"[Report](attachment://report.png)","body":{}},
        {"kind":"UserMessage","seq":4,"createdAt":1,"text":"Another request","body":{}},
        {"kind":"AgentMessage","seq":5,"createdAt":1,"text":"No attachment","body":{}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "new")
    XCTAssertEqual(messages[1].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages[5].referencedFiles.isEmpty)
  }

  func testDeliveredPostTakesPrecedenceOverInternalAssistantSummary() throws {
    let source = #"""
      {"items":[
        {"kind":"UserMessage","seq":0,"createdAt":1,"text":"internal","body":{"display":"Visible request"}},
        {"kind":"ToolCall","seq":1,"createdAt":2,"callId":"c1","body":{"action":"post","text":"Here is your report"}},
        {"kind":"ToolResult","seq":2,"createdAt":3,"callId":"c1","body":{"ok":true}},
        {"kind":"AgentMessage","seq":3,"createdAt":4,"text":"I posted the report","body":{}},
        {"kind":"AgentMessage","seq":4,"createdAt":5,"variant":"files_delivered","body":{"files":[{"name":"report.pdf","artifactId":"file-1"}]}},
        {"kind":"Error","seq":5,"createdAt":6,"text":"The follow-up failed","errorCode":"turn_failure","body":{}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(
      messages.map(\.text), ["Visible request", "Here is your report", "The follow-up failed"])
    XCTAssertEqual(messages[1].files.first?.artifactId, "file-1")
  }

  func testRejectedPostAndHiddenInputsAreNotPresentedAsDelivered() throws {
    let source = #"""
      {"items":[
        {"kind":"UserMessage","seq":0,"createdAt":1,"text":"hidden","hidden":true,"body":{}},
        {"kind":"UserMessage","seq":1,"createdAt":2,"body":{"attachments":[{"name":"photo.jpg"}]}},
        {"kind":"ToolCall","seq":2,"createdAt":3,"callId":"c1","body":{"action":"post","text":"Never delivered"}},
        {"kind":"ToolResult","seq":3,"createdAt":4,"callId":"c1","body":{"ok":false}},
        {"kind":"AgentMessage","seq":4,"createdAt":5,"text":"Unable to post","body":{}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(messages.count, 2)
    XCTAssertEqual(messages[0].files.first?.name, "photo.jpg")
    XCTAssertEqual(messages[1].text, "Unable to post")
  }

  func testCompletedRunCanHaveAFailedOutcome() throws {
    let run = try JSONDecoder().decode(
      Run.self,
      from: Data(#"{"status":"done","result":{"status":"refused","reason":"Access denied"}}"#.utf8))
    XCTAssertTrue(run.isFinished)
    XCTAssertEqual(run.failure, "Access denied")
    let approval = try JSONDecoder().decode(
      Approval.self, from: Data(#"{"requestId":"a","command":"publish","blocksInput":false}"#.utf8))
    XCTAssertFalse(approval.blocksComposer)
  }

  func testUnsentConversationsAreDiscoverableAfterRelaunch() throws {
    let account = UUID().uuidString
    defer { DraftStore.removeAccount(account) }
    let conversation = Conversation(
      id: "local", scopeId: "personal:test", threadRef: "web:test:local", surface: "web",
      localOnly: true)
    let pending = PendingSend(text: "Keep this task", idempotencyKey: "same-key")
    try DraftStore(account: account, thread: conversation.threadRef).write(
      .init(text: pending.text, pending: pending, conversation: conversation))
    let recovered = DraftStore.conversations(account)
    XCTAssertEqual(recovered.first?.threadRef, conversation.threadRef)
    XCTAssertEqual(recovered.first?.localOnly, true)
    XCTAssertEqual(
      DraftStore(account: account, thread: recovered[0].threadRef).read().pending?.idempotencyKey,
      "same-key")
  }
  func testNativePlaygroundsRequireSuccessfulTypedArtifactAndDeduplicate() throws {
    let source =
      #"{"items":[{"kind":"ToolResult","seq":1,"createdAt":1,"tool":"miniapp","body":{"display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"kind":"ToolResult","seq":2,"createdAt":2,"tool":"miniapp","body":{"display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"kind":"ToolResult","seq":3,"createdAt":3,"tool":"miniapp","isError":true,"body":{"display":{"artifact":{"kind":"playground","artifactId":"p2","title":"Failed"}}}},{"kind":"ToolResult","seq":4,"createdAt":4,"tool":"miniapp","body":{"display":{"artifact":{"kind":"playground","artifactId":"../secret","title":"Invalid"}}}}]}"#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    XCTAssertEqual(chatMessages(transcript.items).flatMap(\.playgrounds).map(\.id), ["p1"])
  }
  func testSidebarExcludesChildrenEvenWhenParentIsMissing() {
    func conversation(_ id: String, _ parent: String? = nil) -> Conversation {
      .init(id: id, scopeId: "personal:test", threadRef: "web:" + id, parentSessionId: parent)
    }
    let rows = [
      conversation("root"), conversation("child", "root"), conversation("grandchild", "child"),
      conversation("orphan", "missing"), conversation("promoted", ""),
    ]
    XCTAssertEqual(sidebarConversations(rows).map(\.id), ["root", "promoted"])
    XCTAssertEqual(rows.count, 5)
  }

  func testInheritedForkPointCannotIncludeUnloadedCurrentHistory() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Original question","body":{}},{"kind":"AgentMessage","seq":5,"createdAt":5,"text":"Original answer","body":{}},{"kind":"UserMessage","seq":10000,"createdAt":10000,"text":"Latest","body":{}}]"#
          .utf8))
    let points = NativeForkPoint.points(items, inheritedBoundary: 8)
    XCTAssertEqual(points[1].cut, "8")
    XCTAssertEqual(points[2].cut, "10000")
  }

  func testForkPointsIncludeDeliveredPostAndEndOfAssistantTurn() throws {
    let source =
      #"{"items":[{"kind":"UserMessage","seq":0,"createdAt":0,"text":"First","body":{}},{"kind":"ToolCall","seq":1,"createdAt":1,"callId":"post","body":{"action":"post","text":"Delivered"}},{"kind":"ToolResult","seq":2,"createdAt":2,"callId":"post","body":{"ok":true}},{"kind":"AgentMessage","seq":3,"createdAt":3,"text":"Internal summary","body":{}},{"kind":"UserMessage","seq":4,"createdAt":4,"text":"Hidden event","hidden":true,"body":{}},{"kind":"UserMessage","seq":5,"createdAt":5,"text":"Second","body":{}},{"kind":"AgentMessage","seq":6,"createdAt":6,"text":"Latest","body":{}}]}"#
    let items = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8)).items
    let points = NativeForkPoint.points(items)
    XCTAssertEqual(
      points.map(\.title), ["You: First", "QM: Delivered", "You: Second", "QM: Latest"])
    XCTAssertEqual(points.map(\.cut), ["0", "4", "5", "all"])
    XCTAssertEqual(Set(points.map(\.id)).count, points.count)
  }

}
