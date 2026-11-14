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
  let entry: Item
  var client: APIClient? = nil
  @State private var expanded = false
  var body: some View {
    NativeDisclosureRow(expanded: expanded) {
      expanded.toggle()
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          if entry.presentationRole == "tool_call" || entry.presentationRole == "tool_result" {
            NativeActivityIcon(item: NativeWorkItem(entry: entry))
          }
          Text(entry.presentationRole.replacingOccurrences(of: "_", with: " ").capitalized).font(
            .headline)
        }
        if let tool = entry.tool {
          Text([tool, entry.body?.action].compactMap { $0 }.joined(separator: " · "))
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Text(Date(timeIntervalSince1970: entry.createdAt / 1000), style: .time)
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .buttonStyle(.plain)
    if expanded { NativeActivityDetails(entry: entry, client: client) }
  }
}

struct NativeActivityDetails: View {
  let entry: Item
  var client: APIClient? = nil
  var onInspect: () -> Void = {}
  @Environment(\.qmSessionID) private var sessionID
  @State private var fullEntry: Item?
  @State private var loading = false
  @State private var error: String?
  private var displayed: Item { fullEntry ?? entry }

  private static let hiddenKeys: Set<String> = [
    "tool", "action", "callId", "step", "wire", "workStartedAt", "workFinishedAt",
    "retrySafe", "rerun", "runId", "requestId", "scope", "scopeLabel", "chars", "sessionId",
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
      case .null: return false
      case .bool: return true
      case .string(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case .object(let values): return !values.isEmpty
      case .array(let items): return !items.isEmpty
      case .number: return true
      }
    }
    return shown.filter { !hiddenKeys.contains($0.key) }
  }

  private static func label(_ key: String) -> String {
    labels[key] ?? key.prefix(1).uppercased() + key.dropFirst()
  }

  var body: some View {
    let fields = Self.fields(displayed.details)
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
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 7))
      }
      if displayed.truncated == true, client != nil, sessionID != nil, entry.seq != nil {
        Button {
          onInspect()
          loading = true
        } label: {
          NativeActionLabel(
            title: "Load full output", busyTitle: "Loading output…", busy: loading)
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
        let response: TranscriptItemResponse = try await client.fetch(
          "api/sessions/\(sessionID.apiComponent)/items/\(seq)")
        try Task.checkCancellation()
        guard client.generation == generation else { return }
        fullEntry = response.item
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
  let entry: Item
  var result: Item?
  var id: String { entry.reasoningID ?? entry.id }
  var isThinking: Bool { entry.presentationRole == "thinking" }
  enum State: String {
    case running = "In progress"
    case complete = "Complete"
    case failed = "Failed"
    case approval = "Approval needed"
    case unconfirmed = "Unconfirmed"
  }
  var opensAgents: Bool { entry.tool == "subagents" }
  var agentSessionID: String? {
    guard opensAgents,
      let id = (result ?? entry).details?["sessionId"]?.string,
      !id.isEmpty
    else { return nil }
    return id
  }

  func state(active: Bool, turnFailed: Bool = false) -> State {
    guard let result else { return active ? .running : turnFailed ? .failed : .unconfirmed }
    let payload = result
    if payload.body?.blocked == "needs_approval" { return .approval }
    let data = payload.details
    let completedNonzero =
      entry.tool == "sandbox" && entry.body?.action == "exec"
      && data?["code"] != nil && data?["code"] != .number(0)
      && data?["timedOut"] == .bool(false)
      && (data?["stdout"]?.string != nil || data?["stderr"]?.string != nil)
    return (payload.isError == true && !completedNonzero) || payload.body?.error != nil
      || payload.body?.denied == true || payload.body?.ok == false
      || data?["timedOut"] == .bool(true) || data?["quarantined"] == .bool(true)
      ? .failed : .complete
  }

  var failed: Bool { state(active: false) == .failed }

  var service: NativeActivityService? {
    let details = entry.details
    for identifier in [
      details?["mcpServer"]?.string, details?["server"]?.string,
      details?["provider"]?.string,
    ] {
      if let identifier {
        return NativeActivityService(identifier: identifier)
      }
    }
    if let tool = entry.tool, let service = NativeActivityService.named(tool: tool) {
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
    return nil
  }

  func label(active: Bool, turnFailed: Bool = false) -> String {
    let state = state(active: active, turnFailed: turnFailed)
    let data = entry.details
    let purpose = data?["purpose"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    var summary: String
    if opensAgents, let action = entry.body?.action {
      let name = (entry.body?.name ?? result?.details?["title"]?.string ?? "agent")
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
    } else if entry.tool == "files", entry.body?.action == "read",
      let path = data?["path"]?.string
    {
      summary =
        (state == .complete ? "" : "Reading ") + URL(fileURLWithPath: path).lastPathComponent
    } else if entry.tool == "attach", case .array(let files) = data?["files"] {
      summary = "Attach " + files.compactMap(\.string).joined(separator: ", ")
    } else if let command = data?["command"]?.string {
      summary = String(command.split(separator: "\n").first ?? "Command")
    } else if let activity = activityKind {
      summary = activity.label
      if let target = ["path", "query", "target"].compactMap({ data?[$0]?.string }).first {
        summary += " · " + target
      }
    } else {
      let tool =
        service?.name
        ?? entry.tool?.replacingOccurrences(of: "_", with: " ").capitalized
      summary = [tool, entry.body?.action?.replacingOccurrences(of: "_", with: " ")]
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
      if entry.tool == "sandbox", entry.body?.action == "exec",
        case .number(let code) = result?.details?["code"], code != 0
      {
        return summary + " · exit \(code)"
      }
      return summary
    case .running: return summary
    }
  }
  var title: String {
    if isThinking { return "Thinking" }
    let payload = entry
    return [payload.tool, payload.body?.action]
      .compactMap { $0?.replacingOccurrences(of: "_", with: " ") }
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }

  static func supports(_ entry: Item) -> Bool {
    if entry.isHidden == true || entry.body?.redacted == true { return false }
    if entry.presentationRole == "thinking" {
      return entry.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        == false
    }
    return entry.presentationRole == "tool_call" || entry.presentationRole == "tool_result"
  }

  static func items(_ transcript: [Item]) -> [Self] {
    var items: [Self] = []
    var calls: [String: Int] = [:]
    for entry in transcript where supports(entry) {
      if entry.presentationRole == "tool_result", let callID = entry.callId,
        let index = calls[callID], items[index].result == nil
      {
        items[index].result = entry
      } else {
        if entry.presentationRole == "tool_call", let callID = entry.callId {
          calls[callID] = items.count
        }
        items.append(
          Self(entry: entry, result: entry.presentationRole == "tool_result" ? entry : nil))
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
    let key = NativeServiceLogo.key(identifier)
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

}

private struct NativeActivityIcon: View {
  let item: NativeWorkItem

  var body: some View {
    Image("Activity-\(item.activityKind?.icon ?? "wrench")")
      .resizable().renderingMode(.template).scaledToFit()
      .frame(width: 15, height: 15)
      .accessibilityHidden(true)
  }
}

@MainActor @Observable
final class NativeWorkDisclosureState {
  private var expanded: [String: Bool] = [:]

  func binding(
    for key: String, initiallyExpanded: Bool = false, onInspect: @escaping () -> Void = {}
  ) -> Binding<Bool> {
    Binding(
      get: { self.expanded[key] ?? initiallyExpanded },
      set: { value in
        onInspect()
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.25)) {
          self.expanded[key] = value
        }
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
    HStack(spacing: 6) {
      NativeActivityIcon(item: item)
      Text(label)
        .font(.footnote)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
      NativeDisclosureChevron(expanded: expanded)
    }
    .foregroundStyle(
      state == .failed ? Color.red : state == .approval ? QMTheme.ink : QMTheme.ink.opacity(0.6)
    )
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
    Image("Activity-chevron-right")
      .resizable().renderingMode(.template).scaledToFit()
      .frame(width: 14, height: 14)
      .rotationEffect(.degrees(expanded ? 90 : 0))
      .opacity(0.65)
      .accessibilityHidden(true)
  }
}

struct NativeDisclosureRow<Label: View>: View {
  let expanded: Bool
  let toggle: () -> Void
  @ViewBuilder let label: () -> Label

  var body: some View {
    Button(action: toggle) {
      HStack {
        label()
        Spacer(minLength: 0)
        NativeDisclosureChevron(expanded: expanded)
      }
      .contentShape(Rectangle())
    }
    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
  }
}

struct NativeLinkRow<Label: View>: View {
  let action: () -> Void
  @ViewBuilder let label: () -> Label

  var body: some View {
    Button(action: action) {
      HStack {
        label()
        Spacer()
        Image(systemName: "chevron.right").font(.caption).accessibilityHidden(true)
      }
      .padding(.vertical, 6).foregroundStyle(QMTheme.ink)
    }
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
        .padding(.leading, 21).padding(.bottom, 8)
        .transition(.opacity.combined(with: .offset(y: -4)))
      }
    }
    .clipped()
    .tint(QMTheme.ink.opacity(0.6))
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
  var expanded: Binding<Bool> {
    disclosure.binding(
      for: section.id, initiallyExpanded: section.workState == .approval, onInspect: onInspect)
  }

  private var presentation: NativeActivitySummary {
    NativeActivitySummary(section: section, reasoningText: reasoningText)
  }
  var title: String { presentation.title }

  private var soleItem: NativeChatTimelineItem? {
    guard section.items.count == 1, section.status == nil, !presentation.animating,
      section.workState != .approval
    else { return nil }
    return section.items.first
  }

  @ViewBuilder var body: some View {
    if let item = soleItem {
      row(item, presentation: presentation)
    } else {
      group
    }
  }

  private var group: some View {
    let open = expanded.wrappedValue
    let presentation = presentation
    return VStack(alignment: .leading, spacing: 0) {
      if section.items.isEmpty {
        label(presentation, expandable: false, open: false)
      } else {
        Button {
          expanded.wrappedValue = !open
        } label: {
          label(presentation, expandable: true, open: open)
        }
        .buttonStyle(.plain)
        if open {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(section.items) { item in
              row(item, presentation: presentation)
            }
          }
          .padding(.top, 4)
          .transition(.opacity.combined(with: .offset(y: -4)))
        }
      }
    }
    .clipped()
    .tint(QMTheme.ink.opacity(0.6))
    .accessibilityIdentifier(section.status == nil ? section.id : "conversationWorkStatus")
  }

  @ViewBuilder
  private func row(_ item: NativeChatTimelineItem, presentation: NativeActivitySummary)
    -> some View
  {
    switch item.content {
    case .work(let work):
      if work.isThinking, let text = work.entry.text {
        reasoning(text, id: item.id, live: presentation.liveItemID == item.id)
      } else {
        NativeTimelineWorkRow(
          item: work, client: client, user: user, disclosure: disclosure,
          active: item.active, turnFailed: item.turnFailed,
          onShowAgents: onShowAgents, onInspect: onInspect)
      }
    case .reasoning(let block):
      reasoning(reasoningText(block), id: item.id, live: presentation.liveItemID == item.id)
    case .message:
      EmptyView()
    }
  }

  private func label(_ presentation: NativeActivitySummary, expandable: Bool, open: Bool)
    -> some View
  {
    HStack(spacing: 6) {
      Image("Activity-\(presentation.icon)")
        .resizable().renderingMode(.template).scaledToFit()
        .frame(width: 15, height: 15).accessibilityHidden(true)
      if presentation.animating {
        NativeThinkingLabel(text: presentation.title)
      } else {
        Text(presentation.title).font(.footnote).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      if let duration = presentation.duration {
        Text(duration).font(.caption).opacity(0.7).fixedSize()
      }
      if expandable { NativeDisclosureChevron(expanded: open) }
    }
    .foregroundStyle(QMTheme.ink.opacity(0.6))
    .frame(minHeight: 44, alignment: .leading)
    .contentShape(Rectangle())
  }

  private func reasoning(_ text: String, id: String, live: Bool) -> some View {
    let thought = NativeThinkingPresentation(text: text, live: live)
    let binding = disclosure.binding(for: "reasoning:\(id)", onInspect: onInspect)
    return VStack(alignment: .leading, spacing: 0) {
      Button {
        binding.wrappedValue.toggle()
      } label: {
        HStack(spacing: 6) {
          Image("Activity-brain").resizable().renderingMode(.template).scaledToFit()
            .frame(width: 15, height: 15).accessibilityHidden(true)
          Text(thought.title).font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
          NativeDisclosureChevron(expanded: binding.wrappedValue)
        }
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(binding.wrappedValue ? "Expanded" : "Collapsed")
      if binding.wrappedValue {
        MessageMarkdown(
          text: thought.body, client: client, textScale: 0.8, textColor: QMTheme.ink.opacity(0.6)
        )
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(QMTheme.border).frame(width: 2) }
        .padding(.leading, 21).padding(.bottom, 8)
        .transition(.opacity.combined(with: .offset(y: -4)))
      }
    }
    .clipped()
    .foregroundStyle(QMTheme.ink.opacity(0.6))
  }
}

struct NativeThinkingLabel: View {
  var text = "Thinking"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .overlay {
        if !reduceMotion {
          TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            GeometryReader { geometry in
              let phase =
                context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 2.55) / 2.55
              LinearGradient(
                colors: [.clear, QMTheme.ink.opacity(0.7), .clear],
                startPoint: .leading, endPoint: .trailing
              )
              .frame(width: 46)
              .offset(x: -56 + (geometry.size.width + 112) * min(phase / 0.46, 1))
            }
          }
          .mask(Text(text).font(.footnote))
          .accessibilityHidden(true)
        }
      }
  }
}
