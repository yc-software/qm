import Foundation
import os

final class DemoWorkspace: URLProtocol, @unchecked Sendable {
  static let origin = URL(string: "https://demo.qm.invalid")!
  static let user = "demo"

  static var configuration: URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DemoWorkspace.self]
    return configuration
  }

  private static let state = OSAllocatedUnfairLock(initialState: DemoState())

  static func reset() { state.withLock { $0 = DemoState() } }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let request = request
    let reply = Self.state.withLock { $0.reply(to: request) }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: reply.status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: reply.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

struct DemoState: Sendable {
  struct Reply: Sendable {
    var status = 200
    let body: Data

    init(status: Int = 200, _ value: some Encodable) {
      self.status = status
      body = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
    }
  }

  private struct Entry: Encodable, Sendable {
    struct Body: Encodable, Sendable {}
    let kind: String
    let seq: Int
    let createdAt: Double
    let text: String
    var turnId: String?
    let body = Body()
  }

  private struct Failure: Encodable {
    let error: String
    let message: String
  }
  private struct Me: Encodable {
    let user = DemoWorkspace.user
    let displayName = "Demo"
    let companyName = "QM demo"
    let permissions: [String] = []
  }
  private struct Sessions: Encodable { let sessions: [Conversation] }
  private struct Session: Encodable { let session: Conversation }
  private struct History: Encodable {
    let items: [Entry]
    let session: Conversation
  }
  private struct Turn: Encodable {
    let runId: String
    let status = "ok"
    let reply: String
  }
  private struct Empty: Encodable {}
  private struct Sample {
    let id: String
    let title: String
    let pinned: Bool
    let hoursAgo: Double
    let ask: String
    let answer: String
  }
  private struct Approvals: Encodable { let approvals: [String] = [] }
  private struct Contexts: Encodable { let contexts: [String] = [] }

  static let scriptedReply =
    "This is the QM demo, so this reply is scripted and nothing you typed left this device. "
    + "Connect your own QM workspace to get real answers, with QM working across your tools."

  private var conversations: [Conversation] = []
  private var entries: [String: [Entry]] = [:]
  private var turns = 0

  init() {
    let now = Date()
    let samples = [
      Sample(
        id: "demo-welcome", title: "What can I do in this demo?", pinned: false, hoursAgo: 0.2,
        ask: "What can I do in this demo?",
        answer: """
          This is a sample workspace that lives entirely on this device. You can:

          - Open the sample conversations and read through them
          - Start a new conversation and send a message; replies here are scripted
          - Pin, rename or archive a conversation

          Nothing you type leaves this device. To work with a real agent, sign out of the demo \
          and connect your own QM workspace.
          """
      ),
      Sample(
        id: "demo-offsite", title: "Plan the team offsite agenda", pinned: true, hoursAgo: 5,
        ask: "Draft a one-day agenda for our team offsite. Eight people, focused on next quarter.",
        answer: """
          Here is a one-day agenda for eight people:

          **Morning**
          - 9:30 Arrivals and coffee
          - 10:00 Last quarter in review: what worked and what didn't
          - 11:15 Priorities for next quarter, in two groups of four

          **Afternoon**
          - 13:30 Groups report back and the team picks three priorities
          - 15:00 An owner and a first milestone for each priority
          - 16:30 Wrap-up and open questions

          I can turn this into a calendar invite or adjust the timings.
          """
      ),
      Sample(
        id: "demo-support", title: "Summarize this week's support requests", pinned: false,
        hoursAgo: 28, ask: "What were the main themes in support requests this week?",
        answer: """
          Three themes stood out in this sample data:

          1. **Sign-in problems** after the password policy change
          2. **Export delays** on large reports
          3. **Billing questions** about the annual plan

          Sign-in problems were the most common. I can draft a help article for them.
          """
      ),
    ]
    for sample in samples {
      let at = now.addingTimeInterval(-sample.hoursAgo * 3600).timeIntervalSince1970 * 1000
      conversations.append(
        Conversation(
          id: sample.id, scopeId: "personal:\(DemoWorkspace.user)",
          threadRef: "web:\(DemoWorkspace.user):\(sample.id)", surface: "web", canContinue: true,
          title: sample.title, lastActivityAt: at, pinned: sample.pinned))
      entries[sample.id] = [
        Entry(kind: "UserMessage", seq: 1, createdAt: at - 60_000, text: sample.ask),
        Entry(kind: "AgentMessage", seq: 2, createdAt: at, text: sample.answer),
      ]
    }
  }

  mutating func reply(to request: URLRequest) -> Reply {
    guard let url = request.url else { return unavailable }
    let method = request.httpMethod ?? "GET"
    let path = url.path.split(separator: "/").map(String.init)
    let query = Dictionary(
      (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map {
        ($0.name, $0.value ?? "")
      }, uniquingKeysWith: { $1 })
    var body: [String: Any] {
      (try? JSONSerialization.jsonObject(with: request.bodyData) as? [String: Any]) ?? [:]
    }
    switch (method, path.count) {
    case ("GET", 1) where path == ["me"]: return Reply(Me())
    case ("GET", 2) where path == ["api", "contexts"]: return Reply(Contexts())
    case ("GET", 2) where path == ["api", "sessions"]: return Reply(Sessions(sessions: list(query)))
    case ("GET", 3) where path == ["api", "runs", "active"]: return Reply(Empty())
    case ("POST", 2) where path == ["api", "turn"]: return turn(body)
    case ("GET", 3) where path.starts(with: ["api", "sessions"]): return history(path[2])
    case ("POST", 3) where path.starts(with: ["api", "sessions"]): return update(path[2], body)
    case ("GET", 4) where path.starts(with: ["api", "sessions"]) && path[3] == "approvals":
      return Reply(Approvals())
    default: return unavailable
    }
  }

  private var unavailable: Reply {
    Reply(
      status: 403,
      Failure(
        error: "demo", message: "This isn’t available in the demo. Connect a workspace to use it.")
    )
  }

  private func list(_ query: [String: String]) -> [Conversation] {
    let search = query["q"] ?? ""
    let filter =
      ConversationFilter.allCases.first { $0.rawValue.lowercased() == query["status"] } ?? .active
    return conversations.filter(filter.includes)
      .filter { search.isEmpty || ($0.title ?? "").localizedCaseInsensitiveContains(search) }
      .sorted { ($0.lastActivityAt ?? 0) > ($1.lastActivityAt ?? 0) }
  }

  private func history(_ id: String) -> Reply {
    guard let session = conversations.first(where: { $0.id == id }) else { return unavailable }
    return Reply(History(items: entries[id] ?? [], session: session))
  }

  private mutating func update(_ id: String, _ patch: [String: Any]) -> Reply {
    guard let index = conversations.firstIndex(where: { $0.id == id }) else { return unavailable }
    if let title = patch["title"] as? String { conversations[index].title = title }
    if let pinned = patch["pinned"] as? Bool { conversations[index].pinned = pinned }
    if let archived = patch["archived"] as? Bool { conversations[index].archived = archived }
    if let unread = patch["unread"] as? Bool { conversations[index].unread = unread }
    if patch.keys.contains("color") { conversations[index].color = patch["color"] as? String }
    return Reply(Session(session: conversations[index]))
  }

  private mutating func turn(_ body: [String: Any]) -> Reply {
    guard let thread = body["threadRef"] as? String, let text = body["text"] as? String,
      let id = thread.split(separator: ":").last
    else { return unavailable }
    let now = Date().timeIntervalSince1970 * 1000
    let index: Int
    if let existing = conversations.firstIndex(where: { $0.threadRef == thread }) {
      index = existing
    } else {
      conversations.append(
        Conversation(
          id: String(id), scopeId: body["scopeId"] as? String ?? "personal:\(DemoWorkspace.user)",
          threadRef: thread, surface: "web", canContinue: true, title: String(text.prefix(60))))
      index = conversations.endIndex - 1
    }
    let session = conversations[index].id
    turns += 1
    let run = "demo-run-\(turns)"
    let next = (entries[session]?.last?.seq ?? 0) + 1
    entries[session, default: []] += [
      Entry(kind: "UserMessage", seq: next, createdAt: now, text: text, turnId: run),
      Entry(
        kind: "AgentMessage", seq: next + 1, createdAt: now, text: Self.scriptedReply, turnId: run),
    ]
    conversations[index].lastActivityAt = now
    return Reply(Turn(runId: run, reply: Self.scriptedReply))
  }
}
