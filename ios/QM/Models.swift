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
  var type: String?
  var status: Status?
  var color: String?
  var forkedFrom: ForkOrigin?
  var forkBoundarySeq: Int?

  var isShared: Bool {
    type == "group" || type == "channel" || scopeId.hasPrefix("group:")
      || scopeId.hasPrefix("channel:")
  }

  var contextLabel: String? {
    if let channelName, !channelName.isEmpty { return channelName }
    if scopeId.hasPrefix("personal:") { return nil }
    if scopeId.hasPrefix("project:") { return "Project conversation" }
    if type == "group" || scopeId.hasPrefix("group:") { return "Group conversation" }
    if type == "channel" || scopeId.hasPrefix("channel:") { return "Slack channel" }
    return "Shared conversation"
  }

  func slackURL(workspaceURL: String?) -> URL? {
    guard let workspaceURL, var components = URLComponents(string: workspaceURL),
      components.scheme == "https", let host = components.host,
      host.hasSuffix(".slack.com"), components.user == nil, components.password == nil,
      components.port == nil,
      let match = threadRef.wholeMatch(of: /(?:dm|ch):([A-Za-z0-9]+)(?::([0-9]+)\.([0-9]+))?/)
    else { return nil }
    components.path = "/archives/\(match.1)"
    if let seconds = match.2, let fraction = match.3 {
      components.path += "/p\(seconds)\(fraction)"
    }
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
  let entries: [Entry]
  let earlierEntries: Int?
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

struct Entry: Decodable, Identifiable {
  let type: String
  let payload: EntryPayload?
  let createdAt: Double
  let seq: Int?
  let truncated: Bool?
  var id: String { "\(seq ?? -1):\(createdAt):\(type)" }

}

struct NativePlayground: Decodable, Identifiable {
  let kind: String
  let artifactId: String
  let title: String
  var id: String { artifactId }
}

struct EntryPayload: Decodable {
  let details: NativeActivityValue?
  struct Display: Decodable { let artifact: NativePlayground? }
  let playground: NativePlayground?
  let text: String?
  let display: String?
  let hidden: Bool?
  let attachments: [DeliveredFile]?
  let files: [DeliveredFile]?
  let action: String?
  let tool: String?
  let callId: String?
  let ok: Bool?
  let isError: Bool?
  let denied: Bool?
  let blocked: String?
  let error: String?
  let kind: String?
  let message: String?
  let name: String?
  let silent: Bool?
  let runId: String?
  let steered: Bool?
  let thinking: String?
  let redacted: Bool?
  let approved: Bool?
  let command: String?
  let scope: String?
  let requestId: String?
  let ts: String?

  enum CodingKeys: String, CodingKey {
    case text, display, hidden, attachments, files, action, tool, callId, ok, isError, denied,
      blocked, error, kind, message, name, silent, runId, steered, thinking, redacted, approved,
      command, scope, requestId, ts
  }

  init(from decoder: Decoder) throws {
    details = try? NativeActivityValue(from: decoder)
    let c = try? decoder.container(keyedBy: CodingKeys.self)
    text = try? c?.decode(String.self, forKey: .text)
    display = try? c?.decode(String.self, forKey: .display)
    playground = (try? c?.decode(Display.self, forKey: .display))?.artifact
    hidden = try? c?.decode(Bool.self, forKey: .hidden)
    attachments = try? c?.decode([DeliveredFile].self, forKey: .attachments)
    files = try? c?.decode([DeliveredFile].self, forKey: .files)
    action = try? c?.decode(String.self, forKey: .action)
    tool = try? c?.decode(String.self, forKey: .tool)
    callId = try? c?.decode(String.self, forKey: .callId)
    ok = try? c?.decode(Bool.self, forKey: .ok)
    isError = try? c?.decode(Bool.self, forKey: .isError)
    denied = try? c?.decode(Bool.self, forKey: .denied)
    blocked =
      (try? c?.decode(String.self, forKey: .blocked))
      ?? ((c?.contains(.blocked) == true && (try? c?.decodeNil(forKey: .blocked)) != true
        && (try? c?.decode(Bool.self, forKey: .blocked)) != false) ? "blocked" : nil)
    error =
      (try? c?.decode(String.self, forKey: .error))
      ?? ((c?.contains(.error) == true && (try? c?.decodeNil(forKey: .error)) != true
        && (try? c?.decode(Bool.self, forKey: .error)) != false) ? "error" : nil)
    kind = try? c?.decode(String.self, forKey: .kind)
    message = try? c?.decode(String.self, forKey: .message)
    name = try? c?.decode(String.self, forKey: .name)
    silent = try? c?.decode(Bool.self, forKey: .silent)
    runId = try? c?.decode(String.self, forKey: .runId)
    steered = try? c?.decode(Bool.self, forKey: .steered)
    thinking = try? c?.decode(String.self, forKey: .thinking)
    redacted = try? c?.decode(Bool.self, forKey: .redacted)
    approved = try? c?.decode(Bool.self, forKey: .approved)
    command = try? c?.decode(String.self, forKey: .command)
    scope = try? c?.decode(String.self, forKey: .scope)
    requestId = try? c?.decode(String.self, forKey: .requestId)
    ts = try? c?.decode(String.self, forKey: .ts)
  }

  var succeeded: Bool {
    ok != false && isError != true && denied != true && blocked == nil && error == nil
  }
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

  func isRecorded(in entries: [Entry]) -> Bool {
    entries.contains {
      $0.type == "user" && ($0.payload?.runId == runId || (seq != nil && $0.seq == seq))
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
  var activity: [Entry] = []
}

func presentedChatMessages(
  _ entries: [Entry], runs: [ChatRunPresentation], activeRunID: String?,
  queuedRunIDs: Set<String> = []
) -> [ChatMessage] {
  var messages = chatMessages(entries)
  for run in runs {
    if let input = run.input, !input.isRecorded(in: entries), !queuedRunIDs.contains(run.id),
      run.finished || activeRunID == nil || activeRunID == run.runID
    {
      let position =
        input.seq.flatMap { sequence in
          messages.firstIndex { ($0.sequence ?? Int.min) > sequence }
        } ?? messages.endIndex
      messages.insert(input.message, at: position)
    }
    let replyRecorded = run.runID.map { hasRecordedRunReply(entries, runID: $0) } ?? false
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
  var activity: [Entry]? = nil
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
  var activity: [Entry] = []
  var steered = false
  var slackTimestamp: String?
  var edited = false
  var deleted = false
  var notice: ChatNotice?
}

func chatMessages(_ entries: [Entry]) -> [ChatMessage] {
  var messages: [ChatMessage] = []
  var posts: [String: Entry] = [:]
  var posted = false
  var lastText = ""
  var silent = false
  var playgroundIDs = Set<String>()
  var currentRunID: String?
  var activity: [Entry] = []
  var turnStart = 0
  for entry in entries {
    guard let payload = entry.payload else { continue }
    let messageCount = messages.count
    if entry.type == "user", payload.steered != true || payload.runId != nil {
      currentRunID = payload.runId
    }
    if NativeWorkItem.supports(entry) { activity.append(entry) }
    switch entry.type {
    case "user":
      if payload.steered != true {
        activity = []
        turnStart = messages.count
        posts = [:]
        posted = false
        silent = false
        lastText = ""
      }
      guard payload.hidden != true else { continue }
      let text = payload.display ?? payload.text ?? ""
      if let mail = SubagentMail(text: payload.text) {
        messages.append(
          ChatMessage(id: entry.id, role: "notice", text: "", notice: .subagent(mail)))
      } else if !text.isEmpty || !(payload.attachments ?? []).isEmpty {
        messages.append(
          ChatMessage(
            id: entry.id, role: "user", text: text, files: payload.attachments ?? [],
            speaker: payload.name, steered: payload.steered == true, slackTimestamp: payload.ts))
      }
    case "text":
      lastText = payload.text ?? ""
    case "tool_call":
      if payload.action == "post", let callID = payload.callId { posts[callID] = entry }
    case "tool_result":
      if payload.tool == "miniapp", payload.succeeded, let artifact = payload.playground,
        artifact.kind == "playground", FilePreviewResource.path(for: artifact.artifactId) != nil,
        !artifact.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        playgroundIDs.insert(artifact.id).inserted
      {
        messages.append(
          ChatMessage(id: entry.id, role: "assistant", text: "", playgrounds: [artifact]))
      }
      if payload.tool == "finish_silently" && payload.silent == true
        || payload.tool == "stay_silent" && payload.ok == true
      {
        silent = true
      }
      if let callID = payload.callId, let post = posts.removeValue(forKey: callID),
        payload.succeeded
      {
        messages.append(
          ChatMessage(
            id: post.id, role: "assistant", text: post.payload?.text ?? "",
            files: payload.files ?? []))
        posted = true
      } else if payload.tool == "attach", payload.succeeded, let files = payload.files,
        !files.isEmpty
      {
        messages.append(ChatMessage(id: entry.id, role: "assistant", text: "", files: files))
      }
    case "assistant":
      if !posted && !silent {
        let text = payload.text?.isEmpty == false ? payload.text! : lastText
        if !text.isEmpty || !(payload.attachments ?? []).isEmpty {
          messages.append(
            ChatMessage(
              id: entry.id, role: "assistant", text: text, files: payload.attachments ?? [],
              speaker: payload.name))
        }
      }
      posted = false
      silent = false
      lastText = ""
      posts = [:]
    case "delivery":
      if let files = payload.files, !files.isEmpty {
        if let last = messages.indices.last(where: {
          $0 >= turnStart && messages[$0].role == "assistant"
        }) {
          messages[last].files += files
        } else {
          messages.append(ChatMessage(id: entry.id, role: "assistant", text: "", files: files))
        }
      }
    case "approval_resolved":
      if let approved = payload.approved, let command = payload.command {
        messages.append(
          ChatMessage(
            id: entry.id, role: "notice", text: "",
            notice: .approval(approved: approved, command: command, scope: payload.scope)))
      }
    case "system":
      if payload.kind == "message_revision", let action = payload.action,
        ["edited", "deleted"].contains(action), let timestamp = payload.ts, !timestamp.isEmpty
      {
        for index in messages.indices where messages[index].slackTimestamp == timestamp {
          if action == "edited" { messages[index].edited = true }
          if action == "deleted" { messages[index].deleted = true }
        }
        messages.append(
          ChatMessage(
            id: entry.id, role: "notice", text: "",
            notice: .revision(action: action, speaker: payload.name, text: payload.text ?? "")))
      } else if payload.kind == "turn_failure", let message = payload.message {
        messages.append(ChatMessage(id: entry.id, role: "error", text: message))
      }
    default: break
    }
    if entry.type == "assistant", messageCount == messages.count,
      let last = messages.indices.last(where: {
        $0 >= turnStart && messages[$0].role == "assistant"
      })
    {
      messages[last].activity += activity
      activity = []
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
    let activity: [Entry]?
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

func hasRecordedRunReply(_ entries: [Entry], runID: String, includingPosts: Bool = true) -> Bool {
  var matchesRun = false
  var posts: [String: Bool] = [:]
  for entry in entries {
    if entry.type == "user" {
      if entry.payload?.steered != true || entry.payload?.runId != nil {
        matchesRun = entry.payload?.runId == runID
      }
    } else if matchesRun && entry.type == "assistant" {
      return true
    } else if entry.type == "tool_call", entry.payload?.action == "post",
      let callID = entry.payload?.callId
    {
      posts[callID] = matchesRun
    } else if entry.type == "tool_result", let callID = entry.payload?.callId,
      posts.removeValue(forKey: callID) == true, entry.payload?.succeeded == true, includingPosts
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
