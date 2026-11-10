import Foundation

struct Identity: Decodable {
  let user: String
  let companyName: String?
  let displayName: String?
  var suggestedActivities: [SuggestedActivity]? = nil
  var suggestedActivitiesGeneration: Bool? = nil
  var permissions: [String]? = nil
  var slackWorkspaceUrl: String? = nil
}

struct Conversation: Codable, Identifiable, Hashable {
  struct Status: Codable, Hashable {
    let emoji: String
    let text: String
  }
  struct ForkOrigin: Codable, Hashable {
    let sessionId: String
    let title: String?
    var label: String {
      let name = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      return name.isEmpty ? "another conversation" : name
    }
  }
  let id: String
  let scopeId: String
  let threadRef: String
  var surface: String?
  var canContinue: Bool?
  var title: String?
  var channelName: String?
  var lastActivityAt: Double?
  var working: Bool?
  var awaitingInput: Bool?
  var pinned: Bool?
  var archived: Bool?
  var localOnly: Bool?
  var parentSessionId: String?
  var status: Status?
  var color: String?
  var forkedFrom: ForkOrigin?
  var forkBoundarySeq: Int?

  var isShared: Bool { [.group, .channel].contains(ScopeKind(scopeId: scopeId)) }

  var contextLabel: String? {
    if let channelName, !channelName.isEmpty { return channelName }
    switch ScopeKind(scopeId: scopeId) {
    case .personal: return nil
    case .project: return "Project conversation"
    case .group: return "Group conversation"
    case .channel: return "Slack channel"
    case nil: return "Shared conversation"
    }
  }

  private var slackArchivePath: String? {
    let parts = threadRef.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2 || parts.count == 3, parts[0] == "dm" || parts[0] == "ch",
      !parts[1].isEmpty,
      parts[1].unicodeScalars.allSatisfy({
        $0.isASCII && $0.properties.isAlphabetic || ("0"..."9").contains($0)
      })
    else { return nil }
    guard parts.count == 3 else { return "/archives/\(parts[1])" }
    let stamp = parts[2].split(separator: ".", omittingEmptySubsequences: false)
    guard stamp.count == 2,
      stamp.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy { ("0"..."9").contains($0) } })
    else { return nil }
    return "/archives/\(parts[1])/p\(stamp[0])\(stamp[1])"
  }

  func slackURL(workspaceURL: String?) -> URL? {
    guard let workspaceURL, var components = URLComponents(string: workspaceURL),
      components.scheme == "https", let host = components.host,
      host.hasSuffix(".slack.com"), components.user == nil, components.password == nil,
      components.port == nil, let path = slackArchivePath
    else { return nil }
    components.path = path
    components.query = nil
    components.fragment = nil
    return components.url
  }

  func isInherited(_ message: ChatMessage) -> Bool {
    guard forkedFrom != nil, let forkBoundarySeq, let sequence = message.sequence else {
      return false
    }
    return sequence <= forkBoundarySeq
  }

  var label: String { title?.isEmpty == false ? title! : "New conversation" }
  var canReply: Bool { localOnly == true || canContinue == true }
}

enum ConversationFilter: String, CaseIterable {
  case active = "Active"
  case waiting = "Waiting"
  case archived = "Archived"

  func includes(_ conversation: Conversation) -> Bool {
    if self == .archived { return conversation.archived == true }
    guard conversation.archived != true else { return false }
    return self == .waiting
      ? conversation.awaitingInput == true : conversation.awaitingInput != true
  }
}

struct ConversationList: Decodable { let sessions: [Conversation] }

struct Transcript: Decodable {
  let items: [Item]
  let earlierItems: Int?
  let pins: [NativeConversationPin]?
  let session: Conversation?
}

struct NativeConversationPin: Decodable, Identifiable {
  let id: String
  let text: String?
  let entrySeq: Int?
  let preview: String?
  let addedBy: String
  let createdAt: Double
}

struct Item: Decodable, Identifiable {
  let kind: String
  let createdAt: Double
  let seq: Int?
  let truncated: Bool?
  let turnId: String?
  let callId: String?
  let text: String?
  let tool: String?
  let variant: String?
  let isError: Bool?
  let hidden: Bool?
  let externalId: String?
  let approved: Bool?
  let body: ItemBody?
  let details: NativeActivityValue?
  var id: String { "\(seq ?? -1):\(createdAt):\(kind)" }

  enum CodingKeys: String, CodingKey {
    case kind, createdAt, seq, truncated, turnId, callId, text, tool, variant, isError, hidden,
      externalId, approved, body
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    kind = try c.decode(String.self, forKey: .kind)
    createdAt = try c.decode(Double.self, forKey: .createdAt)
    seq = c.logged(Int.self, forKey: .seq)
    truncated = c.logged(Bool.self, forKey: .truncated)
    turnId = c.logged(String.self, forKey: .turnId)
    callId = c.logged(String.self, forKey: .callId)
    text = c.logged(String.self, forKey: .text)
    tool = c.logged(String.self, forKey: .tool)
    variant = c.logged(String.self, forKey: .variant)
    isError = c.logged(Bool.self, forKey: .isError)
    hidden = c.logged(Bool.self, forKey: .hidden)
    externalId = c.logged(String.self, forKey: .externalId)
    approved = c.logged(Bool.self, forKey: .approved)
    body = c.logged(ItemBody.self, forKey: .body)
    details = Self.fields(try? NativeActivityValue(from: decoder))
  }

  private static func fields(_ item: NativeActivityValue?) -> NativeActivityValue? {
    guard case .object(var values) = item else { return nil }
    let body = values.removeValue(forKey: "body")
    for key in ["sessionId", "seq", "createdAt", "kind", "turnId", "step", "truncated"] {
      values[key] = nil
    }
    values = values.filter { $0.value != .null }
    if case .object(var rest) = body {
      rest["wire"] = nil
      values.merge(rest) { column, _ in column }
    }
    return .object(values)
  }

  var kindTitle: String {
    kind.reduce(into: "") { title, character in
      if character.isUppercase, !title.isEmpty { title.append(" ") }
      title.append(character)
    }
  }
  var isUserMessage: Bool { kind == "UserMessage" || kind == "SteeringMessage" }
  var steered: Bool { kind == "SteeringMessage" }
  var isReply: Bool { kind == "AgentMessage" && variant == nil }
  var isHidden: Bool { hidden == true || body?.hidden == true }
  var messageTs: String? {
    kind == "UserMessage" ? externalId : kind == "SteeringMessage" ? body?.ts : nil
  }
  var succeeded: Bool { isError != true && body?.succeeded != false }
}

struct RunActivity: Decodable { let item: Item? }

struct ItemBody: Decodable {
  struct Display: Decodable { let artifact: NativePlayground? }
  let playground: NativePlayground?
  let display: String?
  let hidden: Bool?
  let attachments: [DeliveredFile]?
  let files: [DeliveredFile]?
  let action: String?
  let ok: Bool?
  let denied: Bool?
  let blocked: String?
  let error: String?
  let name: String?
  let silent: Bool?
  let text: String?
  let redacted: Bool?
  let command: String?
  let scope: String?
  let ts: String?

  enum CodingKeys: String, CodingKey {
    case display, hidden, attachments, files, action, ok, denied, blocked, error, name,
      silent, text, redacted, command, scope, ts
  }

  init(from decoder: Decoder) throws {
    let c = try? decoder.container(keyedBy: CodingKeys.self)
    display = try? c?.decode(String.self, forKey: .display)
    playground = (try? c?.decode(Display.self, forKey: .display))?.artifact
    hidden = c?.logged(Bool.self, forKey: .hidden)
    attachments = c?.logged([DeliveredFile].self, forKey: .attachments)
    files = c?.logged([DeliveredFile].self, forKey: .files)
    action = c?.logged(String.self, forKey: .action)
    ok = c?.logged(Bool.self, forKey: .ok)
    denied = c?.logged(Bool.self, forKey: .denied)
    blocked = c?.logged(String.self, forKey: .blocked)
    error =
      (try? c?.decode(String.self, forKey: .error))
      ?? ((c?.contains(.error) == true && (try? c?.decodeNil(forKey: .error)) != true
        && (try? c?.decode(Bool.self, forKey: .error)) != false) ? "error" : nil)
    name = c?.logged(String.self, forKey: .name)
    silent = c?.logged(Bool.self, forKey: .silent)
    text = c?.logged(String.self, forKey: .text)
    redacted = c?.logged(Bool.self, forKey: .redacted)
    command = c?.logged(String.self, forKey: .command)
    scope = c?.logged(String.self, forKey: .scope)
    ts = c?.logged(String.self, forKey: .ts)
  }

  var succeeded: Bool { ok != false && denied != true && blocked == nil && error == nil }
}

struct NativePlayground: Decodable, Identifiable {
  let kind: String
  let artifactId: String
  let title: String
  var id: String { artifactId }
}

struct DeliveredFile: Decodable {
  let name: String?
  let artifactId: String?
}

struct Approval: Decodable, Identifiable {
  let requestId: String
  let command: String
  let reason: String?
  let purpose: String?
  let summary: String?
  let blocksInput: Bool?
  let grantModes: GrantModes?

  struct GrantModes: Decodable {
    let session: Bool
    let always: Bool
  }
  var id: String { requestId }
  var blocksComposer: Bool { blocksInput != false }
}

struct ApprovalList: Decodable { let approvals: [Approval] }

struct RunInput: Decodable {
  struct Attachment: Decodable {
    let name: String
  }
  let runId: String
  let seq: Int?
  let text: String
  let createdAt: Double
  let attachments: [Attachment]?

  func isRecorded(in items: [Item]) -> Bool {
    items.contains {
      $0.isUserMessage && ($0.turnId == runId || (seq != nil && $0.seq == seq))
    }
  }

  var message: ChatMessage {
    ChatMessage(
      id: "input:\(runId)", role: "user", text: text,
      files: (attachments ?? []).map { DeliveredFile(name: $0.name, artifactId: nil) },
      runID: runId, sequence: seq, createdAt: createdAt)
  }
}

struct ChatRunPresentation: Identifiable {
  let id: String
  var runID: String?
  var input: RunInput?
  var reply: String?
  var finished = false
  var activity: [Item] = []
}

func presentedChatMessages(
  _ items: [Item], runs: [ChatRunPresentation], activeRunID: String?,
  queuedRunIDs: Set<String> = []
) -> [ChatMessage] {
  var messages = chatMessages(items)
  for run in runs {
    if let input = run.input, !input.isRecorded(in: items), !queuedRunIDs.contains(run.id),
      run.finished || activeRunID == nil || activeRunID == run.runID
    {
      let position =
        input.seq.flatMap { sequence in
          messages.firstIndex { ($0.sequence ?? Int.min) > sequence }
        } ?? messages.endIndex
      messages.insert(input.message, at: position)
    }
    let replyRecorded = run.runID.map { hasRecordedRunReply(items, runID: $0) } ?? false
    var seen = Set(messages.filter { $0.runID == run.runID }.flatMap(\.activity).map(\.id))
    let remainingActivity = run.activity.filter {
      NativeWorkItem.supports($0) && seen.insert($0.id).inserted
    }
    if run.finished, replyRecorded, let runID = run.runID,
      let index = messages.lastIndex(where: { $0.runID == runID && $0.role == "assistant" })
    {
      messages[index].activity += remainingActivity
      messages[index].activity.sort { ($0.seq ?? Int.max) < ($1.seq ?? Int.max) }
    }
    if let reply = run.reply, !reply.isEmpty, !replyRecorded {
      let position =
        run.runID.flatMap { id in
          messages.lastIndex { $0.runID == id }.map { $0 + 1 }
        } ?? messages.endIndex
      messages.insert(
        ChatMessage(
          id: "reply:\(run.id)", role: "assistant", text: reply, runID: run.runID,
          activity: remainingActivity),
        at: position)
    }
  }
  return messages
}

struct Run: Decodable {
  let status: String
  let partial: String?
  let result: RunResult?
  var replyComplete: Bool? = nil
  var input: RunInput? = nil
  var activity: [RunActivity]? = nil
  var activityItems: [Item]? { activity?.compactMap(\.item) }
  var isFinished: Bool {
    status == "done" || status == "failed" || result != nil || replyComplete == true
  }
  var failure: String? {
    if status == "failed" || result?.status == "failed" || result?.status == "refused" {
      return result?.reason ?? "The task could not be completed."
    }
    return nil
  }
}

struct SubagentMail {
  let sessionID: String
  let title: String
  let kind: String

  init?(text: String?) {
    guard let text,
      let match = text.prefixMatch(
        of: /^<wake reason="subagent" name="([^"]*)" sessionId="([^"]+)" kind="([^"]+)"/)
    else { return nil }
    sessionID = Self.unescaped(String(match.2))
    let name = Self.unescaped(String(match.1)).trimmingCharacters(in: .whitespacesAndNewlines)
    title = name.isEmpty ? "Subagent" : name
    kind = String(match.3)
  }

  private static func unescaped(_ value: String) -> String {
    value.replacingOccurrences(of: "&quot;", with: "\"")
      .replacingOccurrences(of: "&lt;", with: "<")
      .replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "&amp;", with: "&")
  }

  var status: String {
    switch kind {
    case "final_answer": "finished"
    case "no_reply": "finished without a reply"
    case "awaiting_input": "needs an approval"
    case "errored": "failed"
    case "refused": "was refused"
    default: kind.replacingOccurrences(of: "_", with: " ")
    }
  }
}

enum ChatNotice {
  case approval(approved: Bool, command: String, scope: String?)
  case revision(action: String, speaker: String?, text: String)
  case subagent(SubagentMail)
}

struct ChatMessage: Identifiable {
  let id: String
  let role: String
  var text: String
  var files: [DeliveredFile] = []
  var referencedFiles: [DeliveredFile] = []
  var playgrounds: [NativePlayground] = []
  var speaker: String?
  var runID: String?
  var sequence: Int?
  var createdAt: Double?
  var activity: [Item] = []
  var steered = false
  var slackTimestamp: String?
  var edited = false
  var deleted = false
  var notice: ChatNotice?
}

func chatMessages(_ items: [Item]) -> [ChatMessage] {
  var builder = ChatMessageBuilder()
  for entry in items { builder.add(entry) }
  return builder.messagesWithReferences()
}

private struct ChatMessageBuilder {
  var messages: [ChatMessage] = []
  var posts: [String: Item] = [:]
  var posted = false
  var lastText = ""
  var silent = false
  var playgroundIDs = Set<String>()
  var currentRunID: String?
  var activity: [Item] = []
  var turnStart = 0

  mutating func add(_ item: Item) {
    let messageCount = messages.count
    if item.isUserMessage, !item.steered || item.turnId != nil {
      currentRunID = item.turnId
    }
    if NativeWorkItem.supports(item) { activity.append(item) }
    switch item.kind {
    case "UserMessage", "SteeringMessage": addUser(item)
    case "AgentMessage":
      switch item.variant {
      case "narration": lastText = item.text ?? ""
      case "files_delivered": addDelivery(item)
      default: addAssistant(item)
      }
    case "ToolCall":
      if item.body?.action == "post", let callID = item.callId { posts[callID] = item }
    case "ToolResult": addToolResult(item)
    case "ElicitationResponse":
      if let approved = item.approved, let command = item.body?.command {
        messages.append(
          ChatMessage(
            id: item.id, role: "notice", text: "",
            notice: .approval(approved: approved, command: command, scope: item.body?.scope)))
      }
    case "Retraction": addRetraction(item)
    case "Error":
      if let message = item.text {
        messages.append(ChatMessage(id: item.id, role: "error", text: message))
      }
    default: break
    }
    attachActivity(item, from: messageCount)
  }

  private var lastAssistantInTurn: Int? {
    messages.indices.last { $0 >= turnStart && messages[$0].role == "assistant" }
  }

  private mutating func addUser(_ item: Item) {
    if !item.steered {
      activity = []
      turnStart = messages.count
      posts = [:]
      posted = false
      silent = false
      lastText = ""
    }
    guard !item.isHidden else { return }
    let body = item.body
    let text = body?.display ?? item.text ?? ""
    if let mail = SubagentMail(text: item.text) {
      messages.append(ChatMessage(id: item.id, role: "notice", text: "", notice: .subagent(mail)))
    } else if !text.isEmpty || !(body?.attachments ?? []).isEmpty {
      messages.append(
        ChatMessage(
          id: item.id, role: "user", text: text, files: body?.attachments ?? [],
          speaker: body?.name, steered: item.steered, slackTimestamp: item.messageTs))
    }
  }

  private mutating func addToolResult(_ item: Item) {
    let body = item.body
    if item.tool == "miniapp", item.succeeded, let artifact = body?.playground,
      artifact.kind == "playground", FilePreviewResource.path(for: artifact.artifactId) != nil,
      !artifact.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      playgroundIDs.insert(artifact.id).inserted
    {
      messages.append(
        ChatMessage(id: item.id, role: "assistant", text: "", playgrounds: [artifact]))
    }
    if item.tool == "finish_silently" && body?.silent == true
      || item.tool == "stay_silent" && body?.ok == true
    {
      silent = true
    }
    if let callID = item.callId, let post = posts.removeValue(forKey: callID), item.succeeded {
      messages.append(
        ChatMessage(
          id: post.id, role: "assistant", text: post.body?.text ?? "", files: body?.files ?? []))
      posted = true
    } else if item.tool == "attach", item.succeeded, let files = body?.files, !files.isEmpty {
      messages.append(ChatMessage(id: item.id, role: "assistant", text: "", files: files))
    }
  }

  private mutating func addAssistant(_ item: Item) {
    if !posted && !silent {
      let text = item.text?.isEmpty == false ? item.text! : lastText
      let attachments = item.body?.attachments ?? []
      if !text.isEmpty || !attachments.isEmpty {
        messages.append(
          ChatMessage(
            id: item.id, role: "assistant", text: text, files: attachments,
            speaker: item.body?.name))
      }
    }
    posted = false
    silent = false
    lastText = ""
    posts = [:]
  }

  private mutating func addDelivery(_ item: Item) {
    guard let files = item.body?.files, !files.isEmpty else { return }
    if let last = lastAssistantInTurn {
      messages[last].files += files
    } else {
      messages.append(ChatMessage(id: item.id, role: "assistant", text: "", files: files))
    }
  }

  private mutating func addRetraction(_ item: Item) {
    guard let body = item.body, let action = body.action, ["edited", "deleted"].contains(action),
      let timestamp = body.ts, !timestamp.isEmpty
    else { return }
    for index in messages.indices where messages[index].slackTimestamp == timestamp {
      if action == "edited" { messages[index].edited = true }
      if action == "deleted" { messages[index].deleted = true }
    }
    messages.append(
      ChatMessage(
        id: item.id, role: "notice", text: "",
        notice: .revision(action: action, speaker: body.name, text: body.text ?? "")))
  }

  private mutating func attachActivity(_ item: Item, from messageCount: Int) {
    if item.isReply, messageCount == messages.count, let last = lastAssistantInTurn {
      messages[last].activity += activity
      activity = []
    }
    for index in messageCount..<messages.count {
      messages[index].runID = currentRunID
      messages[index].sequence = item.seq
      messages[index].createdAt = item.createdAt
      if ["assistant", "error"].contains(messages[index].role) {
        messages[index].activity = activity
        activity = []
      }
    }
  }

  func messagesWithReferences() -> [ChatMessage] {
    var messages = messages
    var references: [String: DeliveredFile] = [:]
    for index in messages.indices {
      if messages[index].role == "user" { references = [:] }
      if case .subagent = messages[index].notice { references = [:] }
      for file in messages[index].files {
        if let name = file.name { references[name] = file }
      }
      messages[index].referencedFiles = Array(references.values)
    }
    return messages
  }
}

struct RunResult: Decodable {
  let status: String
  let reply: String?
  let reason: String?
  let pendingApprovals: [Approval]?
}

struct ActiveRun: Decodable { let runId: String? }
struct Submission: Decodable {
  let runId: String?
  let status: String?
  let reason: String?
  let reply: String?
  let pendingApprovals: [Approval]?
  var isTerminalResult: Bool {
    ["ok", "failed", "refused", "pending_approval", "silent", "react"].contains(status ?? "")
  }
}

struct PendingSend: Codable {
  let text: String
  let idempotencyKey: String
  var attachments: [UploadAttachment]? = nil
  var runtime: RuntimeSelection? = nil
}

struct StreamEvent: Decodable {
  let type: String
  let name: String?
  let value: Value?

  var run: Run? {
    guard name == "run", let value, let status = value.status else { return nil }
    return Run(
      status: status, partial: value.partial, result: value.result,
      replyComplete: value.replyComplete, input: value.input, activity: value.activity)
  }

  struct Value: Decodable {
    let offset: Int?
    let delta: String?
    let status: String?
    let partial: String?
    let result: RunResult?
    let replyComplete: Bool?
    let input: RunInput?
    let activity: [RunActivity]?
  }
}

struct StreamText {
  private(set) var text = ""
  private var utf16Count = 0

  mutating func apply(_ event: StreamEvent) throws {
    if event.name == "run", let partial = event.value?.result?.reply ?? event.value?.partial {
      text = partial
      utf16Count = partial.utf16.count
    } else if event.name == "delta", let offset = event.value?.offset,
      let delta = event.value?.delta
    {
      guard offset >= 0, offset <= utf16Count else {
        throw QMError.message("Reconnecting to the response…")
      }
      let incoming = Array(delta.utf16)
      let overlap = utf16Count - offset
      if overlap < incoming.count {
        let suffix = incoming.dropFirst(overlap)
        text.append(String(decoding: suffix, as: UTF16.self))
        utf16Count += suffix.count
      }
    }
  }
}

enum QMError: LocalizedError {
  case message(String)
  case rejected(String)
  case signedOut

  var errorDescription: String? {
    switch self {
    case .message(let message), .rejected(let message): message
    case .signedOut: "Your session expired. Sign in again to continue."
    }
  }
}

struct ConversationUpdate: Decodable { let session: Conversation }

func sidebarConversations(_ conversations: [Conversation]) -> [Conversation] {
  conversations.filter { $0.parentSessionId?.isEmpty != false }
}

func hasRecordedRunReply(_ items: [Item], runID: String, includingPosts: Bool = true) -> Bool {
  var matchesRun = false
  var posts: [String: Bool] = [:]
  for item in items {
    if item.isUserMessage {
      if !item.steered || item.turnId != nil {
        matchesRun = item.turnId == runID
      }
    } else if matchesRun && item.isReply {
      return true
    } else if item.kind == "ToolCall", item.body?.action == "post", let callID = item.callId {
      posts[callID] = matchesRun
    } else if item.kind == "ToolResult", let callID = item.callId,
      posts.removeValue(forKey: callID) == true, item.succeeded, includingPosts
    {
      return true
    }
  }
  return false
}

struct SuggestedActivity: Decodable, Identifiable {
  let id: String
  let title: String
  let prompt: String
  let icon: String?
}

struct SuggestedActivitiesResponse: Decodable {
  let activities: [SuggestedActivity]
  let pending: Bool?
}
