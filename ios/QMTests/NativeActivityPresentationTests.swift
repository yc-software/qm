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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"kind":"ToolCall","seq":1,"createdAt":1,"tool":"execute","callId":"command","body":{"purpose":"Check build","command":"build"}},
          {"kind":"ToolResult","seq":2,"createdAt":2,"tool":"execute","callId":"command","body":{"ok":false,"error":"Build failed"}},
          {"type":"tool_call","seq":3,"createdAt":3,"payload":{"tool":"files","action":"read","callId":"file","path":"docs/SPEC.md"}},
          {"type":"tool_result","seq":4,"createdAt":4,"payload":{"callId":"file","ok":true}},
          {"type":"tool_call","seq":5,"createdAt":5,"payload":{"tool":"background","action":"watch","callId":"watch"}}
        ]
        """#.utf8))
    let items = NativeWorkItem.items(entries)
    XCTAssertEqual(items.map { $0.activityKind?.icon }, ["terminal", "book-open", "terminal"])
    XCTAssertEqual(items.map { $0.state(active: true) }, [.failed, .complete, .running])
    XCTAssertEqual(
      items.map { $0.label(active: true) }, ["Check build · Failed", "SPEC.md", "Managing process"])
  }

  func testLatestThoughtReplacesCompletedToolInLiveSummary() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Check","runId":"run"}},
          {"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"execute","callId":"check","purpose":"Check build"}},
          {"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"check","ok":true}},
          {"type":"thinking","seq":4,"createdAt":4,"payload":{"thinking":"**Reviewing the result**\nThe build passed."}}
        ]
        """#.utf8))
    let timeline = NativeChatTimeline(
      messages: chatMessages(entries), entries: entries, activeRunID: "run")
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
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1000,"payload":{"text":"Check","runId":"run"}},
          {"type":"tool_call","seq":2,"createdAt":2000,"payload":{"tool":"execute","callId":"check"}},
          {"type":"tool_result","seq":3,"createdAt":4000,"payload":{"callId":"check","ok":true}},
          {"type":"text","seq":4,"createdAt":4500,"payload":{"text":"Done","phase":"final_answer"}},
          {"type":"assistant","seq":5,"createdAt":5000,"payload":{"text":"Done","runId":"run","workStartedAt":1000,"workFinishedAt":5000}}
        ]
        """#.utf8))
    let timeline = NativeChatTimeline(messages: chatMessages(entries), entries: entries)
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
