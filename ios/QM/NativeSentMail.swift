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
    var units = 0
    return String(
      chatSource.prefix {
        units += $0.utf16.count
        return units <= Self.chatLimit
      })
  }
  static func plain(_ html: String) -> String {
    NativeHTMLText(html).text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

struct NativeHTMLText {
  private static let hidden: Set<String> = ["script", "style", "head", "title", "template"]
  private static let breaks: Set<String> = [
    "br", "/p", "/div", "/tr", "/li", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6",
  ]
  private static let named: [String: String] = [
    "nbsp": " ", "quot": "\"", "apos": "'", "lt": "<", "gt": ">", "amp": "&",
    "lsquo": "\u{2018}", "rsquo": "\u{2019}", "ldquo": "\u{201C}", "rdquo": "\u{201D}",
    "ndash": "\u{2013}", "mdash": "\u{2014}", "hellip": "\u{2026}", "bull": "\u{2022}",
    "middot": "\u{00B7}", "copy": "\u{00A9}", "reg": "\u{00AE}", "trade": "\u{2122}",
    "euro": "\u{20AC}", "pound": "\u{00A3}", "laquo": "\u{00AB}", "raquo": "\u{00BB}",
  ]
  private(set) var text = ""
  private let source: [Character]
  private var index = 0

  init(_ html: String) {
    source = Array(html)
    while index < source.count {
      switch source[index] {
      case "<": tag()
      case "&": entity()
      default:
        text.append(source[index])
        index += 1
      }
    }
  }

  private func starts(_ prefix: String, at position: Int) -> Bool {
    let candidate = Array(prefix)
    guard position + candidate.count <= source.count else { return false }
    return zip(source[position...], candidate).allSatisfy {
      $0.0.lowercased() == $0.1.lowercased()
    }
  }

  private func find(_ needle: String, from position: Int) -> Int? {
    var cursor = position
    while cursor < source.count {
      if starts(needle, at: cursor) { return cursor }
      cursor += 1
    }
    return nil
  }

  private mutating func tag() {
    if starts("<!--", at: index) {
      index = find("-->", from: index + 4).map { $0 + 3 } ?? source.count
      return
    }
    var cursor = index + 1
    let closing = cursor < source.count && source[cursor] == "/"
    if closing { cursor += 1 }
    let nameStart = cursor
    while cursor < source.count, source[cursor].isLetter || source[cursor].isNumber { cursor += 1 }
    guard cursor > nameStart || (!closing && cursor < source.count && source[cursor] == "!")
    else {
      text.append("<")
      index += 1
      return
    }
    let name = String(source[nameStart..<cursor]).lowercased()
    var quote: Character?
    while cursor < source.count {
      let character = source[cursor]
      if let open = quote {
        if character == open { quote = nil }
      } else if character == "\"" || character == "'" {
        quote = character
      } else if character == ">" {
        break
      }
      cursor += 1
    }
    index = min(cursor + 1, source.count)
    if !closing, Self.hidden.contains(name) {
      index =
        find("</\(name)", from: index).map { end in
          (source[end...].firstIndex(of: ">") ?? source.count - 1) + 1
        } ?? source.count
      return
    }
    if Self.breaks.contains(closing ? "/" + name : name) { text.append("\n") }
  }

  private mutating func entity() {
    guard let end = source[index...].prefix(32).firstIndex(of: ";") else {
      text.append("&")
      index += 1
      return
    }
    let body = String(source[(index + 1)..<end])
    var decoded: String?
    if body.hasPrefix("#x") || body.hasPrefix("#X") {
      decoded = UInt32(body.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map(String.init)
    } else if body.hasPrefix("#") {
      decoded = UInt32(body.dropFirst()).flatMap(Unicode.Scalar.init).map(String.init)
    } else {
      decoded = Self.named[body]
    }
    guard let decoded else {
      text.append("&")
      index += 1
      return
    }
    text += decoded
    index = end + 1
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
  var loaded = false
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
      loaded = true
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
            Text(
              Date(timeIntervalSince1970: message.sentAt / 1000)
                .formatted(date: .abbreviated, time: .shortened)
            ).font(.caption)
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.busy && !model.loaded && model.error == nil {
        NativeCollectionLoading(label: "Loading sent mail", symbol: "paperplane")
      }
      if model.nextPage != nil {
        Button("Load more") { Task { await model.load(more: true) } }.disabled(model.busy)
      }
      if model.messages.isEmpty && model.loaded && model.error == nil {
        ContentUnavailableView("No sent mail", systemImage: "paperplane")
      }
    }.navigationTitle("Sent mail").task { await model.load() }.refreshable { await model.load() }
      .modifier(
        NativeCollectionRefresh(
          active: model.busy && (model.loaded || model.error != nil), label: "Loading sent mail"))
  }
}

struct NativeSentMailDetail: View {
  let client: APIClient
  let user: String
  let original: NativeSentEmail
  @State private var detail: NativeSentEmail?
  @State private var plainBody = ""
  @State private var chatTrimmed = false
  @State private var item: NativeInboxItem?
  @State private var error: String?
  @State private var busy = false
  @State private var loading = false
  @State private var opening = false
  var body: some View {
    QMList {
      Section {
        Text(original.subject.isEmpty ? "No subject" : original.subject).font(.headline)
        LabeledContent("To", value: original.to)
        Text(
          Date(timeIntervalSince1970: original.sentAt / 1000)
            .formatted(date: .abbreviated, time: .shortened))
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
            Text(plainBody.isEmpty ? "This email has no text body." : plainBody)
              .textSelection(.enabled)
            if let attachments = detail.attachments, !attachments.isEmpty {
              Text("Attachments: " + attachments.joined(separator: ", ")).font(.caption)
            }
          }
        }
        Button {
          Task { await openChat(detail) }
        } label: {
          HStack {
            if !busy || loading {
              Image(systemName: "bubble.left.and.bubble.right").accessibilityHidden(true)
            }
            NativeActionLabel(
              title: "Ask QM about this email", busyTitle: "Opening chat…", busy: busy && !loading)
          }
        }.disabled(busy)
        if chatTrimmed {
          Text(
            "This email is longer than \(NativeSentEmail.chatLimit.formatted()) characters. QM will only see the first \(NativeSentEmail.chatLimit.formatted())."
          ).font(.caption).foregroundStyle(.secondary)
        }
      }
      if let error {
        Text(error).foregroundStyle(.red)
        Button("Retry") { Task { await load() } }.disabled(busy)
      }
      if loading && detail == nil && error == nil {
        NativeParagraphLoading(label: "Loading email")
      }
    }.navigationTitle("Sent email").navigationBarTitleDisplayMode(.inline)
      .modifier(
        NativeCollectionRefresh(
          active: loading && (detail != nil || error != nil), label: "Refreshing email")
      )
      .task { await load() }.refreshable { await load() }
      .navigationDestination(isPresented: $opening) {
        if let item { NativeInboxItemView(client: client, user: user, original: item) }
      }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    loading = true
    defer {
      loading = false
      busy = false
    }
    do {
      let fetched: NativeSentEmail = try await client.fetch(
        "api/inbox/sent/\(original.id.apiComponent)",
        query: [.init(name: "accountType", value: original.accountType ?? "default")])
      plainBody = fetched.plainBody
      chatTrimmed = fetched.chatTrimmed
      detail = fetched
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
