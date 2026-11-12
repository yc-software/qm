import XCTest

@testable import QM

final class NativeRunTimelineTests: XCTestCase {
  private func entries(_ json: String) throws -> [Entry] {
    try JSONDecoder().decode([Entry].self, from: Data(json.utf8))
  }

  private func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
  }

  func testCommentarySeparatesEarlierWorkFromContinuedWork() throws {
    let activity = try entries(
      #"""
      [
        {"type":"thinking","seq":1,"createdAt":1,"payload":{"thinking":"First step"}},
        {"type":"text_start","seq":1,"createdAt":2,"payload":{"streamOffset":0}},
        {"type":"text","seq":2,"createdAt":3,"payload":{"text":"I found the first issue.","phase":"commentary"}},
        {"type":"tool_call","seq":3,"createdAt":4,"payload":{"callId":"check","tool":"execute"}},
        {"type":"thinking","seq":4,"createdAt":5,"payload":{"thinking":"Check the next issue"}}
      ]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "I found the first issue.", startOffset: 0,
      runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["I found the first issue.", ""])
    XCTAssertEqual(timeline.messages.map { $0.activity.compactMap(\.seq) }, [[1], [3, 4]])
    XCTAssertFalse(timeline.responding)
  }

  func testLaterStreamedTextSurvivesRecordedInterimPost() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Find issues","runId":"run"}},
        {"type":"tool_call","seq":2,"createdAt":2,"payload":{"action":"post","callId":"post","text":"First update"}},
        {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}}
      ]
      """#)
    let activity = try entries(
      #"""
      [
        {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"Continuing"}},
        {"type":"text_start","seq":4,"createdAt":5,"payload":{"streamOffset":14}}
      ]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "First update\n\nMore issues", startOffset: 0,
      runID: "run", recorded: chatMessages(history))
    XCTAssertEqual(timeline.messages.last?.text, "More issues")
    XCTAssertEqual(timeline.messages.last?.activity.compactMap(\.seq), [4])
    XCTAssertTrue(timeline.responding)
  }

  func testTextBoundariesUseUTF16AndRetainedStreamOffset() throws {
    let activity = try entries(
      #"""
      [{"type":"text_start","seq":1,"createdAt":2,"payload":{"phase":"final_answer","streamOffset":108}}]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Hi 👋!\n\nFinal", startOffset: 100,
      runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.last?.text, "Final")
  }

  func testIdenticalCommentaryAndFinalTextRemainSeparateMessages() throws {
    let activity = try entries(
      #"""
      [
        {"type":"text_start","seq":1,"createdAt":1,"payload":{"phase":"commentary","streamOffset":0}},
        {"type":"text","seq":2,"createdAt":2,"payload":{"text":"Ready","phase":"commentary"}},
        {"type":"text_start","seq":2,"createdAt":3,"payload":{"phase":"final_answer","streamOffset":7}}
      ]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Ready\n\nReady", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["Ready", "Ready"])
    XCTAssertNotEqual(timeline.messages.first?.id, timeline.messages.last?.id)
  }

  func testReloadKeepsCommentaryAndLaterThinkingInTheirOrder() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Find issues","runId":"run"}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"First"}},
        {"type":"text","seq":3,"createdAt":3,"payload":{"text":"Continuing","phase":"commentary"}},
        {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"Second"}},
        {"type":"text","seq":5,"createdAt":5,"payload":{"text":"Done"}},
        {"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"Done"}}
      ]
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
    let activity = try entries(
      #"""
      [
        {"type":"text","seq":1,"createdAt":1,"payload":{"text":"Public update","phase":"commentary"}},
        {"type":"text","seq":2,"createdAt":2,"payload":{"text":"Internal summary","demoted":true}}
      ]
      """#)
    XCTAssertEqual(chatMessages(activity).map(\.text), ["Public update"])
    let timeline = NativeRunTimeline(
      activity: activity, partial: "", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map(\.text), ["Public update", ""])
  }

  func testRepeatedTextInDifferentStepsKeepsFinalReplyBelowLaterWork() throws {
    let history = try entries(
      #"""
      [
        {"type":"text","seq":1,"createdAt":1,"payload":{"text":"Ready","step":{"id":"first","index":0}}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"Check again"}},
        {"type":"assistant","seq":3,"createdAt":3,"payload":{"text":"Ready","step":{"id":"second","index":0}}}
      ]
      """#)
    let messages = chatMessages(history)
    XCTAssertEqual(messages.map(\.text), ["Ready", "Ready"])
    XCTAssertEqual(messages.last?.activity.compactMap(\.seq), [2])
    let withoutWork = chatMessages([history[0], history[2]])
    XCTAssertEqual(withoutWork.map(\.text), ["Ready", "Ready"])
  }

  func testCompletionKeepsLiveCommentaryWhenHistoryHasNotCaughtUp() throws {
    let history = try entries(
      #"[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Check","runId":"run"}}]"#)
    let activity = try entries(
      #"""
      [
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"First"}},
        {"type":"text","seq":3,"createdAt":3,"payload":{"text":"First update"}},
        {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"Second"}}
      ]
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
    let activity = try entries(
      #"""
      [
        {"type":"text","seq":1,"createdAt":1,"payload":{"text":"First update"}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"Finishing"}},
        {"type":"text_start","seq":2,"createdAt":3,"payload":{"streamOffset":14}}
      ]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "Done", startOffset: 0, runID: "run", recorded: [],
      finalReply: true)
    XCTAssertEqual(timeline.messages.map(\.text), ["First update", "Done"])
    XCTAssertEqual(timeline.messages.last?.activity.compactMap(\.seq), [2])
  }

  func testUnphasedTerminalReplyRepeatingCommentaryRemainsADistinctMessage() throws {
    let activity = try entries(
      #"""
      [
        {"type":"text","seq":1,"createdAt":1,"payload":{"text":"Ready","step":{"id":"first","index":0}}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"Check again"}}
      ]
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
    let activity = try entries(
      #"""
      [
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"action":"post","callId":"post","text":"Delivered"}},
        {"type":"text","seq":2,"createdAt":2,"payload":{"text":"Still checking","phase":"commentary"}},
        {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}}
      ]
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
    let activity = try entries(
      #"""
      [
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"execute","callId":"check"}},
        {"type":"text","seq":2,"createdAt":2,"payload":{"text":"Still checking","phase":"commentary"}},
        {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"check","ok":true}},
        {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"Next step"}}
      ]
      """#)
    let timeline = NativeRunTimeline(
      activity: activity, partial: "", startOffset: 0, runID: "run", recorded: [])
    XCTAssertEqual(timeline.messages.map { $0.activity.compactMap(\.seq) }, [[1, 3], [4]])
    XCTAssertEqual(
      NativeWorkItem.items(timeline.messages[0].activity).first?.state(active: false), .complete)
    let recorded = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"execute","callId":"check"}},
        {"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Done"}}
      ]
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
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","activity":[{"type":"thinking","seq":1,"createdAt":1,"payload":{"thinking":"Check 👋 next","step":{"id":"step","index":0}}}]}}"#
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
  private func entries(_ json: String) throws -> [Entry] {
    try JSONDecoder().decode([Entry].self, from: Data(json.utf8))
  }

  private func labels(_ timeline: NativeChatTimeline) -> [String] {
    timeline.items.map {
      switch $0.content {
      case .message(let message): message.text
      case .work(let item): item.isThinking ? item.entry.payload?.thinking ?? "" : item.title
      case .reasoning(let block): block.text
      }
    }
  }

  func testActivityGroupsKeepCommentaryAndOldRunsSeparateWithoutDuplicatingCalls() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Old question","runId":"old"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"files","callId":"check"}},
        {"type":"tool_result","seq":2,"createdAt":2,"payload":{"callId":"check","ok":true}},
        {"type":"assistant","seq":3,"createdAt":3,"payload":{"text":"Old answer"}},
        {"type":"user","seq":4,"createdAt":4,"payload":{"text":"New question","runId":"new"}},
        {"type":"thinking","seq":5,"createdAt":5,"payload":{"thinking":"Checking the request"}},
        {"type":"tool_call","seq":6,"createdAt":6,"payload":{"tool":"search","callId":"check"}},
        {"type":"text","seq":7,"createdAt":7,"payload":{"text":"I found a lead","phase":"commentary"}},
        {"type":"tool_call","seq":8,"createdAt":8,"payload":{"tool":"execute","callId":"verify"}},
        {"type":"tool_result","seq":9,"createdAt":9,"payload":{"callId":"verify","ok":true}},
        {"type":"tool_result","seq":10,"createdAt":10,"payload":{"callId":"check","ok":true}}
      ]
      """#)
    let timeline = NativeChatTimeline(
      messages: chatMessages(history), entries: history, activeRunID: "new")
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
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"execute","callId":"check"}}
      ]
      """#)
    func group(
      _ history: [Entry], runID: String? = nil, error: ChatMessage? = nil
    ) throws -> NativeChatTranscriptSection {
      let timeline = NativeChatTimeline(
        messages: chatMessages(history) + [error].compactMap { $0 }, entries: history,
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
    let approval = try entries(
      #"[{"type":"tool_result","seq":2,"createdAt":2,"payload":{"callId":"check","blocked":"needs_approval"}}]"#
    )
    XCTAssertEqual(try group(history + approval).workState, .approval)
  }

  func testEveryInvocationKeepsItsPlaceAcrossLiveCompletionAndReload() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"files","action":"read","callId":"first"}},
        {"type":"tool_result","seq":2,"createdAt":2,"payload":{"callId":"first","ok":true}},
        {"type":"text","seq":3,"createdAt":3,"payload":{"text":"First update"}},
        {"type":"tool_call","seq":4,"createdAt":4,"payload":{"tool":"search","callId":"second"}},
        {"type":"tool_result","seq":5,"createdAt":5,"payload":{"callId":"second","ok":true}},
        {"type":"thinking","seq":6,"createdAt":6,"payload":{"thinking":"Need another opinion"}},
        {"type":"tool_call","seq":7,"createdAt":7,"payload":{"tool":"subagents","action":"open","callId":"spawn"}},
        {"type":"tool_result","seq":8,"createdAt":8,"payload":{"callId":"spawn","ok":true}},
        {"type":"text","seq":9,"createdAt":9,"payload":{"text":"An agent is checking"}},
        {"type":"tool_call","seq":10,"createdAt":10,"payload":{"tool":"execute","callId":"last"}},
        {"type":"tool_result","seq":11,"createdAt":11,"payload":{"callId":"last","ok":true}},
        {"type":"assistant","seq":12,"createdAt":12,"payload":{"text":"Done"}}
      ]
      """#)
    let activity = Array(history.dropFirst().dropLast())
    let live = NativeRunTimeline(
      activity: activity, partial: "Done", startOffset: 0, runID: "run",
      recorded: chatMessages([history[0]]))
    let liveRows = NativeChatTimeline(
      messages: chatMessages([history[0]]) + live.messages, entries: [history[0]] + activity,
      activeRunID: "run", streamingMessageID: live.messages.last?.id)
    let completed = presentedChatMessages(
      [history[0]],
      runs: [
        ChatRunPresentation(
          id: "run", runID: "run", reply: "Done", finished: true,
          activity: activity)
      ], activeRunID: nil)
    let finalRows = NativeChatTimeline(messages: completed, entries: [history[0]] + activity)
    let reloaded = NativeChatTimeline(messages: chatMessages(history), entries: history)
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
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"slack","action":"post","callId":"post","text":"Delivered"}},
        {"type":"text","seq":2,"createdAt":2,"payload":{"text":"Progress","phase":"commentary"}},
        {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}}
      ]
      """#)
    let timeline = NativeChatTimeline(messages: chatMessages(history), entries: history)
    XCTAssertEqual(labels(timeline), ["Check", "slack · post", "Progress", "Delivered"])
    XCTAssertEqual(Set(timeline.items.map(\.id)).count, 4)
    guard case .work(let call) = timeline.items[1].content else { return XCTFail("Missing call") }
    XCTAssertEqual(call.state(active: true), .complete)
    XCTAssertEqual(call.result?.seq, 3)
  }

  func testSourceBlockIndexOrdersTextBeforeLaterThinkingWithinItsStep() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"tool_call","seq":1,"createdAt":1,"payload":{"tool":"files","callId":"before"}},
        {"type":"thinking","seq":2,"createdAt":2,"payload":{"thinking":"Plan parallel work","step":{"id":"step","index":1}}},
        {"type":"text","seq":3,"createdAt":3,"payload":{"text":"Starting agents","step":{"id":"step","index":0}}},
        {"type":"tool_call","seq":4,"createdAt":4,"payload":{"tool":"subagents","action":"open","callId":"spawn","step":{"id":"step","index":2}}},
        {"type":"tool_result","seq":5,"createdAt":5,"payload":{"callId":"spawn","ok":true}},
        {"type":"assistant","seq":6,"createdAt":6,"payload":{"text":"Done","step":{"id":"next","index":0}}}
      ]
      """#)
    let timeline = NativeChatTimeline(messages: chatMessages(history), entries: history)
    XCTAssertEqual(
      labels(timeline),
      [
        "Check", "files", "Starting agents", "Plan parallel work",
        "subagents · open", "Done",
      ])
  }

  func testEqualSequenceEventsKeepSourceOrderAndTrailingSavedWorkStaysVisible() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
        {"type":"text_start","seq":0,"createdAt":1,"payload":{"streamOffset":0}},
        {"type":"text","seq":1,"createdAt":2,"payload":{"text":"Progress"}},
        {"type":"tool_call","seq":1,"createdAt":3,"payload":{"tool":"files","callId":"first"}},
        {"type":"tool_call","seq":1,"createdAt":4,"payload":{"tool":"search","callId":"second"}}
      ]
      """#)
    XCTAssertEqual(
      labels(NativeChatTimeline(messages: chatMessages(history), entries: history)),
      ["Check", "Progress", "files", "search"])
  }

  func testAcceptedInputWithoutSequenceStaysAfterThePreviousAnswer() throws {
    let history = try entries(
      #"""
      [
        {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Old question","runId":"old"}},
        {"type":"assistant","seq":5,"createdAt":5,"payload":{"text":"Old answer"}}
      ]
      """#)
    let messages =
      chatMessages(history) + [
        ChatMessage(id: "new", role: "user", text: "New question", runID: "new")
      ]
    XCTAssertEqual(
      labels(NativeChatTimeline(messages: messages, entries: history)),
      ["Old question", "Old answer", "New question"])
  }

  func testForkBoundarySeparatesInheritedWorkFromCurrentAndPendingRows() throws {
    let conversation = Conversation(
      id: "fork", scopeId: "personal:test", threadRef: "web:fork",
      forkedFrom: .init(sessionId: "source", title: nil), forkBoundarySeq: 5)
    let history = try entries(
      #"""
      [
        {"type":"user","seq":4,"createdAt":4,"payload":{"text":"Old question","runId":"old"}},
        {"type":"tool_call","seq":5,"createdAt":5,"payload":{"tool":"files","callId":"read"}},
        {"type":"user","seq":6,"createdAt":6,"payload":{"text":"New question","runId":"new"}}
      ]
      """#)
    let pending = ChatMessage(id: "pending", role: "assistant", text: "Still working", runID: "new")
    let timeline = NativeChatTimeline(
      messages: chatMessages(history) + [pending], entries: history)
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
        messages: [message], entries: [], activeRunID: "run", reasoning: stream.reasoning,
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
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","partial":"First","activity":[{"type":"text_start","seq":0,"createdAt":0,"payload":{"streamOffset":0}},{"type":"thinking","seq":1,"createdAt":1,"payload":{"thinking":"Second","step":{"id":"step","index":1}}}]}}"#,
    ] {
      try stream.apply(JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8)))
    }
    let history = try entries(
      #"""
      [
        {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Question","runId":"run"}},
        {"type":"thinking","seq":1,"createdAt":1,"payload":{"thinking":"Second","step":{"id":"step","index":1}}}
      ]
      """#)
    let live = NativeRunTimeline(
      activity: [history[1]], partial: stream.text, startOffset: 0,
      runID: "run", recorded: chatMessages([history[0]]))
    let timeline = NativeChatTimeline(
      messages: chatMessages([history[0]]) + live.messages,
      entries: history, activeRunID: "run", reasoning: stream.reasoning,
      reasoningAfterText: stream.reasoningAfterText, streamingMessageID: live.messages.last?.id)
    XCTAssertTrue(stream.reasoning.isEmpty)
    XCTAssertEqual(labels(timeline), ["Question", "First", "Second"])
    let settled = try entries(
      #"[{"type":"text","seq":2,"createdAt":2,"payload":{"text":"First","step":{"id":"step","index":0}}}]"#
    )
    let reloaded = NativeChatTimeline(
      messages: chatMessages(history + settled), entries: history + settled)
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
