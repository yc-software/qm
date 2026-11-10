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
    #"{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Question","runId":"run"}}"#

  private static func reply(host: String, path: String, count: Int, url: URL) -> Reply {
    if path == "/api/runs/run", host.hasPrefix("lifecycle-terminal-activity") {
      let activity =
        host.hasPrefix("lifecycle-terminal-activity-empty")
        ? #","activity":[]"#
        : host.hasPrefix("lifecycle-terminal-activity-omitted")
          ? ""
          : #","activity":[{"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"execute","callId":"check"}},{"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"check","ok":true}},{"type":"text","seq":4,"createdAt":4,"payload":{"text":"Final update","phase":"commentary"}}]"#
      return Reply(
        body: #"{"status":"done","attempt":1,"result":{"status":"ok","reply":"Answer"}"#
          + activity + "}")
    }
    var reply =
      switch path {
      case "/api/runs/active": activeRunReply(host: host, count: count)
      case "/api/turn": turnReply(host: host)
      case "/api/runs/run/events": eventsReply(host: host, count: count)
      case "/api/runs/run":
        if host.hasPrefix("lifecycle-terminal-lookup-race")
          || host.hasPrefix("lifecycle-unmonitored-rejection")
        {
          Reply(
            status: 404, body: #"{"message":"This run can no longer be accessed."}"#,
            held: host.hasPrefix("lifecycle-terminal-lookup-race"))
        } else if host.hasPrefix("lifecycle-still-running") {
          Reply(
            body: #"{"status":"running","attempt":1,"result":null,"partial":"Current response"}"#)
        } else if host.hasPrefix("lifecycle-resume-failure")
          || host.hasPrefix("lifecycle-completed")
        {
          Reply(body: #"{"status":"done","attempt":1,"result":{"status":"ok","reply":"Answer"}}"#)
        } else {
          Reply(status: 503, body: #"{"message":"Terminal SSE should not need polling"}"#)
        }
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
    if host.hasPrefix("lifecycle-accepted"), count == 1 {
      return Reply(body: #"{"runId":null,"run":null}"#)
    }
    if host.hasPrefix("lifecycle-resume-failure")
      || host.hasPrefix("lifecycle-unmonitored-rejection")
    {
      if count == 2 {
        return Reply(status: 503, body: #"{"message":"Active lookup unavailable"}"#)
      }
      if count > 2 { return Reply(body: #"{"runId":null,"run":null}"#) }
    }
    if host.hasPrefix("lifecycle-stale-resume"), count == 1 {
      return Reply(
        status: 503, body: #"{"message":"Superseded active lookup failed"}"#, held: true)
    }
    if count > 1,
      host.hasPrefix("lifecycle-completed") || host.hasPrefix("lifecycle-still-running")
    {
      return Reply(body: #"{"runId":null,"run":null}"#)
    }
    var reply = Reply(body: host.hasPrefix("replay") ? #"{"runId":null}"# : #"{"runId":"run"}"#)
    if host.hasPrefix("active-failure"), count > 1 { reply.status = 503 }
    if host.hasPrefix("overlap"), count > 1 {
      reply.body = #"{"runId":"run","queued":[{"runId":"next","text":"Next"}]}"#
    }
    if host.hasPrefix("overlap-completing"), count == 2 { reply.held = true }
    return reply
  }

  private static func turnReply(host: String) -> Reply {
    if host.hasPrefix("fork-history-held") {
      return Reply(status: 503, body: #"{"message":"Could not send follow-up."}"#)
    }
    if host.hasPrefix("lifecycle-accepted") {
      return Reply(status: 202, body: #"{"runId":"run","status":"queued"}"#, held: true)
    }
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
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"type\":\"tool_call\",\"seq\":4,\"createdAt\":4,\"payload\":{\"tool\":\"execute\",\"callId\":\"after\"}},{\"type\":\"tool_result\",\"seq\":5,\"createdAt\":5,\"payload\":{\"callId\":\"after\",\"ok\":true}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    if host.hasPrefix("posted-active") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"running\"}}\n\n"
    }
    if host.hasPrefix("activity-lag") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"type\":\"thinking\",\"seq\":2,\"createdAt\":2,\"payload\":{\"thinking\":\"Working through it.\"}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    if host.hasPrefix("phase-finish-held") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"activity\":[{\"type\":\"text\",\"seq\":2,\"createdAt\":2,\"payload\":{\"text\":\"First update\"}},{\"type\":\"thinking\",\"seq\":3,\"createdAt\":3,\"payload\":{\"thinking\":\"Finishing\"}},{\"type\":\"text_start\",\"seq\":3,\"createdAt\":4,\"payload\":{\"streamOffset\":14}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    return reply
  }

  private static func historyReply(host: String, count: Int, url: URL) -> Reply {
    if host.hasPrefix("lifecycle-history-gap") {
      if count == 2 { return Reply(status: 503) }
      let earlier =
        #"{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Earlier question"}},{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Earlier answer"}}"#
      let missed =
        #",{"type":"user","seq":3,"createdAt":3,"payload":{"text":"Missed question"}},{"type":"assistant","seq":4,"createdAt":4,"payload":{"text":"Missed answer"}},{"type":"user","seq":5,"createdAt":5,"payload":{"text":"Current question","runId":"run"}}"#
      return Reply(body: #"{"entries":["# + earlier + (count == 1 ? "" : missed) + "]}")
    }
    if host.hasPrefix("phase-finish-held") {
      return Reply(body: #"{"entries":["# + questionEntry + "]}", held: count == 2)
    }
    if host.hasPrefix("resume-empty") {
      return Reply(body: #"{"entries":["# + questionEntry + "]}")
    }
    if host.hasPrefix("lifecycle-accepted") {
      return Reply(
        body: count == 1 ? #"{"entries":[]}"# : #"{"entries":["# + questionEntry + "]}",
        held: count == 2)
    }
    if host.hasPrefix("lifecycle-stale-resume") || host.hasPrefix("lifecycle-background")
      || host.hasPrefix("lifecycle-still-running")
      || host.hasPrefix("lifecycle-unmonitored-rejection")
      || host.hasPrefix("lifecycle-terminal-activity")
    {
      return Reply(body: #"{"entries":["# + questionEntry + "]}")
    }
    if host.hasPrefix("fork-history") {
      return forkHistoryReply(host: host, count: count, url: url)
    }
    if host.hasPrefix("missing-history") { return Reply(status: 503) }
    if host.hasPrefix("empty-history") { return Reply(body: #"{"entries":[]}"#) }
    if host.hasPrefix("posted-") {
      return Reply(
        status: host.hasPrefix("posted-finish") && count > 1 ? 503 : 200,
        body:
          #"{"entries":["# + questionEntry
          + #",{"type":"tool_call","seq":2,"createdAt":2,"payload":{"action":"post","callId":"post","text":"Answer"}},{"type":"tool_result","seq":3,"createdAt":3,"payload":{"callId":"post","ok":true}}]}"#
      )
    }
    if host.hasPrefix("accepted") {
      return Reply(body: count == 1 ? #"{"entries":[]}"# : #"{"entries":["# + questionEntry + "]}")
    }
    if host.hasPrefix("finish-held") || host.hasPrefix("lifecycle-terminal-lookup-race"),
      count == 2
    {
      return Reply(
        body: #"{"entries":["# + questionEntry
          + #",{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Answer"}}]}"#,
        held: true)
    }
    if count == 1 || host.hasPrefix("active-failure") || host.hasPrefix("activity-lag") {
      return Reply(body: #"{"entries":["# + questionEntry + "]}")
    }
    return Reply(
      body: #"{"entries":["# + questionEntry
        + #",{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Answer"}}]}"#)
  }

  private static func forkHistoryReply(host: String, count: Int, url: URL) -> Reply {
    let before = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .first { $0.name == "beforeSeq" }?.value
    guard before == "6", !(host.hasPrefix("fork-history-retry") && count == 1) else {
      return Reply(status: 503)
    }
    return Reply(
      body:
        #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Inherited question"}},{"type":"assistant","seq":5,"createdAt":5,"payload":{"text":"Inherited answer"}}],"earlierEntries":0}"#,
      held: host.hasPrefix("fork-history-held")
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
    if host.hasPrefix("lifecycle-reasoning-deltas"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"running\",\"attempt\":1,\"reasoning\":[{\"step\":\"step\",\"index\":0,\"text\":\"First thought\"}]}}\n\n",
        key: key, finish: false)
      Self.hold("\(key)#\(count)") { [self] in
        let delta = String(repeating: " More reasoning arrives.", count: 30)
        load(
          "data: {\"type\":\"CUSTOM\",\"name\":\"reasoning\",\"value\":{\"step\":\"step\",\"index\":0,\"offset\":13,\"delta\":\"\(delta)\"}}\n\n",
          key: key, finish: false)
      }
      return true
    }
    if host.hasPrefix("resume-empty"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      let snapshot =
        count == 1
        ? #"{"status":"running","attempt":1,"partial":"Already visible"}"#
        : #"{"status":"running","attempt":1,"reasoning":[{"step":"resumed","index":0,"text":"Continuing after resume"}]}"#
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":\(snapshot)}\n\n", key: key,
        finish: false)
      return true
    }
    if host.hasPrefix("reply-complete"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Continuing\",\"status\":\"running\",\"replyComplete\":true,\"result\":null}}\n\ndata: {\"type\":\"CUSTOM\",\"name\":\"reasoning\",\"value\":{\"step\":\"next\",\"index\":0,\"offset\":0,\"delta\":\"Checking another issue\"}}\n\n",
        key: key, finish: false)
      Self.hold("\(key)#\(count)") { [self] in
        load(Self.doneEvent, key: key, finish: true)
      }
      return true
    }
    if host.hasPrefix("lifecycle-"), path == "/api/runs/run/events" {
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      let partial =
        host.hasPrefix("lifecycle-background") && count == 1
        ? "Before background" : "Current response"
      let activity =
        host.hasPrefix("lifecycle-terminal-activity")
        ? #","activity":[{"type":"tool_call","seq":2,"createdAt":2,"payload":{"tool":"execute","callId":"check"}}]"#
        : ""
      load(
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"\(partial)\",\"status\":\"running\",\"attempt\":1,\"result\":null\(activity)}}\n\n",
        key: key, finish: false)
      if host.hasPrefix("lifecycle-background") || host.hasPrefix("lifecycle-terminal-lookup-race"),
        count == 1
      {
        Self.hold("\(key)#\(count)") { [self] in
          load(Self.doneEvent, key: key, finish: true)
        }
      }
      return true
    }
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
