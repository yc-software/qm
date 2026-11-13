import Foundation
import os

struct ChatStubLog: Sendable {
  var received: [String: Int] = [:]
  var loaded: [String: Int] = [:]
  var stopped: [String: Int] = [:]
  var parkedTicks: [String: Int] = [:]
  var bodies: [String: [String]] = [:]
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
  private static let refusedEvent =
    "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"result\":{\"status\":\"refused\",\"reason\":\"Ask an admin for access.\"}}}\n\n"
  private static let stoppedEvent =
    "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"result\":{\"status\":\"ok\",\"reply\":\"(stopped)\",\"stopped\":true}}}\n\n"
  private static let questionEntry =
    #"{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Question","body":{}}"#

  private static let swarmRoot = #"{"id":"root","depth":0,"state":"ready"}"#
  private static let swarmWorkers =
    #"{"id":"worker-one","parentId":"root","depth":1,"state":"ready"},{"id":"worker-two","parentId":"root","depth":1,"state":"ready","control":"paused"},{"id":"worker-three","parentId":"worker-two","depth":2,"state":"reserved"}"#

  private static func session(host: String) -> String {
    let fork =
      host.hasPrefix("fork-history")
      ? #","forkedFrom":{"sessionId":"source","title":"Original"},"forkBoundarySeq":5"# : ""
    return
      #"{"id":"chat","scopeId":"personal:test","threadRef":"web:test:chat","surface":"web","canContinue":true"#
      + fork + "}"
  }

  private static func page(_ reply: Reply, host: String, count: Int) -> Reply {
    guard reply.body.hasPrefix(#"{"items""#) else { return reply }
    var reply = reply
    var fields = #""session":"# + session(host: host)
    if host.hasPrefix("goal-page"), count != 3 {
      fields +=
        #","goal":{"objective":"Ship the release","status":""#
        + (count == 2 ? "paused" : "active") + #"","createdAt":1,"updatedAt":2}"#
    }
    reply.body = "{" + fields + "," + String(reply.body.dropFirst())
    return reply
  }

  private static func parityReply(host: String, path: String, method: String) -> Reply? {
    if path.hasPrefix("/api/keychain/approvals/") {
      return Reply(
        body: host.hasPrefix("credential-pending")
          ? #"{"ask":{"status":"pending"}}"# : #"{"ask":{"status":"approved"}}"#)
    }
    switch path {
    case "/api/approvals/approval": return Reply(body: #"{"status":"ok","reply":"Done"}"#)
    case "/api/sessions/chat/goal/cancel":
      if host.hasPrefix("goal-busy") {
        return Reply(status: 409, body: #"{"error":"busy","message":"Still finishing a reply."}"#)
      }
      if host.hasPrefix("goal-gone") {
        return Reply(status: 409, body: #"{"error":"no_open_goal"}"#)
      }
      return Reply(body: #"{"cancelled":true}"#)
    case "/api/sessions/chat/swarm":
      if method == "POST" {
        if host.hasPrefix("swarm-refused") {
          return Reply(status: 400, body: #"{"error":"stopped workers cannot be resumed"}"#)
        }
        return Reply(
          body: #"{"member":{"id":"worker-one","depth":1,"state":"ready","control":"paused"}}"#,
          held: host.hasPrefix("swarm-held"))
      }
      if host.hasPrefix("swarm-missing") {
        return Reply(status: 400, body: #"{"error":"swarm not found"}"#)
      }
      let peers = host.hasPrefix("swarm-empty") ? swarmRoot : swarmRoot + "," + swarmWorkers
      return Reply(body: #"{"id":"root","self":"# + swarmRoot + #","peers":["# + peers + "]}")
    case "/api/sessions/chat/detach": return Reply(body: #"{"detached":true}"#)
    case "/api/sessions/row": return Reply(body: #"{"session":"# + session(host: host) + "}")
    case "/api/suggested-activities/dismiss":
      return Reply(
        body: host.hasPrefix("dismiss-refused") ? #"{"dismissed":false}"# : #"{"dismissed":true}"#)
    default: return nil
    }
  }

  private static func reply(
    host: String, path: String, count: Int, url: URL, method: String, body: String?
  ) -> Reply {
    if let reply = parityReply(host: host, path: path, method: method) { return reply }
    if path == "/api/runs/run", host.hasPrefix("lifecycle-terminal-activity") {
      let activity =
        host.hasPrefix("lifecycle-terminal-activity-empty")
        ? #","activity":[]"#
        : host.hasPrefix("lifecycle-terminal-activity-omitted")
          ? ""
          : #","activity":[{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"check","tool":"execute","body":{}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"check","body":{"ok":true}},{"seq":4,"createdAt":4,"kind":"AgentMessage","variant":"narration","text":"Final update","body":{"phase":"commentary"}}]"#
      return Reply(
        body: #"{"status":"done","attempt":1,"result":{"status":"ok","reply":"Answer"}"#
          + activity + "}")
    }
    var reply =
      switch path {
      case "/api/runs/active": activeRunReply(host: host, count: count)
      case "/api/turn": turnReply(host: host, body: body)
      case "/api/runs/run/signal":
        if host.hasPrefix("stop-ended") {
          Reply(status: 409, body: #"{"accepted":false,"reason":"terminal"}"#)
        } else if host.hasPrefix("stop-ignored") {
          Reply(status: 409, body: #"{"accepted":false,"reason":"signals_unavailable"}"#)
        } else {
          Reply(body: #"{"accepted":true}"#)
        }
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
      case "/api/sessions/chat":
        page(historyReply(host: host, count: count, url: url), host: host, count: count)
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
    if host.hasPrefix("steered-live"), count < 3 {
      reply.body = #"{"runId":"run","queued":[{"runId":"queued","text":"Change course"}]}"#
    }
    return reply
  }

  private static func turnReply(host: String, body: String?) -> Reply {
    if host.hasPrefix("fork-history-held") {
      return Reply(status: 503, body: #"{"message":"Could not send follow-up."}"#)
    }
    if host.hasPrefix("lifecycle-accepted") {
      return Reply(status: 202, body: #"{"runId":"run","status":"queued"}"#, held: true)
    }
    if host.hasPrefix("overlap") || host.hasPrefix("active-failure") {
      let payload =
        try? JSONSerialization.jsonObject(with: Data((body ?? "").utf8)) as? [String: Any]
      return Reply(
        body: payload?["midTurn"] as? String == "queue"
          ? #"{"runId":"next","status":"queued"}"#
          : #"{"runId":"run","status":"queued","steered":true}"#)
    }
    if host.hasPrefix("accepted") { return Reply(body: #"{"runId":"run","status":"queued"}"#) }
    return Reply(body: #"{"status":"ok","reply":"Answer"}"#)
  }

  private static func eventsReply(host: String, count: Int) -> Reply {
    var reply = Reply(body: doneEvent, contentType: "text/event-stream")
    if host.hasPrefix("outcome-refused") { reply.body = refusedEvent }
    if host.hasPrefix("outcome-stopped") { reply.body = stoppedEvent }
    if host.hasPrefix("overlap"), count == 1 { reply.held = true }
    if host.hasPrefix("reconnect-stall"), count > 1 { reply.held = true }
    if host.hasPrefix("posted-finish") || host.hasPrefix("posted-lag") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"seq\":4,\"createdAt\":4,\"kind\":\"ToolCall\",\"callId\":\"after\",\"tool\":\"execute\",\"body\":{}},{\"seq\":5,\"createdAt\":5,\"kind\":\"ToolResult\",\"callId\":\"after\",\"body\":{\"ok\":true}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    if host.hasPrefix("posted-active") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"running\"}}\n\n"
    }
    if host.hasPrefix("steered-live") {
      reply.held = count == 1
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"running\",\"activity\":[{\"seq\":2,\"createdAt\":2,\"kind\":\"SteeringMessage\",\"turnId\":\"run\",\"externalId\":\"queued-steer:web:test:chat:queued\",\"text\":\"Change course\",\"body\":{}}]}}\n\n"
    }
    if host.hasPrefix("activity-lag") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Answer\",\"status\":\"done\",\"activity\":[{\"seq\":2,\"createdAt\":2,\"kind\":\"Reasoning\",\"text\":\"Working through it.\",\"body\":{}}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    if host.hasPrefix("phase-finish-held") {
      reply.body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"done\",\"activity\":[{\"seq\":2,\"createdAt\":2,\"kind\":\"AgentMessage\",\"variant\":\"narration\",\"text\":\"First update\",\"body\":{}},{\"seq\":3,\"createdAt\":3,\"kind\":\"Reasoning\",\"text\":\"Finishing\",\"body\":{}},{\"seq\":3,\"createdAt\":4,\"marker\":\"text_start\",\"streamOffset\":14}],\"result\":{\"status\":\"ok\",\"reply\":\"Answer\"}}}\n\n"
    }
    return reply
  }

  private static func historyReply(host: String, count: Int, url: URL) -> Reply {
    if host.hasPrefix("outcome-refused") {
      return Reply(body: #"{"items":["# + questionEntry + "]}")
    }
    if host.hasPrefix("outcome-stopped"), count > 1 {
      return Reply(
        body: #"{"items":["# + questionEntry
          + #",{"seq":2,"createdAt":2,"kind":"Stop","body":{"reason":"because you stopped it"}}]}"#
      )
    }
    if host.hasPrefix("lifecycle-history-gap") {
      if count == 2 { return Reply(status: 503) }
      let earlier =
        #"{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Earlier question","body":{}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Earlier answer","body":{}}"#
      let missed =
        #",{"seq":3,"createdAt":3,"kind":"UserMessage","text":"Missed question","body":{}},{"seq":4,"createdAt":4,"kind":"AgentMessage","text":"Missed answer","body":{}},{"seq":5,"createdAt":5,"kind":"UserMessage","turnId":"run","text":"Current question","body":{}}"#
      return Reply(body: #"{"items":["# + earlier + (count == 1 ? "" : missed) + "]}")
    }
    if host.hasPrefix("phase-finish-held") {
      return Reply(body: #"{"items":["# + questionEntry + "]}", held: count == 2)
    }
    if host.hasPrefix("resume-empty") {
      return Reply(body: #"{"items":["# + questionEntry + "]}")
    }
    if host.hasPrefix("lifecycle-accepted") {
      return Reply(
        body: count == 1 ? #"{"items":[]}"# : #"{"items":["# + questionEntry + "]}",
        held: count == 2)
    }
    if host.hasPrefix("lifecycle-stale-resume") || host.hasPrefix("lifecycle-background")
      || host.hasPrefix("lifecycle-still-running")
      || host.hasPrefix("lifecycle-unmonitored-rejection")
      || host.hasPrefix("lifecycle-terminal-activity")
    {
      return Reply(body: #"{"items":["# + questionEntry + "]}")
    }
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
          + #",{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"post","body":{"action":"post","text":"Answer"}},{"seq":3,"createdAt":3,"kind":"ToolResult","callId":"post","body":{"ok":true}}]}"#
      )
    }
    if host.hasPrefix("accepted") {
      return Reply(body: count == 1 ? #"{"items":[]}"# : #"{"items":["# + questionEntry + "]}")
    }
    if host.hasPrefix("finish-held") || host.hasPrefix("lifecycle-terminal-lookup-race"),
      count == 2
    {
      return Reply(
        body: #"{"items":["# + questionEntry
          + #",{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Answer","body":{}}]}"#,
        held: true)
    }
    if count == 1 || host.hasPrefix("active-failure") || host.hasPrefix("activity-lag") {
      return Reply(body: #"{"items":["# + questionEntry + "]}")
    }
    return Reply(
      body: #"{"items":["# + questionEntry
        + #",{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Answer","body":{}}]}"#)
  }

  private static func forkHistoryReply(host: String, count: Int, url: URL) -> Reply {
    let before = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .first { $0.name == "beforeSeq" }?.value
    guard before == "6", !(host.hasPrefix("fork-history-retry") && count == 1) else {
      return Reply(status: 503)
    }
    return Reply(
      body:
        #"{"items":[{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Inherited question","body":{}},{"seq":5,"createdAt":5,"kind":"AgentMessage","text":"Inherited answer","body":{}}],"earlierItems":0}"#,
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
        ? #","activity":[{"seq":2,"createdAt":2,"kind":"ToolCall","callId":"check","tool":"execute","body":{}}]"#
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
    let path = url.path(percentEncoded: true)
    let key = host + path
    let sent = request.bodyData
    let body = sent.isEmpty ? nil : String(decoding: sent, as: UTF8.self)
    let count = Self.record { registry in
      registry.log.received[key, default: 0] += 1
      if let body { registry.log.bodies[key, default: []].append(body) }
      return registry.log.received[key]!
    }
    let reply = Self.reply(
      host: host, path: path, count: count, url: url, method: request.httpMethod ?? "GET",
      body: body)
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
    let key = request.url!.host! + request.url!.path(percentEncoded: true)
    Self.record { $0.log.stopped[key, default: 0] += 1 }
  }
}
