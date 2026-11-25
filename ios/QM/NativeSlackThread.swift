import SwiftUI

struct NativeSlackThreadLayout {
  private(set) var continued = Set<String>()

  init(_ messages: [ChatMessage]) {
    var previous: String?
    for message in messages {
      let speaker: String? =
        if !Self.shows(message) { nil } else if message.role == "assistant" {
          "assistant"
        } else { message.speakerID }
      if let speaker, speaker == previous { continued.insert(message.id) }
      previous = speaker
    }
  }

  static func shows(_ message: ChatMessage) -> Bool {
    guard message.notice == nil,
      !message.text.isEmpty || !message.files.isEmpty || !message.playgrounds.isEmpty
    else { return false }
    return message.role == "assistant" || message.role == "user" && message.slackTimestamp != nil
  }
}

struct NativeSlackRowStyle {
  let continued: Bool
  let appIconURL: URL?
}

struct NativeSlackRow<Content: View>: View {
  let message: ChatMessage
  let client: APIClient
  let style: NativeSlackRowStyle
  @ViewBuilder let content: () -> Content

  private var isAgent: Bool { message.role == "assistant" }
  private var name: String {
    isAgent ? NativeChatMessageView.agentName : message.speaker ?? "Someone"
  }
  private var time: Date? {
    if let stamp = message.slackTimestamp.flatMap(Double.init) {
      return Date(timeIntervalSince1970: stamp)
    }
    return message.createdAt.map { Date(timeIntervalSince1970: $0 / 1000) }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      if style.continued {
        Color.clear.frame(width: 36, height: 1)
      } else {
        NativeSlackAvatar(
          name: name, speakerID: isAgent ? nil : message.speakerID,
          imageURL: isAgent ? style.appIconURL : nil, client: client)
      }
      VStack(alignment: .leading, spacing: 4) {
        if !style.continued { header }
        content()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(name).font(.subheadline.weight(.bold))
      if isAgent {
        Text("APP")
          .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
          .padding(.horizontal, 4).padding(.vertical, 1)
          .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 3))
      }
      if let time {
        Text(time, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct NativeSlackAvatar: View {
  let name: String
  let speakerID: String?
  let imageURL: URL?
  let client: APIClient
  @State private var resolved: URL?
  @MainActor private static var photos: [String: Task<URL?, Never>] = [:]

  private struct Match: Decodable {
    let principalId: String
    let avatarUrl: String?
  }
  private struct Matches: Decodable { let matches: [Match] }

  var body: some View {
    Group {
      if let url = imageURL ?? resolved {
        AsyncImage(url: url) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          initials
        }
      } else {
        initials
      }
    }
    .frame(width: 36, height: 36)
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .accessibilityHidden(true)
    .task(id: speakerID) { await resolve() }
  }

  private var initials: some View {
    let hue = Double(name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }) / 65535
    return Text(String(name.prefix(1)).uppercased())
      .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
      .frame(width: 36, height: 36)
      .background(Color(hue: hue, saturation: 0.45, brightness: 0.6))
  }

  private func resolve() async {
    guard imageURL == nil, let speakerID else { return }
    let lookup =
      Self.photos[speakerID]
      ?? Task { [client] in
        do {
          let found: Matches = try await client.fetch(
            "api/directory/resolve", query: [.init(name: "q", value: speakerID)])
          let raw = found.matches.first { $0.principalId == speakerID }?.avatarUrl
          return raw.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        } catch {
          Log.background.failure("Slack speaker photo", error)
          return nil
        }
      }
    Self.photos[speakerID] = lookup
    resolved = await lookup.value
  }
}
