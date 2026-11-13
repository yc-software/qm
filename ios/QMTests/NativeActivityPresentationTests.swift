import SwiftUI
import XCTest

@testable import QM

@MainActor
final class NativeActivityPresentationTests: XCTestCase {
  func testReasoningHeadingBecomesDisclosureTitleWithoutLosingBody() {
    for heading in [
      "## Checking the rebuild", "**Checking the rebuild**", "__Checking the rebuild__",
    ] {
      let presentation = NativeThinkingPresentation(
        text: heading + "\n\nThe build is running.", live: true)
      XCTAssertEqual(presentation.title, "Checking the rebuild")
      XCTAssertEqual(presentation.body, "The build is running.")
    }
    for live in [false, true] {
      let presentation = NativeThinkingPresentation(
        text: "Check the build.\nKeep watching.", live: live)
      XCTAssertEqual(presentation.title, live ? "Thinking" : "Thought")
      XCTAssertEqual(presentation.body, "Check the build.\nKeep watching.")
    }
  }

  func testToolIdentitySurvivesCompletionAndFailure() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"kind":"ToolCall","seq":1,"createdAt":1,"tool":"execute","callId":"command","body":{"purpose":"Check build","command":"build"}},{"kind":"ToolResult","seq":2,"createdAt":2,"tool":"execute","callId":"command","body":{"ok":false,"error":"Build failed"}},{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"file","tool":"files","body":{"action":"read","path":"docs/SPEC.md"}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"file","body":{"ok":true}},{"seq":5,"createdAt":5,"kind":"ToolCall","callId":"watch","tool":"background","body":{"action":"watch"}}]
        """#.utf8))
    let work = NativeWorkItem.items(items)
    XCTAssertEqual(work.map { $0.activityKind?.icon }, ["terminal", "book-open", "terminal"])
    XCTAssertEqual(work.map { $0.state(active: true) }, [.failed, .complete, .running])
    XCTAssertEqual(
      work.map { $0.label(active: true) }, ["Check build · Failed", "SPEC.md", "Managing process"])
  }

  func testLatestThoughtReplacesCompletedToolInLiveSummary() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Check","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"check","tool":"execute","body":{"purpose":"Check build"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"Reasoning","text":"**Reviewing the result**\nThe build passed.","body":{}}]
        """#.utf8))
    let timeline = NativeChatTimeline(
      messages: chatMessages(items), items: items, activeRunID: "run")
    let section = try XCTUnwrap(
      NativeChatTranscriptSection.grouped(timeline.items, activeRunID: "run", status: .working).last
    )
    let summary = NativeActivitySummary(section: section)
    XCTAssertEqual(summary.title, "Reviewing the result")
    XCTAssertEqual(summary.icon, "brain")
    XCTAssertEqual(summary.liveItemID, section.items.last?.id)
    XCTAssertTrue(summary.animating)
  }

  func testCompletedActivityUsesAssistantBoundaryTiming() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1000,"kind":"UserMessage","turnId":"run","text":"Check","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2000,"kind":"ToolCall","callId":"check","tool":"execute","body":{}},{"seq":3,"createdAt":4000,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":4,"createdAt":4500,"kind":"AgentMessage","variant":"narration","text":"Done","body":{"phase":"final_answer"}},{"seq":5,"createdAt":5000,"kind":"AgentMessage","turnId":"run","text":"Done","body":{"workStartedAt":1000,"workFinishedAt":5000}}]
        """#.utf8))
    let timeline = NativeChatTimeline(messages: chatMessages(items), items: items)
    let section = try XCTUnwrap(
      NativeChatTranscriptSection.grouped(timeline.items, activeRunID: nil, status: nil).first {
        $0.isActivity
      })
    XCTAssertEqual(NativeActivitySummary(section: section).duration, "Worked for 4s")
  }

  func testLiveHeadingResolvesLatestTextWithoutRebuildingSection() {
    let block = RunReasoning(step: "step", index: 0, text: "**Check")
    let section = NativeChatTranscriptSection(
      id: "activity",
      items: [
        .init(id: "thought", content: .reasoning(block), runID: "run", sequence: nil, active: true)
      ], runID: "run", status: .working)
    var latest = block.text
    let group = NativeTimelineActivityGroup(
      section: section, client: APIClient(baseURL: URL(string: "https://example.test")!),
      user: "sample", disclosure: NativeWorkDisclosureState(), reasoningText: { _ in latest })
    XCTAssertEqual(group.title, "Thinking")
    latest = "**Checking the build**\nThe build passed."
    XCTAssertEqual(group.title, "Checking the build")
  }

  func testApprovalCanBeClosedWithoutLosingExplicitDisclosurePreference() {
    let disclosure = NativeWorkDisclosureState()
    let pending = disclosure.binding(for: "approval", initiallyExpanded: true)
    XCTAssertTrue(pending.wrappedValue)
    pending.wrappedValue = false
    XCTAssertFalse(disclosure.binding(for: "approval", initiallyExpanded: true).wrappedValue)
    pending.wrappedValue = true
    XCTAssertTrue(disclosure.binding(for: "approval").wrappedValue)
  }
}
