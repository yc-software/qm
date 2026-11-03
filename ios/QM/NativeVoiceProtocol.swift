import Foundation

enum NativeVoiceAction: Equatable {
  case submit(text: String, delegation: String?)
  case steer(text: String, delegation: String?, remark: Bool)
}

struct NativeVoiceBridge {
  struct Heard {
    let text: String
    let start: Double
    let end: Double
    let at: Double
    let busy: Bool
    var sent = false
    var handled = false
  }
  private struct Said {
    let text: String
    let start: Double
  }
  static let settleSeconds = 0.35
  static let remarkSeconds = 3.5
  static let requestPrefix = "Voice request (speech transcript; may contain recognition errors): "
  static let remarkPrefix =
    "Said while you worked (speech transcript; the voice did not hand this off, so it may be only a remark). If it corrects or adds to the current task, apply it. Otherwise ignore it completely: no tools and no reply about it, and keep your final answer about the task. It was: "
  static let exchangeMark = "\n\nWhat we said since my last request, oldest first:\n"
  static let spokenNote =
    "\n\nYour final answer will be read aloud: give the outcome first in one to three sentences, with no code, links, tables, or long lists."
  static let greeting = "Greet the user briefly and ask what they want to work on."
  static let started =
    "I've started on it. The result arrives as an update; do not state any result before that."
  static let steered =
    "I was already working; this was added to the running task. The result arrives as an update."
  static let unconfirmed =
    "I could not confirm what happened to that request. Tell the user to check the QM conversation before asking again; do not say it succeeded or failed."
  static let approval =
    "QM needs the user's approval before it can continue. Tell them to review it in the QM conversation; agreeing out loud does not approve it, and nothing has been approved yet."

  private(set) var heard: [Heard] = []
  private var said: [Said] = []
  private var consumed = -Double.infinity
  private var remarked = false
  private(set) var waiting: (id: String, offset: Double, deadline: Double)?
  private(set) var delegation: String?
  private var runs: [String] = []
  private var pending: Set<String> = []
  private var progress: String?
  private var runDelegations: [String: String] = [:]
  private var sequence = 0
  private let prefix = "qm_\(UUID().uuidString.prefix(8).lowercased())_"
  var outgoing: [[String: Any]] = []

  var activeRun: String? { runs.first }
  var busy: Bool { activeRun != nil }
  func isLive(_ run: String) -> Bool { runs.contains(run) }

  mutating func takeOutgoing(canSend: Bool) -> [[String: Any]] {
    guard canSend else { return [] }
    let events = outgoing
    outgoing = []
    return events
  }

  mutating func event(_ type: String) -> [String: Any] {
    sequence += 1
    return ["type": type, "event_id": "\(prefix)\(sequence)"]
  }

  mutating func receive(_ event: [String: Any], now: Double) -> [NativeVoiceAction] {
    switch event["type"] as? String {
    case "session.input_transcript.delta":
      guard let text = event["delta"] as? String,
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return [] }
      let start = Self.number(event["start_ms"]) ?? heard.last?.end ?? 0
      let end = max(Self.number(event["end_ms"]) ?? start + 1, start)
      heard.append(.init(text: text, start: start, end: end, at: now, busy: busy))
      if heard.count > 400 { heard.removeFirst(heard.count - 400) }
      if let waiting, end >= waiting.offset { return release() }
      return []
    case "session.output_transcript.delta":
      guard let text = event["delta"] as? String else { return [] }
      said.append(.init(text: text, start: Self.number(event["start_ms"]) ?? heard.last?.end ?? 0))
      if said.count > 200 { said.removeFirst(said.count - 200) }
      return []
    case "session.delegation.created":
      guard let delegation = event["delegation"] as? [String: Any],
        let id = delegation["id"] as? String, !id.isEmpty
      else { return [] }
      append("session.thinking.append", id, "")
      let earlier = release()
      let offset = Self.number(event["offset_ms"]) ?? .infinity
      if (heard.last?.end ?? -.infinity) >= offset { return earlier + handOff(id) }
      waiting = (id, offset, now + Self.settleSeconds)
      return earlier
    default:
      return []
    }
  }

  mutating func tick(now: Double) -> [NativeVoiceAction] {
    if let waiting, now >= waiting.deadline { return release() }
    guard busy, waiting == nil else { return [] }
    let pending = heard.indices.filter { heard[$0].busy && !heard[$0].sent && !heard[$0].handled }
    guard let newest = pending.last, now - heard[newest].at >= Self.remarkSeconds else { return [] }
    let words = Self.join(pending.map { heard[$0] })
    let id = activeRun.flatMap { runDelegations[$0] } ?? delegation
    for index in pending { heard[index].handled = true }
    for index in pending { heard[index].sent = true }
    consumed = max(consumed, pending.map { heard[$0].end }.max() ?? consumed)
    remarked = true
    append(
      "session.thinking.append", id,
      "The user's words \"\(words)\" went to the running task as a remark; it applies them only if they change the task. Do not say they were done unless the result says so."
    )
    return [.steer(text: Self.remarkPrefix + words, delegation: id, remark: true)]
  }

  mutating func observe(run: String) {
    if !runs.contains(run) { runs.append(run) }
  }

  mutating func started(run: String, delegation: String?) {
    observe(run: run)
    if let delegation {
      pending.remove(delegation)
      runDelegations[run] = delegation
    }
    append("session.thinking.append", delegation, Self.started)
  }

  mutating func steered(run: String, delegation: String?, remark: Bool) {
    if let delegation { runDelegations[run] = delegation }
    if !remark { append("session.thinking.append", delegation, Self.steered) }
  }

  mutating func progress(_ line: String, run: String) {
    guard activeRun == run, line != progress else { return }
    progress = line
    append("session.thinking.append", runDelegations[run], "QM is working. Latest step: \(line)")
  }

  mutating func say(_ text: String, delegation: String?) {
    append("session.commentary.append", delegation, text)
  }

  mutating func unconfirmed(delegation: String?) {
    append("session.commentary.append", delegation, Self.unconfirmed)
  }

  @discardableResult mutating func finish(
    run: String?, delegation: String? = nil, status: String?, reply: String?, reason: String?
  ) -> String? {
    let id = delegation ?? run.flatMap { runDelegations.removeValue(forKey: $0) }
    if let delegation { pending.remove(delegation) }
    if let run {
      if activeRun == run { progress = nil }
      runs.removeAll { $0 == run }
    }
    let lost = heard.indices.filter { heard[$0].busy && !heard[$0].sent && !heard[$0].handled }
    let words = Self.join(lost.map { heard[$0] })
    for index in lost { heard[index].handled = true }
    remarked = false
    guard let text = Self.result(status: status, reply: reply, reason: reason, requested: id != nil)
    else { return nil }
    if !words.isEmpty {
      append(
        "session.thinking.append", id,
        "While QM worked the user said \"\(words)\", and it did not reach the task: the update that follows is all that was done. If those words asked for something to be done, say in one short sentence which part was not done. If they were thanks, an opinion, or thinking aloud, do not mention them."
      )
    }
    append("session.commentary.append", id, text)
    return text
  }

  private mutating func release() -> [NativeVoiceAction] {
    guard let waiting else { return [] }
    self.waiting = nil
    return handOff(waiting.id)
  }

  private mutating func handOff(_ id: String) -> [NativeVoiceAction] {
    let from = consumed
    let fresh = heard.indices.filter { heard[$0].end > from && !heard[$0].sent }
    let lastStart = fresh.last.map { heard[$0].start } ?? -.infinity
    let pivot = said.last(where: { $0.start > from && $0.start < lastStart })?.start
    let words = Self.join(
      fresh.filter { heard[$0].start > (pivot ?? -.infinity) }.map { heard[$0] })
    var exchange = ""
    if let pivot {
      let users = fresh.filter { heard[$0].start <= pivot }.map {
        (true, heard[$0].text, heard[$0].start)
      }
      let voice = said.filter { $0.start > from && $0.start <= pivot }.map {
        (false, $0.text, $0.start)
      }
      exchange = Self.lines((users + voice).sorted { $0.2 < $1.2 }.map { ($0.0, $0.1) })
    }
    for index in fresh { heard[index].sent = true }
    consumed = max(consumed, fresh.map { heard[$0].end }.max() ?? consumed)
    delegation = id
    if words.isEmpty {
      append(
        "session.thinking.append", id,
        remarked && busy
          ? "Already added to the running task."
          : busy || !pending.isEmpty
            ? "That request is already with QM; its result arrives as an update."
            : "No request was heard for this hand-off; ask the user to repeat it.")
      return []
    }
    remarked = false
    let text =
      Self.requestPrefix + words + (exchange.isEmpty ? "" : Self.exchangeMark + exchange)
      + Self.spokenNote
    if busy { return [.steer(text: text, delegation: id, remark: false)] }
    pending.insert(id)
    return [.submit(text: text, delegation: id)]
  }

  private mutating func append(_ type: String, _ delegation: String?, _ content: String) {
    var event = event(type)
    event["delegation_id"] = delegation ?? NSNull()
    event["content"] = Self.clip(content, tokens: 400)
    outgoing.append(event)
  }

  static func result(status: String?, reply: String?, reason: String?, requested: Bool) -> String? {
    switch status {
    case "pending_approval":
      return approval
    case "unconfirmed":
      return requested ? unconfirmed : nil
    case "failed", "refused":
      return "QM could not finish: \(spoken(reason ?? "it gave no reason."))"
    default:
      if let reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return spoken(reply)
      }
      return requested
        ? "QM finished without a reply to read out. The details are in the QM conversation." : nil
    }
  }

  static func briefing(_ messages: [(user: Bool, text: String)], working: Bool) -> String? {
    var lines: [String] = []
    var count = 0
    for message in messages.reversed() {
      let text = message.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      guard !text.isEmpty else { continue }
      let line = "- \(message.user ? "User" : "QM"): \(clip(text, tokens: 150))"
      guard count + line.count <= 6000 else { break }
      lines.insert(line, at: 0)
      count += line.count
    }
    if working { lines.append("QM is working on a request in this conversation right now.") }
    guard !lines.isEmpty else { return nil }
    return "Recent messages in this QM conversation, oldest first (context, not requests):\n"
      + lines.joined(separator: "\n")
  }

  static func spoken(_ text: String) -> String {
    let linked = text.replacing(/\[([^\]]+)\]\((?:[^()\s]|\([^)\s]*\))+\)/) { String($0.output.1) }
    return clip(linked.replacing(/<?https?:\/\/[^\s>)]+>?/, with: "(link)"), tokens: 400)
  }

  static func clip(_ text: String, tokens limit: Int) -> String {
    var tokens = 0
    var end = text.startIndex
    for match in text.matches(of: /[A-Za-z]+|\s+|[\s\S]/) {
      let value = match.output
      let cost: Int
      if value.first?.isASCII == true && value.first?.isLetter == true {
        let letters = value.contains(/[a-z][A-Z]/) ? 2 : 4
        cost = (value.count + letters - 1) / letters
      } else if value.allSatisfy(\.isWhitespace) {
        cost = value.contains("\n") ? 1 : 0
      } else {
        cost = value.first?.isASCII == true ? 1 : 2
      }
      if tokens + cost > limit { return String(text[..<end]) + "…" }
      tokens += cost
      end = match.range.upperBound
    }
    return text
  }

  private static func join(_ fragments: [Heard]) -> String {
    fragments.map(\.text).joined().split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  private static func lines(_ parts: [(Bool, String)]) -> String {
    var merged: [(Bool, String)] = []
    for (user, text) in parts {
      if let last = merged.last, last.0 == user {
        merged[merged.count - 1].1 += text
      } else {
        merged.append((user, text))
      }
    }
    var kept: [String] = []
    var count = 0
    for (user, text) in merged.reversed() {
      let words = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      guard !words.isEmpty else { continue }
      let line = "- \(user ? "User" : "You (voice)"): \(words)"
      guard count + line.count <= 2000 else { break }
      kept.insert(line, at: 0)
      count += line.count
    }
    return kept.joined(separator: "\n")
  }

  private static func number(_ value: Any?) -> Double? {
    let number = (value as? NSNumber)?.doubleValue ?? (value as? Double)
    return number.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
  }
}
