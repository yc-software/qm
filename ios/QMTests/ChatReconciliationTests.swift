import Observation
import SwiftUI
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
  private func chat(
    _ prefix: String, probe: PublishProbe? = nil, goal: Conversation.Goal? = nil
  ) throws -> ChatModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatReconciliationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("test")
    let conversation = Conversation(
      id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
      canContinue: true, goal: goal)
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
    release(chat, "/api/runs/run/events", 1)
    await until { chat.activeRunID == nil }
    ChatReconciliationProtocol.advanceTick(clock)
    await Task.yield()
    XCTAssertFalse(probe.wroteAfterTick)
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertTrue(chat.partial.isEmpty)
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.messages.last?.text, "Answer")
  }

  func testRefusedRunKeepsItsReasonInTheTranscriptAcrossRefreshes() async throws {
    let chat = try chat("outcome-refused")
    defer { chat.client.signOut() }
    await chat.resume()
    await until { chat.activeRunID == nil && chat.messages.last?.role == "error" }
    await chat.refresh()
    await chat.refresh()
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Ask an admin for access."])
    XCTAssertNil(chat.error)
  }

  func testStoppedRunShowsAStopMarkerAndNoPlaceholderReply() async throws {
    let chat = try chat("outcome-stopped")
    defer { chat.client.signOut() }
    await chat.resume()
    await until { chat.activeRunID == nil && chat.messages.last?.notice != nil }
    await chat.refresh()
    XCTAssertEqual(chat.messages.map(\.text), ["Question", ""])
    guard case .stopped = chat.messages.last?.notice else {
      return XCTFail("Expected the stop marker to be the last row")
    }
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
        #"{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Question","body":{}}"#.utf8))
    chat.items = [entry]
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.partial = "Streaming"
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    chat.items.removeAll()
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
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.received[events] == 2 }
    XCTAssertEqual(chat.partial, "Newer recovered text")
  }

  func testExistingSessionWaitsForSuccessfulHistoryBeforeShowingEmptyState() async throws {
    let chat = try chat("empty-history")
    defer { chat.client.signOut() }
    XCTAssertFalse(chat.hasLoadedTranscript)
    let view = ChatView(model: chat)
    XCTAssertTrue(view.showsInitialHistoryPlaceholder)
    let loaded = await chat.refresh()
    XCTAssertTrue(loaded)
    XCTAssertTrue(chat.hasLoadedTranscript)
    XCTAssertTrue(chat.messages.isEmpty)
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
  }

  func testFailedHistoryDoesNotBecomeAConfirmedEmptyConversation() async throws {
    let chat = try chat("missing-history")
    defer { chat.client.signOut() }
    let loaded = await chat.refresh()
    XCTAssertFalse(loaded)
    XCTAssertFalse(chat.hasLoadedTranscript)
    XCTAssertTrue(chat.reconnecting)
    XCTAssertNil(chat.error)
    XCTAssertTrue(ChatView(model: chat).showsInitialHistoryPlaceholder)
  }

  func testNewConversationCanShowWelcomeImmediately() throws {
    let existing = try chat("new-history")
    defer { existing.client.signOut() }
    let fresh = ChatModel(
      conversation: existing.conversation, client: existing.client, user: "test",
      knownSession: false)
    XCTAssertTrue(fresh.hasLoadedTranscript)
    XCTAssertTrue(fresh.messages.isEmpty)
    XCTAssertFalse(ChatView(model: fresh).showsInitialHistoryPlaceholder)
  }

  func testInitialHistoryPlaceholderDoesNotCoverExistingOrPendingContent() throws {
    let chat = try chat("initial-history-content")
    defer { chat.client.signOut() }
    let view = ChatView(model: chat)
    XCTAssertTrue(view.showsInitialHistoryPlaceholder)

    chat.sending = true
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
    chat.sending = false
    chat.activeRunID = "run"
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
    chat.activeRunID = nil
    chat.partial = "Incoming response"
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
    chat.partial = ""
    chat.pending = PendingSend(text: "Saved message", idempotencyKey: "saved")
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
    chat.pending = nil
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1000,"kind":"UserMessage","text":"Existing message","body":{}}]"#
          .utf8))
    XCTAssertFalse(view.showsInitialHistoryPlaceholder)
    XCTAssertEqual(chat.messages.first?.text, "Existing message")
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

  func testReplyCompleteKeepsFollowingReasoningAndFinalResult() async throws {
    let chat = try chat("reply-complete")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.liveReasoning.first?.text == "Checking another issue" }
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Continuing")
    release(chat, "/api/runs/run/events", 1)
    await until { chat.activeRunID == nil }
    XCTAssertEqual(chat.messages.last?.text, "Answer")
  }

  func testResumeSnapshotWithoutPartialKeepsAlreadyVisibleText() async throws {
    let chat = try chat("resume-empty")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Already visible" }
    chat.pause()
    await chat.resume()
    await until { chat.liveReasoning.first?.text == "Continuing after resume" }
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Already visible")
  }

  func testRecordedPostSuppressesCompletedFallbackWhenFinalRefreshFails() async throws {
    let chat = try chat("posted-finish")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.activeRunID == nil && chat.reconnecting }
    XCTAssertNil(chat.activeRunID)
    XCTAssertNil(chat.error)
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer", ""])
    XCTAssertEqual(chat.messages[1].activity.compactMap(\.seq), [2, 3])
    XCTAssertEqual(chat.messages.last?.activity.compactMap(\.seq), [4, 5])
  }

  func testRecordedPostRetainsLaterActivityAcrossSuccessfulStaleRefreshes() async throws {
    let chat = try chat("posted-lag")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.activeRunID == nil && chat.messages.last?.activity.count == 2 }
    XCTAssertNil(chat.activeRunID)
    XCTAssertNil(chat.error)
    let refreshed = await chat.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer", ""])
    XCTAssertEqual(chat.messages[1].activity.compactMap(\.seq), [2, 3])
    XCTAssertEqual(chat.messages.last?.activity.compactMap(\.seq), [4, 5])
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
        #"[{"seq":10000,"createdAt":10000,"kind":"UserMessage","text":"Latest question","body":{}}]"#
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
    XCTAssertFalse(chat.hasActionError)
    XCTAssertFalse(chat.loadingInherited)
    await chat.loadInheritedHistory()
    XCTAssertNil(chat.error)
    XCTAssertEqual(chat.messages.map(\.text), ["Inherited question", "Inherited answer"])
  }

  func testDelayedHistoryLoadingPreservesAFailedFollowUp() async throws {
    for inherited in [true, false] {
      let chat = try chat("fork-history-held")
      defer { chat.client.signOut() }
      chat.conversation.forkedFrom = .init(sessionId: "source", title: "Original")
      chat.conversation.forkBoundarySeq = 5
      chat.items = try JSONDecoder().decode(
        [Item].self,
        from: Data(
          #"[{"seq":6,"createdAt":6,"kind":"UserMessage","text":"Latest question","body":{}}]"#
            .utf8))
      let loading = Task {
        if inherited { await chat.loadInheritedHistory() } else { await chat.loadEarlier() }
      }
      let history = key(chat, "/api/sessions/chat")
      await stub { $0.received[history] == 1 }
      chat.draft = "Keep this follow-up"
      await chat.send()
      XCTAssertEqual(chat.error, "Could not send follow-up.")
      XCTAssertTrue(chat.hasActionError)
      release(chat, "/api/sessions/chat", 1)
      await loading.value
      XCTAssertEqual(
        chat.messages.map(\.text), ["Inherited question", "Inherited answer", "Latest question"])
      XCTAssertEqual(chat.error, "Could not send follow-up.")
      XCTAssertTrue(chat.hasActionError)
      XCTAssertEqual(chat.pending?.text, "Keep this follow-up")
      XCTAssertEqual(chat.draft, "Keep this follow-up")
    }
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

  func testCompletedReplyIsVisibleWithoutActiveStatusWhileHistoryRefreshWaits() async throws {
    let chat = try chat("finish-held")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    let history = key(chat, "/api/sessions/chat")
    await stub { $0.received[history, default: 0] >= 2 }
    XCTAssertNil(chat.activeRunID)
    XCTAssertFalse(chat.showsWorkingStatus)
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.displayedPartial, "")
    release(chat, "/api/sessions/chat", 2)
    await until { chat.activeRunID == nil }
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertEqual(chat.displayedPartial, "")
  }

  func testFinalReplyRemainsVisibleAfterCommentaryWhileHistoryRefreshWaits() async throws {
    let chat = try chat("phase-finish-held")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    let history = key(chat, "/api/sessions/chat")
    await stub { $0.received[history, default: 0] >= 2 }
    XCTAssertNil(chat.activeRunID)
    XCTAssertFalse(chat.showsWorkingStatus)
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "First update", "Answer"])
    release(chat, "/api/sessions/chat", 2)
    await until { chat.activeRunID == nil }
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "First update", "Answer"])
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
    await until { chat.reconnecting }
    XCTAssertEqual(chatMessages(chat.items).last?.text, "Answer")
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertNil(chat.activeRunID)
  }

  func testMessageSentDuringActiveRunWaitsInTheQueue() async throws {
    let chat = try chat("active-failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Still writing" }
    chat.draft = "Next"
    await chat.send()
    XCTAssertEqual(
      chat.queue.inputs, [QueuedInput(runId: "next", text: "Next", hasAttachments: nil)])
    XCTAssertFalse(chat.messages.contains { $0.text == "Next" })
  }

  func testSteeredQueuedMessageStaysVisibleUntilTheRunRecordsIt() async throws {
    let chat = try chat("steered-live")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await chat.queue.refresh()
    XCTAssertEqual(chat.queue.inputs.map(\.text), ["Change course"])
    chat.queue.steer(chat.queue.inputs[0])
    await until { chat.queue.steering.map(\.text) == ["Change course"] && !chat.queue.mutating }
    XCTAssertNil(chat.liveTimeline?.messages.first { $0.steered })
    release(chat, "/api/runs/run/events", 1)
    await until { chat.liveTimeline?.messages.first { $0.steered }?.text == "Change course" }
    XCTAssertTrue(chat.queue.steering.isEmpty)
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
    XCTAssertTrue(chat.reconnecting)
    XCTAssertNil(chat.error)
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"old","text":"Repeat","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Same answer","body":{}},{"seq":3,"createdAt":3,"kind":"UserMessage","turnId":"new","text":"Repeat","body":{}}]
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
        [{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Start","body":{}},{"seq":2,"createdAt":2,"kind":"SteeringMessage","text":"Steer","body":{}},{"seq":3,"createdAt":3,"kind":"AgentMessage","text":"Done","body":{}}]
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

  func testAcceptedSendFollowsRunWhenConcurrentActivityRefreshIsCancelled() async throws {
    let chat = try chat("lifecycle-accepted")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    chat.draft = "Question"
    let sending = Task { await chat.send() }
    let turn = key(chat, "/api/turn")
    await stub { $0.received[turn] == 1 }
    let queue = QueuedInputsModel(
      client: chat.client, threadRef: chat.conversation.threadRef,
      scopeID: chat.conversation.scopeId
    ) { await chat.reconcileActivity($0) }
    let discovering = Task { await queue.refresh() }
    let history = key(chat, "/api/sessions/chat")
    await stub { $0.received[history] == 2 }
    XCTAssertEqual(chat.activeRunID, "run")
    discovering.cancel()
    queue.stop()
    await discovering.value
    release(chat, "/api/sessions/chat", 2)
    release(chat, "/api/turn", 1)
    await sending.value
    await until { chat.partial == "Current response" }
    await queue.refresh()
    XCTAssertEqual(ChatReconciliationProtocol.log.received[turn], 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run/events")], 1)
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.partialRunID, "run")
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertFalse(chat.sending)
    XCTAssertNil(chat.pending)
    XCTAssertTrue(chat.draft.isEmpty)
    XCTAssertNil(chat.error)
  }

  func testInactiveSnapshotRepairsActivityAfterResumeLookupFailure() async throws {
    let chat = try chat("lifecycle-resume-failure")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    chat.draft = "Keep this unsent draft"
    chat.pause()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.stopped[events] == 1 }
    await chat.resume()
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    let queue = QueuedInputsModel(
      client: chat.client, threadRef: chat.conversation.threadRef,
      scopeID: chat.conversation.scopeId
    ) { await chat.reconcileActivity($0) }
    await queue.refresh()
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/active")], 3)
    XCTAssertNil(queue.activeRunID)
    XCTAssertNil(chat.activeRunID)
    XCTAssertTrue(chat.displayedPartial.isEmpty)
    XCTAssertEqual(chat.messages.filter { $0.role == "assistant" }.map(\.text), ["Answer"])
    XCTAssertEqual(chat.draft, "Keep this unsent draft")
    XCTAssertNil(chat.error)
  }

  func testInactiveSnapshotDoesNotStopAnAuthoritativelyRunningResponse() async throws {
    let chat = try chat("lifecycle-still-running")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    let queue = QueuedInputsModel(
      client: chat.client, threadRef: chat.conversation.threadRef,
      scopeID: chat.conversation.scopeId
    ) { await chat.reconcileActivity($0) }
    await queue.refresh()
    XCTAssertNil(queue.activeRunID)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/active")], 2)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run/events")], 1)
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Current response")
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertNil(chat.error)
  }

  func testTerminalLookupUsesItsActivitySnapshotWhileHistoryLags() async throws {
    let scenarios: [(String, [String], [NativeWorkItem.State])] = [
      ("full", ["Question", "Final update", "Answer"], [.complete]),
      ("empty", ["Question", "Answer"], []),
      ("omitted", ["Question", "Answer"], [.unconfirmed]),
    ]
    for (suffix, messages, states) in scenarios {
      let chat = try chat("lifecycle-terminal-activity-\(suffix)")
      defer {
        chat.pause()
        chat.client.signOut()
      }
      await chat.resume()
      await until { chat.partial == "Current response" }
      XCTAssertEqual(
        chat.timeline.items.compactMap { item -> NativeWorkItem.State? in
          guard case .work(let work) = item.content else { return nil }
          return work.state(active: item.active)
        }, [.running], suffix)

      await chat.reconcileActivity(.init(runId: nil, queued: []))

      XCTAssertEqual(chat.messages.map(\.text), messages, suffix)
      XCTAssertEqual(
        chat.timeline.items.compactMap { item -> NativeWorkItem.State? in
          guard case .work(let work) = item.content else { return nil }
          return work.state(active: item.active)
        }, states, suffix)
      XCTAssertNil(chat.activeRunID, suffix)
      XCTAssertTrue(chat.displayedPartial.isEmpty, suffix)
      XCTAssertNil(chat.error, suffix)
    }
  }

  func testExpandedReasoningUpdatesForSameBlockWithoutTranscriptRefresh() async throws {
    let chat = try chat("lifecycle-reasoning-deltas")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.liveReasoning.first?.text == "First thought" }
    let section = try XCTUnwrap(
      NativeChatTranscriptSection.grouped(
        chat.timeline.items, activeRunID: chat.activeRunID, status: chat.workStatus
      ).last)
    let disclosure = NativeWorkDisclosureState()
    let group = NativeTimelineActivityGroup(
      section: section, client: chat.client, user: chat.user,
      disclosure: disclosure, reasoningText: chat.reasoningText)
    group.expanded.wrappedValue = true
    disclosure.binding(for: "reasoning:\(try XCTUnwrap(section.items.first).id)").wrappedValue =
      true
    let firstTitle = group.title
    let controller = UIHostingController(rootView: group.frame(width: 280))
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousWindow = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previousWindow?.makeKey()
    }
    controller.view.layoutIfNeeded()
    let proposed = CGSize(width: 280, height: 2_000)
    let initialHeight = controller.sizeThatFits(in: proposed).height

    release(chat, "/api/runs/run/events", 1)
    await until { (chat.liveReasoning.first?.text.count ?? 0) > 600 }
    let deadline = ContinuousClock.now + .seconds(3)
    while controller.sizeThatFits(in: proposed).height <= initialHeight + 200,
      ContinuousClock.now < deadline
    {
      try await Task.sleep(for: .milliseconds(20))
    }

    XCTAssertGreaterThan(controller.sizeThatFits(in: proposed).height, initialHeight + 200)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/sessions/chat")], 1)
    XCTAssertEqual(chat.liveReasoning.count, 1)
    XCTAssertEqual(
      group.title,
      NativeThinkingPresentation(text: try XCTUnwrap(chat.liveReasoning.first).text, live: true)
        .title)
    XCTAssertEqual(firstTitle, "Thinking")
  }

  func testReopeningDuringAnEmptyActiveSnapshotKeepsTheResponseAndReconnects() async throws {
    let chat = try chat("lifecycle-still-running")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    chat.draft = "Keep my follow-up"
    chat.pause()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.stopped[events] == 1 }
    await chat.resume()
    await stub { $0.received[events] == 2 }
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Current response")
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertEqual(chat.draft, "Keep my follow-up")
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run")], 1)
    XCTAssertNil(chat.error)
  }

  func testHealthyStreamRetriesMissedHistoryAfterReopening() async throws {
    let chat = try chat("lifecycle-history-gap")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.refresh()
    XCTAssertTrue(chat.hasLoadedTranscript)
    XCTAssertEqual(chat.messages.map(\.text), ["Earlier question", "Earlier answer"])
    chat.pause()
    await chat.resume()
    await until { chat.partial == "Current response" }
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertTrue(chat.reconnecting)
    XCTAssertEqual(chat.messages.map(\.text), ["Earlier question", "Earlier answer"])
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertEqual(
      chat.messages.map(\.text),
      [
        "Earlier question", "Earlier answer", "Missed question", "Missed answer",
        "Current question",
      ])
    XCTAssertEqual(chat.displayedPartial, "Current response")
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertFalse(chat.reconnecting)
    XCTAssertNil(chat.error)
    let history = key(chat, "/api/sessions/chat")
    XCTAssertEqual(ChatReconciliationProtocol.log.received[history], 3)
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertEqual(ChatReconciliationProtocol.log.received[history], 3)
  }

  func testRejectedLookupCannotInterruptTerminalHistoryRefresh() async throws {
    let chat = try chat("lifecycle-terminal-lookup-race")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    let lookup = key(chat, "/api/runs/run")
    let history = key(chat, "/api/sessions/chat")
    let reconciling = Task { await chat.reconcileActivity(.init(runId: nil, queued: [])) }
    defer { reconciling.cancel() }
    await stub { $0.received[lookup] == 1 }
    release(chat, "/api/runs/run/events", 1)
    await stub { $0.received[history] == 2 }
    XCTAssertNil(chat.activeRunID)
    XCTAssertNil(chat.liveTimeline)
    XCTAssertTrue(chat.partial.isEmpty)
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    let stoppedHistory = ChatReconciliationProtocol.log.stopped[history]
    release(chat, "/api/runs/run", 1)
    await reconciling.value
    XCTAssertNil(chat.activeRunID)
    XCTAssertNil(chat.error)
    XCTAssertEqual(ChatReconciliationProtocol.log.stopped[history], stoppedHistory)
    release(chat, "/api/sessions/chat", 2)
    await until { chat.activeRunID == nil && chat.messages.last?.text == "Answer" }
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertTrue(chat.displayedPartial.isEmpty)
    XCTAssertNil(chat.error)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[lookup], 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run/events")], 1)
  }

  func testFailedResumeReconnectsKnownRunAndLaterRejectionStopsIt() async throws {
    let chat = try chat("lifecycle-unmonitored-rejection")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    chat.pause()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.stopped[events] == 1 }
    await chat.resume()
    XCTAssertEqual(chat.activeRunID, "run")
    await stub { $0.received[events] == 2 }
    XCTAssertNil(chat.error)
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.error, "This run can no longer be accessed.")
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.error, "This run can no longer be accessed.")
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.error, "This run can no longer be accessed.")
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertEqual(ChatReconciliationProtocol.log.received[events], 2)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run")], 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/sessions/chat")], 2)
  }

  func testSupersededResumeFailureCannotReplaceNewerHealthyState() async throws {
    let chat = try chat("lifecycle-stale-resume")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    let first = Task { await chat.resume() }
    let active = key(chat, "/api/runs/active")
    await stub { $0.received[active] == 1 }
    await until { chat.error == nil && chat.hasLoadedTranscript }
    await chat.resume()
    await until { chat.partial == "Current response" }
    XCTAssertNil(chat.error)
    release(chat, "/api/runs/active", 1)
    await first.value
    XCTAssertEqual(ChatReconciliationProtocol.log.received[active], 2)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/run/events")], 1)
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Current response")
    XCTAssertNil(chat.error)
  }

  func testBackgroundResumeRestoresSameRunWithoutPublishingStoppedStream() async throws {
    let chat = try chat("lifecycle-background")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Before background" }
    chat.draft = "Unsent during background"
    chat.pause()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.stopped[events] == 1 }
    await chat.resume()
    await until { chat.partial == "Current response" }
    release(chat, "/api/runs/run/events", 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[events], 2)
    XCTAssertEqual(ChatReconciliationProtocol.log.loaded[events], 2)
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.displayedPartial, "Current response")
    XCTAssertEqual(chat.messages.map(\.text), ["Question"])
    XCTAssertEqual(chat.draft, "Unsent during background")
    XCTAssertNil(chat.error)
  }

  func testRunFinishedWhilePausedRestoresOneFinalReplyWithoutReopeningStream() async throws {
    let chat = try chat("lifecycle-completed")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    await until { chat.partial == "Current response" }
    chat.pause()
    let events = key(chat, "/api/runs/run/events")
    await stub { $0.stopped[events] == 1 }
    await chat.resume()
    XCTAssertEqual(ChatReconciliationProtocol.log.received[events], 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/runs/active")], 2)
    XCTAssertEqual(chat.messages.map(\.text), ["Question", "Answer"])
    XCTAssertNil(chat.activeRunID)
    XCTAssertTrue(chat.displayedPartial.isEmpty)
    XCTAssertNil(chat.error)
  }

  private func approvals(_ json: String) throws -> [Approval] {
    try JSONDecoder().decode([Approval].self, from: Data(json.utf8))
  }

  private func bodies(_ chat: ChatModel, _ path: String) -> [String] {
    ChatReconciliationProtocol.log.bodies[key(chat, path)] ?? []
  }

  func testCredentialApprovalsRouteToKeychainWhileCommandApprovalsStayOnApprovals() async throws {
    let chat = try chat("credential")
    defer { chat.client.signOut() }
    chat.approvals = try approvals(
      #"""
      [
        {"requestId":"approval","command":"publish","grantModes":{"session":false,"always":false}},
        {"requestId":"keychain:ask:1:2","command":"github (work)","summary":"Use your github credential in Chat","reason":"Credential approval","grantModes":{"session":false,"always":true},"blocksInput":false},
        {"requestId":"keychain:ask/standing","command":"gitlab","grantModes":{"session":false,"always":true},"blocksInput":false},
        {"requestId":"keychain:ask-denied","command":"jira","grantModes":{"session":false,"always":true},"blocksInput":false}
      ]
      """#)
    XCTAssertEqual(chat.approvals.map(\.isCredential), [false, true, true, true])
    XCTAssertEqual(chat.workStatus, .awaitingInput)

    await chat.decide(chat.approvals[1], approved: true)
    await chat.decide(chat.approvals[1], approved: true, scope: "always")
    await chat.decide(chat.approvals[1], approved: false)
    XCTAssertEqual(chat.approvals.map(\.id), ["approval"])
    XCTAssertNil(chat.error)
    XCTAssertEqual(bodies(chat, "/api/keychain/approvals/ask:1:2"), [#"{"decision":"once"}"#])
    XCTAssertEqual(
      bodies(chat, "/api/keychain/approvals/ask%2Fstanding"), [#"{"decision":"standing"}"#])
    XCTAssertEqual(bodies(chat, "/api/keychain/approvals/ask-denied"), [#"{"decision":"deny"}"#])
    XCTAssertNil(
      ChatReconciliationProtocol.log.received[key(chat, "/api/approvals/keychain:ask:1:2")])

    await chat.decide(chat.approvals[0], approved: true)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(chat, "/api/approvals/approval")], 1)
    XCTAssertTrue(chat.approvals.isEmpty)
  }

  func testPendingCredentialDecisionKeepsTheApproval() async throws {
    let chat = try chat("credential-pending")
    defer { chat.client.signOut() }
    chat.approvals = try approvals(
      #"[{"requestId":"keychain:ask","command":"github","grantModes":{"session":false,"always":true},"blocksInput":false}]"#
    )
    await chat.decide(chat.approvals[0], approved: true)
    XCTAssertEqual(chat.approvals.map(\.id), ["keychain:ask"])
    XCTAssertNotNil(chat.error)
    XCTAssertFalse(chat.sending)
  }

  func testGoalFollowsEachTranscriptRefreshInsteadOfTheListRow() async throws {
    let chat = try chat("goal-page", goal: .init(objective: "Ship the release"))
    defer { chat.client.signOut() }
    XCTAssertEqual(chat.goal?.paused, false)

    await chat.refresh()
    XCTAssertEqual(chat.goal?.objective, "Ship the release")
    XCTAssertEqual(chat.goal?.paused, false)

    await chat.refresh()
    XCTAssertEqual(chat.goal?.paused, true)

    await chat.refresh()
    XCTAssertNil(chat.goal)

    await chat.refresh()
    XCTAssertEqual(chat.goal?.objective, "Ship the release")
    XCTAssertEqual(chat.goal?.paused, false)
    XCTAssertTrue(chat.conversation.canReply)
  }

  func testGoalCancelClearsTheGoalHidesMissingGoalsAndReportsBusy() async throws {
    let goal = Conversation.Goal(objective: "Ship the release")
    let cancelled = try chat("goal-cancelled", goal: goal)
    defer { cancelled.client.signOut() }
    await cancelled.cancelGoal()
    XCTAssertNil(cancelled.goal)
    XCTAssertNil(cancelled.error)
    XCTAssertEqual(
      ChatReconciliationProtocol.log.received[key(cancelled, "/api/sessions/chat/goal/cancel")], 1)

    let busy = try chat("goal-busy", goal: goal)
    defer { busy.client.signOut() }
    await busy.cancelGoal()
    XCTAssertEqual(busy.goal, goal)
    XCTAssertEqual(busy.error, "Still finishing a reply.")

    let gone = try chat("goal-gone", goal: goal)
    defer { gone.client.signOut() }
    await gone.cancelGoal()
    XCTAssertNil(gone.goal)
    XCTAssertNil(gone.error)

    await gone.cancelGoal()
    XCTAssertEqual(
      ChatReconciliationProtocol.log.received[key(gone, "/api/sessions/chat/goal/cancel")], 1)
  }

  func testStopAcceptsARunThatAlreadyEndedAndReportsWhenStoppingDidNothing() async throws {
    let ended = try chat("stop-ended")
    defer { ended.client.signOut() }
    ended.activeRunID = "run"
    ended.error = "Earlier failure"
    await ended.stop()
    XCTAssertNil(ended.error)

    let ignored = try chat("stop-ignored")
    defer { ignored.client.signOut() }
    ignored.activeRunID = "run"
    await ignored.stop()
    XCTAssertEqual(ignored.error, "QM could not stop this response (signals_unavailable).")
    XCTAssertEqual(
      ChatReconciliationProtocol.log.received[key(ignored, "/api/runs/run/signal")], 1)
  }

  func testDetachRefreshesTheRowAndIsOnlyAvailableToSubagents() async throws {
    let subagent = try chat("detach")
    defer { subagent.client.signOut() }
    subagent.conversation.parentSessionId = "parent"
    XCTAssertTrue(subagent.conversation.isSubagent)
    await subagent.detach()
    XCTAssertFalse(subagent.conversation.isSubagent)
    XCTAssertTrue(subagent.conversation.canReply)
    XCTAssertNil(subagent.error)
    XCTAssertEqual(
      ChatReconciliationProtocol.log.received[key(subagent, "/api/sessions/chat/detach")], 1)
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(subagent, "/api/sessions/row")], 1)

    let topLevel = try chat("detach")
    defer { topLevel.client.signOut() }
    await topLevel.detach()
    XCTAssertNil(
      ChatReconciliationProtocol.log.received[key(topLevel, "/api/sessions/chat/detach")])
  }

  func testDismissingASuggestedActivityRemovesItOnceTheServerConfirms() async throws {
    let identity = Identity(
      user: "test", companyName: nil, displayName: nil,
      suggestedActivities: ["a", "b", "c", "d"].map {
        SuggestedActivity(id: $0, title: "Activity \($0)", prompt: "Do \($0)", icon: nil)
      })
    for prefix in ["dismiss-confirmed", "dismiss-refused"] {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [ChatReconciliationProtocol.self]
      let client = APIClient(
        baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
        configuration: configuration)
      let model = NativeSuggestedActivitiesModel(client: client)
      XCTAssertEqual(model.activities(for: identity).map(\.id), ["a", "b", "c"])
      await model.dismiss(identity.suggestedActivities![0])
      let path = client.baseURL.host! + "/api/suggested-activities/dismiss"
      XCTAssertEqual(ChatReconciliationProtocol.log.bodies[path], [#"{"id":"a"}"#], prefix)
      XCTAssertEqual(
        model.activities(for: identity).map(\.id),
        prefix == "dismiss-confirmed" ? ["b", "c", "d"] : ["a", "b", "c"], prefix)
      XCTAssertNil(model.dismissing)
    }
  }

  func testSuggestedActivitiesAreDismissibleOnlyWhenGenerated() throws {
    var identity = Identity(
      user: "test", companyName: nil, displayName: nil,
      suggestedActivities: ["a", "b", "c", "d"].map {
        SuggestedActivity(id: $0, title: "Activity \($0)", prompt: "Do \($0)", icon: nil)
      })
    let client = try chat("dismiss-confirmed").client
    defer { client.signOut() }
    let model = NativeSuggestedActivitiesModel(client: client)
    func suggestions() -> NativeSuggestedActivities {
      NativeSuggestedActivities(model: model, identity: identity) { _ in }
    }
    XCTAssertFalse(suggestions().dismissible)
    identity.suggestedActivitiesGeneration = true
    XCTAssertTrue(suggestions().dismissible)
  }

}
