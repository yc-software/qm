import Foundation

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
  let elicitId: String?
  let step: Int?
  let errorCode: String?
  let body: ItemBody?
  let details: NativeActivityValue?
  var id: String { "\(seq ?? -1):\(createdAt):\(kind)" }

  enum CodingKeys: String, CodingKey {
    case item, marker, kind, createdAt, seq, truncated, turnId, callId, text, tool, variant,
      isError, hidden, externalId, approved, elicitId, step, errorCode, body
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if c.contains(.item) {
      self = try c.decode(Item.self, forKey: .item)
      return
    }
    kind = try c.decode(String.self, forKey: c.contains(.marker) ? .marker : .kind)
    createdAt = try c.decode(Double.self, forKey: .createdAt)
    seq = try c.decodeIfPresent(Int.self, forKey: .seq)
    truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated)
    turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
    callId = try c.decodeIfPresent(String.self, forKey: .callId)
    text = try c.decodeIfPresent(String.self, forKey: .text)
    tool = try c.decodeIfPresent(String.self, forKey: .tool)
    variant = try c.decodeIfPresent(String.self, forKey: .variant)
    isError = try c.decodeIfPresent(Bool.self, forKey: .isError)
    hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
    externalId = try c.decodeIfPresent(String.self, forKey: .externalId)
    approved = try c.decodeIfPresent(Bool.self, forKey: .approved)
    elicitId = try c.decodeIfPresent(String.self, forKey: .elicitId)
    step = try c.decodeIfPresent(Int.self, forKey: .step)
    errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
    body = try c.decodeIfPresent(ItemBody.self, forKey: .body)
    if kind == "ToolCall" || kind == "ToolResult" { _ = try c.decode(String.self, forKey: .callId) }
    if kind == "Elicitation" || kind == "ElicitationResponse" {
      _ = try c.decode(String.self, forKey: .elicitId)
    }
    details = Self.fields(try NativeActivityValue(from: decoder))
  }

  private static func fields(_ item: NativeActivityValue) -> NativeActivityValue? {
    guard case .object(var values) = item else { return nil }
    let body = values.removeValue(forKey: "body")
    for key in ["sessionId", "seq", "createdAt", "kind", "turnId", "truncated"] {
      values[key] = nil
    }
    values = values.filter { $0.value != .null }
    if case .object(var rest) = body {
      rest["wire"] = nil
      values.merge(rest) { column, _ in column }
    }
    return .object(values)
  }

  var presentationRole: String {
    switch kind {
    case "UserMessage", "SteeringMessage": "user"
    case "AgentMessage":
      variant == "narration" ? "text" : variant == "files_delivered" ? "delivery" : "assistant"
    case "Reasoning": "thinking"
    case "ToolCall": "tool_call"
    case "ToolResult": "tool_result"
    case "Elicitation": "approval_request"
    case "ElicitationResponse": "approval_resolved"
    case "text_start": "text_start"
    default: "system"
    }
  }
  var isHumanPrompt: Bool {
    guard ["UserMessage", "SteeringMessage"].contains(kind), !isHidden,
      details?["overheard"] != .bool(true)
    else { return false }
    return (details?["speakerId"] != nil && details?["speakerId"] != .null)
      || details?["slackReplyReceipt"] == .bool(true)
      || kind == "SteeringMessage" && details?["author"] != nil
  }

  var steered: Bool { kind == "SteeringMessage" }
  var isHidden: Bool { hidden == true || body?.hidden == true }
  var messageTs: String? { externalId ?? body?.ts }
  var succeeded: Bool { isError != true && body?.succeeded != false }
}

struct ItemBody: Decodable {
  struct Wire: Decodable {
    struct Message: Decodable { let id: String? }
    let message: Message?
  }
  let wire: Wire?
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
    case wire, display, hidden, attachments, files, action, ok, denied, blocked, error, name,
      silent, text, redacted, command, scope, ts
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    wire = c.logged(Wire.self, forKey: .wire)
    let fields = try NativeActivityValue(from: decoder)
    display = fields["display"]?.string
    if case .object = fields["display"] {
      playground = c.logged(Display.self, forKey: .display)?.artifact
    } else {
      playground = nil
    }
    hidden = c.logged(Bool.self, forKey: .hidden)
    attachments = c.logged([DeliveredFile].self, forKey: .attachments)
    files = c.logged([DeliveredFile].self, forKey: .files)
    action = c.logged(String.self, forKey: .action)
    ok = c.logged(Bool.self, forKey: .ok)
    denied = c.logged(Bool.self, forKey: .denied)
    blocked = c.logged(String.self, forKey: .blocked)
    switch fields["error"] {
    case .string(let message): error = message
    case nil, .null, .bool(false): error = nil
    default: error = "error"
    }
    name = c.logged(String.self, forKey: .name)
    silent = c.logged(Bool.self, forKey: .silent)
    text = c.logged(String.self, forKey: .text)
    redacted = c.logged(Bool.self, forKey: .redacted)
    command = c.logged(String.self, forKey: .command)
    scope = c.logged(String.self, forKey: .scope)
    ts = c.logged(String.self, forKey: .ts)
  }

  var succeeded: Bool { ok != false && denied != true && blocked == nil && error == nil }
}

struct NativePlayground: Decodable, Identifiable {
  let kind: String
  let artifactId: String
  let title: String
  var id: String { artifactId }
}
