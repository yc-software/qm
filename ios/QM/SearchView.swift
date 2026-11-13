import SwiftUI

struct ConversationSearchHit: Decodable, Identifiable {
  let sessionId: String
  let title: String?
  let snippet: String
  let seq: Int
  var entryType: String? = nil
  let archived: Bool?
  var id: String { "\(sessionId):\(seq)" }
  var matchedTitle: Bool { entryType == "title" }
  var path: String { "s/\(sessionId)" }
}

struct ConversationSearchResults: Decodable {
  let hits: [ConversationSearchHit]
}

struct ResourceSearchHit: Decodable, Identifiable, Hashable {
  let id: String
  let kind: String
  let title: String
  let snippet: String
}

struct ResourceSearchResults: Decodable {
  let hits: [ResourceSearchHit]
  let failed: [String]
  let limited: [String]?
}

enum ResourceSearchKind: String, CaseIterable {
  case skills, crons, apps, webhooks, contexts

  var label: String {
    switch self {
    case .skills: "Skills"
    case .crons: "Crons"
    case .apps: "Apps"
    case .webhooks: "Webhooks"
    case .contexts: "Projects"
    }
  }

  var symbol: String {
    switch self {
    case .skills: "shippingbox"
    case .crons: "clock"
    case .apps: "square.stack.3d.up"
    case .webhooks: "bolt.horizontal"
    case .contexts: "folder"
    }
  }

  static func label(_ kind: String) -> String { ResourceSearchKind(rawValue: kind)?.label ?? kind }
}

struct ResourceSearchGroup: Identifiable {
  let kind: ResourceSearchKind
  let hits: [ResourceSearchHit]
  var id: String { kind.rawValue }
}

@MainActor @Observable
final class NativeWorkspaceSearchModel {
  let client: APIClient
  let user: String
  var query = "" {
    didSet {
      guard query != oldValue else { return }
      loader.cancel()
      clear()
      loader.loading = active
    }
  }
  private(set) var hits: [ConversationSearchHit] = []
  private(set) var resources: [ResourceSearchHit] = []
  private(set) var resourcesLimited = false
  private(set) var failedResourceKinds: [String] = []
  private(set) var chatError: String?
  private(set) var resourceError: String?
  private(set) var completed = false
  private let loader = LoadGuard()
  var searching: Bool { loader.loading }
  var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
  var active: Bool { term.count >= 2 }

  init(client: APIClient, user: String) {
    self.client = client
    self.user = user
  }

  var groups: [ResourceSearchGroup] {
    ResourceSearchKind.allCases.compactMap { kind in
      let matching = resources.filter { $0.kind == kind.rawValue }
      return matching.isEmpty ? nil : ResourceSearchGroup(kind: kind, hits: matching)
    }
  }

  var resourceNotice: String? {
    guard resourceError == nil else { return resourceError }
    var notes: [String] = []
    if !failedResourceKinds.isEmpty {
      let kinds = failedResourceKinds.map(ResourceSearchKind.label).joined(separator: ", ")
      notes.append("Could not search \(kinds).")
    }
    if resourcesLimited { notes.append("Showing first results.") }
    return notes.isEmpty ? nil : notes.joined(separator: " ")
  }

  private func clear() {
    hits = []
    resources = []
    resourcesLimited = false
    failedResourceKinds = []
    chatError = nil
    resourceError = nil
    completed = false
  }

  func retry() async {
    clear()
    await search()
  }

  func search() async {
    guard !Task.isCancelled, !completed else { return }
    let term = self.term
    guard active else {
      loader.cancel()
      return
    }
    let query = [URLQueryItem(name: "q", value: term)]
    await loader.run {
      try await Task.sleep(for: .milliseconds(250))
      async let chatSearch: ConversationSearchResults = try await client.fetch(
        "api/search", query: query)
      async let resourceSearch: ResourceSearchResults = try await client.fetch(
        "api/resources/search", query: query)
      let chats: Result<ConversationSearchResults, any Error>
      do { chats = .success(try await chatSearch) } catch { chats = .failure(error) }
      let found: Result<ResourceSearchResults, any Error>
      do { found = .success(try await resourceSearch) } catch { found = .failure(error) }
      return (chats, found)
    } apply: { chats, found in
      switch chats {
      case .success(let result): hits = result.hits
      case .failure(let error): chatError = error.localizedDescription
      }
      switch found {
      case .success(let result):
        resources = result.hits
        resourcesLimited = !(result.limited ?? []).isEmpty
        failedResourceKinds = result.failed
      case .failure(let error): resourceError = error.localizedDescription
      }
      completed = true
    } failed: {
      chatError = $0.localizedDescription
      completed = true
    }
  }

  func ask() -> ChatModel {
    let model = ChatModel(
      conversation: .draft(user: user), client: client, user: user, knownSession: false)
    model.draft =
      "Find the chat, skill, cron, app, or other resource matching this search query and give me a link: \(term)"
    return model
  }
}

struct SearchView: View {
  @State private var model: NativeWorkspaceSearchModel
  @State private var asking: ChatModel?

  init(client: APIClient, user: String) {
    _model = State(initialValue: NativeWorkspaceSearchModel(client: client, user: user))
  }

  var body: some View {
    QMList {
      if model.searching && !model.completed {
        NativeCollectionLoading(
          label: "Searching your workspace", symbol: "text.magnifyingglass", rows: 3)
      }
      if model.completed && (!model.groups.isEmpty || model.resourceNotice != nil) {
        resourcesSection
      }
      if model.completed && (!model.hits.isEmpty || model.chatError != nil) {
        messagesSection
      }
      if model.completed && model.groups.isEmpty && model.hits.isEmpty && model.chatError == nil
        && model.resourceNotice == nil
      {
        ContentUnavailableView.search(text: model.term)
      }
      if model.active {
        Section {
          Button("Ask QM to find it", systemImage: "sparkles") { asking = model.ask() }
        }
      }
    }
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Search")
    .searchable(text: $model.query, prompt: "Search your workspace")
    .navigationDestination(
      isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
    ) {
      if let asking { ChatView(model: asking) }
    }
    .overlay {
      if !model.active {
        ContentUnavailableView(
          "Find past work", systemImage: "magnifyingglass",
          description: Text("Search conversations, skills, crons, apps, webhooks and projects."))
      }
    }
    .task(id: model.query) { await model.search() }
  }

  private var resourcesSection: some View {
    Section("Resources") {
      ForEach(model.groups) { group in
        Text(group.kind.label).font(.caption).foregroundStyle(.secondary)
        ForEach(group.hits) { hit in
          NavigationLink {
            NativeResourceDestination(client: model.client, user: model.user, hit: hit)
          } label: {
            HStack(spacing: 14) {
              Image(systemName: group.kind.symbol).foregroundStyle(QMTheme.ink)
              VStack(alignment: .leading, spacing: 6) {
                Text(hit.title).font(.headline)
                if !hit.snippet.isEmpty {
                  Text(hit.snippet).font(.subheadline).lineLimit(2).foregroundStyle(.secondary)
                }
              }
            }.padding(.vertical, 8)
          }
        }
      }
      if let notice = model.resourceNotice {
        Text(notice).font(.caption).foregroundStyle(.secondary)
        if model.resourceError != nil { Button("Try again") { Task { await model.retry() } } }
      }
    }
  }

  private var messagesSection: some View {
    Section("Messages") {
      ForEach(model.hits) { hit in
        NavigationLink {
          NativeConversationDestination(
            client: model.client, user: model.user, sessionID: hit.sessionId,
            initialSequence: hit.matchedTitle ? nil : hit.seq)
        } label: {
          VStack(alignment: .leading, spacing: 8) {
            Text(hit.title ?? "Conversation").font(.headline)
            if !hit.matchedTitle {
              Text(hit.snippet).font(.subheadline).lineLimit(4).foregroundStyle(.secondary)
            }
            if hit.archived == true { Label("Archived", systemImage: "archivebox").font(.caption) }
          }.padding(.vertical, 8)
        }
      }
      if let error = model.chatError {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.retry() } }
      }
    }
  }
}

enum NativeResourceTarget {
  case skill(SkillsModel, NativeSkill)
  case cron(CronsModel, NativeCron)
  case app(NativeApp)
  case webhook(WebhooksModel, NativeWebhook)
  case project(ProjectsModel, WorkspaceContext)

  @MainActor
  static func resolve(_ hit: ResourceSearchHit, client: APIClient, user: String) async throws
    -> NativeResourceTarget?
  {
    func loaded(_ error: String?) throws {
      if let error { throw QMError.message(error) }
    }
    switch ResourceSearchKind(rawValue: hit.kind) {
    case .skills:
      struct Found: Decodable { let skill: NativeSkill? }
      async let found: Found = try await client.fetch(
        "api/skills/\(hit.id.apiComponent)", accepting: [404])
      let model = SkillsModel(client: client, user: user)
      await model.load()
      guard let skill = try await found.skill else { return nil }
      try loaded(model.error)
      return .skill(model, skill)
    case .crons:
      let model = CronsModel(client: client)
      await model.load()
      try loaded(model.error)
      return (model.owned + model.shared).first { $0.id == hit.id }.map { .cron(model, $0) }
    case .apps:
      struct Found: Decodable { let deployment: NativeApp? }
      let found: Found = try await client.fetch(
        "api/apps/\(hit.id.apiComponent)", accepting: [404])
      return found.deployment.map { .app($0) }
    case .webhooks:
      let model = WebhooksModel(client: client)
      await model.load()
      try loaded(model.error)
      return model.webhooks.first { $0.id == hit.id }.map { .webhook(model, $0) }
    case .contexts:
      let model = ProjectsModel(client: client, user: user)
      await model.load()
      try loaded(model.error)
      return model.contexts.first { $0.scopeId == hit.id }.map { .project(model, $0) }
    case nil:
      return nil
    }
  }
}

struct NativeResourceDestination: View {
  let client: APIClient
  let user: String
  let hit: ResourceSearchHit
  @State private var target: NativeResourceTarget?
  @State private var missing = false
  @State private var error: String?
  @State private var retry = 0

  var body: some View {
    Group {
      if let target {
        switch target {
        case .skill(let model, let skill): NativeSkillDetail(model: model, original: skill)
        case .cron(let model, let cron): NativeCronDetail(model: model, original: cron, user: user)
        case .app(let app): NativeAppDetail(client: client, user: user, original: app)
        case .webhook(let model, let webhook):
          NativeWebhookDetail(model: model, original: webhook, user: user)
        case .project(let model, let context):
          ProjectDetailView(
            model: model, original: context,
            identity: Identity(user: user, companyName: nil, displayName: nil))
        }
      } else if let error {
        ContentUnavailableView {
          Label(
            "\(ResourceSearchKind.label(hit.kind)) unavailable",
            systemImage: "wifi.exclamationmark")
        } description: {
          Text(error)
        } actions: {
          Button("Try again") { retry += 1 }
        }
      } else if missing {
        ContentUnavailableView(
          "No longer available", systemImage: "questionmark.folder",
          description: Text("“\(hit.title)” is not available to your account."))
      } else {
        QMList {
          NativeCollectionLoading(label: "Opening \(hit.title)", rows: 2)
        }
      }
    }
    .navigationTitle(hit.title).navigationBarTitleDisplayMode(.inline)
    .task(id: retry) {
      guard target == nil else { return }
      error = nil
      missing = false
      do {
        let generation = client.generation
        let resolved = try await NativeResourceTarget.resolve(hit, client: client, user: user)
        try Task.checkCancellation()
        guard client.generation == generation else { return }
        target = resolved
        missing = resolved == nil
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
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
        ScrollView {
          NativeChatHistoryPlaceholder()
            .padding(20)
            .frame(maxWidth: QMTheme.conversationWidth)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(QMTheme.paper)
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
