import XCTest

@testable import QM

final class NativeRunTimelineTests: XCTestCase {
  private func items(_ json: String) throws -> [Item] {
    try JSONDecoder().decode([Item].self, from: Data(json.utf8))
  }

  private func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
  }

  func testCommentarySeparatesEarlierWorkFromContinuedWork() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"Reasoning","text":"First step","body":{}},{"seq":1,"createdAt":2,"marker":"text_start","streamOffset":0},{"seq":2,"createdAt":3,"kind":"AgentMessage","variant":"narration","text":"I found the first issue.","body":{"phase":"commentary"}},{"seq":3,"createdAt":4,"kind":"ToolCall","callId":"check","tool":"execute","body":{}},{"seq":4,"createdAt":5,"kind":"Reasoning","text":"Check the next issue","body":{}}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "I found the first issue.", startOffset: 0,
      runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["I found the first issue.", ""])
    XCTAssertEqual(timeline.messages.map { $0.activity.compactMap(\.seq) }, [[1], [3, 4]])
    XCTAssertFalse(timeline.responding)
  }

  func testLaterStreamedTextSurvivesRecordedInterimPost() throws {
    let history = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Find issues","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"First update"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"post","body":{"ok":true}}]
      """#)
    let activity = try items(
      #"""
      [{"seq":4,"createdAt":4,"kind":"Reasoning","text":"Continuing","body":{}},{"seq":4,"createdAt":5,"marker":"text_start","streamOffset":14}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "First update\n\nMore issues", startOffset: 0,
      runID: "run", recorded: chatMessages(history))
    XCTAssertEqual(timeline.messages.last?.text, "More issues")
    XCTAssertEqual(timeline.messages.last?.activity.compactMap(\.seq), [4])
    XCTAssertTrue(timeline.responding)
  }

  func testTextBoundariesUseUTF16AndRetainedStreamOffset() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":2,"marker":"text_start","phase":"final_answer","streamOffset":108}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Hi 👋!\n\nFinal", startOffset: 100,
      runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.last?.text, "Final")
  }

  func testIdenticalCommentaryAndFinalTextRemainSeparateMessages() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"marker":"text_start","phase":"commentary","streamOffset":0},{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Ready","body":{"phase":"commentary"}},{"seq":2,"createdAt":3,"marker":"text_start","phase":"final_answer","streamOffset":7}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Ready\n\nReady", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["Ready", "Ready"])
    XCTAssertNotEqual(timeline.messages.first?.id, timeline.messages.last?.id)
  }

  func testReloadKeepsCommentaryAndLaterThinkingInTheirOrder() throws {
    let history = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Find issues","body":{}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"First","body":{}},{"seq":3,"createdAt":3,"kind":"AgentMessage","variant":"narration","text":"Continuing","body":{"phase":"commentary"}},{"seq":4,"createdAt":4,"kind":"Reasoning","text":"Second","body":{}},{"seq":5,"createdAt":5,"kind":"AgentMessage","variant":"narration","text":"Done","step":0,"body":{"wire":{"message":{"id":"final"}}}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"Done","step":0,"body":{"wire":{"message":{"id":"final"}}}}]
      """#)
    let messages = chatMessages(history)
    XCTAssertEqual(messages.map(\.text), ["Find issues", "Continuing", "Done"])
    XCTAssertEqual(messages.map { $0.activity.compactMap(\.seq) }, [[], [2], [4]])
  }

  func testReplyCompleteWaitsForTerminalResult() throws {
    let reply = try event(
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","replyComplete":true,"partial":"Continuing"}}"#
    )
    XCTAssertFalse(try XCTUnwrap(reply.run).isFinished)
    let done = try event(
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","replyComplete":true,"result":{"status":"ok","reply":"Done"}}}"#
    )
    XCTAssertTrue(try XCTUnwrap(done.run).isFinished)
  }

  func testDemotedTextDoesNotBecomePublicCommentary() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"AgentMessage","variant":"narration","text":"Public update","body":{"phase":"commentary"}},{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Internal summary","body":{"retracted":true}}]
      """#)
    XCTAssertEqual(chatMessages(activity).map(\.text), ["Public update"])
    let timeline = NativeRunTimeline(
      activity: activity, partial: "", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["Public update", ""])
  }

  func testRepeatedTextInDifferentStepsKeepsFinalReplyBelowLaterWork() throws {
    let history = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"AgentMessage","variant":"narration","text":"Ready","step":0,"body":{"wire":{"message":{"id":"first"}}}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Check again","body":{}},{"seq":3,"createdAt":3,"kind":"AgentMessage","text":"Ready","step":0,"body":{"wire":{"message":{"id":"second"}}}}]
      """#)
    let messages = chatMessages(history)
    XCTAssertEqual(messages.map(\.text), ["Ready", "Ready"])
    XCTAssertEqual(messages.last?.activity.compactMap(\.seq), [2])
    let withoutWork = chatMessages([history[0], history[2]])
    XCTAssertEqual(withoutWork.map(\.text), ["Ready", "Ready"])
  }

  func testCompletionKeepsLiveCommentaryWhenHistoryHasNotCaughtUp() throws {
    let history = try items(
      #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Check","body":{}}]"#)
    let activity = try items(
      #"""
      [{"seq":2,"createdAt":2,"kind":"Reasoning","text":"First","body":{}},{"seq":3,"createdAt":3,"kind":"AgentMessage","variant":"narration","text":"First update","body":{}},{"seq":4,"createdAt":4,"kind":"Reasoning","text":"Second","body":{}}]
      """#)
    let messages = presentedChatMessages(
      history,
      runs: [
        ChatRunPresentation(
          id: "run", runID: "run", reply: "Done", finished: true, activity: activity)
      ],
      activeRunID: nil)
    XCTAssertEqual(messages.map(\.text), ["Check", "First update", "Done"])
    XCTAssertEqual(messages.map { $0.activity.compactMap(\.seq) }, [[], [2], [4]])
  }

  func testTerminalReplyUsesItsOwnTextWhileHistoryRefreshIsPending() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"AgentMessage","variant":"narration","text":"First update","body":{}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Finishing","body":{}},{"seq":2,"createdAt":3,"marker":"text_start","streamOffset":14}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Done", startOffset: 0, runID: "run", recorded: [],
      finalReply: true)
    XCTAssertEqual(timeline.messages.map(\.text), ["First update", "Done"])
    XCTAssertEqual(timeline.messages.last?.activity.compactMap(\.seq), [2])
  }

  func testUnphasedTerminalReplyRepeatingCommentaryRemainsADistinctMessage() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"AgentMessage","variant":"narration","text":"Ready","step":0,"body":{"wire":{"message":{"id":"first"}}}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Check again","body":{}}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Ready", startOffset: 0, runID: "run", recorded: [],
      finalReply: true)
    XCTAssertEqual(timeline.messages.map(\.text), ["Ready", "Ready"])
    XCTAssertEqual(timeline.messages.last?.activity.compactMap(\.seq), [2])
    let completed = presentedChatMessages(
      [],
      runs: [
        ChatRunPresentation(
          id: "run", runID: "run", reply: "Ready", finished: true,
          activity: [activity[0]])
      ], activeRunID: nil)
    XCTAssertEqual(completed.map(\.text), ["Ready", "Ready"])
  }

  func testPostCompletedAfterCommentarySuppressesPrivateTerminalSummary() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"Delivered"}},{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Still checking","body":{"phase":"commentary"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"post","body":{"ok":true}}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Private terminal summary", startOffset: 0, runID: "run",
      recorded: [], finalReply: true)
    XCTAssertEqual(timeline.messages.map(\.text), ["Still checking", "Delivered", ""])
    XCTAssertEqual(timeline.messages.first?.activity.compactMap(\.seq), [1, 3])
    let recorded = NativeRunTimeline(
      activity: [], partial: "Private terminal summary", startOffset: 0, runID: "run",
      recorded: chatMessages(activity, runID: "run"), finalReply: true)
    XCTAssertEqual(recorded.messages.map(\.text), [""])
  }

  func testLateToolResultStaysWithItsCallAcrossCommentary() throws {
    let activity = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"check","tool":"execute","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Still checking","body":{"phase":"commentary"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"Reasoning","text":"Next step","body":{}}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map { $0.activity.compactMap(\.seq) }, [[1, 3], [4]])
    XCTAssertEqual(
      NativeWorkItem.items(timeline.messages[0].activity).first?.state(active: false), .complete)
    let recorded = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"check","tool":"execute","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Done","body":{}}]
      """#)
    let completed = presentedChatMessages(
      recorded,
      runs: [
        ChatRunPresentation(
          id: "run", runID: "run", reply: "Done", finished: true, activity: [activity[2]])
      ],
      activeRunID: nil)
    XCTAssertEqual(completed.map(\.text), ["Check", "Done"])
    XCTAssertEqual(completed.last?.activity.compactMap(\.seq), [1, 3])
  }

  func testReasoningStreamsThenSettlesUnderItsPersistedIdentity() throws {
    var stream = StreamText()
    try stream.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"reasoning":[{"step":"step","index":0,"text":"Check 👋"}]}}"#
      ))
    try stream.apply(
      event(
        #"{"type":"CUSTOM","name":"reasoning","value":{"step":"step","index":0,"offset":8,"delta":" next"}}"#
      ))
    XCTAssertEqual(stream.reasoning.map(\.text), ["Check 👋 next"])
    try stream.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","activity":[{"seq":1,"createdAt":1,"kind":"Reasoning","text":"Check 👋 next","step":0,"body":{"wire":{"message":{"id":"step"}}}}]}}"#
      ))
    XCTAssertTrue(stream.reasoning.isEmpty)
    try stream.apply(
      event(
        #"{"type":"CUSTOM","name":"reasoning","value":{"step":"new","index":0,"offset":0,"delta":"Retry"}}"#
      ))
    XCTAssertEqual(stream.reasoning.map(\.text), ["Retry"])
    try stream.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":2}}"#))
    XCTAssertTrue(stream.reasoning.isEmpty)
  }
}

final class NativeChatTimelineTests: XCTestCase {
  private func items(_ json: String) throws -> [Item] {
    try JSONDecoder().decode([Item].self, from: Data(json.utf8))
  }

  private func labels(_ timeline: NativeChatTimeline) -> [String] {
    timeline.items.map {
      switch $0.content {
      case .message(let message): message.text
      case .work(let item): item.isThinking ? item.entry.text ?? "" : item.title
      case .reasoning(let block): block.text
      }
    }
  }

  func testActivityGroupsKeepCommentaryAndOldRunsSeparateWithoutDuplicatingCalls() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"old","text":"Old question","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"check","tool":"files","body":{}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":3,"createdAt":3,"kind":"AgentMessage","text":"Old answer","body":{}},{"seq":4,"createdAt":4,"kind":"UserMessage","turnId":"new","text":"New question","body":{}},{"seq":5,"createdAt":5,"kind":"Reasoning","text":"Checking the request","body":{}},{"seq":6,"createdAt":6,"kind":"ToolCall","callId":"check","tool":"search","body":{}},{"seq":7,"createdAt":7,"kind":"AgentMessage","variant":"narration","text":"I found a lead","body":{"phase":"commentary"}},{"seq":8,"createdAt":8,"kind":"ToolCall","callId":"verify","tool":"execute","body":{}},{"seq":9,"createdAt":9,"kind":"ToolResult","callId":"verify","body":{"ok":true}},{"seq":10,"createdAt":10,"kind":"ToolResult","callId":"check","body":{"ok":true}}]
      """#)
    let timeline = NativeChatTimeline(
      messages: chatMessages(history), items: history, activeRunID: "new")
    let sections = NativeChatTranscriptSection.grouped(
      timeline.items, activeRunID: "new", status: .working)
    XCTAssertEqual(sections.map(\.isActivity), [false, true, false, false, true, false, true])
    let groups = sections.filter(\.isActivity)
    XCTAssertEqual(groups.map(\.runID), ["old", "new", "new"])
    XCTAssertEqual(groups.map { $0.items.compactMap(\.sequence) }, [[1], [5, 6], [8]])
    XCTAssertEqual(groups.map(\.status), [nil, nil, .working])
    XCTAssertEqual(sections.flatMap(\.items).map(\.id), timeline.items.map(\.id))
    XCTAssertEqual(Set(sections.map(\.id)).count, sections.count)
    let calls = groups.flatMap(\.items).compactMap { item -> NativeWorkItem? in
      guard case .work(let work) = item.content, !work.isThinking else { return nil }
      return work
    }
    XCTAssertEqual(calls.map { $0.result?.seq }, [2, 10, 9])
    XCTAssertTrue(calls.allSatisfy { $0.state(active: true) == .complete })
  }

  func testActivityGroupDoesNotPresentFailedInterruptedOrApprovalWorkAsComplete() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"check","tool":"execute","body":{}}]
      """#)
    func group(
      _ history: [Item], runID: String? = nil, error: ChatMessage? = nil
    ) throws -> NativeChatTranscriptSection {
      let timeline = NativeChatTimeline(
        messages: chatMessages(history) + [error].compactMap { $0 }, items: history,
        activeRunID: runID)
      let sections = NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: runID, status: nil)
      return try XCTUnwrap(sections.first(where: \.isActivity))
    }
    XCTAssertEqual(try group(history, runID: "run").workState, .running)
    XCTAssertEqual(try group(history).workState, .unconfirmed)
    let failed = ChatMessage(
      id: "failure", role: "error", text: "The run failed", runID: "run")
    XCTAssertEqual(try group(history, error: failed).workState, .failed)
    let approval = try items(
      #"[{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"check","body":{"blocked":"needs_approval"}}]"#
    )
    XCTAssertEqual(try group(history + approval).workState, .approval)
  }

  func testEveryInvocationKeepsItsPlaceAcrossLiveCompletionAndReload() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"first","tool":"files","body":{"action":"read"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"first","body":{"ok":true}},{"seq":3,"createdAt":3,"kind":"AgentMessage","variant":"narration","text":"First update","body":{}},{"seq":4,"createdAt":4,"kind":"ToolCall","callId":"second","tool":"search","body":{}},{"seq":5,"createdAt":5,"kind":"ToolResult","callId":"second","body":{"ok":true}},{"seq":6,"createdAt":6,"kind":"Reasoning","text":"Need another opinion","body":{}},{"seq":7,"createdAt":7,"kind":"ToolCall","callId":"spawn","tool":"subagents","body":{"action":"open"}},{"seq":8,"createdAt":8,"kind":"ToolResult","callId":"spawn","body":{"ok":true}},{"seq":9,"createdAt":9,"kind":"AgentMessage","variant":"narration","text":"An agent is checking","body":{}},{"seq":10,"createdAt":10,"kind":"ToolCall","callId":"last","tool":"execute","body":{}},{"seq":11,"createdAt":11,"kind":"ToolResult","callId":"last","body":{"ok":true}},{"seq":12,"createdAt":12,"kind":"AgentMessage","text":"Done","body":{}}]
      """#)
    let activity = Array(history.dropFirst().dropLast())
    let live = NativeRunTimeline(
      activity: activity, partial: "Done", startOffset: 0, runID: "run",
      recorded: chatMessages([history[0]]))
    let liveRows = NativeChatTimeline(
      messages: chatMessages([history[0]]) + live.messages, items: [history[0]] + activity,
      activeRunID: "run", streamingMessageID: live.messages.last?.id)
    let completed = presentedChatMessages(
      [history[0]],
      runs: [
        ChatRunPresentation(
          id: "run", runID: "run", reply: "Done", finished: true,
          activity: activity)
      ], activeRunID: nil)
    let finalRows = NativeChatTimeline(messages: completed, items: [history[0]] + activity)
    let reloaded = NativeChatTimeline(messages: chatMessages(history), items: history)
    let expected = [
      "Check", "files · read", "First update", "search", "Need another opinion",
      "subagents · open", "An agent is checking", "execute", "Done",
    ]
    for rows in [liveRows, finalRows, reloaded] {
      XCTAssertEqual(labels(rows), expected)
      XCTAssertEqual(Set(rows.items.map(\.id)).count, rows.items.count)
    }
    let workIDs = { (timeline: NativeChatTimeline) in
      timeline.items.compactMap { item -> String? in
        if case .work = item.content { return item.id }
        return nil
      }
    }
    XCTAssertEqual(workIDs(liveRows), workIDs(reloaded))
    XCTAssertEqual(workIDs(finalRows), workIDs(reloaded))
  }

  func testLatePostResultUpdatesInvocationWithoutMovingCommentaryOrCollidingWithDelivery() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"post","tool":"slack","body":{"action":"post","text":"Delivered"}},{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Progress","body":{"phase":"commentary"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"post","body":{"ok":true}}]
      """#)
    let timeline = NativeChatTimeline(messages: chatMessages(history), items: history)
    XCTAssertEqual(labels(timeline), ["Check", "slack · post", "Progress", "Delivered"])
    XCTAssertEqual(Set(timeline.items.map(\.id)).count, 4)
    guard case .work(let call) = timeline.items[1].content else { return XCTFail("Missing call") }
    XCTAssertEqual(call.state(active: true), .complete)
    XCTAssertEqual(call.result?.seq, 3)
  }

  func testSourceBlockIndexOrdersTextBeforeLaterThinkingWithinItsStep() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"before","tool":"files","body":{}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Plan parallel work","step":1,"body":{"wire":{"message":{"id":"step"}}}},{"seq":3,"createdAt":3,"kind":"AgentMessage","variant":"narration","text":"Starting agents","step":0,"body":{"wire":{"message":{"id":"step"}}}},{"seq":4,"createdAt":4,"kind":"ToolCall","callId":"spawn","tool":"subagents","step":2,"body":{"action":"open","wire":{"message":{"id":"step"}}}},{"seq":5,"createdAt":5,"kind":"ToolResult","callId":"spawn","body":{"ok":true}},{"seq":6,"createdAt":6,"kind":"AgentMessage","text":"Done","step":0,"body":{"wire":{"message":{"id":"next"}}}}]
      """#)
    let timeline = NativeChatTimeline(messages: chatMessages(history), items: history)
    XCTAssertEqual(
      labels(timeline),
      [
        "Check", "files", "Starting agents", "Plan parallel work",
        "subagents · open", "Done",
      ])
  }

  func testEqualSequenceEventsKeepSourceOrderAndTrailingSavedWorkStaysVisible() throws {
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":0,"createdAt":1,"marker":"text_start","streamOffset":0},{"seq":1,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"Progress","body":{}},{"seq":1,"createdAt":3,"kind":"ToolCall","callId":"first","tool":"files","body":{}},{"seq":1,"createdAt":4,"kind":"ToolCall","callId":"second","tool":"search","body":{}}]
      """#)
    XCTAssertEqual(
      labels(NativeChatTimeline(messages: chatMessages(history), items: history)),
      ["Check", "Progress", "files", "search"])
  }

  func testAcceptedInputWithoutSequenceStaysAfterThePreviousAnswer() throws {
    let history = try items(
      #"""
      [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"old","text":"Old question","body":{}},{"seq":5,"createdAt":5,"kind":"AgentMessage","text":"Old answer","body":{}}]
      """#)
    let messages =
      chatMessages(history) + [
        ChatMessage(id: "new", role: "user", text: "New question", runID: "new")
      ]
    XCTAssertEqual(
      labels(NativeChatTimeline(messages: messages, items: history)),
      ["Old question", "Old answer", "New question"])
  }

  func testForkBoundarySeparatesInheritedWorkFromCurrentAndPendingRows() throws {
    let conversation = Conversation(
      id: "fork", scopeId: "personal:test", threadRef: "web:fork",
      forkedFrom: .init(sessionId: "source", title: nil), forkBoundarySeq: 5)
    let history = try items(
      #"""
      [{"seq":4,"createdAt":4,"kind":"UserMessage","turnId":"old","text":"Old question","body":{}},{"seq":5,"createdAt":5,"kind":"ToolCall","callId":"read","tool":"files","body":{}},{"seq":6,"createdAt":6,"kind":"UserMessage","turnId":"new","text":"New question","body":{}}]
      """#)
    let pending = ChatMessage(id: "pending", role: "assistant", text: "Still working", runID: "new")
    let timeline = NativeChatTimeline(
      messages: chatMessages(history) + [pending], items: history)
    XCTAssertEqual(
      timeline.items.filter { $0.isInherited(in: conversation) }.map(\.id),
      [history[0].id, "work:\(history[1].id)"])
    XCTAssertEqual(
      timeline.items.filter { !$0.isInherited(in: conversation) }.map(\.id),
      [history[2].id, pending.id])
  }

  func testLiveReasoningKeepsItsObservedPositionBeforeOrAfterStreamingText() throws {
    let delta = try JSONDecoder().decode(
      StreamEvent.self,
      from: Data(
        #"{"type":"CUSTOM","name":"delta","value":{"offset":0,"delta":"Progress"}}"#.utf8))
    let reasoning = try JSONDecoder().decode(
      StreamEvent.self,
      from: Data(
        #"{"type":"CUSTOM","name":"reasoning","value":{"step":"step","index":1,"offset":0,"delta":"Next thought"}}"#
          .utf8))
    for textFirst in [true, false] {
      var stream = StreamText()
      for event in textFirst ? [delta, reasoning] : [reasoning, delta] { try stream.apply(event) }
      let message = ChatMessage(id: "live", role: "assistant", text: stream.text, runID: "run")
      let timeline = NativeChatTimeline(
        messages: [message], items: [], activeRunID: "run", reasoning: stream.reasoning,
        reasoningAfterText: stream.reasoningAfterText, streamingMessageID: "live")
      XCTAssertEqual(
        labels(timeline), textFirst ? ["Progress", "Next thought"] : ["Next thought", "Progress"])
    }
  }

  @MainActor
  func testThinkingPersistingBeforeDeferredTextKeepsObservedLiveOrderAndDisclosure() throws {
    var stream = StreamText()
    for json in [
      #"{"type":"CUSTOM","name":"delta","value":{"offset":0,"delta":"First"}}"#,
      #"{"type":"CUSTOM","name":"reasoning","value":{"step":"step","index":1,"offset":0,"delta":"Second"}}"#,
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","partial":"First","activity":[{"seq":0,"createdAt":0,"marker":"text_start","streamOffset":0},{"seq":1,"createdAt":1,"kind":"Reasoning","text":"Second","step":1,"body":{"wire":{"message":{"id":"step"}}}}]}}"#,
    ] {
      try stream.apply(JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8)))
    }
    let history = try items(
      #"""
      [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Question","body":{}},{"seq":1,"createdAt":1,"kind":"Reasoning","text":"Second","step":1,"body":{"wire":{"message":{"id":"step"}}}}]
      """#)
    let live = NativeRunTimeline(
      activity: [history[1]], partial: stream.text, startOffset: 0,
      runID: "run", recorded: chatMessages([history[0]]))
    let timeline = NativeChatTimeline(
      messages: chatMessages([history[0]]) + live.messages,
      items: history, activeRunID: "run", reasoning: stream.reasoning,
      reasoningAfterText: stream.reasoningAfterText, streamingMessageID: live.messages.last?.id)
    XCTAssertTrue(stream.reasoning.isEmpty)
    XCTAssertEqual(labels(timeline), ["Question", "First", "Second"])
    let settled = try items(
      #"[{"seq":2,"createdAt":2,"kind":"AgentMessage","variant":"narration","text":"First","step":0,"body":{"wire":{"message":{"id":"step"}}}}]"#
    )
    let reloaded = NativeChatTimeline(
      messages: chatMessages(history + settled), items: history + settled)
    XCTAssertEqual(labels(reloaded), ["Question", "First", "Second"])
    let liveSection = try XCTUnwrap(
      NativeChatTranscriptSection.grouped(timeline.items, activeRunID: "run", status: .working)
        .last)
    let reloadedSection = try XCTUnwrap(
      NativeChatTranscriptSection.grouped(reloaded.items, activeRunID: nil, status: nil).last)
    XCTAssertTrue(liveSection.isActivity)
    XCTAssertTrue(reloadedSection.isActivity)
    XCTAssertEqual(liveSection.id, reloadedSection.id)
    let client = APIClient(baseURL: URL(string: "https://example.com")!)
    let disclosure = NativeWorkDisclosureState()
    let liveGroup = NativeTimelineActivityGroup(
      section: liveSection, client: client, user: "test", disclosure: disclosure)
    liveGroup.expanded.wrappedValue = true
    let reloadedGroup = NativeTimelineActivityGroup(
      section: reloadedSection, client: client, user: "test", disclosure: disclosure)
    XCTAssertTrue(reloadedGroup.expanded.wrappedValue)
  }
}
