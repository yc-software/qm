import Observation
import XCTest

@testable import QM

private struct Arrival {
  let arrive: @Sendable () -> Void
  private let stream: AsyncStream<Bool>
  private let finish: @Sendable () -> Void

  init() {
    let (stream, continuation) = AsyncStream<Bool>.makeStream()
    let timer = Task {
      try await Task.sleep(for: .seconds(5))
      continuation.yield(false)
    }
    continuation.onTermination = { _ in timer.cancel() }
    self.stream = stream
    arrive = { continuation.yield(true) }
    finish = { continuation.finish() }
  }

  func wait() async -> Bool {
    defer { finish() }
    for await arrived in stream { return arrived }
    return false
  }
}

@MainActor
private final class ModelWatch {
  private var condition: (@MainActor () -> Bool)?
  private let then: @Sendable () -> Void

  init(_ condition: @escaping @MainActor () -> Bool, then: @escaping @Sendable () -> Void) {
    self.condition = condition
    self.then = then
    check()
  }

  func stop() { condition = nil }

  private func check() {
    guard let condition else { return }
    let met = withObservationTracking {
      condition()
    } onChange: {
      Task { @MainActor in self.check() }
    }
    if met {
      stop()
      then()
    }
  }
}

@MainActor
private final class Sighting {
  var seen = false
}

@MainActor @Observable
private final class PublishProbe {
  var chat: ChatModel?
  var armed = false
  var checked = false
  var wroteAfterTick = false

  func heldTickReturned() {
    guard let chat else { return }
    withObservationTracking {
      _ = chat.partial
    } onChange: {
      MainActor.assumeIsolated {
        if self.armed { self.wroteAfterTick = true }
      }
    }
    armed = true
    Task { @MainActor in
      armed = false
      checked = true
    }
  }
}

@MainActor
final class ChatReconciliationTests: XCTestCase {
  private func chat(_ prefix: String, probe: PublishProbe? = nil) throws -> ChatModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatReconciliationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("test")
    let conversation = Conversation(
      id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
      canContinue: true)
    guard let probe else {
      return ChatModel(conversation: conversation, client: client, user: "test", knownSession: true)
    }
    let clock = client.baseURL.host!
    let chat = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: true,
      publishTick: {
        if try await ChatReconciliationProtocol.publishTick(clock) { probe.heldTickReturned() }
      })
    probe.chat = chat
    return chat
  }

  private func key(_ chat: ChatModel, _ path: String) -> String {
    chat.client.baseURL.host! + path
  }

  private func release(_ chat: ChatModel, _ path: String, _ count: Int) {
    ChatReconciliationProtocol.release("\(key(chat, path))#\(count)")
  }

  private func stub(
    _ condition: @escaping @Sendable (ChatStubLog) -> Bool, file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    let arrival = Arrival()
    let id = ChatReconciliationProtocol.wait(until: condition, then: arrival.arrive)
    let arrived = await arrival.wait()
    ChatReconciliationProtocol.stopWaiting(id)
    XCTAssertTrue(arrived, "The stub never reached the expected state", file: file, line: line)
  }

  private func until(
    _ condition: @escaping @MainActor () -> Bool, file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    let arrival = Arrival()
    let watch = ModelWatch(condition, then: arrival.arrive)
    let arrived = await arrival.wait()
    watch.stop()
    XCTAssertTrue(arrived, "The chat never reached the expected state", file: file, line: line)
  }

  private func watch(_ check: @escaping @MainActor () -> Void) -> ModelWatch {
    ModelWatch(
      {
        check()
        return false
      }, then: {})
  }

  func testBurstPublishesAllTextAndTerminalCannotBeOverwrittenByDelayedPartial() async throws {
    let probe = PublishProbe()
    let chat = try chat("stream-burst", probe: probe)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    let clock = chat.client.baseURL.host!
    await chat.resume()
    await until { chat.partial.count == 200 }
    XCTAssertEqual(chat.partial, String(repeating: "x", count: 200))
    ChatReconciliationProtocol.holdTicks(clock)
    await stub { $0.parkedTicks[clock] == 1 }
    withObservationTracking {
      _ = chat.activeRunID
    } onChange: {
      ChatReconciliationProtocol.advanceTick(clock)
    }
    release(chat, "/api/runs/run/events", 1)
    await until { probe.checked }
    XCTAssertFalse(probe.wroteAfterTick)
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertTrue(chat.partial.isEmpty)
    XCTAssertNil(chat.activeRunID)
  }

  func testPausingStreamPreventsDelayedTextPublication() async throws {
    let chat = try chat("stream-burst")
    defer { chat.client.signOut() }
    await chat.resume()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.loaded[events] == 1 }
    chat.pause()
    let partial = chat.partial
    await stub { $0.stopped[events] == 1 }
    release(chat, "/api/runs/run/events", 1)
    XCTAssertEqual(chat.partial, partial)
    XCTAssertEqual(ChatReconciliationProtocol.log.loaded[events], 1)
  }

  func testCachedHistoryTracksEntryChangesAndPreservesItDuringStreaming() throws {
    let chat = try chat("cached-history")
    defer { chat.client.signOut() }
    let entry = try JSONDecoder().decode(
      Item.self,
      from: Data(
        #"{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Question","body":{}}"#.utf8))
    chat.items = [entry]
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.partial = "Streaming"
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.items.removeAll()
    XCTAssertTrue(chat.messages.isEmpty)
    XCTAssertTrue(chat.transcriptItems.isEmpty)
  }

  func testStalledReconnectDoesNotOverwriteRecoveredPartial() async throws {
    let chat = try chat("reconnect-stall")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.received[events] == 2 }
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
    await until { !chat.partial.isEmpty }
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
    await until { chat.activeRunID == nil && chat.error != nil }
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
    await until { chat.activeRunID == nil && chat.messages.last?.activity.count == 4 }
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
    chat.earlierItems = 9999
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"kind":"UserMessage","seq":10000,"createdAt":10000,"text":"Latest question","body":{}}]"#
          .utf8))
    await chat.loadInheritedHistory()
    XCTAssertNil(chat.error)
    XCTAssertEqual(
      chat.messages.map(\.text), ["Inherited question", "Inherited answer", "Latest question"])
    XCTAssertEqual(chat.items.map(\.seq), [10000])
    XCTAssertEqual(chat.earlierItems, 9999)
    XCTAssertFalse(chat.needsEarlierHistory(for: 5))
    XCTAssertTrue(chat.needsEarlierHistory(for: 5000))
    XCTAssertFalse(chat.needsEarlierHistory(for: 10000))
    await chat.loadInheritedHistory()
    XCTAssertEqual(
      ChatReconciliationProtocol.log.received[key(chat, "/api/sessions/chat")], 1)
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
    await until { chat.messages.last?.role == "assistant" }
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.messages.last?.activity.first?.text, "Working through it.")
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testFinalTranscriptNeverAppearsBesideStreamingCopyWhileApprovalsArePending() async throws {
    let chat = try chat("delayed")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    let answer = Sighting()
    let invariant = watch {
      guard chatMessages(chat.items).contains(where: { $0.role == "assistant" }) else { return }
      answer.seen = true
      XCTAssertEqual(chat.displayedPartial, "")
      XCTAssertNil(chat.activeRunID)
    }
    defer { invariant.stop() }
    await chat.resume()
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertTrue(chatMessages(chat.items).contains { $0.role == "assistant" })
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertNil(chat.activeRunID)
    release(chat, "/api/sessions/chat/approvals", 2)
    await stub { $0.loaded[approvals] == 2 }
    XCTAssertTrue(answer.seen)
    XCTAssertEqual(chatMessages(chat.items).filter { $0.role == "assistant" }.count, 1)
    XCTAssertNil(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run")])
  }

  func testApprovalsFailureCannotResurrectStreamingCopy() async throws {
    let chat = try chat("failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.error != nil }
    XCTAssertEqual(chatMessages(chat.items).last?.text, "Answer")
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
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chatMessages(chat.items).filter { $0.role == "assistant" }.count, 1)
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
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertEqual(chat.items.count, 2)
    XCTAssertEqual(chat.displayedPartial, "")
    release(chat, "/api/sessions/chat/approvals", 2)
    await sending.value
    XCTAssertNotNil(chat.error)
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
    await until { chat.items.count == 2 }
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run/events")], 1)
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testPreviousRunCompletingDuringQueuedSubmissionKeepsItsOwnIdentity() async throws {
    let chat = try chat("overlap-completing")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    let recorded = Sighting()
    let invariant = watch {
      let answers = chat.messages.filter { $0.role == "assistant" && $0.text == "Answer" }
      guard !answers.isEmpty else { return }
      recorded.seen = true
      XCTAssertEqual(answers.count, 1)
      XCTAssertEqual(chat.displayedPartial, "")
    }
    defer { invariant.stop() }
    await chat.resume()
    chat.draft = "Next"
    let submitting = Task { await chat.send() }
    let active = key(chat, "/api/runs/active")
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[active] == 2 }
    release(chat, "/api/runs/run/events", 1)
    await stub { $0.received[approvals] == 2 }
    release(chat, "/api/runs/active", 2)
    await submitting.value
    XCTAssertTrue(recorded.seen)
    XCTAssertNil(chat.activeRunID)
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
    XCTAssertTrue(chat.items.isEmpty)
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    await chat.refresh()
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertEqual(chat.messages.first?.sequence, 1)
  }

  func testIdenticalRepliesAcrossSeparateRunsRemainVisible() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Repeat","turnId":"old","body":{}},
          {"kind":"AgentMessage","seq":2,"createdAt":2,"text":"Same answer","body":{}},
          {"kind":"UserMessage","seq":3,"createdAt":3,"text":"Repeat","turnId":"new","body":{}}
        ]
        """#.utf8))
    XCTAssertTrue(hasRecordedRunReply(items, runID: "old"))
    XCTAssertFalse(hasRecordedRunReply(items, runID: "new"))
    XCTAssertEqual(chatMessages(items).count, 3)
  }

  func testSteeringWithoutRunIDKeepsTheActiveRunAssociation() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [
          {"kind":"UserMessage","seq":1,"createdAt":1,"text":"Start","turnId":"run","body":{}},
          {"kind":"SteeringMessage","seq":2,"createdAt":2,"text":"Steer","body":{}},
          {"kind":"AgentMessage","seq":3,"createdAt":3,"text":"Done","body":{}}
        ]
        """#.utf8))
    XCTAssertTrue(hasRecordedRunReply(items, runID: "run"))
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
    let approvals = key(chat, "/api/sessions/chat/approvals")
    let refreshes = ChatReconciliationProtocol.log.received[approvals, default: 0]
    release(chat, "/api/runs/run/events", 1)
    await stub { $0.received[approvals, default: 0] > refreshes }
    XCTAssertNil(chat.activeRunID)
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
    await until { chat.partial == "Still writing" }
    XCTAssertEqual(chat.partial, "Still writing")
    chat.draft = "Next"
    await chat.send()
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.partialRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Still writing")
    XCTAssertFalse(chat.messages.contains { $0.text == "Next" })
    XCTAssertNil(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/next/events")])
  }

}
