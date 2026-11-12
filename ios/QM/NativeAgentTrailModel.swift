import Foundation

struct NativeAgentBranch: Identifiable, Equatable {
  enum State: String {
    case working = "Working"
    case waiting = "Needs attention"
    case failed = "Failed"
    case returned = "Done"

    var symbol: String {
      switch self {
      case .working: "circle.inset.filled"
      case .waiting: "exclamationmark.circle"
      case .failed: "exclamationmark.triangle"
      case .returned: "checkmark"
      }
    }
  }

  let conversation: Conversation
  let depth: Int
  let parentName: String?
  var id: String { conversation.id }
  var name: String { Self.name(conversation) }
  var state: State {
    if conversation.awaitingInput == true { return .waiting }
    if conversation.working == true { return .working }
    return conversation.lastTurnFailed == true ? .failed : .returned
  }

  static func name(_ conversation: Conversation) -> String {
    for value in [conversation.title, conversation.purpose] {
      if let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
        return text
      }
    }
    return "Agent"
  }

  static func rows(_ sessions: [Conversation], rootID: String) -> [Self] {
    var unique = Set([rootID])
    let sessions = sessions.filter { unique.insert($0.id).inserted }
    let byID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
    let children = Dictionary(grouping: sessions) { $0.parentSessionId ?? rootID }
    let roots = sessions.filter {
      $0.parentSessionId == rootID || byID[$0.parentSessionId ?? ""] == nil
    }
    var seen = Set<String>()
    var result: [Self] = []
    for root in roots + sessions where !seen.contains(root.id) {
      var stack = [(root, 1)]
      while let (session, depth) = stack.popLast() {
        guard seen.insert(session.id).inserted else { continue }
        let parentName = session.parentSessionId.flatMap { parent in
          parent == rootID ? nil : byID[parent].map(Self.name) ?? "another agent"
        }
        result.append(.init(conversation: session, depth: depth, parentName: parentName))
        stack.append(contentsOf: (children[session.id] ?? []).reversed().map { ($0, depth + 1) })
      }
    }
    return result
  }

  static func current(
    _ rows: [Self], since promptStartedAt: Double? = nil
  ) -> [Self] {
    rows.filter { branch in
      if branch.state == .working || branch.state == .waiting { return true }
      guard let promptStartedAt,
        let lastActivityAt = branch.conversation.lastActivityAt
      else { return false }
      return lastActivityAt >= promptStartedAt
    }
  }

  static func pendingLaunches(_ activity: [NativeWorkItem], listed: [Self]) -> [NativeWorkItem] {
    let listedIDs = Set(listed.map(\.id))
    return activity.filter { item in
      guard item.entry.type == "tool_call", item.opensAgents,
        item.entry.payload?.action == "open"
      else { return false }
      switch item.state(active: true) {
      case .running:
        return true
      case .complete:
        return item.agentSessionID.map { !listedIDs.contains($0) } ?? false
      case .failed, .approval, .unconfirmed:
        return false
      }
    }
  }
}

@MainActor @Observable
final class NativeAgentTrailModel {
  private(set) var branches: [NativeAgentBranch] = []
  private(set) var updatedAt: Date?
  private(set) var error: String?
  var loading: Bool { loader.loading }
  var stale: Bool { error != nil }
  private let client: APIClient
  private let conversationID: String
  private let generation: UUID
  private let loader = LoadGuard()

  init(client: APIClient, conversationID: String) {
    self.client = client
    self.conversationID = conversationID
    generation = client.generation
  }

  func refresh() async {
    guard client.generation == generation else {
      branches = []
      updatedAt = nil
      error = nil
      return
    }
    await loader.run {
      try await client.fetch("api/sessions/\(conversationID.apiComponent)/children")
        as ConversationList
    } apply: { response in
      guard client.generation == generation else { return }
      branches = NativeAgentBranch.rows(response.sessions, rootID: conversationID)
      updatedAt = .now
      error = nil
    } failed: { failure in
      guard client.generation == generation else {
        branches = []
        updatedAt = nil
        error = nil
        return
      }
      error = failure.localizedDescription
    }
  }

}
