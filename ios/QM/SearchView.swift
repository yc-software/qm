import SwiftUI

struct ConversationSearchHit: Decodable, Identifiable {
  let sessionId: String
  let title: String?
  let snippet: String
  let seq: Int
  let archived: Bool?
  var id: String { "\(sessionId):\(seq)" }
  var path: String { "s/\(sessionId)" }
}

struct ConversationSearchResults: Decodable {
  let hits: [ConversationSearchHit]
}

struct SearchView: View {
  let client: APIClient
  let user: String
  @State private var query = ""
  @State private var hits: [ConversationSearchHit] = []
  @State private var loading = false
  @State private var error: String?
  @State private var retry = 0

  var body: some View {
    QMList {
      ForEach(hits) { hit in
        NavigationLink {
          NativeConversationDestination(
            client: client, user: user, sessionID: hit.sessionId, initialSequence: hit.seq)
        } label: {
          VStack(alignment: .leading, spacing: 8) {
            Text(hit.title ?? "Conversation").font(.headline)
            Text(hit.snippet).font(.subheadline).lineLimit(4).foregroundStyle(.secondary)
            if hit.archived == true { Label("Archived", systemImage: "archivebox").font(.caption) }
          }.padding(.vertical, 8)
        }.listRowBackground(QMTheme.paper)
      }
    }
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Search messages")
    .searchable(text: $query, prompt: "Search messages across your workspace")
    .overlay {
      if loading {
        NativeWave()
      } else if let error {
        ContentUnavailableView {
          Label("Search unavailable", systemImage: "wifi.exclamationmark")
        } description: {
          Text(error)
        } actions: {
          Button("Try again") { retry += 1 }
        }
      } else if hits.isEmpty {
        ContentUnavailableView(
          query.count < 2 ? "Find past work" : "No matching messages",
          systemImage: "magnifyingglass",
          description: Text(
            query.count < 2
              ? "Search conversation text, including archived work." : "Try a different phrase."))
      }
    }
    .task(id: query + "|" + String(retry)) {
      let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
      guard term.count >= 2 else {
        hits = []
        loading = false
        error = nil
        return
      }
      loading = true
      hits = []
      error = nil
      do {
        try await Task.sleep(for: .milliseconds(250))
        let result: ConversationSearchResults = try await client.fetch(
          "api/search", query: [.init(name: "q", value: term)])
        try Task.checkCancellation()
        hits = result.hits
        loading = false
      } catch is CancellationError {} catch {
        guard !Task.isCancelled else { return }
        self.error = error.localizedDescription
        loading = false
      }
    }
  }
}

struct NativeConversationDestination: View {
  let client: APIClient
  let user: String
  let sessionID: String
  var initialSequence: Int? = nil
  @State private var model: ChatModel?
  @State private var error: String?
  @State private var retry = 0

  var body: some View {
    Group {
      if let model {
        ChatView(model: model, initialSequence: initialSequence)
      } else if let error {
        ContentUnavailableView {
          Label("Conversation unavailable", systemImage: "bubble.left")
        } description: {
          Text(error)
        } actions: {
          Button("Try again") { retry += 1 }
        }
      } else {
        NativeWave().accessibilityLabel("Opening conversation")
      }
    }
    .task(id: retry) {
      error = nil
      do {
        let generation = client.generation
        let transcript: Transcript = try await client.fetch(
          "api/sessions/\(sessionID)", query: [.init(name: "tailTurns", value: "25")])
        try Task.checkCancellation()
        guard client.generation == generation else { return }
        guard let found = transcript.session else {
          throw QMError.message("This conversation is no longer available to your account.")
        }
        model = ChatModel(
          conversation: found, client: client, user: user,
          knownSession: true, transcript: transcript)
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
  }
}
