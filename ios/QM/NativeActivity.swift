import SwiftUI

indirect enum NativeActivityValue: Codable, Equatable {
  case object([String: NativeActivityValue])
  case array([NativeActivityValue])
  case string(String)
  case number(Decimal)
  case bool(Bool)
  case null

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let boolean = try? value.decode(Bool.self) {
      self = .bool(boolean)
    } else if let string = try? value.decode(String.self) {
      self = .string(string)
    } else if let number = try? value.decode(Decimal.self) {
      self = .number(number)
    } else if let object = try? value.decode([String: Self].self) {
      self = .object(object)
    } else {
      self = .array(try value.decode([Self].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  subscript(_ key: String) -> NativeActivityValue? {
    guard case .object(let values) = self else { return nil }
    return values[key]
  }

  var string: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var formatted: String {
    if case .string(let text) = self { return text }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "Unavailable" }
    return String(decoding: data, as: UTF8.self)
  }

  var fields: [(key: String, value: NativeActivityValue)] {
    guard case .object(let values) = self else { return [("Payload", self)] }
    let priority = [
      "tool", "action", "purpose", "command", "path", "query", "text", "message", "reason",
      "args", "arguments", "input", "stdout", "stderr", "result", "output", "error",
    ]
    let ranks = Dictionary(uniqueKeysWithValues: priority.enumerated().map { ($1, $0) })
    return values.sorted {
      let left = ranks[$0.key] ?? priority.count
      let right = ranks[$1.key] ?? priority.count
      return left == right ? $0.key < $1.key : left < right
    }
  }
}

struct NativeActivityRow: View {
  let entry: Entry
  var client: APIClient? = nil
  @State private var expanded = false
  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      NativeActivityDetails(entry: entry, client: client)
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          if entry.type == "tool_call" || entry.type == "tool_result" {
            NativeActivityIcon(item: NativeWorkItem(entry: entry))
          }
          Text(entry.type.replacingOccurrences(of: "_", with: " ").capitalized).font(.headline)
        }
        if let tool = entry.payload?.tool {
          Text([tool, entry.payload?.action].compactMap { $0 }.joined(separator: " · "))
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Text(Date(timeIntervalSince1970: entry.createdAt / 1000), style: .time)
          .font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

struct NativeActivityDetails: View {
  let entry: Entry
  var client: APIClient? = nil
  var onInspect: () -> Void = {}
  @Environment(\.qmSessionID) private var sessionID
  @State private var fullEntry: Entry?
  @State private var loading = false
  @State private var error: String?
  private var displayed: Entry { fullEntry ?? entry }

  static let contentKeys = [
    "purpose", "command", "path", "query", "url", "text", "message", "reason", "args",
    "arguments", "input", "stdout", "stderr", "result", "output", "content", "error",
  ]
  private static let hiddenKeys: Set<String> = [
    "tool", "action", "callId", "step", "wire", "workStartedAt", "workFinishedAt",
    "retrySafe", "rerun", "runId", "requestId", "scope", "scopeLabel", "code", "timedOut",
    "quarantined", "pressure", "chars", "sessionId",
  ]
  private static let labels = [
    "args": "Arguments", "arguments": "Arguments", "stdout": "Output", "stderr": "Errors",
    "url": "URL",
  ]
  private static let monospacedKeys: Set<String> = [
    "command", "stdout", "stderr", "path", "query", "result", "output", "args", "arguments",
    "input", "content",
  ]

  static func fields(_ details: NativeActivityValue?) -> [(key: String, value: NativeActivityValue)]
  {
    guard let details else { return [] }
    guard case .object = details else { return [("Payload", details)] }
    let shown = details.fields.filter { field in
      switch field.value {
      case .null, .bool: return false
      case .string(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case .object(let values): return !values.isEmpty
      case .array(let items): return !items.isEmpty
      case .number: return true
      }
    }
    let content = shown.filter { contentKeys.contains($0.key) }
    return content.isEmpty ? shown.filter { !hiddenKeys.contains($0.key) } : content
  }

  private static func label(_ key: String) -> String {
    labels[key] ?? key.prefix(1).uppercased() + key.dropFirst()
  }

  var body: some View {
    let fields = Self.fields(displayed.payload?.details)
    VStack(alignment: .leading, spacing: 10) {
      if fields.isEmpty {
        Text("No details.").font(.footnote).foregroundStyle(.secondary)
      }
      ForEach(fields, id: \.key) { field in
        VStack(alignment: .leading, spacing: 2) {
          Text(Self.label(field.key)).font(.caption).foregroundStyle(.secondary)
          NativeActivityText(
            text: field.value.formatted, monospaced: Self.monospacedKeys.contains(field.key),
            onInspect: onInspect)
        }
      }
      if displayed.truncated == true, client != nil, sessionID != nil, entry.seq != nil {
        Button {
          onInspect()
          loading = true
        } label: {
          NativeActionLabel(
            title: "Load full output", busyTitle: "Loading output...", busy: loading)
        }
        .font(.footnote).disabled(loading)
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
      }
    }
    .task(id: loading) {
      guard loading, let client, let sessionID, let seq = entry.seq else { return }
      let generation = client.generation
      defer { loading = false }
      do {
        let collection = entry.itemKind == nil ? "entries" : "items"
        let response: TranscriptEntryResponse = try await client.fetch(
          "api/sessions/\(sessionID.apiComponent)/\(collection)/\(seq)")
        try Task.checkCancellation()
        guard client.generation == generation else { return }
        fullEntry = response.entry
        error = nil
      } catch {
        if !Task.isCancelled { self.error = "Could not load full output. Try again." }
      }
    }
  }
}

private struct NativeActivityText: View {
  let text: String
  let monospaced: Bool
  var onInspect: () -> Void = {}
  @State private var limit = 1200

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(String(text.prefix(limit)))
        .font(monospaced ? .footnote.monospaced() : .footnote).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      if text.count > limit {
        Button("Show more") {
          onInspect()
          limit += 6000
        }
        .font(.footnote)
      }
    }
  }
}

struct NativeWorkItem: Identifiable {
  let entry: Entry
  var result: Entry?
  var id: String { entry.reasoningID ?? entry.id }
  var isThinking: Bool { entry.type == "thinking" }
  enum State: String {
    case running = "In progress"
    case complete = "Complete"
    case failed = "Failed"
    case approval = "Approval needed"
    case unconfirmed = "Unconfirmed"
  }
  var opensAgents: Bool { entry.payload?.tool == "subagents" }
  var agentSessionID: String? {
    guard opensAgents,
      let id = (result ?? entry).payload?.details?["sessionId"]?.string,
      !id.isEmpty
    else { return nil }
    return id
  }

  func state(active: Bool, turnFailed: Bool = false) -> State {
    guard let result else { return active ? .running : turnFailed ? .failed : .unconfirmed }
    let payload = result.payload
    if payload?.blocked == "needs_approval" { return .approval }
    let data = payload?.details
    let completedNonzero =
      entry.payload?.tool == "sandbox" && entry.payload?.action == "exec"
      && data?["code"] != nil && data?["code"] != .number(0)
      && data?["timedOut"] == .bool(false)
      && (data?["stdout"]?.string != nil || data?["stderr"]?.string != nil)
    return (payload?.isError == true && !completedNonzero) || payload?.error != nil
      || payload?.denied == true || payload?.ok == false
      || data?["timedOut"] == .bool(true) || data?["quarantined"] == .bool(true)
      ? .failed : .complete
  }

  var failed: Bool { state(active: false) == .failed }

  var service: NativeActivityService? {
    let details = entry.payload?.details
    for identifier in [
      details?["mcpServer"]?.string, details?["server"]?.string,
      details?["provider"]?.string,
    ] {
      if let identifier {
        return NativeActivityService(identifier: identifier)
      }
    }
    if let tool = entry.payload?.tool, let service = NativeActivityService.named(tool: tool) {
      return service
    }
    for value in [
      details?["url"]?.string, details?["args"]?["url"]?.string,
      details?["request"]?["url"]?.string,
    ] {
      if let value, let host = URL(string: value)?.host {
        return NativeActivityService(host: host)
      }
    }
    if ["execute", "sandbox", "computer"].contains(entry.payload?.tool ?? ""),
      let purpose = details?["purpose"]?.string
    {
      return NativeActivityService.named(purpose: purpose)
    }
    return nil
  }

  var symbol: String {
    if isThinking { return "brain" }
    switch (entry.payload?.tool, entry.payload?.action) {
    case ("files", _), ("attach", _): return "doc.text"
    case ("skills", _): return "book.closed"
    case ("sandbox", _), ("execute", _): return "terminal"
    case ("web", _), ("browser", _): return "globe"
    case ("search", _), ("tool_search", _): return "magnifyingglass"
    case ("apps", _): return "square.stack.3d.up"
    case ("subagents", _): return "arrow.triangle.branch"
    case ("sessions", _): return "bubble.left.and.bubble.right"
    default: return "gearshape.2"
    }
  }

  var category: String {
    switch (entry.payload?.tool, entry.payload?.action) {
    case ("files", "read"), ("skills", "read"): return "files"
    case ("sandbox", "exec"): return "commands"
    default: return "tools"
    }
  }

  func label(active: Bool, turnFailed: Bool = false) -> String {
    let state = state(active: active, turnFailed: turnFailed)
    let data = entry.payload?.details
    let purpose = data?["purpose"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    var summary: String
    if opensAgents, let action = entry.payload?.action {
      let name = (entry.payload?.name ?? result?.payload?.details?["title"]?.string ?? "agent")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      switch action {
      case "open":
        summary = (state == .complete ? "Started " : "Starting ") + (name.isEmpty ? "agent" : name)
      case "wait": summary = state == .complete ? "Waited for agents" : "Waiting for agents"
      case "read": summary = state == .complete ? "Checked agents" : "Checking agents"
      case "send_message": summary = state == .complete ? "Messaged agent" : "Messaging agent"
      default: summary = "Agents"
      }
    } else if let purpose, !purpose.isEmpty {
      summary = purpose
    } else if entry.payload?.tool == "files", entry.payload?.action == "read",
      let path = data?["path"]?.string
    {
      summary = "Read " + URL(fileURLWithPath: path).lastPathComponent
    } else if entry.payload?.tool == "attach", case .array(let files) = data?["files"] {
      summary = "Attach " + files.compactMap(\.string).joined(separator: ", ")
    } else if let command = data?["command"]?.string {
      summary = String(command.split(separator: "\n").first ?? "Command")
    } else {
      let tool =
        service?.name
        ?? entry.payload?.tool?.replacingOccurrences(of: "_", with: " ").capitalized
      summary = [tool, entry.payload?.action?.replacingOccurrences(of: "_", with: " ")]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
      if let target = ["path", "query", "url", "channel", "repo", "target"].compactMap({ key in
        data?[key]?.string ?? data?["args"]?[key]?.string
      }).first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
        summary += " · " + target
      }
      if summary.isEmpty { summary = "Tool activity" }
    }
    switch state {
    case .failed: return summary + " · Failed"
    case .approval: return summary + " · Approval needed"
    case .unconfirmed: return isThinking ? summary : summary + " · Unconfirmed"
    case .complete:
      if entry.payload?.tool == "sandbox", entry.payload?.action == "exec",
        case .number(let code) = result?.payload?.details?["code"], code != 0
      {
        return summary + " · exit \(code)"
      }
      return summary
    case .running: return summary
    }
  }
  var title: String {
    if isThinking { return "Thinking" }
    let payload = entry.payload
    return [payload?.tool, payload?.action]
      .compactMap { $0?.replacingOccurrences(of: "_", with: " ") }
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }

  static func supports(_ entry: Entry) -> Bool {
    if entry.payload?.hidden == true || entry.payload?.redacted == true { return false }
    if entry.type == "thinking" {
      return entry.payload?.thinking?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        == false
    }
    return entry.type == "tool_call" || entry.type == "tool_result"
  }

  static func items(_ entries: [Entry]) -> [Self] {
    var items: [Self] = []
    var calls: [String: Int] = [:]
    for entry in entries where supports(entry) {
      if entry.type == "tool_result", let callID = entry.payload?.callId,
        let index = calls[callID], items[index].result == nil
      {
        items[index].result = entry
      } else {
        if entry.type == "tool_call", let callID = entry.payload?.callId {
          calls[callID] = items.count
        }
        items.append(Self(entry: entry, result: entry.type == "tool_result" ? entry : nil))
      }
    }
    return items
  }
}

struct NativeActivityService {
  let name: String
  let logo: String?

  private init(name: String, logo: String?) {
    self.name = name
    self.logo = logo
  }

  private static let names: [String: String] = [
    "googlesheets": "Google Sheets", "googledrive": "Google Drive",
    "googlecalendar": "Google Calendar", "gmail": "Gmail", "google": "Google",
    "slack": "Slack", "notion": "Notion", "linear": "Linear", "github": "GitHub",
    "dropbox": "Dropbox", "x": "X",
  ]

  init(identifier: String) {
    let key = identifier.lowercased().replacingOccurrences(of: "_", with: "")
      .replacingOccurrences(of: "-", with: "")
    logo = Self.names[key] == nil ? nil : key
    name =
      Self.names[key]
      ?? identifier.replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ").capitalized
  }

  init(host: String) {
    let lower = host.lowercased()
    let domain = lower.hasPrefix("www.") ? String(lower.dropFirst(4)) : lower
    let domains = [
      ("sheets.google.com", "googlesheets"),
      ("drive.google.com", "googledrive"), ("calendar.google.com", "googlecalendar"),
      ("mail.google.com", "gmail"), ("google.com", "google"),
      ("slack.com", "slack"), ("notion.so", "notion"), ("notion.com", "notion"),
      ("linear.app", "linear"), ("github.com", "github"),
      ("dropbox.com", "dropbox"), ("x.com", "x"),
    ]
    let identifier = domains.first { domain == $0.0 || domain.hasSuffix(".\($0.0)") }?.1
    if let identifier {
      self.init(identifier: identifier)
    } else {
      self.init(name: domain, logo: nil)
    }
  }

  static func named(tool: String) -> Self? {
    let name = tool.lowercased().hasPrefix("mcp__") ? String(tool.dropFirst(5)) : tool
    let identifier = name.split(separator: "/", maxSplits: 1).first.map(String.init) ?? name
    let service = Self(identifier: identifier)
    if service.logo != nil { return service }
    for logo in names.keys where identifier.hasPrefix("\(logo)_") {
      return Self(identifier: logo)
    }
    return nil
  }

  static func named(purpose: String) -> Self? {
    let words = purpose.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    if words.contains("google") {
      for (word, service) in [
        ("sheets", "googlesheets"), ("drive", "googledrive"),
        ("calendar", "googlecalendar"),
      ] where words.contains(word) {
        return Self(identifier: service)
      }
    }
    for word in words where !["x", "linear", "notion"].contains(word) {
      let service = Self(identifier: word)
      if service.logo != nil { return service }
    }
    return nil
  }
}

private struct NativeActivityIcon: View {
  let item: NativeWorkItem

  var body: some View {
    Group {
      if let logo = item.service?.logo {
        Image("Service-\(logo)").resizable().renderingMode(.template)
          .scaledToFit()
      } else {
        Image(systemName: item.symbol).resizable().scaledToFit()
      }
    }
    .frame(width: 16, height: 16)
    .accessibilityHidden(true)
  }
}

@MainActor @Observable
final class NativeWorkDisclosureState {
  private var expanded = Set<String>()

  func binding(for key: String, onInspect: @escaping () -> Void = {}) -> Binding<Bool> {
    Binding(
      get: { self.expanded.contains(key) },
      set: { value in
        onInspect()
        if value { self.expanded.insert(key) } else { self.expanded.remove(key) }
      })
  }
}

enum NativeReadOnlyWorkStatus: String {
  case pending = "Pending"
  case working = "Working"
  case awaitingInput = "Needs attention"
  case reconnecting = "Reconnecting"

  init?(conversation: Conversation) {
    guard !conversation.canReply else { return nil }
    if conversation.awaitingInput == true {
      self = .awaitingInput
    } else if conversation.working == true {
      self = .working
    } else {
      return nil
    }
  }

}

private struct NativeTimelineWorkLabel: View {
  let item: NativeWorkItem
  let active: Bool
  let turnFailed: Bool
  let expanded: Bool
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let state = item.state(active: active, turnFailed: turnFailed)
    let label = item.label(active: active, turnFailed: turnFailed)
    HStack(spacing: 8) {
      NativeWorkStateIndicator(state: state)
        .frame(width: 20, height: 20)
      Text(label)
        .font(.subheadline)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
      NativeDisclosureChevron(expanded: expanded)
    }
    .foregroundStyle(state == .failed || state == .approval ? QMTheme.warning : QMTheme.ink)
    .frame(minHeight: 44, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label), \(state.rawValue)")
    .accessibilityAddTraits(.isButton)
  }
}

private struct NativeDisclosureChevron: View {
  let expanded: Bool

  var body: some View {
    Image(systemName: expanded ? "chevron.down" : "chevron.right")
      .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      .frame(width: 20, height: 20)
      .accessibilityHidden(true)
  }
}

private struct NativeTimelineWorkDetails: View {
  let item: NativeWorkItem
  let client: APIClient
  let user: String
  var onShowAgents: (() -> Void)? = nil
  var onInspect: () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      NativeActivityDetails(entry: item.entry, client: client, onInspect: onInspect)
      if let result = item.result, result.id != item.entry.id {
        NativeActivityDetails(entry: result, client: client, onInspect: onInspect)
      }
      if let sessionID = item.agentSessionID {
        NavigationLink {
          NativeConversationDestination(client: client, user: user, sessionID: sessionID)
        } label: {
          Label("Open agent conversation", systemImage: "arrow.triangle.branch")
        }
        .font(.footnote).frame(minHeight: 44, alignment: .leading)
      } else if item.opensAgents, let onShowAgents {
        Button("View agents", systemImage: "arrow.triangle.branch", action: onShowAgents)
          .font(.footnote).frame(minHeight: 44, alignment: .leading)
      }
    }
  }
}

struct NativeTimelineWorkRow: View {
  let item: NativeWorkItem
  let client: APIClient
  let user: String
  let disclosure: NativeWorkDisclosureState
  var active = false
  var turnFailed = false
  var onShowAgents: (() -> Void)? = nil
  var onInspect: () -> Void = {}
  var expanded: Binding<Bool> { disclosure.binding(for: item.id, onInspect: onInspect) }

  var body: some View {
    let open = expanded.wrappedValue
    VStack(alignment: .leading, spacing: 0) {
      Button {
        expanded.wrappedValue = !open
      } label: {
        NativeTimelineWorkLabel(item: item, active: active, turnFailed: turnFailed, expanded: open)
      }
      .buttonStyle(.plain)
      if open {
        NativeTimelineWorkDetails(
          item: item, client: client, user: user, onShowAgents: onShowAgents, onInspect: onInspect
        )
        .padding(.leading, 28).padding(.bottom, 8)
      }
    }
    .tint(.brown)
    .accessibilityIdentifier("activity-\(item.id)")
  }
}

struct NativeTimelineActivityGroup: View {
  let section: NativeChatTranscriptSection
  let client: APIClient
  let user: String
  let disclosure: NativeWorkDisclosureState
  var reasoningText: (RunReasoning) -> String = { $0.text }
  var onShowAgents: (() -> Void)? = nil
  var onInspect: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var expanded: Binding<Bool> { disclosure.binding(for: section.id, onInspect: onInspect) }

  private var tools: [NativeWorkItem] {
    section.items.compactMap {
      if case .work(let work) = $0.content, !work.isThinking { return work }
      return nil
    }
  }

  var title: String {
    if let status = section.status {
      if status == .working {
        if let running = tools.last(where: { $0.state(active: true) == .running }) {
          return running.label(active: true)
        }
        return "Thinking…"
      }
      return status.rawValue
    }
    switch section.workState {
    case .failed: return "Activity · Failed"
    case .approval: return "Approval needed"
    case .unconfirmed: return "Activity · Unconfirmed"
    case .running: return "Working…"
    case .complete, nil: return "Reasoning & tools"
    }
  }

  var body: some View {
    let open = expanded.wrappedValue
    VStack(alignment: .leading, spacing: 0) {
      if section.items.isEmpty {
        label(expandable: false, open: false)
      } else {
        Button {
          expanded.wrappedValue = !open
        } label: {
          label(expandable: true, open: open)
        }
        .buttonStyle(.plain)
        if open {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(section.items) { item in
              switch item.content {
              case .work(let work):
                if work.isThinking, let text = work.entry.payload?.thinking {
                  reasoning(text)
                } else {
                  NativeTimelineWorkRow(
                    item: work, client: client, user: user, disclosure: disclosure,
                    active: item.active, turnFailed: item.turnFailed,
                    onShowAgents: onShowAgents, onInspect: onInspect)
                }
              case .reasoning(let block):
                reasoning(reasoningText(block))
              case .message:
                EmptyView()
              }
            }
          }
          .padding(.top, 4)
        }
      }
    }
    .tint(.brown)
    .accessibilityIdentifier(section.status == nil ? section.id : "conversationWorkStatus")
  }

  private func label(expandable: Bool, open: Bool) -> some View {
    HStack(spacing: 8) {
      Group {
        if section.status == .working || section.status == .pending {
          if reduceMotion {
            Image(systemName: "hourglass")
          } else {
            ProgressView().controlSize(.small)
          }
        } else if section.status == .reconnecting {
          Image(systemName: "wifi.slash")
        } else if section.status == .awaitingInput {
          Image(systemName: "pause.circle")
        } else if let state = section.workState {
          NativeWorkStateIndicator(state: state)
        } else {
          Image(systemName: "text.alignleft")
        }
      }
      .frame(width: 20, height: 20).accessibilityHidden(true)
      Text(title).font(.subheadline).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if !tools.isEmpty {
        Text("\(tools.count) \(tools.count == 1 ? "tool" : "tools")")
          .font(.caption).foregroundStyle(.secondary).fixedSize()
      }
      if expandable { NativeDisclosureChevron(expanded: open) }
    }
    .foregroundStyle(QMTheme.ink)
    .frame(minHeight: 44, alignment: .leading)
    .contentShape(Rectangle())
  }

  private func reasoning(_ text: String) -> some View {
    MessageMarkdown(text: text, client: client)
      .font(.footnote).foregroundStyle(.secondary)
      .padding(.leading, 28)
  }
}
