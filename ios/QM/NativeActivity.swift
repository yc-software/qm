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
      "tool", "action", "command", "path", "query", "text", "message", "reason",
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
    DisclosureGroup(isExpanded: $expanded) {
      if expanded {
        NativeActivityDetails(entry: entry, client: client)
      }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        Text(entry.kindTitle).font(.headline)
        if let tool = entry.tool {
          Text([tool, entry.body?.action].compactMap { $0 }.joined(separator: " · "))
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Text(Date(timeIntervalSince1970: entry.createdAt / 1000), style: .time)
          .font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

struct NativeActivityDetails: View {
  let entry: Item
  var client: APIClient? = nil
  @Environment(\.qmSessionID) private var sessionID
  @State private var fullEntry: Item?
  @State private var loading = false
  @State private var error: String?
  private var displayed: Item { fullEntry ?? entry }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if displayed.truncated == true {
        Label("This event was shortened by the server.", systemImage: "exclamationmark.circle")
          .font(.caption).foregroundStyle(.secondary)
        if client != nil, sessionID != nil, entry.seq != nil {
          Button(loading ? "Loading output…" : "Load full output") { loading = true }
            .disabled(loading)
        }
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
      }
      if let details = displayed.details {
        let primary = details.fields.filter {
          [
            "purpose", "command", "path", "query", "text", "stdout", "stderr", "result", "output",
            "error", "reason",
          ].contains($0.key)
        }
        ForEach(primary, id: \.key) { field in
          NativeActivityField(name: field.key, text: field.value.formatted)
        }
        DisclosureGroup("Event details") {
          ForEach(details.fields, id: \.key) { field in
            NativeActivityField(name: field.key, text: field.value.formatted)
          }
          if let seq = entry.seq { LabeledContent("Sequence", value: String(seq)).font(.caption) }
        }.font(.caption).foregroundStyle(.secondary)
      } else {
        Text("No event details.").foregroundStyle(.secondary)
      }
    }
    .task(id: loading) {
      guard loading, let client, let sessionID, let seq = entry.seq else { return }
      let generation = client.generation
      defer { loading = false }
      do {
        struct Response: Decodable { let item: Item }
        let response: Response = try await client.fetch("api/sessions/\(sessionID)/items/\(seq)")
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

private struct NativeActivityField: View {
  let name: String
  let text: String
  @State private var limit = 6000
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(name).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Text(text.isEmpty ? "(empty)" : String(text.prefix(limit)))
        .font(.callout.monospaced()).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      if text.count > limit {
        Button("Show more (\(text.count - limit) characters remaining)") { limit += 6000 }
          .font(.caption)
      }
    }.padding(.vertical, 5)
  }
}

struct NativeWorkItem: Identifiable {
  let entry: Item
  var result: Item?
  var id: String { entry.id }
  var isThinking: Bool { entry.kind == "Reasoning" }
  enum State { case running, complete, failed, approval, unconfirmed }

  func state(active: Bool, turnFailed: Bool = false) -> State {
    guard let result else { return active ? .running : turnFailed ? .failed : .unconfirmed }
    let body = result.body
    if body?.blocked == "needs_approval" { return .approval }
    let data = result.details
    let completedNonzero =
      entry.tool == "sandbox" && entry.body?.action == "exec"
      && data?["code"] != nil && data?["code"] != .number(0)
      && data?["timedOut"] == .bool(false)
      && (data?["stdout"]?.string != nil || data?["stderr"]?.string != nil)
    return (result.isError == true && !completedNonzero) || body?.error != nil
      || body?.denied == true || body?.ok == false
      || data?["timedOut"] == .bool(true) || data?["quarantined"] == .bool(true)
      ? .failed : .complete
  }

  var failed: Bool { state(active: false) == .failed }

  var category: String {
    switch (entry.tool, entry.body?.action) {
    case ("files", "read"), ("skills", "read"): return "files"
    case ("sandbox", "exec"): return "commands"
    default: return "tools"
    }
  }

  func label(active: Bool, turnFailed: Bool = false) -> String {
    let state = state(active: active, turnFailed: turnFailed)
    let data = entry.details
    let purpose = data?["purpose"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    let base: String
    if let purpose, !purpose.isEmpty {
      base = purpose
    } else if entry.tool == "files", entry.body?.action == "read",
      let path = data?["path"]?.string
    {
      base = "Read " + URL(fileURLWithPath: path).lastPathComponent
    } else if entry.tool == "attach", case .array(let files) = data?["files"] {
      base = "Attach " + files.compactMap(\.string).joined(separator: ", ")
    } else if let command = data?["command"]?.string {
      base = String(command.split(separator: "\n").first ?? "Command")
    } else {
      base = title.isEmpty ? "Tool activity" : title
    }
    switch state {
    case .failed: return base + " · Failed"
    case .approval: return base + " · Approval needed"
    case .unconfirmed: return isThinking ? base : base + " · Unconfirmed"
    case .complete:
      if entry.tool == "sandbox", entry.body?.action == "exec",
        case .number(let code) = result?.details?["code"], code != 0
      {
        return base + " · exit \(code)"
      }
      return base
    case .running: return base
    }
  }
  var title: String {
    if isThinking { return "Thinking" }
    return [entry.tool, entry.body?.action]
      .compactMap { $0?.replacingOccurrences(of: "_", with: " ") }
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }

  static func supports(_ item: Item) -> Bool {
    if item.isHidden || item.body?.redacted == true { return false }
    if item.kind == "Reasoning" {
      return item.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
    return item.kind == "ToolCall" || item.kind == "ToolResult"
  }

  static func items(_ activity: [Item]) -> [Self] {
    var items: [Self] = []
    var calls: [String: Int] = [:]
    for item in activity where supports(item) {
      if item.kind == "ToolResult", let callID = item.callId, let index = calls[callID],
        items[index].result == nil
      {
        items[index].result = item
      } else {
        if item.kind == "ToolCall", let callID = item.callId { calls[callID] = items.count }
        items.append(Self(entry: item, result: item.kind == "ToolResult" ? item : nil))
      }
    }
    return items
  }
}

struct NativeWorkSummary: View {
  let activity: [Item]
  let client: APIClient
  var active = false
  var responding = false
  var turnFailed = false
  var finishedAt: Double?
  @State private var expanded = false

  private var items: [NativeWorkItem] { NativeWorkItem.items(activity) }
  private func title(at date: Date) -> String {
    let times = activity.map(\.createdAt).filter { $0 > 0 }
    guard let start = times.min() else { return active ? "Working…" : "Worked" }
    let end =
      active && !responding
      ? date.timeIntervalSince1970 * 1000 : finishedAt ?? times.max() ?? start
    let seconds = max(0, Int(((end - start) / 1000).rounded()))
    let duration = seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
    return "\(active && !responding ? "Working" : "Worked") for \(duration)"
  }

  var body: some View {
    if active || !items.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Button {
          expanded.toggle()
        } label: {
          HStack(spacing: 8) {
            if active && !responding {
              TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(title(at: context.date))
              }
            } else {
              Text(title(at: .now))
            }
            if !items.isEmpty {
              Image(systemName: expanded ? "chevron.down" : "chevron.right")
                .font(.caption2.weight(.semibold))
            }
          }
          .font(.footnote).foregroundStyle(.secondary)
          .frame(minHeight: 32, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(items.isEmpty)
        .accessibilityLabel(title(at: .now))
        .accessibilityValue(items.isEmpty ? "" : expanded ? "Expanded" : "Collapsed")
        if expanded {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(items) { item in
              DisclosureGroup {
                if item.isThinking, let thinking = item.entry.text {
                  MessageMarkdown(text: thinking, client: client)
                } else {
                  NativeActivityDetails(entry: item.entry, client: client)
                  if let result = item.result, result.id != item.entry.id {
                    Divider()
                    NativeActivityDetails(entry: result, client: client)
                  }
                }
              } label: {
                HStack(spacing: 6) {
                  if item.isThinking {
                    Image(systemName: "brain")
                  } else {
                    Image(
                      systemName: item.state(active: active, turnFailed: turnFailed) == .failed
                        ? "exclamationmark.circle"
                        : item.state(active: active) == .approval
                          ? "hand.raised"
                          : item.result != nil
                            ? "checkmark.circle" : active ? "ellipsis" : "questionmark.circle")
                  }
                  Text(item.label(active: active, turnFailed: turnFailed))
                }
                .font(.footnote).foregroundStyle(
                  item.state(active: active, turnFailed: turnFailed) == .failed ? .red : .secondary
                )
                .lineLimit(2)
              }
            }
          }
          .padding(.leading, 14)
          .overlay(alignment: .leading) {
            Rectangle().fill(QMTheme.border).frame(width: 1)
          }
        }
      }
    }
  }
}
