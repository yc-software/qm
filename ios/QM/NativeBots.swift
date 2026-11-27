import SwiftUI

struct Bot: Decodable, Identifiable, Hashable {
  enum Role: String, Decodable, CaseIterable {
    case owner, write, read
    var label: String {
      switch self {
      case .owner: "Owner"
      case .write: "Can edit"
      case .read: "Can chat"
      }
    }
  }
  struct Icon: Decodable, Hashable {
    let kind: String
    let value: String?
  }
  struct Skill: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
  }
  let id: String
  let name: String
  let description: String
  let role: Role
  var icon: Icon? = nil
  var instructions: String? = nil
  var skills: [Skill]? = nil
  var emoji: String? { icon?.kind == "emoji" ? icon?.value : nil }
}

struct BotChat: Identifiable, Hashable {
  let conversation: Conversation
  let modelId: String?
  var id: String { conversation.id }
}

@MainActor @Observable
final class BotsModel {
  private struct BotList: Decodable {
    let personas: [Bot]?
    let error: String?
  }
  private struct BotDetail: Decodable { let persona: Bot }
  private struct Assignment: Decodable {
    struct Persona: Decodable { let sessionModelId: String? }
    let persona: Persona?
  }

  let client: APIClient
  let user: String
  var bots: [Bot] = []
  var enabled = false
  var loaded = false
  var starting: String?
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }

  init(client: APIClient, user: String) {
    self.client = client
    self.user = user
  }

  func load() async {
    await loader.run {
      try await client.fetch("api/personas", accepting: [404]) as BotList
    } apply: { result in
      if let personas = result.personas {
        bots = personas
        enabled = true
      } else if result.error == "personas_disabled" {
        bots = []
        enabled = false
      } else {
        throw QMError.rejected(APIClient.errorMessage(status: 404, data: nil))
      }
      loaded = true
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }

  func detail(_ bot: Bot) async throws -> Bot {
    try await (client.fetch("api/personas/\(bot.id.apiComponent)") as BotDetail).persona
  }

  func startChat(with bot: Bot) async -> BotChat? {
    guard starting == nil else { return nil }
    starting = bot.id
    defer { starting = nil }
    do {
      let created: ConversationUpdate = try await client.fetch(
        "api/sessions", body: ["scopeId": "personal:\(user)"])
      let assignment: Assignment = try await client.fetch(
        "api/sessions/\(created.session.id.apiComponent)/persona", body: ["personaId": bot.id],
        method: "PUT")
      var conversation = created.session
      conversation.personaId = bot.id
      error = nil
      return BotChat(conversation: conversation, modelId: assignment.persona?.sessionModelId)
    } catch {
      self.error = "Couldn’t start a chat with \(bot.name). \(error.localizedDescription)"
      return nil
    }
  }

  func chatModel(_ chat: BotChat) -> ChatModel {
    let model = ChatModel(
      conversation: chat.conversation, client: client, user: user, knownSession: true)
    if let modelId = chat.modelId {
      model.selectRuntime(.init(modelId: modelId, effortLevel: nil, fastMode: nil))
    }
    return model
  }
}

struct BotGlyph: View {
  var emoji: String? = nil
  var size: CGFloat = 17

  var body: some View {
    if let emoji, !emoji.isEmpty {
      Text(emoji).font(.system(size: size))
    } else {
      Image("Activity-bot")
        .resizable().renderingMode(.template).scaledToFit()
        .frame(width: size, height: size)
    }
  }
}

struct NativeBotsView: View {
  @State private var model: BotsModel
  @State private var query = ""
  @State private var chat: BotChat?

  init(client: APIClient, identity: Identity) {
    _model = State(initialValue: BotsModel(client: client, user: identity.user))
  }

  private var visible: [Bot] {
    model.bots.filter {
      query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
        || $0.description.localizedCaseInsensitiveContains(query)
    }
  }

  var body: some View {
    QMList {
      QMPageHeading(title: "Bots", subtitle: "Reusable roles you can chat with.")
      if let error = model.error {
        Section {
          Text(error).foregroundStyle(.red)
          Button("Try again") { Task { await model.load() } }
        }
      }
      ForEach(Bot.Role.allCases, id: \.self) { role in
        let bots = visible.filter { $0.role == role }
        if !bots.isEmpty {
          Section(role.label) {
            ForEach(bots) { row($0) }
          }
        }
      }
      if model.loading && !model.loaded {
        NativeCollectionLoading(label: "Loading bots…")
      } else if model.loaded && !model.enabled {
        ContentUnavailableView {
          Label {
            Text("Bots aren't turned on for you.")
          } icon: {
            BotGlyph(size: 40)
          }
        }
      } else if model.loaded && model.bots.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No bots yet")
          } icon: {
            BotGlyph(size: 40)
          }
        } description: {
          Text("Create one to give QM a reusable role you can chat with anywhere.")
        }
      } else if model.loaded && visible.isEmpty {
        ContentUnavailableView {
          Label("No bots match your search.", systemImage: "magnifyingglass")
        } actions: {
          Button("Clear search") { query = "" }
        }
      }
    }
    .disabled(model.starting != nil)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Bots").navigationBarTitleDisplayMode(.inline)
    .searchable(text: $query, prompt: "Search bots")
    .modifier(
      NativeCollectionRefresh(active: model.loading && model.loaded, label: "Refreshing bots")
    )
    .task { await model.load() }
    .refreshable { await model.load() }
    .navigationDestination(item: $chat) { ChatView(model: model.chatModel($0)) }
  }

  private func row(_ bot: Bot) -> some View {
    NavigationLink {
      NativeBotDetailView(model: model, original: bot)
    } label: {
      HStack(spacing: 14) {
        BotGlyph(emoji: bot.emoji).foregroundStyle(QMTheme.ink)
        VStack(alignment: .leading, spacing: 6) {
          Text(bot.name).font(.headline)
          if !bot.description.isEmpty {
            Text(bot.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
          }
        }
        if model.starting == bot.id { ProgressView().controlSize(.small) }
      }.padding(.vertical, 8)
    }
    .listRowBackground(QMTheme.paper)
    .contextMenu {
      Button("Chat with \(bot.name)", systemImage: "bubble.left") { start(bot) }
    }
  }

  private func start(_ bot: Bot) {
    Task { chat = await model.startChat(with: bot) }
  }
}

struct NativeBotDetailView: View {
  let model: BotsModel
  let original: Bot
  @State private var detail: Bot?
  @State private var error: String?
  @State private var chat: BotChat?

  private var bot: Bot { detail ?? original }

  var body: some View {
    QMList {
      QMPageHeading(title: bot.name, subtitle: bot.role.label)
      Button {
        Task { chat = await model.startChat(with: bot) }
      } label: {
        NativeActionLabel(
          title: "Chat with \(bot.name)", busyTitle: "Starting…", busy: model.starting == bot.id
        )
        .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(model.starting != nil)
      .listRowSeparator(.hidden)
      if let message = error ?? model.error {
        Text(message).foregroundStyle(.red)
      }
      if !bot.description.isEmpty {
        Section("Description") { Text(bot.description) }
      }
      if let instructions = bot.instructions, !instructions.isEmpty {
        Section("Instructions") {
          Text(instructions).font(.callout).textSelection(.enabled)
        }
      }
      if let skills = bot.skills, !skills.isEmpty {
        Section("Skills") {
          ForEach(skills) { skill in
            VStack(alignment: .leading, spacing: 4) {
              Text(skill.name).font(.headline)
              Text(skill.description).font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 4)
          }
        }
      }
    }
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle(bot.name).navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .refreshable { await load() }
    .navigationDestination(item: $chat) { ChatView(model: model.chatModel($0)) }
  }

  private func load() async {
    do {
      detail = try await model.detail(original)
      error = nil
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
}
