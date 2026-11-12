import XCTest

@testable import QM

final class TranscriptTests: XCTestCase {
  func testSuccessfulPostReconcilesCompletedFallbackBeforeTerminalHistoryArrives() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"A"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"surface","action":"post","callId":"p","text":"Answer"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"tool":"surface","callId":"p","ok":true}}
        ]
        """#.utf8))
    let messages = presentedChatMessages(
      entries,
      runs: [
        ChatRunPresentation(id: "A", runID: "A", reply: "Internal final summary", finished: true)
      ],
      activeRunID: nil)
    XCTAssertEqual(messages.map(\.text), ["Question", "Answer"])
    XCTAssertTrue(hasRecordedRunReply(entries, runID: "A"))
    XCTAssertFalse(hasRecordedRunReply(entries, runID: "B"))
    XCTAssertFalse(hasRecordedRunReply(Array(entries.prefix(2)), runID: "A"))
  }

  func testAttachmentOnlyHistoryKeepsFallbackWithoutDuplicatingActivity() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"A"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"attach","callId":"attachment"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"tool":"attach","callId":"attachment","ok":true,"files":[{"name":"report.txt","artifactId":"report"}]}},
          {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"Summarizing the report"}}
        ]
        """#.utf8))
    let messages = presentedChatMessages(
      Array(entries.prefix(3)),
      runs: [
        .init(
          id: "A", runID: "A", reply: "Answer", finished: true, activity: Array(entries.dropFirst())
        )
      ],
      activeRunID: nil)
    XCTAssertEqual(messages.filter { $0.text == "Answer" }.count, 1)
    XCTAssertEqual(messages.flatMap(\.files).map(\.name), ["report.txt"])
    XCTAssertEqual(messages.flatMap(\.activity).compactMap(\.seq), [2, 3, 4])
  }

  func testCompletedRunWithoutReplyKeepsItsActivityVisible() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Check status","runId":"A"}}]"#
          .utf8))
    let activity = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"web","action":"search","callId":"check"}},{"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"check","ok":true}}]"#
          .utf8))
    let run = ChatRunPresentation(
      id: "A", runID: "A", reply: "", finished: true, activity: activity)
    let messages = presentedChatMessages(entries, runs: [run], activeRunID: nil)
    XCTAssertEqual(messages.map(\.role), ["user", "assistant"])
    XCTAssertEqual(messages.last?.text, "")
    XCTAssertEqual(messages.last?.activity.compactMap(\.seq), [2, 3])
    XCTAssertEqual(messages.last?.runID, "A")
  }

  func testFailedAndUnmatchedPostsDoNotSuppressTheRunReply() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"A"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"action":"post","callId":"failed","text":"Answer"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"failed","ok":false}},
          {"type":"tool_result","seq":4,"createdAt":4,"payload":{"callId":"unmatched","ok":true}},
          {"type":"user","seq":5,"createdAt":5,"payload":{"text":"Next","runId":"B"}},
          {"type":"tool_call","seq":6,"createdAt":6,"payload":{"action":"post","callId":"next","text":"Answer"}},
          {"type":"tool_result","seq":7,"createdAt":7,"payload":{"callId":"next","ok":true}}
        ]
        """#.utf8))
    XCTAssertFalse(hasRecordedRunReply(entries, runID: "A"))
    XCTAssertTrue(hasRecordedRunReply(entries, runID: "B"))
  }

  func testApprovalReceiptsStayChronologicalWithoutConsumingActivityOrDelivery() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Run tests","runId":"run"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"callId":"execute","tool":"execute"}},
          {"type":"approval_resolved","seq":3,"createdAt":3,"payload":{"requestId":"approval","approved":true,"command":"npm test","scope":"session"}},
          {"type":"assistant","seq":4,"createdAt":4,"payload":{"text":"Passed"}},
          {"type":"approval_resolved","seq":5,"createdAt":5,"payload":{"approved":false,"command":"Another action"}},
          {"type":"delivery","seq":6,"createdAt":6,"payload":{"files":[{"name":"result.txt","artifactId":"result"}]}}
        ]
        """#.utf8))
    let messages = chatMessages(entries)
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
    XCTAssertEqual(NativeForkPoint.points(entries).count, 2)
    guard case .approval(let denied, _, _) = messages[3].notice else {
      return XCTFail("Denial receipt missing")
    }
    XCTAssertFalse(denied)
  }

  func testSlackRevisionsPreserveTheOriginalAndBadgeOnlyTheMatchingMessage() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Ship Friday","name":"Alice","ts":"100.1"}},
          {"type":"user","seq":2,"createdAt":2,"payload":{"text":"Another message","ts":"100.2"}},
          {"type":"system","seq":3,"createdAt":3,"payload":{"kind":"message_revision","action":"edited","ts":"100.1","text":"Ship Monday","name":"Alice"}},
          {"type":"system","seq":4,"createdAt":4,"payload":{"kind":"message_revision","action":"deleted","ts":"100.1","name":"Alice"}},
          {"type":"system","seq":5,"createdAt":5,"payload":{"kind":"message_revision","action":"deleted","ts":"outside-window"}}
        ]
        """#.utf8))
    let messages = chatMessages(entries)
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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"<wake reason=\"subagent\" name=\"Research &amp; Analysis\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>","display":"[subagent Research: final answer]"}},
          {"type":"user","seq":2,"createdAt":2,"payload":{"text":"<wake reason=\"subagent\">ordinary incomplete text"}}
        ]
        """#.utf8))
    let messages = chatMessages(entries)
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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Start"}},
          {"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Report","attachments":[{"name":"report.png","artifactId":"old"}]}},
          {"type":"approval_resolved","seq":3,"createdAt":3,"payload":{"approved":true,"command":"Continue"}},
          {"type":"assistant","seq":4,"createdAt":4,"payload":{"text":"Same turn [report](attachment://report.png)"}},
          {"type":"user","seq":5,"createdAt":5,"payload":{"text":"<wake reason=\"subagent\" name=\"Research\" sessionId=\"child\" kind=\"final_answer\" at=\"2026-09-30T22:00:00Z\">Finished.</wake>"}},
          {"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"New turn [report](attachment://report.png)"}}
        ]
        """#.utf8))
    let messages = chatMessages(entries)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages.last!.referencedFiles.isEmpty)
  }

  func testSteeringAfterAPostDoesNotDuplicateTheDeliveredReply() throws {
    let source = #"""
      [
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Start","runId":"run"}},
        {"type":"tool_call","seq":2,"createdAt":2,"payload":{"callId":"post","action":"post","text":"Delivered answer"}},
        {"type":"user","seq":3,"createdAt":3,"payload":{"text":"Steer before delivery","steered":true}},
        {"type":"tool_result","seq":4,"createdAt":4,"payload":{"callId":"post","ok":true}},
        {"type":"user","seq":5,"createdAt":5,"payload":{"text":"Steer after delivery","steered":true}},
        {"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"Delivered answer"}}
      ]
      """#
    let entries = try JSONDecoder().decode([Entry].self, from: Data(source.utf8))
    let messages = chatMessages(entries)
    XCTAssertEqual(
      messages.map(\.text),
      ["Start", "Steer before delivery", "Delivered answer", "Steer after delivery"])
    XCTAssertEqual(messages.filter(\.steered).count, 2)
    XCTAssertTrue(messages.allSatisfy { $0.runID == "run" })
  }

  func testRunInputReconciliationUsesIdentityInsteadOfRepeatedText() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Again","runId":"first"}}]"#.utf8)
    )
    let first = RunInput(runId: "first", seq: 1, text: "Again", createdAt: 1, attachments: nil)
    let second = RunInput(runId: "second", seq: nil, text: "Again", createdAt: 2, attachments: nil)
    let runs = [
      ChatRunPresentation(id: "first", runID: "first", input: first),
      ChatRunPresentation(id: "second", runID: "second", input: second),
    ]
    let messages = presentedChatMessages(entries, runs: runs, activeRunID: "second")
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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"First","runId":"first"}},{"type":"user","seq":3,"createdAt":3,"payload":{"text":"Next","runId":"next"}}]"#
          .utf8))
    let runs = [ChatRunPresentation(id: "first", runID: "first", reply: "Answer", finished: true)]
    XCTAssertEqual(
      presentedChatMessages(entries, runs: runs, activeRunID: "next").map(\.text),
      ["First", "Answer", "Next"])
  }

  func testRecordedReplyAtomicallyReplacesFallbackAndInputSnapshot() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"First","runId":"first"}},{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Answer"}}]"#
          .utf8))
    let input = RunInput(runId: "first", seq: 1, text: "First", createdAt: 1, attachments: nil)
    let runs = [
      ChatRunPresentation(
        id: "first", runID: "first", input: input, reply: "Answer", finished: true)
    ]
    XCTAssertEqual(
      presentedChatMessages(entries, runs: runs, activeRunID: nil).map(\.text), ["First", "Answer"])
  }

  func testAttachmentReferencesStayWithTheirTurnAndUseLatestDeliveredVersion() throws {
    let source = #"""
      {"entries":[
        {"type":"user","seq":0,"createdAt":1,"payload":{"text":"Create a report"}},
        {"type":"tool_result","seq":1,"createdAt":1,"payload":{"tool":"attach","ok":true,"files":[{"name":"report.png","artifactId":"old"}]}},
        {"type":"tool_result","seq":2,"createdAt":1,"payload":{"tool":"attach","ok":true,"files":[{"name":"report.png","artifactId":"new"}]}},
        {"type":"assistant","seq":3,"createdAt":1,"payload":{"text":"[Report](attachment://report.png)"}},
        {"type":"user","seq":4,"createdAt":1,"payload":{"text":"Another request"}},
        {"type":"assistant","seq":5,"createdAt":1,"payload":{"text":"No attachment"}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.entries)
    XCTAssertEqual(messages[3].referencedFiles.first?.artifactId, "new")
    XCTAssertEqual(messages[1].referencedFiles.first?.artifactId, "old")
    XCTAssertTrue(messages[5].referencedFiles.isEmpty)
  }

  func testDeliveredPostTakesPrecedenceOverInternalAssistantSummary() throws {
    let source = #"""
      {"entries":[
        {"type":"user","seq":0,"createdAt":1,"payload":{"text":"internal","display":"Visible request"}},
        {"type":"tool_call","seq":1,"createdAt":2,"payload":{"action":"post","callId":"c1","text":"Here is your report"}},
        {"type":"tool_result","seq":2,"createdAt":3,"payload":{"callId":"c1","ok":true}},
        {"type":"assistant","seq":3,"createdAt":4,"payload":{"text":"I posted the report"}},
        {"type":"delivery","seq":4,"createdAt":5,"payload":{"files":[{"name":"report.pdf","artifactId":"file-1"}]}},
        {"type":"system","seq":5,"createdAt":6,"payload":{"kind":"turn_failure","message":"The follow-up failed"}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.entries)
    XCTAssertEqual(
      messages.map(\.text), ["Visible request", "Here is your report", "The follow-up failed"])
    XCTAssertEqual(messages[1].files.first?.artifactId, "file-1")
  }

  func testRejectedPostAndHiddenInputsAreNotPresentedAsDelivered() throws {
    let source = #"""
      {"entries":[
        {"type":"user","seq":0,"createdAt":1,"payload":{"text":"hidden","hidden":true}},
        {"type":"user","seq":1,"createdAt":2,"payload":{"attachments":[{"name":"photo.jpg"}]}},
        {"type":"tool_call","seq":2,"createdAt":3,"payload":{"action":"post","callId":"c1","text":"Never delivered"}},
        {"type":"tool_result","seq":3,"createdAt":4,"payload":{"callId":"c1","ok":false}},
        {"type":"assistant","seq":4,"createdAt":5,"payload":{"text":"Unable to post"}}
      ]}
      """#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    let messages = chatMessages(transcript.entries)
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
      #"{"entries":[{"type":"tool_result","seq":1,"createdAt":1,"payload":{"tool":"miniapp","display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"type":"tool_result","seq":2,"createdAt":2,"payload":{"tool":"miniapp","display":{"artifact":{"kind":"playground","artifactId":"p1","title":"Calculator"}}}},{"type":"tool_result","seq":3,"createdAt":3,"payload":{"tool":"miniapp","isError":true,"display":{"artifact":{"kind":"playground","artifactId":"p2","title":"Failed"}}}},{"type":"tool_result","seq":4,"createdAt":4,"payload":{"tool":"miniapp","display":{"artifact":{"kind":"playground","artifactId":"../secret","title":"Invalid"}}}}]}"#
    let transcript = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8))
    XCTAssertEqual(chatMessages(transcript.entries).flatMap(\.playgrounds).map(\.id), ["p1"])
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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Original question"}},{"type":"assistant","seq":5,"createdAt":5,"payload":{"text":"Original answer"}},{"type":"user","seq":10000,"createdAt":10000,"payload":{"text":"Latest"}}]"#
          .utf8))
    let points = NativeForkPoint.points(entries, inheritedBoundary: 8)
    XCTAssertEqual(points[1].cut, "8")
    XCTAssertEqual(points[2].cut, "10000")
  }

  func testForkPointsIncludeDeliveredPostAndEndOfAssistantTurn() throws {
    let source =
      #"{"entries":[{"type":"user","seq":0,"createdAt":0,"payload":{"text":"First"}},{"type":"tool_call","seq":1,"createdAt":1,"payload":{"action":"post","callId":"post","text":"Delivered"}},{"type":"tool_result","seq":2,"createdAt":2,"payload":{"callId":"post","ok":true}},{"type":"assistant","seq":3,"createdAt":3,"payload":{"text":"Internal summary"}},{"type":"user","seq":4,"createdAt":4,"payload":{"hidden":true,"text":"Hidden event"}},{"type":"user","seq":5,"createdAt":5,"payload":{"text":"Second"}},{"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"Latest"}}]}"#
    let entries = try JSONDecoder().decode(Transcript.self, from: Data(source.utf8)).entries
    let points = NativeForkPoint.points(entries)
    XCTAssertEqual(
      points.map(\.title), ["You: First", "QM: Delivered", "You: Second", "QM: Latest"])
    XCTAssertEqual(points.map(\.cut), ["0", "4", "5", "all"])
    XCTAssertEqual(Set(points.map(\.id)).count, points.count)
  }

}
