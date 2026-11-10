import XCTest

@testable import QM

@MainActor
final class NativeWorkPresentationTests: XCTestCase {
  func testInspectCallbackRunsBeforeDisclosureHeightChanges() {
    let disclosure = NativeWorkDisclosureState()
    var inspectedValues: [Bool] = []
    let expanded = disclosure.binding(for: "tool") {
      inspectedValues.append(disclosure.binding(for: "tool").wrappedValue)
    }
    expanded.wrappedValue = true
    expanded.wrappedValue = false
    XCTAssertEqual(inspectedValues, [false, true])
    XCTAssertFalse(expanded.wrappedValue)
  }

  func testIndividualToolDetailsRemainExpandedAcrossCompletion() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Check","runId":"run"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"files","callId":"first"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"first","ok":true}},
          {"type":"text","seq":4,"createdAt":4,"payload":{"text":"Progress"}},
          {"type":"tool_call","seq":5,"createdAt":5,"payload":{"tool":"search","callId":"second"}},
          {"type":"tool_result","seq":6,"createdAt":6,"payload":{"callId":"second","ok":true}},
          {"type":"assistant","seq":7,"createdAt":7,"payload":{"text":"Done"}}
        ]
        """#.utf8))
    let client = APIClient(baseURL: URL(string: "https://example.com")!)
    let disclosure = NativeWorkDisclosureState()
    let pending = try XCTUnwrap(NativeWorkItem.items([entries[1]]).first)
    let live = NativeTimelineWorkRow(
      item: pending, client: client, user: "test", disclosure: disclosure, active: true)
    live.expanded.wrappedValue = true
    let timeline = NativeChatTimeline(messages: chatMessages(entries), entries: entries)
    let work = timeline.items.compactMap { item -> NativeWorkItem? in
      if case .work(let work) = item.content { return work }
      return nil
    }
    let completed = NativeTimelineWorkRow(
      item: work[0], client: client, user: "test", disclosure: disclosure)
    let second = NativeTimelineWorkRow(
      item: work[1], client: client, user: "test", disclosure: disclosure)
    XCTAssertTrue(completed.expanded.wrappedValue)
    XCTAssertFalse(second.expanded.wrappedValue)
    second.expanded.wrappedValue = true
    XCTAssertTrue(completed.expanded.wrappedValue)
    XCTAssertTrue(second.expanded.wrappedValue)
    XCTAssertEqual(work[0].state(active: false), .complete)
    completed.expanded.wrappedValue = false
    XCTAssertFalse(live.expanded.wrappedValue)
    XCTAssertTrue(second.expanded.wrappedValue)
  }

  func testActivityDisclosureStaysOpenThroughReasoningToolsAndCompletion() throws {
    let client = APIClient(baseURL: URL(string: "https://example.com")!)
    let disclosure = NativeWorkDisclosureState()
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":0,"createdAt":0,"payload":{"text":"Check","runId":"run"}},
          {"type":"thinking","seq":1,"createdAt":1,"payload":{"thinking":"Checking","step":{"id":"step","index":0}}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"subagents","action":"open","name":"Scout","callId":"spawn"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"spawn","ok":true}}
        ]
        """#.utf8))
    func group(
      _ history: [Entry], status: NativeReadOnlyWorkStatus?, reasoning: [RunReasoning] = []
    ) throws -> NativeTimelineActivityGroup {
      let runID = status == nil ? nil : "run"
      let timeline = NativeChatTimeline(
        messages: chatMessages(history), entries: history, activeRunID: runID,
        reasoning: reasoning)
      let sections = NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: runID, status: status)
      XCTAssertEqual(sections.filter(\.isActivity).count, 1)
      return NativeTimelineActivityGroup(
        section: try XCTUnwrap(sections.last), client: client, user: "test",
        disclosure: disclosure)
    }
    let reasoning = [RunReasoning(step: "step", index: 0, text: "Checking")]
    let thinking = try group([entries[0]], status: .working, reasoning: reasoning)
    thinking.expanded.wrappedValue = true
    let running = try group(Array(entries.prefix(3)), status: .working, reasoning: reasoning)
    let completed = try group(entries, status: nil)
    XCTAssertEqual(thinking.section.items.count, 1)
    XCTAssertEqual(running.section.items.count, 2)
    XCTAssertEqual(completed.section.items.count, 2)
    XCTAssertEqual(thinking.title, "Thinking…")
    XCTAssertEqual(running.title, "Starting Scout")
    XCTAssertEqual(completed.title, "Reasoning & tools")
    for row in [running, completed] {
      XCTAssertEqual(row.section.id, thinking.section.id)
      XCTAssertTrue(row.expanded.wrappedValue)
    }
    completed.expanded.wrappedValue = false
    XCTAssertFalse(thinking.expanded.wrappedValue)
  }

  func testReadOnlyWorkFeedbackDistinguishesWaitingAndWorking() {
    var conversation = Conversation(
      id: "chat", scopeId: "channel:test", threadRef: "ch:test:1.0", surface: "slack",
      canContinue: false)
    XCTAssertNil(NativeReadOnlyWorkStatus(conversation: conversation))
    conversation.working = true
    XCTAssertEqual(NativeReadOnlyWorkStatus(conversation: conversation)?.rawValue, "Working")
    conversation.awaitingInput = true
    XCTAssertEqual(
      NativeReadOnlyWorkStatus(conversation: conversation)?.rawValue, "Needs attention")
    conversation.working = false
    XCTAssertEqual(
      NativeReadOnlyWorkStatus(conversation: conversation)?.rawValue, "Needs attention")
    conversation.awaitingInput = false
    XCTAssertNil(NativeReadOnlyWorkStatus(conversation: conversation))
    conversation.canContinue = true
    conversation.working = true
    XCTAssertNil(NativeReadOnlyWorkStatus(conversation: conversation))
  }
}
