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
  var purpose: String? = nil
  var workingSince: Double? = nil
  var lastTurnFailed: Bool? = nil
  var pinned: Bool?
  var archived: Bool?
  var localOnly: Bool?
  var parentSessionId: String?
  var status: Status?
  var color: String?
  var forkedFrom: ForkOrigin?
  var forkBoundarySeq: Int?
  var unread: Bool?
  var goal: Goal? = nil
  var subagents: Subagents? = nil

  struct Subagents: Codable, Hashable {
    var running: Int
    var waiting: Int
  }

  struct Goal: Codable, Hashable {
    let objective: String
    var status: String? = nil
    var paused: Bool { status == "paused" }
  }

  static func draft(user: String, scopeId: String? = nil, channelName: String? = nil)
    -> Conversation
  {
    let id = UUID().uuidString.lowercased()
    return Conversation(
      id: id, scopeId: scopeId ?? "personal:\(user)", threadRef: "web:\(user):\(id)",
      surface: "web", channelName: channelName, localOnly: true)
  }

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
    guard parts.count == 2 || parts.count == 3, ["dm", "ch", "grp"].contains(parts[0]),
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

  var isSlackThread: Bool { slackArchivePath != nil }

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

  var label: String {
    if let title, !title.isEmpty { return title }
    if localOnly == true { return "New conversation" }
    if let channelName, !channelName.isEmpty {
      return ScopeKind(scopeId: scopeId) == .channel ? "#\(channelName)" : channelName
    }
    if surface == "web" { return "Web chat" }
    return surface == "slack" ? "Direct message" : "Untitled chat"
  }
  var needsInput: Bool { awaitingInput == true || (subagents?.waiting ?? 0) > 0 }
  var isSubagent: Bool { parentSessionId?.isEmpty == false }
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

struct ConversationList: Decodable {
  let sessions: [Conversation]
  let nextCursor: String?

  private enum CodingKeys: String, CodingKey { case sessions, pinned, nextCursor }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    sessions =
      try (values.decodeIfPresent([Conversation].self, forKey: .pinned) ?? [])
      + values.decode([Conversation].self, forKey: .sessions)
    nextCursor = try values.decodeIfPresent(String.self, forKey: .nextCursor)
  }
}

struct Transcript: Decodable {
  let latestPromptAt: Double?
  let items: [Item]
  let earlierItems: Int?
  let pins: [NativeConversationPin]?
  let session: Conversation?
  let goal: Conversation.Goal?
}

struct NativeConversationPin: Decodable, Identifiable {
  let id: String
  let text: String?
  let entrySeq: Int?
  let preview: String?
  let addedBy: String
  let createdAt: Double
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
  var credentialAskID: String? {
    requestId.hasPrefix("keychain:") ? String(requestId.dropFirst("keychain:".count)) : nil
  }
  var isCredential: Bool { credentialAskID != nil }
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
      $0.presentationRole == "user" && ($0.turnId == runId || (seq != nil && $0.seq == seq))
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
  var failure: String?
  var finished = false
  var activity: [Item] = []
}

func presentedChatMessages(
  _ items: [Item], runs: [ChatRunPresentation], activeRunID: String?,
  queuedRunIDs: Set<String> = [], liveActivity: [Item] = [], surface: String? = nil
) -> [ChatMessage] {
  var messages = chatMessages(items, surface: surface)
  if let activeRunID {
    let indices = messages.indices.filter { messages[$0].runID == activeRunID }
    for entry in liveActivity {
      _ = attachToolResult(entry, to: &messages, indices: indices)
    }
  }
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
    let projected =
      run.finished ? chatMessages(run.activity, runID: run.runID, surface: surface) : []
    for var message in projected where !messages.contains(where: { $0.id == message.id }) {
      let presented = Set(messages.flatMap(\.activity).map(\.id))
      message.activity.removeAll { presented.contains($0.id) }
      let position =
        message.sequence.flatMap { sequence in
          messages.firstIndex { ($0.sequence ?? Int.min) > sequence }
        } ?? run.runID.flatMap { id in messages.lastIndex { $0.runID == id }.map { $0 + 1 } }
        ?? messages.endIndex
      messages.insert(message, at: position)
    }
    let projectedIDs = Set(projected.map(\.id))
    let delivered = run.activity.contains {
      projectedIDs.contains($0.id)
        && ($0.presentationRole == "assistant"
          || $0.presentationRole == "tool_call" && $0.body?.action == "post")
    }
    let last = run.activity.last
    let finalNarration =
      last?.presentationRole == "text" && last?.details?["phase"] == .string("final_answer")
      && last?.details?["demoted"] != .bool(true)
    let replyRecorded =
      (run.runID.map { hasRecordedRunReply(items, runID: $0) } ?? false)
      || delivered || finalNarration
    var seen = Set(messages.filter { $0.runID == run.runID }.flatMap(\.activity).map(\.id))
    var remainingActivity = run.activity.filter {
      NativeWorkItem.supports($0) && seen.insert($0.id).inserted
    }
    let indices = messages.indices.filter { messages[$0].runID == run.runID }
    remainingActivity.removeAll {
      attachToolResult($0, to: &messages, indices: indices)
    }
    if run.finished, replyRecorded, let runID = run.runID,
      let first = remainingActivity.first,
      let index = messages.lastIndex(where: { $0.runID == runID && $0.role == "assistant" })
    {
      messages.insert(
        ChatMessage(
          id: "activity:\(first.id)", role: "assistant", text: "", runID: runID,
          activity: remainingActivity), at: index + 1)
    }
    func insertionAfterRun() -> Int {
      run.runID.flatMap { id in messages.lastIndex { $0.runID == id }.map { $0 + 1 } }
        ?? messages.endIndex
    }
    if let reply = run.reply, !reply.isEmpty, !replyRecorded {
      let position = insertionAfterRun()
      messages.insert(
        ChatMessage(
          id: "reply:\(run.id)", role: "assistant", text: reply, runID: run.runID,
          activity: remainingActivity),
        at: position)
    } else if run.finished, !remainingActivity.isEmpty,
      !messages.contains(where: { $0.runID == run.runID && $0.role == "assistant" })
    {
      let position = insertionAfterRun()
      messages.insert(
        ChatMessage(
          id: "activity:\(run.id)", role: "assistant", text: "", runID: run.runID,
          activity: remainingActivity),
        at: position)
    }
    if let failure = run.failure,
      run.runID == nil || !messages.contains(where: { $0.role == "error" && $0.runID == run.runID })
    {
      let position = insertionAfterRun()
      messages.insert(
        ChatMessage(id: "failure:\(run.id)", role: "error", text: failure, runID: run.runID),
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
  var activity: [Item]? = nil
  var attempt: Int? = nil
  var partialStartOffset: Int? = nil
  var reasoning: [RunReasoning]? = nil
  var isFinished: Bool {
    status == "done" || status == "failed" || result != nil
  }
  var failure: String? {
    runFailure(
      status: status == "failed" ? status : result?.status, reason: result?.reason,
      refusalKind: result?.refusalKind)
  }
  var finalReply: String? { result?.stopped == true ? partial : result?.reply }
}

func runFailure(status: String?, reason: String?, refusalKind: String?) -> String? {
  guard refusalKind != "approval_denied", status == "failed" || status == "refused" else {
    return nil
  }
  return reason ?? "The task could not be completed."
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
  case stopped
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

func chatMessages(_ items: [Item], runID: String? = nil, surface: String? = nil)
  -> [ChatMessage]
{
  var builder = ChatMessageBuilder(currentRunID: runID, surface: surface)
  for entry in items { builder.add(entry) }
  return builder.messagesWithReferences()
}

private struct ChatMessageBuilder {
  var messages: [ChatMessage] = []
  var posts: [String: Item] = [:]
  var posted = false
  var lastText = ""
  var lastTextID: String?
  var lastTextPhase: String?
  var lastTextStep: String?
  var silent = false
  var playgroundIDs = Set<String>()
  var currentRunID: String?
  var surface: String?
  var activity: [Item] = []
  var turnStart = 0

  mutating func add(_ entry: Item) {
    let messageCount = messages.count
    if entry.presentationRole == "user", entry.steered != true || entry.turnId != nil {
      currentRunID = entry.turnId
    } else if let runID = entry.turnId {
      currentRunID = runID
    }
    if NativeWorkItem.supports(entry),
      !attachToolResult(entry, to: &messages, indices: Array(turnStart..<messages.count))
    {
      activity.append(entry)
    }
    switch entry.presentationRole {
    case "user": addUser(entry)
    case "text": addText(entry)
    case "tool_call":
      if entry.body?.action == "post", let callID = entry.callId { posts[callID] = entry }
    case "tool_result": addToolResult(entry)
    case "assistant": addAssistant(entry)
    case "delivery": addDelivery(entry)
    case "approval_resolved":
      if let approved = entry.approved, let command = entry.body?.command {
        messages.append(
          ChatMessage(
            id: entry.id, role: "notice", text: "",
            notice: .approval(approved: approved, command: command, scope: entry.body?.scope)))
      }
    case "system": addSystem(entry)
    default: break
    }
    attachActivity(entry, from: messageCount)
  }

  private var lastAssistantInTurn: Int? {
    messages.indices.last { $0 >= turnStart && messages[$0].role == "assistant" }
  }

  private mutating func addUser(_ entry: Item) {
    if entry.steered != true {
      activity = []
      turnStart = messages.count
      posts = [:]
      posted = false
      silent = false
      lastText = ""
      lastTextID = nil
      lastTextPhase = nil
      lastTextStep = nil
    }
    guard entry.isHidden != true,
      !(entry.details?["overheard"] == .bool(true)
        && entry.details?["sourceRole"] == .string("agent"))
    else { return }
    let written = entry.body?.display ?? entry.text ?? ""
    let text = surface == "slack" ? SlackText.markdown(written) : written
    if let mail = SubagentMail(text: entry.text) {
      messages.append(ChatMessage(id: entry.id, role: "notice", text: "", notice: .subagent(mail)))
    } else if !text.isEmpty || !(entry.body?.attachments ?? []).isEmpty {
      messages.append(
        ChatMessage(
          id: entry.id, role: "user", text: text, files: entry.body?.attachments ?? [],
          speaker: entry.body?.name, steered: entry.steered == true,
          slackTimestamp: entry.messageTs))
    }
  }

  private mutating func addToolResult(_ entry: Item) {
    if entry.tool == "miniapp", entry.succeeded, let artifact = entry.body?.playground,
      artifact.kind == "playground", FilePreviewResource.path(for: artifact.artifactId) != nil,
      !artifact.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      playgroundIDs.insert(artifact.id).inserted
    {
      messages.append(
        ChatMessage(id: entry.id, role: "assistant", text: "", playgrounds: [artifact]))
    }
    if entry.tool == "finish_silently" && entry.body?.silent == true
      || entry.tool == "stay_silent" && entry.body?.ok == true
    {
      silent = true
    }
    if let callID = entry.callId, let post = posts.removeValue(forKey: callID),
      entry.succeeded
    {
      messages.append(
        ChatMessage(
          id: post.id, role: "assistant", text: post.body?.text ?? "",
          files: entry.body?.files ?? []))
      posted = true
    } else if entry.tool == "attach", entry.succeeded, let files = entry.body?.files,
      !files.isEmpty
    {
      messages.append(ChatMessage(id: entry.id, role: "assistant", text: "", files: files))
    }
  }

  private mutating func addAssistant(_ entry: Item) {
    if !posted && !silent {
      let text = entry.text?.isEmpty == false ? entry.text! : lastText
      if let last = messages.indices.last, messages[last].id == lastTextID,
        lastTextPhase != "commentary", activity.isEmpty,
        lastTextStep != nil, lastTextStep == entry.stepIdentity
      {
        messages[last].files += entry.body?.attachments ?? []
      } else if !text.isEmpty || !(entry.body?.attachments ?? []).isEmpty {
        messages.append(
          ChatMessage(
            id: entry.id, role: "assistant", text: text, files: entry.body?.attachments ?? [],
            speaker: entry.body?.name))
      }
    }
    posted = false
    silent = false
    lastText = ""
    lastTextID = nil
    lastTextPhase = nil
    lastTextStep = nil
    posts = [:]
  }

  private mutating func addText(_ entry: Item) {
    lastText = entry.text ?? ""
    lastTextPhase = entry.details?["phase"]?.string
    lastTextStep = entry.stepIdentity
    guard entry.isHidden != true, entry.details?["retracted"] == nil,
      entry.details?["prodded"] == nil,
      !lastText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    lastTextID = entry.id
    messages.append(ChatMessage(id: entry.id, role: "assistant", text: lastText))
  }

  private mutating func addDelivery(_ entry: Item) {
    guard let files = entry.body?.files, !files.isEmpty else { return }
    if let last = lastAssistantInTurn {
      messages[last].files += files
    } else {
      messages.append(ChatMessage(id: entry.id, role: "assistant", text: "", files: files))
    }
  }

  private mutating func addSystem(_ entry: Item) {
    if entry.kind == "Retraction", let action = entry.body?.action,
      ["edited", "deleted"].contains(action), let timestamp = entry.messageTs, !timestamp.isEmpty
    {
      for index in messages.indices where messages[index].slackTimestamp == timestamp {
        if action == "edited" { messages[index].edited = true }
        if action == "deleted" { messages[index].deleted = true }
      }
      messages.append(
        ChatMessage(
          id: entry.id, role: "notice", text: "",
          notice: .revision(
            action: action, speaker: entry.body?.name, text: entry.body?.text ?? "")))
    } else if entry.kind == "Error", let message = entry.text {
      messages.append(ChatMessage(id: entry.id, role: "error", text: message))
    } else if entry.kind == "Stop" {
      messages.append(ChatMessage(id: entry.id, role: "notice", text: "", notice: .stopped))
    }
  }

  private mutating func attachActivity(_ entry: Item, from messageCount: Int) {
    if entry.presentationRole == "assistant", messageCount == messages.count,
      let first = activity.first
    {
      messages.append(ChatMessage(id: "activity:\(first.id)", role: "assistant", text: ""))
    }
    for index in messageCount..<messages.count {
      messages[index].runID = currentRunID
      messages[index].sequence = entry.seq
      messages[index].createdAt = entry.createdAt
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

private func attachToolResult(_ entry: Item, to messages: inout [ChatMessage], indices: [Int])
  -> Bool
{
  guard entry.presentationRole == "tool_result", let callID = entry.callId,
    let index = indices.last(where: { index in
      messages[index].activity.contains {
        $0.presentationRole == "tool_call" && $0.callId == callID
      }
    })
  else { return false }
  if !messages[index].activity.contains(where: { $0.id == entry.id }) {
    messages[index].activity.append(entry)
  }
  return true
}

struct RunResult: Decodable {
  let status: String
  let reply: String?
  let reason: String?
  let pendingApprovals: [Approval]?
  var refusalKind: String? = nil
  var stopped: Bool? = nil
}

struct ActiveRun: Decodable { let runId: String? }
struct Submission: Decodable {
  let runId: String?
  let status: String?
  let reason: String?
  let reply: String?
  let pendingApprovals: [Approval]?
  var refusalKind: String? = nil
  var stopped: Bool? = nil
  var isTerminalResult: Bool {
    ["ok", "failed", "refused", "pending_approval", "silent", "react"].contains(status ?? "")
  }
  var failure: String? { runFailure(status: status, reason: reason, refusalKind: refusalKind) }
  var finalReply: String? { stopped == true ? nil : reply }
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
      replyComplete: value.replyComplete, input: value.input, activity: value.activity,
      attempt: value.attempt, partialStartOffset: value.partialStartOffset,
      reasoning: value.reasoning)
  }

  struct Value: Decodable {
    let offset: Int?
    let startOffset: Int?
    let delta: String?
    let status: String?
    let partial: String?
    let result: RunResult?
    let replyComplete: Bool?
    let input: RunInput?
    let activity: [Item]?
    let attempt: Int?
    let partialStartOffset: Int?
    let reasoning: [RunReasoning]?
    let step: String?
    let index: Int?
  }
}

struct StreamText {
  private(set) var text = ""
  private(set) var isFinalReply = false
  private(set) var startOffset = 0
  private(set) var reasoning: [RunReasoning] = []
  private var utf16Offset = 0
  private var attempt: Int?
  private var textBlockOffset: Int?
  private var textPosition: Int?
  private var reasoningPositions: [String: Int] = [:]
  private var nextPosition = 0

  var reasoningAfterText: Set<String> {
    guard let textPosition else { return [] }
    return Set(reasoningPositions.filter { $0.value > textPosition }.map(\.key))
  }

  mutating func apply(_ run: Run) {
    if let attempt = run.attempt, attempt != self.attempt {
      self = StreamText()
      self.attempt = attempt
    }
    let lastText = run.activity?.last {
      $0.presentationRole == "text_start" || $0.presentationRole == "text"
    }
    if lastText?.presentationRole == "text" { textPosition = nil }
    if let marker = run.activity?.last(where: { $0.presentationRole == "text_start" }),
      case .number(let offset) = marker.details?["streamOffset"]
    {
      let offset = NSDecimalNumber(decimal: offset).intValue
      if textBlockOffset != offset {
        textBlockOffset = offset
        textPosition = nil
      }
    }
    for block in run.reasoning ?? [] { mergeReasoning(block, offset: 0) }
    if let reply = run.finalReply {
      text = reply
      isFinalReply = true
      startOffset = 0
      utf16Offset = reply.utf16.count
      textPosition = nil
      if !reply.isEmpty { recordTextPosition() }
    } else if let partial = run.partial {
      text = partial
      isFinalReply = false
      startOffset = run.partialStartOffset ?? 0
      utf16Offset = startOffset + partial.utf16.count
      if lastText?.presentationRole == "text" {
        textPosition = nil
      } else if utf16Offset > (textBlockOffset ?? startOffset) {
        recordTextPosition()
      }
    }
    if let activity = run.activity {
      let persisted = Set(activity.compactMap(\.reasoningID))
      reasoning.removeAll { persisted.contains($0.id) }
    }
  }

  mutating func apply(_ event: StreamEvent) throws {
    if let run = event.run {
      apply(run)
    } else if event.name == "reasoning", let value = event.value, let step = value.step,
      let index = value.index, let offset = value.offset, let delta = value.delta
    {
      mergeReasoning(RunReasoning(step: step, index: index, text: delta), offset: offset)
    } else if event.name == "delta", let offset = event.value?.offset,
      let delta = event.value?.delta
    {
      let retainedStart = max(startOffset, event.value?.startOffset ?? 0)
      guard offset >= 0, offset <= max(utf16Offset, retainedStart) else {
        throw QMError.message("Reconnecting to the response…")
      }
      if retainedStart > startOffset {
        text = String(decoding: text.utf16.dropFirst(retainedStart - startOffset), as: UTF16.self)
        startOffset = retainedStart
        utf16Offset = max(utf16Offset, retainedStart)
      }
      let incoming = Array(delta.utf16)
      let overlap = utf16Offset - offset
      if overlap < incoming.count {
        let suffix = incoming.dropFirst(overlap)
        text.append(String(decoding: suffix, as: UTF16.self))
        utf16Offset += suffix.count
        recordTextPosition()
      }
    }
  }

  private mutating func mergeReasoning(_ block: RunReasoning, offset: Int) {
    let index = reasoning.firstIndex { $0.id == block.id }
    let current = index.map { reasoning[$0].text } ?? ""
    guard offset >= 0, offset <= current.utf16.count else { return }
    let text = String(decoding: current.utf16.prefix(offset), as: UTF16.self) + block.text
    guard text.utf16.count > current.utf16.count else { return }
    let updated = RunReasoning(step: block.step, index: block.index, text: text)
    if let index {
      reasoning[index] = updated
    } else {
      reasoning.removeAll { $0.step != block.step }
      reasoningPositions = reasoningPositions.filter { key, _ in reasoning.contains { $0.id == key }
      }
      reasoningPositions[block.id] = nextPosition
      nextPosition += 1
      reasoning.append(updated)
    }
  }

  private mutating func recordTextPosition() {
    guard textPosition == nil else { return }
    if textBlockOffset == nil { textBlockOffset = startOffset }
    textPosition = nextPosition
    nextPosition += 1
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
  conversations.filter { !$0.isSubagent }
}

func hasRecordedRunReply(_ items: [Item], runID: String, includingPosts: Bool = true) -> Bool {
  var matchesRun = false
  var posts: [String: Bool] = [:]
  for entry in items {
    if entry.presentationRole == "user" {
      if entry.steered != true || entry.turnId != nil {
        matchesRun = entry.turnId == runID
      }
    } else if matchesRun && entry.presentationRole == "assistant" {
      return true
    } else if entry.presentationRole == "tool_call", entry.body?.action == "post",
      let callID = entry.callId
    {
      posts[callID] = matchesRun
    } else if entry.presentationRole == "tool_result", let callID = entry.callId,
      posts.removeValue(forKey: callID) == true, entry.succeeded == true, includingPosts
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
