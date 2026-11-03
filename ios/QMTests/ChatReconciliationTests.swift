import XCTest
import os

@testable import QM

final class ChatReconciliationProtocol: URLProtocol, @unchecked Sendable {
  static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let host = request.url!.host!
    let path = request.url!.path
    let count = Self.counts.withLock { values in
      let key = host + path
      values[key, default: 0] += 1
      return values[key]!
    }
    var status = 200
    var delay = 0.005
    var body = "{}"
    var contentType = "application/json"
    switch path {
    case "/api/runs/active":
      body = host.hasPrefix("replay") ? #"{"runId":null}"# : #"{"runId":"run"}"#
      if host.hasPrefix("active-failure"), count > 1 { status = 503 }
      if host.hasPrefix("overlap"), count > 1 {
        body = #"{"runId":"run","queued":[{"runId":"next","text":"Next"}]}"#
      }
    case "/api/turn":
      body = #"{"status":"ok","reply":"Answer"}"#
      if host.hasPrefix("overlap") || host.hasPrefix("active-failure") {
        body = #"{"runId":"next","status":"queued"}"#
      }
      if host.hasPrefix("accepted") { body = #"{"runId":"run","status":"queued"}"# }
    case "/api/runs/run/events":
      contentType = "text/event-stream"
      if host.hasPrefix("overlap") { delay = 0.15 }
      if host.hasPrefix("reconnect-stall"), count > 1 { delay = 1 }
      body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
      if host.hasPrefix("posted-finish") || host.hasPrefix("posted-lag") {
        body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"type\":\"tool_call\",\"seq\":4,\"createdAt\":4,\"payload\":{\"tool\":\"execute\",\"callId\":\"after\"}},{\"type\":\"tool_result\",\"seq\":5,\"createdAt\":5,\"payload\":{\"callId\":\"after\",\"ok\":true}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
      }
      if host.hasPrefix("posted-active") {
        body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"running\"}}\n\n"
      }
      if host.hasPrefix("activity-lag") {
        body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"type\":\"thinking\",\"seq\":2,\"createdAt\":2,\"payload\":{\"thinking\":\"Working through it.\"}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
      }
    case "/api/runs/run":
      status = 503
      body = #"{"message":"Terminal SSE should not need polling"}"#
    case "/api/sessions/chat":
      body =
        count == 1
        ? #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}}]}"#
        : #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}},{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Answer"}}]}"#
      if host.hasPrefix("active-failure") || host.hasPrefix("activity-lag") {
        body =
          #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}}]}"#
      }
      if host.hasPrefix("accepted") {
        body =
          count == 1
          ? #"{"entries":[]}"#
          : #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}}]}"#
      }
      if host.hasPrefix("empty-history") { body = #"{"entries":[]}"# }
      if host.hasPrefix("missing-history") { status = 503 }
      if host.hasPrefix("posted-") {
        body =
          #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}},{"type":"tool_call","seq":2,"createdAt":2,"payload":{"action":"post","callId":"post","text":"Answer"}},{"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}}]}"#
        if host.hasPrefix("posted-finish"), count > 1 { status = 503 }
      }
      if host.hasPrefix("fork-history") {
        let before = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
          .first { $0.name == "beforeSeq" }?.value
        if before == "6", !(host.hasPrefix("fork-history-retry") && count == 1) {
          body =
            #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Inherited question"}},{"type":"assistant","seq":5,"createdAt":5,"payload":{"text":"Inherited answer"}}],"earlierEntries":0}"#
        } else {
          status = 503
        }
      }
    case "/api/sessions/chat/approvals":
      body = #"{"approvals":[]}"#
      if count > 1 {
        delay = 0.3
        if host.hasPrefix("failure") || host.hasPrefix("replay-failure") { status = 503 }
      }
    default: break
    }
    if host.hasPrefix("reconnect-stall") {
      if path.hasSuffix("/events") {
        body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Old\",\"status\":\"running\"}}\n\n"
      } else if path == "/api/runs/run" {
        status = 200
        body = #"{"status":"running","partial":"Newer recovered text"}"#
      }
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil,
      headerFields: ["Content-Type": contentType])!
    if host.hasPrefix("active-failure"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(
        self,
        didLoad: Data(
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Still writing\",\"status\":\"running\"}}\n\n"
            .utf8))
      return
    }
    if host.hasPrefix("stream-burst"), path.hasSuffix("/events") {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      let burst = (0..<200).map {
        "data: {\"type\":\"CUSTOM\",\"name\":\"delta\",\"value\":{\"offset\":\($0),\"delta\":\"x\"}}\n\n"
      }.joined()
      client?.urlProtocol(self, didLoad: Data(burst.utf8))
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in
        let terminal =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"result\":{\"status\":\"ok\",\"reply\":\"Complete\"}}}\n\n"
        client?.urlProtocol(self, didLoad: Data(terminal.utf8))
        client?.urlProtocolDidFinishLoading(self)
      }
      return
    }
    let responseBody = body
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}
}

@MainActor
final class ChatReconciliationTests: XCTestCase {
  private func chat(_ prefix: String) throws -> ChatModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatReconciliationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("test")
    return ChatModel(
      conversation: .init(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true)
  }

  func testBurstPublishesAllTextAndTerminalCannotBeOverwrittenByDelayedPartial() async throws {
    let chat = try chat("stream-burst")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<30 {
      if chat.partial.count == 200 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(chat.partial, String(repeating: "x", count: 200))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertTrue(chat.partial.isEmpty)
    XCTAssertNil(chat.activeRunID)
  }

  func testPausingStreamPreventsDelayedTextPublication() async throws {
    let chat = try chat("stream-burst")
    defer { chat.client.signOut() }
    await chat.resume()
    chat.pause()
    let partial = chat.partial
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(chat.partial, partial)
  }

  func testCachedHistoryTracksEntryChangesAndPreservesItDuringStreaming() throws {
    let chat = try chat("cached-history")
    defer { chat.client.signOut() }
    let entry = try JSONDecoder().decode(
      Entry.self,
      from: Data(
        #"{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question"}}"#.utf8))
    chat.entries = [entry]
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.partial = "Streaming"
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.entries.removeAll()
    XCTAssertTrue(chat.messages.isEmpty)
    XCTAssertTrue(chat.transcriptEntries.isEmpty)
  }

  func testStalledReconnectDoesNotOverwriteRecoveredPartial() async throws {
    let chat = try chat("reconnect-stall")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    let key = chat.client.baseURL.host! + "/api/runs/run/events"
    for _ in 0..<300 {
      if ChatReconciliationProtocol.counts.withLock({ $0[key, default: 0] }) >= 2 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertGreaterThanOrEqual(
      ChatReconciliationProtocol.counts.withLock { $0[key, default: 0] }, 2)
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(chat.partial, "Newer recovered text")
  }

  func testExistingSessionWaitsForSuccessfulHistoryBeforeShowingEmptyState() async throws {
    let chat = try chat("empty-history")
    defer { chat.client.signOut() }
    XCTAssertFalse(chat.hasLoadedTranscript)
    let loaded = await chat.refresh()
    XCTAssertTrue(loaded)
    XCTAssertTrue(chat.hasLoadedTranscript)
    XCTAssertTrue(chat.messages.isEmpty)
  }

  func testFailedHistoryDoesNotBecomeAConfirmedEmptyConversation() async throws {
    let chat = try chat("missing-history")
    defer { chat.client.signOut() }
    let loaded = await chat.refresh()
    XCTAssertFalse(loaded)
    XCTAssertFalse(chat.hasLoadedTranscript)
    XCTAssertNotNil(chat.error)
  }

  func testNewConversationCanShowWelcomeImmediately() throws {
    let existing = try chat("new-history")
    defer { existing.client.signOut() }
    let fresh = ChatModel(
      conversation: existing.conversation, client: existing.client, user: "test",
      knownSession: false)
    XCTAssertTrue(fresh.hasLoadedTranscript)
    XCTAssertTrue(fresh.messages.isEmpty)
  }

  func testRecordedPostSuppressesActiveStreamingCopy() async throws {
    let chat = try chat("posted-active")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if !chat.partial.isEmpty { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(chat.partial, "Answer")
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
  }

  func testRecordedPostSuppressesCompletedFallbackWhenFinalRefreshFails() async throws {
    let chat = try chat("posted-finish")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.activeRunID == nil, chat.error != nil { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertNil(chat.activeRunID)
    XCTAssertNotNil(chat.error)
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.messages.last?.activity.map(\.seq), [2, 3, 4, 5])
  }

  func testRecordedPostRetainsLaterActivityAcrossSuccessfulStaleRefreshes() async throws {
    let chat = try chat("posted-lag")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.activeRunID == nil, chat.messages.last?.activity.count == 4 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertNil(chat.activeRunID)
    XCTAssertNil(chat.error)
    let refreshed = await chat.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.messages.last?.activity.map(\.seq), [2, 3, 4, 5])
    XCTAssertEqual(chat.runPresentations.count, 1)
  }

  func testInheritedHistoryLoadsAtTheForkBoundaryWithoutFetchingCurrentPages() async throws {
    let chat = try chat("fork-history")
    defer { chat.client.signOut() }
    chat.conversation.forkedFrom = .init(sessionId: "source", title: "Original")
    chat.conversation.forkBoundarySeq = 5
    chat.earlierEntries = 9999
    chat.entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"[{"type":"user","seq":10000,"createdAt":10000,"payload":{"text":"Latest question"}}]"#
          .utf8))
    await chat.loadInheritedHistory()
    XCTAssertNil(chat.error)
    XCTAssertEqual(
      chat.messages.map(\.text), ["Inherited question", "Inherited answer", "Latest question"])
    XCTAssertEqual(chat.entries.map(\.seq), [10000])
    XCTAssertEqual(chat.earlierEntries, 9999)
    XCTAssertFalse(chat.needsEarlierHistory(for: 5))
    XCTAssertTrue(chat.needsEarlierHistory(for: 5000))
    XCTAssertFalse(chat.needsEarlierHistory(for: 10000))
    await chat.loadInheritedHistory()
    let key = chat.client.baseURL.host! + "/api/sessions/chat"
    XCTAssertEqual(ChatReconciliationProtocol.counts.withLock { $0[key, default: 0] }, 1)
  }

  func testInheritedHistoryCanRetryAfterFailure() async throws {
    let chat = try chat("fork-history-retry")
    defer { chat.client.signOut() }
    chat.conversation.forkedFrom = .init(sessionId: "source", title: "Original")
    chat.conversation.forkBoundarySeq = 5
    await chat.loadInheritedHistory()
    XCTAssertNotNil(chat.error)
    XCTAssertFalse(chat.loadingInherited)
    await chat.loadInheritedHistory()
    XCTAssertNil(chat.error)
    XCTAssertEqual(chat.messages.map(\.text), ["Inherited question", "Inherited answer"])
  }

  func testCompletedReplyRetainsActivityWhileTranscriptHistoryLags() async throws {
    let chat = try chat("activity-lag")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.messages.last?.role == "assistant" { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.messages.last?.activity.first?.payload?.thinking, "Working through it.")
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testFinalTranscriptNeverAppearsBesideStreamingCopyWhileApprovalsArePending() async throws {
    let chat = try chat("delayed")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    var sawFinal = false
    for _ in 0..<100 {
      if chatMessages(chat.entries).contains(where: { $0.role == "assistant" }) {
        sawFinal = true
        XCTAssertEqual(chat.displayedPartial, "")
        XCTAssertNil(chat.activeRunID)
      }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(sawFinal)
    XCTAssertEqual(chatMessages(chat.entries).filter { $0.role == "assistant" }.count, 1)
    let key = chat.client.baseURL.host! + "/api/runs/run"
    let polls = ChatReconciliationProtocol.counts.withLock { $0[key, default: 0] }
    XCTAssertEqual(polls, 0)
  }

  func testApprovalsFailureCannotResurrectStreamingCopy() async throws {
    let chat = try chat("failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    try await Task.sleep(for: .milliseconds(450))
    XCTAssertEqual(chatMessages(chat.entries).last?.text, "Answer")
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertNil(chat.activeRunID)
  }

  func testCompetingIdleRefreshCannotResurrectStreamingCopy() async throws {
    let chat = try chat("idle")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.entries.count == 2 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chatMessages(chat.entries).filter { $0.role == "assistant" }.count, 1)
  }

  func testCompletedReplayWithoutRunIDReconcilesBeforeFailedApprovals() async throws {
    let chat = try chat("replay-failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    chat.draft = "Question"
    let sending = Task { await chat.send() }
    var sawFinal = false
    for _ in 0..<100 {
      if chat.entries.count == 2 {
        sawFinal = true
        XCTAssertEqual(chat.displayedPartial, "")
      }
      try await Task.sleep(for: .milliseconds(5))
    }
    await sending.value
    XCTAssertTrue(sawFinal)
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testStaleActivityCannotRestartCompletedRun() async throws {
    let chat = try chat("stale")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.entries.count == 2 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertNil(chat.activeRunID)
    try await Task.sleep(for: .milliseconds(400))
    let key = chat.client.baseURL.host! + "/api/runs/run/events"
    let streams = ChatReconciliationProtocol.counts.withLock { $0[key, default: 0] }
    XCTAssertEqual(streams, 1)
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testPreviousRunCompletingDuringQueuedSubmissionKeepsItsOwnIdentity() async throws {
    let chat = try chat("overlap")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    chat.draft = "Next"
    let submitting = Task { await chat.send() }
    var sawRecordedAnswer = false
    for _ in 0..<100 {
      let answers = chat.messages.filter { $0.role == "assistant" && $0.text == "Answer" }
      if !answers.isEmpty {
        sawRecordedAnswer = true
        XCTAssertEqual(answers.count, 1)
        XCTAssertEqual(chat.displayedPartial, "")
      }
      try await Task.sleep(for: .milliseconds(5))
    }
    await submitting.value
    XCTAssertTrue(sawRecordedAnswer)
    XCTAssertFalse(chat.messages.contains { $0.text == "Next" })
  }

  func testAcceptedInputStaysVisibleUntilHistoryRecordsItsRun() async throws {
    let chat = try chat("accepted")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    chat.draft = "Question"
    await chat.send()
    XCTAssertTrue(chat.entries.isEmpty)
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    await chat.refresh()
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertEqual(chat.messages.first?.sequence, 1)
  }

  func testIdenticalRepliesAcrossSeparateRunsRemainVisible() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Repeat","runId":"old"}},
          {"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Same answer"}},
          {"type":"user","seq":3,"createdAt":3,"payload":{"text":"Repeat","runId":"new"}}
        ]
        """#.utf8))
    XCTAssertTrue(hasRecordedRunReply(entries, runID: "old"))
    XCTAssertFalse(hasRecordedRunReply(entries, runID: "new"))
    XCTAssertEqual(chatMessages(entries).count, 3)
  }

  func testSteeringWithoutRunIDKeepsTheActiveRunAssociation() throws {
    let entries = try JSONDecoder().decode(
      [Entry].self,
      from: Data(
        #"""
        [
          {"type":"user","seq":1,"createdAt":1,"payload":{"text":"Start","runId":"run"}},
          {"type":"user","seq":2,"createdAt":2,"payload":{"text":"Steer","steered":true}},
          {"type":"assistant","seq":3,"createdAt":3,"payload":{"text":"Done"}}
        ]
        """#.utf8))
    XCTAssertTrue(hasRecordedRunReply(entries, runID: "run"))
  }
  func testWithdrawnQueueInputDoesNotReappearWhenActiveRunFinishes() async throws {
    let chat = try chat("overlap")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    chat.draft = "Next"
    await chat.send()
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertFalse(chat.messages.contains { $0.text == "Next" })
    XCTAssertFalse(chat.runPresentations.contains { $0.id == "next" })
  }

  func testUnavailableActivityPreservesKnownActiveStreamAfterQueueSubmission() async throws {
    let chat = try chat("active-failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.partial == "Still writing" { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(chat.partial, "Still writing")
    chat.draft = "Next"
    await chat.send()
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.partialRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Still writing")
    XCTAssertFalse(chat.messages.contains { $0.text == "Next" })
    let key = chat.client.baseURL.host! + "/api/runs/next/events"
    let nextStreams = ChatReconciliationProtocol.counts.withLock { $0[key, default: 0] }
    XCTAssertEqual(nextStreams, 0)
  }

}
