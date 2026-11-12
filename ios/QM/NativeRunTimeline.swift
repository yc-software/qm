import Foundation

struct NativeRunTimeline {
  struct LiveText {
    let start: Int?
    let startIsRecorded: Bool
    let deliveredPost: Bool
    let finalText: String?
    let assistantTexts: Set<String>

    func callAsFunction(_ partial: String, startOffset: Int, finalReply: Bool) -> String {
      if !finalReply, let start {
        return startIsRecorded
          ? ""
          : String(decoding: partial.utf16.dropFirst(max(0, start - startOffset)), as: UTF16.self)
      }
      if finalReply ? deliveredPost || finalText == partial : assistantTexts.contains(partial) {
        return ""
      }
      return partial
    }
  }

  let messages: [ChatMessage]
  let responding: Bool
  let liveText: LiveText

  init(
    activity: [Entry], partial: String, startOffset: Int, runID: String,
    recorded: [ChatMessage], finalReply: Bool = false
  ) {
    let projected = chatMessages(activity, runID: runID)
    let presented = Set(recorded.map(\.id))
    let consumed = Set((recorded + projected).flatMap(\.activity).map(\.id))
    var messages = projected.filter { !presented.contains($0.id) }
    let recordedActivity = Set(recorded.flatMap(\.activity).map(\.id))
    for index in messages.indices {
      messages[index].activity.removeAll { recordedActivity.contains($0.id) }
    }
    let tail = activity.filter { NativeWorkItem.supports($0) && !consumed.contains($0.id) }
    let lastText = activity.last { $0.type == "text_start" || $0.type == "text" }
    let runMessages = (recorded + projected).filter { $0.runID == runID }
    let runMessageIDs = Set(runMessages.map(\.id))
    var start: Int?
    if let marker = activity.last(where: { $0.type == "text_start" }),
      case .number(let offset) = marker.payload?.details?["streamOffset"]
    {
      start = NSDecimalNumber(decimal: offset).intValue
    }
    let liveText = LiveText(
      start: start, startIsRecorded: lastText?.type == "text",
      deliveredPost: (activity + recorded.flatMap(\.activity)).contains {
        $0.type == "tool_call" && $0.payload?.action == "post" && runMessageIDs.contains($0.id)
      },
      finalText: activity.last?.id == lastText?.id && lastText?.type == "text"
        && lastText?.payload?.details?["phase"] == .string("final_answer")
        ? lastText?.payload?.text : nil,
      assistantTexts: Set(runMessages.lazy.filter { $0.role == "assistant" }.map(\.text)))
    let text = liveText(partial, startOffset: startOffset, finalReply: finalReply)
    responding = !text.isEmpty
    messages.append(
      ChatMessage(
        id: "live:\(runID):\(projected.last?.id ?? "start")", role: "assistant", text: text,
        runID: runID, activity: tail))
    self.messages = messages
    self.liveText = liveText
  }
}

struct NativeChatTimelineItem: Identifiable {
  enum Content {
    case message(ChatMessage)
    case work(NativeWorkItem)
    case reasoning(RunReasoning)
  }

  let id: String
  var content: Content
  let runID: String?
  let sequence: Int?
  var active = false
  var turnFailed = false
  var streaming = false
  var workDuration: Double? = nil

  func isInherited(in conversation: Conversation) -> Bool {
    guard conversation.forkedFrom != nil, let boundary = conversation.forkBoundarySeq,
      let sequence
    else { return false }
    return sequence <= boundary
  }
}

struct NativeChatTimeline {
  let items: [NativeChatTimelineItem]

  init(
    messages: [ChatMessage], entries: [Entry], activeRunID: String? = nil,
    reasoning: [RunReasoning] = [], reasoningAfterText: Set<String> = [],
    streamingMessageID: String? = nil
  ) {
    var seen = Set<String>()
    let recorded = (entries + messages.flatMap(\.activity)).enumerated()
      .filter { seen.insert($0.element.id).inserted }
      .sorted {
        let left = $0.element.seq ?? Int.max
        let right = $1.element.seq ?? Int.max
        return left == right ? $0.offset < $1.offset : left < right
      }.map(\.element)
    let groups = Dictionary(grouping: recorded.filter { $0.stepID != nil }) { $0.stepID! }
    var emittedSteps = Set<String>()
    let entries = recorded.flatMap { entry -> [Entry] in
      guard let stepID = entry.stepID else { return [entry] }
      guard emittedSteps.insert(stepID).inserted else { return [] }
      return (groups[stepID] ?? []).enumerated().sorted {
        let left = $0.element.stepIndex ?? Int.max
        let right = $1.element.stepIndex ?? Int.max
        return left == right ? $0.offset < $1.offset : left < right
      }.map(\.element)
    }
    let entryOrder = Dictionary(uniqueKeysWithValues: entries.enumerated().map { ($1.id, $0) })
    var entryRuns: [String: String] = [:]
    for message in messages {
      entryRuns[message.id] = message.runID
      for entry in message.activity { entryRuns[entry.id] = message.runID }
    }
    var currentRunID: String?
    for entry in entries {
      if entry.type == "user", entry.payload?.steered != true {
        currentRunID = entry.payload?.runId
      } else if let runID = entry.payload?.runId {
        currentRunID = runID
      }
      if entryRuns[entry.id] == nil { entryRuns[entry.id] = currentRunID }
    }
    let runPositions = Dictionary(grouping: entries.enumerated()) {
      entryRuns[$0.element.id] ?? ""
    }.mapValues { $0.map(\.offset) }
    var work: [NativeWorkItem] = []
    var calls: [String: Int] = [:]
    for entry in entries where NativeWorkItem.supports(entry) {
      let callKey = (entryRuns[entry.id] ?? "") + ":" + (entry.payload?.callId ?? entry.id)
      if entry.type == "tool_result", let index = calls[callKey], work[index].result == nil {
        work[index].result = entry
      } else {
        if entry.type == "tool_call" { calls[callKey] = work.count }
        work.append(NativeWorkItem(entry: entry, result: entry.type == "tool_result" ? entry : nil))
      }
    }
    var ordered: [(item: NativeChatTimelineItem, position: Int, rank: Int, order: Int)] = []
    let hasStreamingText = messages.contains { $0.id == streamingMessageID && !$0.text.isEmpty }
    let failedRuns = Set(messages.lazy.filter { $0.role == "error" }.map(\.runID))
    for item in work {
      let runID = entryRuns[item.entry.id]
      let followsText =
        hasStreamingText && runID == activeRunID
        && item.entry.reasoningID.map(reasoningAfterText.contains) == true
      ordered.append(
        (
          NativeChatTimelineItem(
            id: "work:\(item.id)", content: .work(item), runID: runID, sequence: item.entry.seq,
            active: activeRunID != nil && runID == activeRunID,
            turnFailed: failedRuns.contains(runID)),
          followsText
            ? runPositions[runID ?? ""]?.max() ?? 0 : entryOrder[item.entry.id] ?? Int.max,
          followsText ? 3 : 0, entryOrder[item.entry.id] ?? Int.max
        ))
    }
    let persistedReasoning = Set(work.compactMap { $0.entry.reasoningID })
    for (index, block) in reasoning.enumerated() where !persistedReasoning.contains(block.id) {
      ordered.append(
        (
          NativeChatTimelineItem(
            id: "work:\(block.id)", content: .reasoning(block), runID: activeRunID,
            sequence: nil, active: true),
          runPositions[activeRunID ?? ""]?.max() ?? max(0, entries.count - 1),
          reasoningAfterText.contains(block.id) ? 3 : 1, index
        ))
    }
    var previousPosition = 0
    for (index, message) in messages.enumerated() {
      guard
        message.notice != nil || !message.text.isEmpty || !message.files.isEmpty
          || !message.playgrounds.isEmpty || message.role == "error"
      else { continue }
      let positions = runPositions[message.runID ?? ""] ?? []
      let sourcePosition =
        entryOrder[message.id].flatMap { index in
          entries[index].seq == message.sequence ? index : nil
        } ?? message.sequence.flatMap { sequence in entries.firstIndex { $0.seq == sequence } }
      let beforePosition =
        sourcePosition == nil
        ? message.sequence.flatMap { sequence in
          entries.firstIndex { ($0.seq ?? Int.max) > sequence }
        } : nil
      let position =
        sourcePosition ?? beforePosition
        ?? (message.role == "user" ? positions.min() : positions.max())
        ?? previousPosition
      previousPosition = position
      ordered.append(
        (
          NativeChatTimelineItem(
            id: message.id, content: .message(message), runID: message.runID,
            sequence: message.sequence, streaming: message.id == streamingMessageID),
          position,
          sourcePosition != nil
            ? 0
            : beforePosition != nil || message.role == "user" && !positions.isEmpty ? -1 : 2,
          index
        ))
    }
    var items = ordered.enumerated().sorted {
      let left = $0.element
      let right = $1.element
      if left.position != right.position { return left.position < right.position }
      if left.rank != right.rank { return left.rank < right.rank }
      if left.order != right.order { return left.order < right.order }
      return $0.offset < $1.offset
    }.map(\.element.item)
    var durations: [String: Double] = [:]
    for entry in entries {
      if let runID = entryRuns[entry.id], let duration = entry.workDuration {
        durations[runID] = duration
      }
    }
    var timedRuns = Set<String>()
    for index in items.indices.reversed() {
      if case .message = items[index].content { continue }
      if let runID = items[index].runID, timedRuns.insert(runID).inserted {
        items[index].workDuration = durations[runID]
      }
    }
    self.items = items
  }
}

struct NativeChatTranscriptSection: Identifiable {
  let id: String
  var items: [NativeChatTimelineItem]
  let runID: String?
  var status: NativeReadOnlyWorkStatus?
  var workDuration: Double? = nil

  var isActivity: Bool {
    guard let first = items.first else { return true }
    if case .message = first.content { return false }
    return true
  }

  var workState: NativeWorkItem.State? {
    let states = items.compactMap { item -> NativeWorkItem.State? in
      guard case .work(let work) = item.content, !work.isThinking else { return nil }
      return work.state(active: item.active, turnFailed: item.turnFailed)
    }
    return [.failed, .approval, .running, .unconfirmed, .complete].first { states.contains($0) }
  }

  static func grouped(
    _ items: [NativeChatTimelineItem], activeRunID: String?,
    status: NativeReadOnlyWorkStatus?
  ) -> [Self] {
    var sections: [Self] = []
    for item in items {
      if case .message = item.content {
        sections.append(Self(id: item.id, items: [item], runID: item.runID))
      } else if let last = sections.last, last.isActivity, last.runID == item.runID {
        sections[sections.count - 1].items.append(item)
        if let duration = item.workDuration { sections[sections.count - 1].workDuration = duration }
      } else {
        sections.append(
          Self(
            id: "activity:\(item.runID ?? "history"):\(item.id)", items: [item], runID: item.runID,
            workDuration: item.workDuration))
      }
    }
    let answering: Bool
    if let activeRunID, let last = items.last, last.runID == activeRunID,
      case .message(let message) = last.content
    {
      answering = message.role == "assistant" && !message.text.isEmpty
    } else {
      answering = false
    }
    if let status, status != .working || !answering {
      if let last = sections.last, last.isActivity, last.runID == activeRunID {
        sections[sections.count - 1].status = status
      } else {
        sections.append(
          Self(
            id: "activity:\(activeRunID ?? "current"):pending", items: [],
            runID: activeRunID, status: status))
      }
    }
    return sections
  }
}

extension Entry {
  var workDuration: Double? {
    guard case .number(let start) = payload?.details?["workStartedAt"],
      case .number(let end) = payload?.details?["workFinishedAt"]
    else { return nil }
    let seconds = NSDecimalNumber(decimal: (end - start) / 1000).doubleValue
    return seconds.isFinite && seconds >= 0 ? seconds : nil
  }
}
