import Observation
import XCTest
import os

@testable import QM

struct ChatStubLog: Sendable {
  var received: [String: Int] = [:]
  var loaded: [String: Int] = [:]
  var stopped: [String: Int] = [:]
  var parkedTicks: [String: Int] = [:]
}

final class ChatReconciliationProtocol: URLProtocol, @unchecked Sendable {
  private struct Waiter: Sendable {
    let condition: @Sendable (ChatStubLog) -> Bool
    let then: @Sendable () -> Void
  }
  private struct Registry: Sendable {
    var log = ChatStubLog()
    var held: [String: @Sendable () -> Void] = [:]
    var released: Set<String> = []
    var waiters: [UUID: Waiter] = [:]
    var holdingTicks: Set<String> = []
    var parkedTicks: [String: CheckedContinuation<Bool, Error>] = [:]
  }
  private enum TickStep: Sendable {
    case cancelled
    case free
    case parked
  }
  private static let registry = OSAllocatedUnfairLock(initialState: Registry())
  private let isStopped = OSAllocatedUnfairLock(initialState: false)

  static var log: ChatStubLog { registry.withLock { $0.log } }

  @discardableResult
  private static func record<T: Sendable>(_ change: @Sendable (inout Registry) -> T) -> T {
    let (value, reached) = registry.withLock { registry in
      let value = change(&registry)
      let met = registry.waiters.filter { $0.value.condition(registry.log) }
      for id in met.keys { registry.waiters[id] = nil }
      return (value, met.values.map(\.then))
    }
    for then in reached { then() }
    return value
  }

  static func wait(
    until condition: @escaping @Sendable (ChatStubLog) -> Bool, then: @escaping @Sendable () -> Void
  ) -> UUID {
    let id = UUID()
    record { $0.waiters[id] = Waiter(condition: condition, then: then) }
    return id
  }

  static func holdTicks(_ clock: String) {
    record { $0.holdingTicks.insert(clock) }
  }

  static func advanceTick(_ clock: String) {
    record { $0.parkedTicks.removeValue(forKey: clock) }?.resume(returning: true)
  }

  @MainActor static func publishTick(_ clock: String) async throws -> Bool {
    let parked = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Bool, Error>) in
        let step = record { registry -> TickStep in
          if Task.isCancelled { return .cancelled }
          guard registry.holdingTicks.contains(clock) else { return .free }
          registry.parkedTicks[clock] = continuation
          registry.log.parkedTicks[clock, default: 0] += 1
          return .parked
        }
        switch step {
        case .cancelled: continuation.resume(throwing: CancellationError())
        case .free: continuation.resume(returning: false)
        case .parked: break
        }
      }
    } onCancel: {
      record { $0.parkedTicks.removeValue(forKey: clock) }?.resume(throwing: CancellationError())
    }
    if !parked { try await Task.sleep(for: .milliseconds(1)) }
    return parked
  }

  static func stopWaiting(_ id: UUID) {
    registry.withLock { $0.waiters[id] = nil }
  }

  static func release(_ key: String) {
    let deliver = registry.withLock { registry -> (@Sendable () -> Void)? in
      if let deliver = registry.held.removeValue(forKey: key) { return deliver }
      registry.released.insert(key)
      return nil
    }
    deliver?()
  }

  private static func hold(_ key: String, _ deliver: @escaping @Sendable () -> Void) {
    let releasedEarly = registry.withLock { registry -> Bool in
      if registry.released.remove(key) != nil { return true }
      registry.held[key] = deliver
      return false
    }
    if releasedEarly { DispatchQueue.global().async(execute: deliver) }
  }

  private func load(_ text: String, key: String, finish: Bool) {
    guard !isStopped.withLock({ $0 }) else { return }
    client?.urlProtocol(self, didLoad: Data(text.utf8))
    if finish { client?.urlProtocolDidFinishLoading(self) }
    Self.record { $0.log.loaded[key, default: 0] += 1 }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let host = request.url!.host!
    let path = request.url!.path
    let key = host + path
    let count = Self.record { registry in
      registry.log.received[key, default: 0] += 1
      return registry.log.received[key]!
    }
    var status = 200
    var held = false
    var body = "{}"
    var contentType = "application/json"
    switch path {
    case "/api/runs/active":
      body = host.hasPrefix("replay") ? #"{"runId":null}"# : #"{"runId":"run"}"#
      if host.hasPrefix("active-failure"), count > 1 { status = 503 }
      if host.hasPrefix("overlap"), count > 1 {
        body = #"{"runId":"run","queued":[{"runId":"next","text":"Next"}]}"#
      }
      if host.hasPrefix("overlap-completing"), count == 2 { held = true }
    case "/api/turn":
      body = #"{"status":"ok","reply":"Answer"}"#
      if host.hasPrefix("overlap") || host.hasPrefix("active-failure") {
        body = #"{"runId":"next","status":"queued"}"#
      }
      if host.hasPrefix("accepted") { body = #"{"runId":"run","status":"queued"}"# }
    case "/api/runs/run/events":
      contentType = "text/event-stream"
      if host.hasPrefix("overlap"), count == 1 { held = true }
      if host.hasPrefix("reconnect-stall"), count > 1 { held = true }
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
      if count > 1, host.hasPrefix("failure") || host.hasPrefix("replay-failure") { status = 503 }
      if count == 2, ["idle", "replay-failure", "delayed"].contains(where: host.hasPrefix) {
        held = true
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
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Still writing\",\"status\":\"running\"}}\n\n",
        key: key, finish: false)
      return
    }
    if host.hasPrefix("stream-burst"), path.hasSuffix("/events") {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      let burst = (0..<200).map {
        "data: {\"type\":\"CUSTOM\",\"name\":\"delta\",\"value\":{\"offset\":\($0),\"delta\":\"x\"}}\n\n"
      }.joined()
      load(burst, key: key, finish: false)
      Self.hold("\(key)#\(count)") { [self] in
        load(
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"result\":{\"status\":\"ok\",\"reply\":\"Complete\"}}}\n\n",
          key: key, finish: true)
      }
      return
    }
    let responseBody = body
    let respond: @Sendable () -> Void = { [self] in
      guard !isStopped.withLock({ $0 }) else { return }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      load(responseBody, key: key, finish: true)
    }
    if held {
      Self.hold("\(key)#\(count)", respond)
    } else {
      DispatchQueue.global().async(execute: respond)
    }
  }
  override func stopLoading() {
    isStopped.withLock { $0 = true }
    let key = request.url!.host! + request.url!.path
    Self.record { $0.log.stopped[key, default: 0] += 1 }
  }
}

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
    let answer = Sighting()
    let invariant = watch {
      guard chatMessages(chat.entries).contains(where: { $0.role == "assistant" }) else { return }
      answer.seen = true
      XCTAssertEqual(chat.displayedPartial, "")
      XCTAssertNil(chat.activeRunID)
    }
    defer { invariant.stop() }
    await chat.resume()
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertTrue(chatMessages(chat.entries).contains { $0.role == "assistant" })
    XCTAssertEqual(chat.displayedPartial, "")
    XCTAssertNil(chat.activeRunID)
    release(chat, "/api/sessions/chat/approvals", 2)
    await stub { $0.loaded[approvals] == 2 }
    XCTAssertTrue(answer.seen)
    XCTAssertEqual(chatMessages(chat.entries).filter { $0.role == "assistant" }.count, 1)
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
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
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
    let approvals = key(chat, "/api/sessions/chat/approvals")
    await stub { $0.received[approvals] == 2 }
    XCTAssertEqual(chat.entries.count, 2)
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
    await until { chat.entries.count == 2 }
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
