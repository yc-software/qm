import Foundation

enum NativeActivityKind {
  case thinking, read, search, execute, write, publish, memory, history, background, agent

  var icon: String {
    switch self {
    case .thinking, .memory: "brain"
    case .read: "book-open"
    case .search: "search"
    case .execute, .background: "terminal"
    case .write: "pencil"
    case .publish: "rocket"
    case .history: "scroll-text"
    case .agent: "bot"
    }
  }

  var label: String {
    switch self {
    case .thinking: "Thinking"
    case .read: "Reading file"
    case .search: "Searching"
    case .execute: "Running command"
    case .write: "Writing file"
    case .publish: "Publishing"
    case .memory: "Searching memory"
    case .history: "Searching history"
    case .background: "Managing process"
    case .agent: "Working with agents"
    }
  }
}

extension NativeWorkItem {
  var activityKind: NativeActivityKind? {
    if isThinking { return .thinking }
    switch (entry.tool, entry.body?.action) {
    case ("read", _), ("files", "read"), ("skills", "read"): return .read
    case ("write", _), ("files", "write"): return .write
    case ("search", _), ("tool_search", _): return .search
    case ("execute", _):
      return entry.details?["background"] == .bool(true) ? .background : .execute
    case ("sandbox", "exec"): return .execute
    case ("background", _): return .background
    case ("apps", "publish"): return .publish
    case ("memory", _): return .memory
    case ("history", _): return .history
    case ("sessions", _), ("subagents", _): return .agent
    default: return nil
    }
  }
}

struct NativeThinkingPresentation {
  let title: String
  let body: String

  init(text: String, live: Bool) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let lines = trimmed.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    let first = String(lines.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var heading: String?
    let hashes = first.prefix(while: { $0 == "#" }).count
    if (1...6).contains(hashes), first.dropFirst(hashes).hasPrefix(" ") {
      heading = String(first.dropFirst(hashes + 1))
      if let suffix = heading?.range(of: " #", options: .backwards),
        heading?[suffix.upperBound...].allSatisfy({ $0 == "#" }) == true
      {
        heading = String(heading![..<suffix.lowerBound])
      }
    } else {
      for marker in ["**", "__"]
      where first.count > 4
        && first.hasPrefix(marker) && first.hasSuffix(marker)
      {
        heading = String(first.dropFirst(2).dropLast(2))
      }
    }
    if let heading, !heading.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      title = heading.trimmingCharacters(in: .whitespacesAndNewlines)
      body = lines.count > 1 ? String(lines[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
    } else {
      title = live ? "Thinking" : "Thought"
      body = trimmed
    }
  }
}

struct NativeActivitySummary {
  let title: String
  let icon: String
  let duration: String?
  let animating: Bool
  let liveItemID: String?

  init(section: NativeChatTranscriptSection, reasoningText: (RunReasoning) -> String = { $0.text })
  {
    animating = section.status == .working
    liveItemID = animating ? section.items.last?.id : nil
    duration = section.workDuration.map {
      "Worked for " + $0.formatted(.number.precision(.fractionLength(0))) + "s"
    }
    if let status = section.status, status != .working {
      title = status.rawValue
      icon = "wrench"
      return
    }
    if animating {
      if let last = section.items.last {
        switch last.content {
        case .work(let work):
          title =
            work.isThinking
            ? NativeThinkingPresentation(text: work.entry.text ?? "", live: true).title
            : work.label(active: last.active, turnFailed: last.turnFailed)
          icon = work.activityKind?.icon ?? "wrench"
        case .reasoning(let block):
          title = NativeThinkingPresentation(text: reasoningText(block), live: true).title
          icon = "brain"
        case .message:
          title = "Thinking"
          icon = "brain"
        }
      } else {
        title = "Thinking"
        icon = "brain"
      }
      return
    }
    let tools = section.items.compactMap { item -> (NativeWorkItem, NativeWorkItem.State)? in
      guard case .work(let work) = item.content, !work.isThinking else { return nil }
      return (work, work.state(active: item.active, turnFailed: item.turnFailed))
    }
    var descriptions: [String] = []
    if tools.contains(where: { $0.0.activityKind == .read }) { descriptions.append("Read files") }
    if tools.contains(where: { $0.0.activityKind == .search }) { descriptions.append("Searched") }
    if tools.contains(where: { $0.0.activityKind == .execute }) {
      descriptions.append("Ran commands")
    }
    if tools.contains(where: { ![.read, .search, .execute].contains($0.0.activityKind) }) {
      descriptions.append("Used tools")
    }
    let summary = descriptions.enumerated().map {
      $0.offset == 0 ? $0.element : $0.element.lowercased()
    }.joined(separator: ", ")
    var notes: [String] = []
    let failed = tools.filter { $0.1 == .failed }.count
    let unconfirmed = tools.filter { $0.1 == .unconfirmed }.count
    if failed > 0 { notes.append("\(failed) failed") }
    if tools.contains(where: { $0.1 == .approval }) { notes.append("Approval needed") }
    if unconfirmed > 0 { notes.append("\(unconfirmed) unconfirmed") }
    title = ([summary.isEmpty ? "Thought" : summary] + notes).joined(separator: " · ")
    icon = tools.first?.0.activityKind?.icon ?? (tools.isEmpty ? "brain" : "wrench")
  }
}
