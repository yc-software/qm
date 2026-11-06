import Foundation
import os

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

  private struct Reply {
    var status = 200
    var body = "{}"
    var contentType = "application/json"
    var held = false
  }

  private static let doneEvent =
    "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
  private static let questionEntry =
    #"{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Question","turnId":"run","body":{}}"#

  private static func reply(host: String, path: String, count: Int, url: URL) -> Reply {
    var reply =
      switch path {
      case "/api/runs/active": activeRunReply(host: host, count: count)
      case "/api/turn": turnReply(host: host)
      case "/api/runs/run/events": eventsReply(host: host, count: count)
      case "/api/runs/run":
        Reply(status: 503, body: #"{"message":"Terminal SSE should not need polling"}"#)
      case "/api/sessions/chat": historyReply(host: host, count: count, url: url)
      case "/api/sessions/chat/approvals": approvalsReply(host: host, count: count)
      default: Reply()
      }
    if host.hasPrefix("reconnect-stall") {
      if path.hasSuffix("/events") {
        reply.body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Old\",\"status\":\"running\"}}\n\n"
      } else if path == "/api/runs/run" {
        reply.status = 200
        reply.body = #"{"status":"running","partial":"Newer recovered text"}"#
      }
    }
    return reply
  }

  private static func activeRunReply(host: String, count: Int) -> Reply {
    var reply = Reply(body: host.hasPrefix("replay") ? #"{"runId":null}"# : #"{"runId":"run"}"#)
    if host.hasPrefix("active-failure"), count > 1 { reply.status = 503 }
    if host.hasPrefix("overlap"), count > 1 {
      reply.body = #"{"runId":"run","queued":[{"runId":"next","text":"Next"}]}"#
    }
    if host.hasPrefix("overlap-completing"), count == 2 { reply.held = true }
    return reply
  }

  private static func turnReply(host: String) -> Reply {
    if host.hasPrefix("overlap") || host.hasPrefix("active-failure") {
      return Reply(body: #"{"runId":"next","status":"queued"}"#)
    }
    if host.hasPrefix("accepted") { return Reply(body: #"{"runId":"run","status":"queued"}"#) }
    return Reply(body: #"{"status":"ok","reply":"Answer"}"#)
  }

  private static func eventsReply(host: String, count: Int) -> Reply {
    var reply = Reply(body: doneEvent, contentType: "text/event-stream")
    if host.hasPrefix("overlap"), count == 1 { reply.held = true }
    if host.hasPrefix("reconnect-stall"), count > 1 { reply.held = true }
    if host.hasPrefix("posted-finish") || host.hasPrefix("posted-lag") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"item\":{\"kind\":\"ToolCall\",\"seq\":4,\"createdAt\":4,\"callId\":\"after\",\"tool\":\"execute\",\"body\":{}}},{\"item\":{\"kind\":\"ToolResult\",\"seq\":5,\"createdAt\":5,\"callId\":\"after\",\"body\":{\"ok\":true}}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    if host.hasPrefix("posted-active") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"running\"}}\n\n"
    }
    if host.hasPrefix("activity-lag") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"item\":{\"kind\":\"Reasoning\",\"seq\":2,\"createdAt\":2,\"text\":\"Working through it.\",\"body\":{}}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    return reply
  }

  private static func historyReply(host: String, count: Int, url: URL) -> Reply {
    if host.hasPrefix("fork-history") {
      return forkHistoryReply(host: host, count: count, url: url)
    }
    if host.hasPrefix("missing-history") { return Reply(status: 503) }
    if host.hasPrefix("empty-history") { return Reply(body: #"{"items":[]}"#) }
    if host.hasPrefix("posted-") {
      return Reply(
        status: host.hasPrefix("posted-finish") && count > 1 ? 503 : 200,
        body:
          #"{"items":["# + questionEntry
          + #",{"kind":"ToolCall","seq":2,"createdAt":2,"callId":"post","body":{"action":"post","text":"Answer"}},{"kind":"ToolResult","seq":3,"createdAt":3,"callId":"post","body":{"ok":true}}]}"#
      )
    }
    if host.hasPrefix("accepted") {
      return Reply(body: count == 1 ? #"{"items":[]}"# : #"{"items":["# + questionEntry + "]}")
    }
    if count == 1 || host.hasPrefix("active-failure") || host.hasPrefix("activity-lag") {
      return Reply(body: #"{"items":["# + questionEntry + "]}")
    }
    return Reply(
      body: #"{"items":["# + questionEntry
        + #",{"kind":"AgentMessage","seq":2,"createdAt":2,"text":"Answer","body":{}}]}"#)
  }

  private static func forkHistoryReply(host: String, count: Int, url: URL) -> Reply {
    let before = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .first { $0.name == "beforeSeq" }?.value
    guard before == "6", !(host.hasPrefix("fork-history-retry") && count == 1) else {
      return Reply(status: 503)
    }
    return Reply(
      body:
        #"{"items":[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Inherited question","body":{}},{"kind":"AgentMessage","seq":5,"createdAt":5,"text":"Inherited answer","body":{}}],"earlierItems":0}"#
    )
  }

  private static func approvalsReply(host: String, count: Int) -> Reply {
    var reply = Reply(body: #"{"approvals":[]}"#)
    if count > 1, host.hasPrefix("failure") || host.hasPrefix("replay-failure") {
      reply.status = 503
    }
    if count == 2, ["idle", "replay-failure", "delayed"].contains(where: host.hasPrefix) {
      reply.held = true
    }
    return reply
  }

  private func streamWithoutFinishing(
    host: String, path: String, response: HTTPURLResponse, key: String, count: Int
  ) -> Bool {
    if host.hasPrefix("active-failure"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Still writing\",\"status\":\"running\"}}\n\n",
        key: key, finish: false)
      return true
    }
    guard host.hasPrefix("stream-burst"), path.hasSuffix("/events") else { return false }
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
    return true
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let url = request.url!
    let host = url.host!
    let path = url.path
    let key = host + path
    let count = Self.record { registry in
      registry.log.received[key, default: 0] += 1
      return registry.log.received[key]!
    }
    let reply = Self.reply(host: host, path: path, count: count, url: url)
    let response = HTTPURLResponse(
      url: url, statusCode: reply.status, httpVersion: nil,
      headerFields: ["Content-Type": reply.contentType])!
    if streamWithoutFinishing(host: host, path: path, response: response, key: key, count: count) {
      return
    }
    let respond: @Sendable () -> Void = { [self] in
      guard !isStopped.withLock({ $0 }) else { return }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      load(reply.body, key: key, finish: true)
    }
    if reply.held {
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
