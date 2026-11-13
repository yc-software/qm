import SwiftUI
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
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"first","tool":"files","body":{}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"first","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"AgentMessage","variant":"narration","text":"Progress","body":{}},{"seq":5,"createdAt":5,"kind":"ToolCall","callId":"second","tool":"search","body":{}},{"seq":6,"createdAt":6,"kind":"ToolResult","callId":"second","body":{"ok":true}},{"seq":7,"createdAt":7,"kind":"AgentMessage","text":"Done","body":{}}]
        """#.utf8))
    let client = APIClient(baseURL: URL(string: "https://example.com")!)
    let disclosure = NativeWorkDisclosureState()
    let pending = try XCTUnwrap(NativeWorkItem.items([items[1]]).first)
    let live = NativeTimelineWorkRow(
      item: pending, client: client, user: "test", disclosure: disclosure, active: true)
    live.expanded.wrappedValue = true
    let timeline = NativeChatTimeline(messages: chatMessages(items), items: items)
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
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Check","body":{}},{"seq":1,"createdAt":1,"kind":"Reasoning","text":"Checking","step":0,"body":{"wire":{"message":{"id":"step"}}}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"spawn","tool":"subagents","body":{"action":"open","name":"Scout"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"spawn","body":{"ok":true}}]
        """#.utf8))
    func group(
      _ history: [Item], status: NativeReadOnlyWorkStatus?, reasoning: [RunReasoning] = []
    ) throws -> NativeTimelineActivityGroup {
      let runID = status == nil ? nil : "run"
      let timeline = NativeChatTimeline(
        messages: chatMessages(history), items: history, activeRunID: runID,
        reasoning: reasoning)
      let sections = NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: runID, status: status)
      XCTAssertEqual(sections.filter(\.isActivity).count, 1)
      return NativeTimelineActivityGroup(
        section: try XCTUnwrap(sections.last), client: client, user: "test",
        disclosure: disclosure)
    }
    let reasoning = [RunReasoning(step: "step", index: 0, text: "Checking")]
    let thinking = try group([items[0]], status: .working, reasoning: reasoning)
    thinking.expanded.wrappedValue = true
    let running = try group(Array(items.prefix(3)), status: .working, reasoning: reasoning)
    let completed = try group(items, status: nil)
    XCTAssertEqual(thinking.section.items.count, 1)
    XCTAssertEqual(running.section.items.count, 2)
    XCTAssertEqual(completed.section.items.count, 2)
    XCTAssertEqual(thinking.title, "Thinking")
    XCTAssertEqual(running.title, "Starting Scout")
    XCTAssertEqual(completed.title, "Used tools")
    for row in [running, completed] {
      XCTAssertEqual(row.section.id, thinking.section.id)
      XCTAssertTrue(row.expanded.wrappedValue)
    }
    completed.expanded.wrappedValue = false
    XCTAssertFalse(thinking.expanded.wrappedValue)
  }

  func testThinkingYieldsToProgressiveAnswerAndReturnsForLaterWork() throws {
    let history = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Hello","body":{}}]
        """#.utf8))
    func sections(_ text: String, reasoning: [RunReasoning] = [], after: Set<String> = [])
      -> [NativeChatTranscriptSection]
    {
      let live = NativeRunTimeline(
        activity: [], partial: text, startOffset: 0, runID: "run",
        recorded: chatMessages(history))
      let timeline = NativeChatTimeline(
        messages: chatMessages(history) + live.messages, items: history, activeRunID: "run",
        reasoning: reasoning, reasoningAfterText: after,
        streamingMessageID: live.messages.last?.id)
      return NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: "run", status: .working)
    }
    XCTAssertEqual(sections("").last?.status, .working)
    for text in ["H", "Hello", "Hello there"] {
      let result = sections(text)
      XCTAssertFalse(result.contains { $0.status == .working })
      guard case .message(let message) = result.last?.items.last?.content else {
        return XCTFail("Expected the streamed answer last")
      }
      XCTAssertEqual(message.text, text)
    }
    let reasoning = RunReasoning(step: "next", index: 0, text: "Checking again")
    XCTAssertEqual(
      sections("Hello", reasoning: [reasoning], after: [reasoning.id]).last?.status, .working)
  }

  func testAnswerKeepsAttentionStatesAndDoesNotHideNextRunThinking() {
    let message = ChatMessage(id: "answer", role: "assistant", text: "Hello", runID: "run")
    let timeline = NativeChatTimeline(messages: [message], items: [], activeRunID: "run")
    for status: NativeReadOnlyWorkStatus in [.reconnecting, .awaitingInput, .pending] {
      XCTAssertEqual(
        NativeChatTranscriptSection.grouped(
          timeline.items, activeRunID: "run", status: status
        ).last?.status, status)
    }
    XCTAssertEqual(
      NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: "next", status: .working
      ).last?.status, .working)
    XCTAssertNil(
      NativeChatTranscriptSection.grouped(
        timeline.items, activeRunID: nil, status: nil
      ).last?.status)
  }

  func testCompletedAndFailedActivityKeepDistinctSummaries() async throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":0,"createdAt":0,"kind":"UserMessage","turnId":"run","text":"Review the launch plan","body":{}},{"seq":1,"createdAt":1,"kind":"AgentMessage","variant":"narration","text":"I’ll check the available tools and data first.","body":{}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"check","tool":"execute","body":{"purpose":"Check tools and data"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"ToolCall","callId":"list","tool":"tool_search","body":{"purpose":"List available tools"}},{"seq":5,"createdAt":5,"kind":"ToolResult","callId":"list","body":{"ok":true}},{"seq":6,"createdAt":6,"kind":"AgentMessage","variant":"narration","text":"Next I’ll check the project directory.","body":{}},{"seq":7,"createdAt":7,"kind":"ToolCall","callId":"lookup","tool":"execute","body":{"purpose":"Check project access"}},{"seq":8,"createdAt":8,"kind":"ToolResult","callId":"lookup","body":{"ok":false,"error":"Access unavailable"}}]
        """#.utf8))
    let timeline = NativeChatTimeline(messages: chatMessages(items), items: items)
    let sections = NativeChatTranscriptSection.grouped(
      timeline.items, activeRunID: nil, status: nil
    )
    .filter(\.isActivity)
    XCTAssertEqual(sections.count, 2)
    let client = APIClient(baseURL: URL(string: "https://example.test")!)
    let disclosure = NativeWorkDisclosureState()
    let groups = sections.map {
      NativeTimelineActivityGroup(section: $0, client: client, user: "test", disclosure: disclosure)
    }
    XCTAssertEqual(groups.map(\.title), ["Searched, ran commands", "Ran commands · 1 failed"])
    groups[0].expanded.wrappedValue = true
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previous = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(
      rootView: NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            Text("I’ll check the available tools and data first.")
            groups[0]
            groups[1]
            Text("The internal directory isn’t available. I’ll check the public project notes.")
            NativeTimelineActivityGroup(
              section: .init(id: "thinking", items: [], runID: "next", status: .working),
              client: client, user: "test", disclosure: disclosure)
          }
          .padding(20)
        }
        .foregroundStyle(QMTheme.ink)
        .background(QMTheme.paper)
        .navigationTitle("Launch plan").navigationBarTitleDisplayMode(.inline)
      })
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }
    try await Task.sleep(for: .milliseconds(400))
    window.layoutIfNeeded()
    let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "Activity presentation"
    attachment.lifetime = .keepAlways
    add(attachment)
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
