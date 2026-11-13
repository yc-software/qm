import XCTest

@testable import QM

final class TranscriptTests: XCTestCase {
  func testSuccessfulPostReconcilesCompletedFallbackBeforeTerminalHistoryArrives() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"A","text":"Question","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"p","tool":"surface","body":{"action":"post","text":"Answer"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"p","tool":"surface","body":{"ok":true}}]
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"A","text":"Question","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"attachment","tool":"attach","body":{}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"attachment","tool":"attach","body":{"ok":true,"files":[{"name":"report.txt","artifactId":"report"}]}},{"seq":4,"createdAt":4,"kind":"Reasoning","text":"Summarizing the report","body":{}}]
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

  func testCompletedRunWithoutReplyKeepsItsActivityVisible() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"A","text":"Check status","body":{}}]"#
          .utf8))
    let activity = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"check","tool":"web","body":{"action":"search"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"check","body":{"ok":true}}]"#
          .utf8))
    let run = ChatRunPresentation(
      id: "A", runID: "A", reply: "", finished: true, activity: activity)
    let messages = presentedChatMessages(items, runs: [run], activeRunID: nil)
    XCTAssertEqual(messages.map(\.role), ["user", "assistant"])
    XCTAssertEqual(messages.last?.text, "")
    XCTAssertEqual(messages.last?.activity.compactMap(\.seq), [2, 3])
    XCTAssertEqual(messages.last?.runID, "A")
  }

  func testFailedAndUnmatchedPostsDoNotSuppressTheRunReply() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"A","text":"Question","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"failed","body":{"action":"post","text":"Answer"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"failed","body":{"ok":false}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"unmatched","body":{"ok":true}},{"seq":5,"createdAt":5,"kind":"UserMessage","turnId":"B","text":"Next","body":{}},{"seq":6,"createdAt":6,"kind":"ToolCall","callId":"next","body":{"action":"post","text":"Answer"}},{"seq":7,"createdAt":7,"kind":"ToolResult","callId":"next","body":{"ok":true}}]
        """#.utf8))
    XCTAssertFalse(hasRecordedRunReply(items, runID: "A"))
    XCTAssertTrue(hasRecordedRunReply(items, runID: "B"))
  }

  func testApprovalReceiptsStayChronologicalWithoutConsumingActivityOrDelivery() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Run tests","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"execute","tool":"execute","body":{}},{"seq":3,"createdAt":3,"kind":"ElicitationResponse","elicitId":"approval","approved":true,"body":{"command":"npm test","scope":"session"}},{"seq":4,"createdAt":4,"kind":"AgentMessage","text":"Passed","body":{}},{"seq":5,"createdAt":5,"kind":"ElicitationResponse","approved":false,"elicitId":"approval-5","body":{"command":"Another action"}},{"seq":6,"createdAt":6,"kind":"AgentMessage","variant":"files_delivered","body":{"files":[{"name":"result.txt","artifactId":"result"}]}}]
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","externalId":"100.1","text":"Ship Friday","body":{"name":"Alice"}},{"seq":2,"createdAt":2,"kind":"UserMessage","externalId":"100.2","text":"Another message","body":{}},{"seq":3,"createdAt":3,"kind":"Retraction","externalId":"100.1","body":{"action":"edited","text":"Ship Monday","name":"Alice"}},{"seq":4,"createdAt":4,"kind":"Retraction","externalId":"100.1","body":{"action":"deleted","name":"Alice"}},{"seq":5,"createdAt":5,"kind":"Retraction","externalId":"outside-window","body":{"action":"deleted"}}]
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","text":"<wake reason=\"subagent\" name=\"Research &amp; Analysis\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>","body":{"display":"[subagent Research: final answer]"}},{"seq":2,"createdAt":2,"kind":"UserMessage","text":"<wake reason=\"subagent\">ordinary incomplete text","body":{}}]
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Start","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Report","body":{"attachments":[{"name":"report.png","artifactId":"old"}]}},{"seq":3,"createdAt":3,"kind":"ElicitationResponse","approved":true,"elicitId":"approval-3","body":{"command":"Continue"}},{"seq":4,"createdAt":4,"kind":"AgentMessage","text":"Same turn [report](attachment://report.png)","body":{}},{"seq":5,"createdAt":5,"kind":"UserMessage","text":"<wake reason=\"subagent\" name=\"Research\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>","body":{}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"New turn [report](attachment://report.png)","body":{}}]
        """#.utf8))
    let messages = chatMessages(items)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages.last!.referencedFiles.isEmpty)
  }

  func testSteeringAfterAPostDoesNotDuplicateTheDeliveredReply() throws {
    let source = #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Start","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"Delivered answer"}},{"seq":3,"createdAt":3,"kind":"SteeringMessage","text":"Steer before delivery","body":{}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"post","body":{"ok":true}},{"seq":5,"createdAt":5,"kind":"SteeringMessage","text":"Steer after delivery","body":{}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"Delivered answer","body":{}}]
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
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"first","text":"Again","body":{}}]"#.utf8)
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
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"first","text":"First","body":{}},{"seq":3,"createdAt":3,"kind":"UserMessage","turnId":"next","text":"Next","body":{}}]"#
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
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"first","text":"First","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Answer","body":{}}]"#
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
      {"items":[{"seq":0,"createdAt":1,"kind":"UserMessage","text":"Create a report","body":{}},{"seq":1,"createdAt":1,"kind":"ToolResult","tool":"attach","callId":"call-1","body":{"ok":true,"files":[{"name":"report.png","artifactId":"old"}]}},{"seq":2,"createdAt":1,"kind":"ToolResult","tool":"attach","callId":"call-2","body":{"ok":true,"files":[{"name":"report.png","artifactId":"new"}]}},{"seq":3,"createdAt":1,"kind":"AgentMessage","text":"[Report](attachment://report.png)","body":{}},{"seq":4,"createdAt":1,"kind":"UserMessage","text":"Another request","body":{}},{"seq":5,"createdAt":1,"kind":"AgentMessage","text":"No attachment","body":{}}]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "new")
    XCTAssertEqual(messages[1].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages[5].referencedFiles.isEmpty)
  }

  func testDeliveredPostTakesPrecedenceOverInternalAssistantSummary() throws {
    let source = #"""
      {"items":[{"seq":0,"createdAt":1,"kind":"UserMessage","text":"internal","body":{"display":"Visible request"}},{"seq":1,"createdAt":2,"kind":"ToolCall","callId":"c1","body":{"action":"post","text":"Here is your report"}},{"seq":2,"createdAt":3,"kind":"ToolResult","callId":"c1","body":{"ok":true}},{"seq":3,"createdAt":4,"kind":"AgentMessage","text":"I posted the report","body":{}},{"seq":4,"createdAt":5,"kind":"AgentMessage","variant":"files_delivered","body":{"files":[{"name":"report.pdf","artifactId":"file-1"}]}},{"seq":5,"createdAt":6,"kind":"Error","text":"The follow-up failed","body":{}}]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.items)
    XCTAssertEqual(
      messages.map(\.text), ["Visible request", "Here is your report", "The follow-up failed"])
    XCTAssertEqual(messages[1].files.first?.artifactId, "file-1")
  }

  func testRejectedPostAndHiddenInputsAreNotPresentedAsDelivered() throws {
    let source = #"""
      {"items":[{"seq":0,"createdAt":1,"kind":"UserMessage","hidden":true,"text":"hidden","body":{}},{"seq":1,"createdAt":2,"kind":"UserMessage","body":{"attachments":[{"name":"photo.jpg"}]}},{"seq":2,"createdAt":3,"kind":"ToolCall","callId":"c1","body":{"action":"post","text":"Never delivered"}},{"seq":3,"createdAt":4,"kind":"ToolResult","callId":"c1","body":{"ok":false}},{"seq":4,"createdAt":5,"kind":"AgentMessage","text":"Unable to post","body":{}}]}
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
      #"{"items":[{"seq":1,"createdAt":1,"kind":"ToolResult","tool":"miniapp","callId":"call-1","body":{"display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"seq":2,"createdAt":2,"kind":"ToolResult","tool":"miniapp","callId":"call-2","body":{"display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"seq":3,"createdAt":3,"kind":"ToolResult","tool":"miniapp","isError":true,"callId":"call-3","body":{"display":{"artifact":{"kind":"playground","artifactId":"p2","title":"Failed"}}}},{"seq":4,"createdAt":4,"kind":"ToolResult","tool":"miniapp","callId":"call-4","body":{"display":{"artifact":{"kind":"playground","artifactId":"../secret","title":"Invalid"}}}}]}"#
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
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Original question","body":{}},{"seq":5,"createdAt":5,"kind":"AgentMessage","text":"Original answer","body":{}},{"seq":10000,"createdAt":10000,"kind":"UserMessage","text":"Latest","body":{}}]"#
          .utf8))
    let points = NativeForkPoint.points(items, inheritedBoundary: 8)
    XCTAssertEqual(points[1].cut, "8")
    XCTAssertEqual(points[2].cut, "10000")
  }

  func testForkPointsIncludeDeliveredPostAndEndOfAssistantTurn() throws {
    let source =
      #"{"items":[{"seq":0,"createdAt":0,"kind":"UserMessage","text":"First","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"Delivered"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"post","body":{"ok":true}},{"seq":3,"createdAt":3,"kind":"AgentMessage","text":"Internal summary","body":{}},{"seq":4,"createdAt":4,"kind":"UserMessage","hidden":true,"text":"Hidden event","body":{}},{"seq":5,"createdAt":5,"kind":"UserMessage","text":"Second","body":{}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"Latest","body":{}}]}"#
    let items = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8)).items
    let points = NativeForkPoint.points(items)
    XCTAssertEqual(
      points.map(\.title), ["You: First", "QM: Delivered", "You: Second", "QM: Latest"])
    XCTAssertEqual(points.map(\.cut), ["0", "4", "5", "all"])
    XCTAssertEqual(Set(points.map(\.id)).count, points.count)
  }

}
