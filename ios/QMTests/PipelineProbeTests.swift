import XCTest

@testable import QM

@MainActor
final class PipelineProbeTests: XCTestCase {
  func testPipelineCost() throws {
    for (turns, tools) in [(25, 4), (25, 40), (100, 20)] {
      var entries: [[String: Any]] = []
      var seq = 0
      func add(_ type: String, _ payload: [String: Any]) {
        seq += 1
        entries.append(["type": type, "seq": seq, "createdAt": Double(seq) * 1000, "payload": payload])
      }
      for turn in 0..<turns {
        let run = "run-\(turn)"
        add("user", ["text": "Question \(turn)", "runId": run])
        for tool in 0..<tools {
          add("tool_call", ["runId": run, "callId": "c\(turn)-\(tool)", "tool": "execute", "purpose": "Step \(tool)"])
          add("tool_result", ["runId": run, "callId": "c\(turn)-\(tool)", "ok": true, "stdout": "ok"])
          if tool % 10 == 5 { add("text", ["runId": run, "text": "Commentary \(tool)"]) }
        }
        add("assistant", ["runId": run, "text": "Answer \(turn) " + String(repeating: "word ", count: 200)])
      }
      let transcript = try JSONDecoder().decode(
        Transcript.self,
        from: JSONSerialization.data(withJSONObject: ["entries": entries, "earlierEntries": 0]))
      let model = ChatModel(
        conversation: Conversation(
          id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
          canContinue: true),
        client: APIClient(baseURL: URL(string: "https://probe.example.test")!), user: "test",
        knownSession: true, transcript: transcript)
      model.activeRunID = "run-\(turns - 1)"
      model.partial = String(repeating: "Streaming text. ", count: 100)
      func time(_ name: String, _ body: () -> Void) {
        let start = CACurrentMediaTime()
        for _ in 0..<20 { body() }
        let each = (CACurrentMediaTime() - start) / 20 * 1000
        print("PIPE entries=\(entries.count) \(name)=\(String(format: "%.2f", each))ms")
      }
      time("entryIDs") { _ = model.transcriptEntries.map(\.id) }
      time("chatMessages") { _ = chatMessages(model.transcriptEntries) }
      time("liveTimeline") { _ = model.liveTimeline }
      time("timeline") { _ = model.timeline.items }
      time("displayedPartial") { _ = model.displayedPartial }
      time("agentActivity") { _ = model.agentActivity }
      let items = model.timeline.items
      time("grouped") {
        _ = NativeChatTranscriptSection.grouped(
          items, activeRunID: model.activeRunID, status: model.workStatus)
      }
      time("bodyEquivalent") {
        _ = model.messages
        _ = model.liveTimeline
        _ = model.forkableMessageIDs
        let timeline = model.timeline.items
        _ = NativeChatTranscriptSection.grouped(
          timeline, activeRunID: model.activeRunID, status: model.workStatus)
        _ = model.displayedPartial
        _ = model.displayedPartial
        _ = model.displayedPartial
        _ = model.agentActivity
        _ = model.latestPromptAt
      }
      time("partialMutation") { model.partial += "x" }
    }
  }
}
