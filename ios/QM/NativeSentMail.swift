import SwiftUI

struct NativeSentEmail: Decodable, Identifiable {
  struct Message: Decodable {
    let from: String
    let to: String
    let cc: String?
    let sentAt: Double
    let body: String
    let attachments: [String]?
  }
  var accountType: String?
  let id: String
  let threadId: String
  let to: String
  let subject: String
  let snippet: String?
  let sentAt: Double
  let conversation: [Message]?
  let from: String?
  let cc: String?
  let body: String?
  let html: Bool?
  let attachments: [String]?
  let rfcMessageId: String?
  var plainBody: String { html == true ? Self.plain(body ?? "") : body ?? "" }
  static let chatLimit = 50000
  var chatSource: String {
    guard let conversation, !conversation.isEmpty else { return plainBody }
    return conversation.map { "\($0.from) to \($0.to):\n\($0.body)" }.joined(separator: "\n\n")
  }
  var chatTrimmed: Bool { chatSource.utf16.count > Self.chatLimit }
  var chatText: String {
    let text = chatSource
    guard text.utf16.count > Self.chatLimit else { return text }
    return String(text[..<String.Index(utf16Offset: Self.chatLimit, in: text)])
  }
  static func plain(_ html: String) -> String {
    var text = html.replacingOccurrences(
      of: "(?is)<(script|style)\\b[^>]*>.*?</\\1\\s*>", with: "", options: .regularExpression
    )
    .replacingOccurrences(
      of: "(?i)<br\\s*/?>|</(?:p|div|tr|li|h[1-6])>", with: "\n", options: .regularExpression
    )
    .replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
    let numeric = try! NSRegularExpression(pattern: "&#(x[0-9a-fA-F]+|[0-9]+);")
    for match in numeric.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed()
    {
      guard let range = Range(match.range(at: 1), in: text),
        let whole = Range(match.range, in: text)
      else { continue }
      let value = String(text[range])
      let number = value.hasPrefix("x") ? UInt32(value.dropFirst(), radix: 16) : UInt32(value)
      if let number, let scalar = UnicodeScalar(number) {
        text.replaceSubrange(whole, with: String(scalar))
      }
    }
    for (entity, value) in [
      ("&nbsp;", " "), ("&quot;", "\""), ("&apos;", "'"), ("&lt;", "<"), ("&gt;", ">"),
      ("&amp;", "&"),
    ] {
      text = text.replacingOccurrences(of: entity, with: value)
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
struct NativeSentMailPage: Decodable {
  let accountType: String?
  let messages: [NativeSentEmail]
  let nextPageToken: String?
  let accountEmail: String
}

@MainActor @Observable
final class SentMailModel {
  let client: APIClient
  var messages: [NativeSentEmail] = []
  var accountEmail = ""
  var accountType: String?
  var nextPage: String?
  var busy = false
  var error: String?
  private var visited: Set<String> = []
  init(client: APIClient) { self.client = client }
  func load(more: Bool = false) async {
    guard !busy, !more || nextPage != nil else { return }
    busy = true
    defer { busy = false }
    do {
      var query: [URLQueryItem] = []
      if more {
        query.append(.init(name: "pageToken", value: nextPage))
        if let accountType { query.append(.init(name: "accountType", value: accountType)) }
      }
      let result: NativeSentMailPage = try await client.fetch("api/inbox/sent", query: query)
      try Task.checkCancellation()
      if !more {
        visited = []
        messages = []
      }
      if more, let nextPage { visited.insert(nextPage) }
      accountType = result.accountType ?? accountType
      accountEmail = result.accountEmail
      var keys = Set(messages.map { ($0.accountType ?? "default") + "|" + $0.id })
      messages.append(
        contentsOf: result.messages.compactMap { original in
          var message = original
          message.accountType = message.accountType ?? result.accountType ?? "default"
          return keys.insert((message.accountType ?? "default") + "|" + message.id).inserted
            ? message : nil
        })
      nextPage = result.nextPageToken
      if let nextPage, visited.contains(nextPage) {
        self.nextPage = nil
        throw QMError.message("The mail list did not advance. Refresh to try again.")
      }
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeSentMailView: View {
  let user: String
  @State private var model: SentMailModel
  init(client: APIClient, user: String) {
    self.user = user
    _model = State(initialValue: SentMailModel(client: client))
  }
  var body: some View {
    QMList {
      if !model.accountEmail.isEmpty {
        Text(model.accountEmail).font(.caption).foregroundStyle(.secondary)
      }
      ForEach(model.messages) { message in
        NavigationLink {
          NativeSentMailDetail(client: model.client, user: user, original: message)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(message.subject.isEmpty ? "No subject" : message.subject).font(.headline)
            Text("To: \(message.to)").font(.subheadline)
            Text(NativeSentEmail.plain(message.snippet ?? "")).lineLimit(2).foregroundStyle(
              .secondary)
            Text(Date(timeIntervalSince1970: message.sentAt / 1000), style: .date).font(.caption)
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.busy { ProgressView() }
      if model.nextPage != nil {
        Button("Load more") { Task { await model.load(more: true) } }.disabled(model.busy)
      }
      if model.messages.isEmpty && !model.busy && model.error == nil {
        ContentUnavailableView("No sent mail", systemImage: "paperplane")
      }
    }.navigationTitle("Sent mail").task { await model.load() }.refreshable { await model.load() }
  }
}

struct NativeSentMailDetail: View {
  let client: APIClient
  let user: String
  let original: NativeSentEmail
  @State private var detail: NativeSentEmail?
  @State private var item: NativeInboxItem?
  @State private var error: String?
  @State private var busy = false
  @State private var opening = false
  var body: some View {
    QMList {
      Section {
        Text(original.subject.isEmpty ? "No subject" : original.subject).font(.headline)
        LabeledContent("To", value: original.to)
        Text(Date(timeIntervalSince1970: original.sentAt / 1000), style: .date)
      }
      if let detail {
        if let conversation = detail.conversation, !conversation.isEmpty {
          ForEach(Array(conversation.enumerated()), id: \.offset) { _, message in
            Section {
              LabeledContent("From", value: message.from)
              LabeledContent("To", value: message.to)
              if let cc = message.cc, !cc.isEmpty { LabeledContent("Cc", value: cc) }
              Text(message.body).textSelection(.enabled)
              if let attachments = message.attachments, !attachments.isEmpty {
                Text("Attachments: " + attachments.joined(separator: ", ")).font(.caption)
              }
            }
          }
        } else {
          Section {
            if let from = detail.from { LabeledContent("From", value: from) }
            if let cc = detail.cc, !cc.isEmpty { LabeledContent("Cc", value: cc) }
            Text(detail.plainBody.isEmpty ? "This email has no text body." : detail.plainBody)
              .textSelection(.enabled)
            if let attachments = detail.attachments, !attachments.isEmpty {
              Text("Attachments: " + attachments.joined(separator: ", ")).font(.caption)
            }
          }
        }
        Button("Ask QM about this email", systemImage: "bubble.left.and.bubble.right") {
          Task { await openChat(detail) }
        }.disabled(busy)
        if detail.chatTrimmed {
          Text(
            "This email is longer than \(NativeSentEmail.chatLimit.formatted()) characters. QM will only see the first \(NativeSentEmail.chatLimit.formatted())."
          ).font(.caption).foregroundStyle(.secondary)
        }
      }
      if let error {
        Text(error).foregroundStyle(.red)
        Button("Retry") { Task { await load() } }.disabled(busy)
      }
      if detail == nil && error == nil { ProgressView() }
    }.navigationTitle("Sent email").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
      .navigationDestination(isPresented: $opening) {
        if let item { NativeInboxItemView(client: client, user: user, original: item) }
      }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      detail = try await client.fetch(
        "api/inbox/sent/\(original.id.apiComponent)",
        query: [.init(name: "accountType", value: original.accountType ?? "default")])
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func openChat(_ detail: NativeSentEmail) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      var body: [String: Any] = [
        "accountType": detail.accountType ?? original.accountType ?? "default",
        "messageId": detail.id, "threadId": detail.threadId, "subject": detail.subject,
        "from": detail.from ?? "", "to": detail.to, "cc": detail.cc ?? "",
        "text": detail.chatText,
      ]
      if let id = detail.rfcMessageId { body["rfcMessageId"] = id }
      let result: NativeInboxDetail = try await client.fetch("api/inbox/sent-chat", body: body)
      try Task.checkCancellation()
      item = result.item
      opening = true
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
