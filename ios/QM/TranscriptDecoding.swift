import Foundation

extension Transcript {
  private enum CodingKeys: String, CodingKey {
    case entries, items, earlierEntries, earlierItems, pins, session, goal
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let usesItems = values.contains(.items)
    entries = try values.decode([Entry].self, forKey: usesItems ? .items : .entries)
    earlierEntries = try values.decodeIfPresent(
      Int.self, forKey: usesItems ? .earlierItems : .earlierEntries)
    pins = try values.decodeIfPresent([NativeConversationPin].self, forKey: .pins)
    session = try values.decodeIfPresent(Conversation.self, forKey: .session)
    goal = try values.decodeIfPresent(Conversation.Goal.self, forKey: .goal)
  }
}

struct TranscriptEntryResponse: Decodable {
  let entry: Entry

  private enum CodingKeys: String, CodingKey { case entry, item }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    entry = try values.decode(Entry.self, forKey: values.contains(.item) ? .item : .entry)
  }
}

extension Entry {
  private enum CodingKeys: String, CodingKey {
    case type, payload, createdAt, seq, truncated, item, marker, phase, streamOffset
    case kind, body, text, variant, turnId, callId, tool, elicitId, isError, hidden, externalId
    case throughSeq, approved, blobSha, wakeCause, step, author, errorCode
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    if values.contains(.item) {
      self = try values.decode(Entry.self, forKey: .item)
      return
    }
    createdAt = try values.decode(Double.self, forKey: .createdAt)
    truncated = try values.decodeIfPresent(Bool.self, forKey: .truncated)
    if values.contains(.marker) {
      type = try values.decode(String.self, forKey: .marker)
      seq = try values.decode(Int.self, forKey: .seq)
      var fields: [String: NativeActivityValue] = [:]
      fields["phase"] = try values.decodeIfPresent(NativeActivityValue.self, forKey: .phase)
      fields["streamOffset"] = try values.decodeIfPresent(
        NativeActivityValue.self, forKey: .streamOffset)
      payload = try Self.payload(fields)
      id = "\(seq ?? -1):\(createdAt):\(type)"
      return
    }
    guard values.contains(.kind) else {
      type = try values.decode(String.self, forKey: .type)
      payload = try values.decodeIfPresent(EntryPayload.self, forKey: .payload)
      seq = try values.decodeIfPresent(Int.self, forKey: .seq)
      id = "\(seq ?? -1):\(createdAt):\(type)"
      return
    }
    let kind = try values.decode(String.self, forKey: .kind)
    itemKind = kind
    seq = try values.decode(Int.self, forKey: .seq)
    let variant = try values.decodeIfPresent(String.self, forKey: .variant)
    var fields = try values.decode([String: NativeActivityValue].self, forKey: .body)
    let textKey: String?
    switch kind {
    case "UserMessage", "SteeringMessage":
      type = "user"
      textKey = "text"
    case "AgentMessage":
      type =
        variant == "narration" ? "text" : variant == "files_delivered" ? "delivery" : "assistant"
      textKey = "text"
    case "Reasoning":
      type = "thinking"
      textKey = "thinking"
    case "ToolCall":
      type = "tool_call"
      textKey = nil
    case "ToolResult":
      type = "tool_result"
      textKey = "result"
    case "Elicitation":
      type = "approval_request"
      textKey = nil
    case "ElicitationResponse":
      type = "approval_resolved"
      textKey = nil
    default:
      type = "system"
      textKey = kind == "Error" ? "message" : kind == "ContextCompaction" ? "text" : nil
      let systemKinds = [
        "ContextCompaction": "context_summary", "Retraction": "message_revision",
        "Error": "turn_failure", "Stop": "turn_stopped", "Wake": "wake",
      ]
      fields["kind"] = fields["kind"] ?? .string(systemKinds[kind] ?? kind)
    }
    if let textKey {
      let text = try values.decodeIfPresent(String.self, forKey: .text)
      fields[textKey] = text.map(NativeActivityValue.string) ?? fields[textKey] ?? .string("")
    }
    let stringColumns: [(CodingKeys, String)] = [
      (.turnId, "runId"), (.callId, "callId"), (.tool, "tool"), (.elicitId, "requestId"),
      (.externalId, "ts"), (.wakeCause, "cause"), (.author, "author"), (.errorCode, "errorCode"),
    ]
    for (column, field) in stringColumns {
      if let value = try values.decodeIfPresent(String.self, forKey: column) {
        fields[field] = .string(value)
      }
    }
    for column in [CodingKeys.isError, .hidden, .approved] {
      if let value = try values.decodeIfPresent(Bool.self, forKey: column) {
        fields[column.rawValue] = .bool(value)
      }
    }
    if let throughSeq = try values.decodeIfPresent(Int.self, forKey: .throughSeq) {
      fields["throughSeq"] = .number(Decimal(throughSeq))
    }
    if kind == "ToolCall" || kind == "ToolResult" {
      _ = try values.decode(String.self, forKey: .callId)
    }
    if kind == "Elicitation" || kind == "ElicitationResponse" {
      _ = try values.decode(String.self, forKey: .elicitId)
    }
    if kind == "SteeringMessage" { fields["steered"] = .bool(true) }
    if let blob = try values.decodeIfPresent(String.self, forKey: .blobSha) {
      var output: [String: NativeActivityValue] = [:]
      if case .object(let existing) = fields["output"] { output = existing }
      output["blob"] = .string(blob)
      fields["output"] = .object(output)
    }
    var step: [String: NativeActivityValue] = [:]
    if case .object(let message) = fields["wire"]?["message"] { step = message }
    if let index = try values.decodeIfPresent(Int.self, forKey: .step) {
      step["index"] = .number(Decimal(index))
    }
    if !step.isEmpty { fields["step"] = .object(step) }
    payload = try Self.payload(fields)
    id = "\(seq ?? -1):\(createdAt):\(type)"
  }

  private static func payload(_ fields: [String: NativeActivityValue]) throws -> EntryPayload {
    try JSONDecoder().decode(EntryPayload.self, from: JSONEncoder().encode(fields))
  }
}
