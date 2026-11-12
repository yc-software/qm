import SwiftUI

struct WorkspaceProject: Decodable, Identifiable, Hashable {
  struct Member: Decodable, Identifiable, Hashable {
    let principalId: String
    let displayName: String
    let viaChannel: Bool?
    var id: String { principalId }
  }
  struct SlackChannel: Decodable, Hashable {
    let channelId: String
    let channelName: String
  }
  let id: String
  let name: String
  let ownerId: String
  let memberIds: [String]
  let scopeId: String
  let members: [Member]
  let slackChannel: SlackChannel?
}

struct WorkspaceContext: Decodable, Identifiable, Hashable {
  struct GroupMember: Decodable, Identifiable, Hashable {
    let principalId: String
    let displayName: String
    let avatarUrl: String?
    var id: String { principalId }
  }
  let scopeId: String
  let kind: String
  let name: String?
  let isPrivate: Bool?
  let sessionCount: Int
  let project: WorkspaceProject?
  var groupMembers: [GroupMember]? = nil
  var id: String { scopeId }
  private var scopeKind: ScopeKind? { ScopeKind(scopeId: scopeId) }
  var isPersonal: Bool { scopeKind == .personal }
  var icon: String {
    if isPersonal { return "person" }
    if project != nil { return "folder" }
    if scopeKind == .group { return "person.2" }
    if scopeKind == .channel { return "number" }
    return "folder"
  }
  var section: String {
    if isPersonal { return "Personal" }
    if project != nil { return "Projects" }
    if scopeKind == .channel { return "Channels" }
    return "Shared spaces"
  }
  var title: String {
    project?.name ?? name ?? (isPersonal ? "Personal" : "Shared workspace")
  }
}

struct WorkspaceContexts: Decodable { let contexts: [WorkspaceContext] }
struct ProjectResult: Decodable { let project: WorkspaceProject }

extension String {
  var apiComponent: String {
    addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
  }
}

@MainActor @Observable
final class ProjectsModel {
  let client: APIClient
  let user: String
  var contexts: [WorkspaceContext] = []
  var conversations: [String: [Conversation]] = [:]
  private(set) var nextCursors: [String: String] = [:]
  private(set) var loadingMore: String?
  var loaded = false
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }

  init(client: APIClient, user: String = "") {
    self.client = client
    self.user = user
  }

  func load() async {
    guard !busy else { return }
    await loader.run {
      try await client.fetch("api/contexts") as WorkspaceContexts
    } apply: { result in
      contexts = result.contexts
      loaded = true
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }

  func loadConversations(_ scopeId: String, more: Bool = false) async {
    let cursor = more ? nextCursors[scopeId] : nil
    guard !more || (cursor != nil && loadingMore == nil) else { return }
    if more { loadingMore = scopeId }
    defer { if more { loadingMore = nil } }
    do {
      let page: ConversationList = try await client.fetch(
        "api/sessions",
        query: [.init(name: "scope", value: scopeId)]
          + (cursor.map { [.init(name: "before", value: $0)] } ?? []))
      let loaded = more ? (conversations[scopeId] ?? []).filter { $0.localOnly != true } : []
      let known = Set(loaded.map(\.id))
      conversations[scopeId] = DraftStore.merging(
        loaded + page.sessions.filter { !known.contains($0.id) },
        account: client.baseURL.absoluteString + user
      ).filter { $0.scopeId == scopeId }
      nextCursors[scopeId] = page.nextCursor
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  func mutate(_ path: String, body: [String: Any] = [:], method: String = "POST") async
    -> WorkspaceProject?
  {
    guard !busy else { return nil }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let result: ProjectResult = try await client.fetch(path, body: body, method: method)
      try Task.checkCancellation()
      let context = WorkspaceContext(
        scopeId: result.project.scopeId, kind: "group", name: result.project.name,
        isPrivate: nil,
        sessionCount: contexts.first { $0.scopeId == result.project.scopeId }?.sessionCount ?? 0,
        project: result.project)
      if let index = contexts.firstIndex(where: { $0.scopeId == context.scopeId }) {
        contexts[index] = context
      } else {
        contexts.insert(context, at: 0)
      }
      error = nil
      return result.project
    } catch {
      self.error = error.localizedDescription
      return nil
    }
  }
}

struct ProjectsView: View {
  let identity: Identity
  @State private var model: ProjectsModel
  @State private var query = ""
  @State private var creating = false
  @State private var name = ""

  init(client: APIClient, identity: Identity) {
    self.identity = identity
    _model = State(initialValue: ProjectsModel(client: client, user: identity.user))
  }

  private var visibleContexts: [WorkspaceContext] {
    model.contexts.filter {
      ($0.isPersonal || $0.project != nil || $0.sessionCount > 0)
        && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query))
    }
  }

  var body: some View {
    QMList {
      QMPageHeading(title: "Projects", subtitle: "A place for conversations and shared context.")
      if let error = model.error {
        Section {
          Text(error).foregroundStyle(.red)
          Button("Try again") { Task { await model.load() } }
        }
      }
      ForEach(["Personal", "Projects", "Channels", "Shared spaces"], id: \.self) { section in
        let contexts = visibleContexts.filter { $0.section == section }
        if !contexts.isEmpty {
          Section(section) {
            ForEach(contexts) { context in
              NavigationLink {
                ProjectDetailView(model: model, original: context, identity: identity)
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: context.icon)
                    .foregroundStyle(QMTheme.ink)
                  VStack(alignment: .leading, spacing: 6) {
                    Text(context.title).font(.headline)
                    Text(
                      "\(context.sessionCount) \(context.sessionCount == 1 ? "conversation" : "conversations")"
                    ).font(.caption).foregroundStyle(
                      .secondary)
                  }
                  if context.isPrivate == true { Image(systemName: "lock").font(.caption) }
                }.padding(.vertical, 8)
              }.listRowBackground(QMTheme.paper)
            }
          }
        }
      }
      if model.loading && !model.loaded && model.contexts.isEmpty && model.error == nil {
        NativeCollectionLoading(label: "Loading projects", symbol: "folder")
      } else if visibleContexts.isEmpty && model.loaded && model.error == nil && !query.isEmpty {
        ContentUnavailableView {
          Label("No matching projects", systemImage: "magnifyingglass")
        } description: {
          Text("Try another project or channel name.")
        } actions: {
          Button("Clear search") { query = "" }
        }
      } else if model.contexts.isEmpty && model.loaded && model.error == nil {
        ContentUnavailableView(
          "A place for shared work", systemImage: "folder",
          description: Text(
            "Create a project to keep conversations, files, and instructions together.")
        )
        .listRowBackground(QMTheme.paper)
      }
    }
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline).searchable(text: $query)
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.loaded || !model.contexts.isEmpty || model.error != nil),
        label: "Refreshing projects")
    )
    .refreshable { await model.load() }.task { await model.load() }
    .toolbar {
      Button("New project", systemImage: "plus") {
        name = ""
        creating = true
      }
    }
    .sheet(isPresented: $creating) {
      NavigationStack {
        QMForm {
          TextField("Project name", text: $name)
          if let error = model.error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("New project")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { creating = false }.disabled(model.busy)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task {
                if await model.mutate(
                  "api/projects",
                  body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines)]) != nil
                {
                  creating = false
                }
              }
            } label: {
              NativeActionLabel(
                title: "Create", busyTitle: "Creating…", busy: model.busy, compact: true)
            }.disabled(
              name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 200
                || model.busy)
          }
        }
        .interactiveDismissDisabled(model.busy)
      }.presentationDetents([.medium, .large])
    }
  }
}

struct ProjectDetailView: View {
  enum Resource: String, Identifiable {
    case files, apps, skills, model
    var id: String { rawValue }
  }
  @State private var selectedResource: Resource?

  @Bindable var model: ProjectsModel
  let original: WorkspaceContext
  let identity: Identity
  @State private var newConversation: Conversation?
  @State private var editingName = false
  @State private var name = ""
  @State private var addingMember = false
  @State private var removing: WorkspaceProject.Member?
  @State private var slackChannel = ""
  @State private var editingSlack = false
  @State private var unlinkingSlack = false
  @State private var policy: ChannelPolicyModel?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  init(model: ProjectsModel, original: WorkspaceContext, identity: Identity) {
    self.model = model
    self.original = original
    self.identity = identity
    _policy = State(
      initialValue: ChannelPolicyModel(client: model.client, scopeId: original.scopeId))
  }

  private var context: WorkspaceContext {
    model.contexts.first { $0.id == original.id } ?? original
  }
  private var project: WorkspaceProject? { context.project }
  private var owner: Bool { project?.ownerId == identity.user }

  private var conversations: [Conversation] {
    sidebarConversations(model.conversations[context.scopeId] ?? []).filter {
      $0.archived != true
    }
  }

  private func resource(_ title: String, icon: String) -> some View {
    VStack(spacing: 9) {
      Image(systemName: icon).font(.system(size: 18, weight: .regular))
      Text(title).font(.caption.weight(.medium))
    }
    .frame(maxWidth: .infinity).padding(.vertical, 16)
    .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(QMTheme.border, lineWidth: 0.5))
  }

  var body: some View {
    QMList {
      QMPageHeading(
        title: context.title,
        subtitle:
          "\(context.sessionCount) \(context.sessionCount == 1 ? "conversation" : "conversations") · \(context.isPersonal ? "Your workspace" : "Shared workspace")"
      )
      resourceGrid
      if let error = model.error { Text(error).foregroundStyle(.red) }
      conversationsSection
      if let project { projectSections(project) }
      if let policy { ChannelPolicySection(model: policy) }
    }
    .disabled(model.busy)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle(context.title).navigationBarTitleDisplayMode(.inline)
    .modifier(
      NativeCollectionRefresh(active: model.loading, label: "Refreshing project")
    )
    .task { await model.load() }
    .task { await model.loadConversations(context.scopeId) }
    .task { await policy?.load() }
    .refreshable {
      await model.load()
      await policy?.load()
    }
    .toolbar { toolbarContent }
    .navigationDestination(item: $selectedResource) { resource in
      resourceDestination(resource)
    }
    .navigationDestination(item: $newConversation) { conversation in
      ChatView(
        model: ChatModel(
          conversation: conversation, client: model.client, user: identity.user, knownSession: false
        ))
    }
    .sheet(isPresented: $addingMember) {
      if let project { ProjectMemberPicker(model: model, project: project) }
    }
    .alert("Rename project", isPresented: $editingName) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) {}
      Button("Save") { Task { await rename() } }
        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 200)
    }
    .alert("Link Slack channel", isPresented: $editingSlack) {
      TextField("Channel name or ID", text: $slackChannel)
      Button("Cancel", role: .cancel) {}
      Button("Link") { Task { await linkSlack() } }
    } message: {
      Text("Channel members will gain access to this project.")
    }
    .confirmationDialog(
      "Remove this person from the project?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    ) {
      Button("Remove person", role: .destructive) {
        if let project, let removing {
          Task { await remove(removing, from: project) }
        }
        removing = nil
      }
    }
    .confirmationDialog("Unlink the Slack channel?", isPresented: $unlinkingSlack) {
      Button("Unlink channel", role: .destructive) { Task { await unlinkSlack() } }
    } message: {
      Text("People whose access comes from the channel will lose access to this project.")
    }
  }

  private var resourceGrid: some View {
    LazyVGrid(
      columns: [
        GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 140 : 72), spacing: 10)
      ],
      spacing: 10
    ) {
      Button {
        selectedResource = .files
      } label: {
        resource("Files", icon: "doc.on.doc")
      }
      Button {
        selectedResource = .apps
      } label: {
        resource("Apps", icon: "square.stack.3d.up")
      }
      Button {
        selectedResource = .skills
      } label: {
        resource("Skills", icon: "shippingbox")
      }
      Button {
        selectedResource = .model
      } label: {
        resource("Model", icon: "slider.horizontal.3")
      }
    }.buttonStyle(.plain).listRowSeparator(.hidden)
  }

  private var conversationsSection: some View {
    Section("Conversations") {
      if conversations.isEmpty {
        Text("Start a conversation to put this workspace to work.")
          .foregroundStyle(.secondary).padding(.vertical, 16)
      }
      ForEach(conversations) { conversation in
        NavigationLink {
          ChatView(
            model: ChatModel(
              conversation: conversation, client: model.client, user: identity.user,
              knownSession: conversation.localOnly != true))
        } label: {
          NativeConversationRow(conversation: conversation)
        }
      }
      if model.nextCursors[context.scopeId] != nil {
        Button {
          Task { await model.loadConversations(context.scopeId, more: true) }
        } label: {
          NativeActionLabel(
            title: "Load more", busyTitle: "Loading...",
            busy: model.loadingMore == context.scopeId
          )
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(model.loadingMore != nil)
      }
    }
  }

  @ViewBuilder
  private func projectSections(_ project: WorkspaceProject) -> some View {
    Section("People") {
      ForEach(project.members) { member in
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text(member.displayName)
            if member.principalId == project.ownerId {
              Text("Owner").font(.caption).foregroundStyle(.secondary)
            } else if member.viaChannel == true {
              Text("Via Slack channel").font(.caption).foregroundStyle(.secondary)
            }
          }
          Spacer()
          if owner && member.principalId != project.ownerId && member.viaChannel != true {
            Button("Remove", role: .destructive) { removing = member }.font(.caption)
          }
        }
      }
      Button("Add people", systemImage: "person.badge.plus") { addingMember = true }
    }
    Section("Slack channel") {
      if let channel = project.slackChannel {
        Label(channel.channelName, systemImage: "number")
        Button("Unlink channel", role: .destructive) { unlinkingSlack = true }
      } else {
        Text("No linked channel").foregroundStyle(.secondary)
        Button {
          slackChannel = ""
          editingSlack = true
        } label: {
          NativeServiceLabel(title: "Link Slack channel", service: "slack")
        }
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup {
      Button("New conversation", systemImage: "square.and.pencil") {
        newConversation = .draft(
          user: identity.user, scopeId: context.scopeId, channelName: context.title)
      }
      if owner {
        Button("Rename", systemImage: "pencil") {
          name = context.title
          editingName = true
        }
      }
    }
  }

  @ViewBuilder
  private func resourceDestination(_ resource: Resource) -> some View {
    switch resource {
    case .apps: NativeAppsView(client: model.client, user: identity.user, scope: context.scopeId)
    case .files: NativeFilesView(client: model.client, scope: context.scopeId)
    case .skills:
      NativeSkillsView(client: model.client, user: identity.user, scope: context.scopeId)
    case .model: RuntimeControlsView(client: model.client, scopeID: context.scopeId)
    }
  }

  private func rename() async {
    guard let project else { return }
    _ = await model.mutate(
      "api/projects/\(project.id.apiComponent)", body: ["name": name], method: "PATCH")
  }

  private func linkSlack() async {
    guard let project else { return }
    _ = await model.mutate(
      "api/projects/\(project.id.apiComponent)/slack-channel",
      body: ["channel": slackChannel], method: "PUT")
  }

  private func remove(_ member: WorkspaceProject.Member, from project: WorkspaceProject) async {
    _ = await model.mutate(
      "api/projects/\(project.id.apiComponent)/members/\(member.principalId.apiComponent)",
      method: "DELETE")
  }

  private func unlinkSlack() async {
    guard let project else { return }
    _ = await model.mutate(
      "api/projects/\(project.id.apiComponent)/slack-channel", method: "DELETE")
  }
}

enum NativeTriState: String, CaseIterable, Identifiable {
  case `default`, on, off
  var id: String { rawValue }

  init(_ value: Bool?) {
    switch value {
    case nil: self = .default
    case true?: self = .on
    case false?: self = .off
    }
  }

  var body: Any {
    switch self {
    case .default: NSNull()
    case .on: true
    case .off: false
    }
  }

  var label: String { rawValue.capitalized }
}

struct AmbientBotPolicy: Decodable, Hashable {
  let mode: String
  let rollupHours: Double?

  var label: String {
    switch mode {
    case "ignore": "Ignore"
    case "rollup": "Batch every \((rollupHours ?? 24).formatted())h"
    case "action": "Act immediately"
    case "user": "Treat like a person"
    default: mode
    }
  }

  var body: [String: Any] {
    var out: [String: Any] = ["mode": mode]
    if mode == "rollup", let rollupHours { out["rollupHours"] = rollupHours }
    return out
  }
}

struct AmbientBot: Identifiable, Hashable {
  let name: String
  let policy: AmbientBotPolicy
  var id: String { name }
}

struct AmbientPolicy: Decodable {
  let orders: String
  let bots: [String: AmbientBotPolicy]
  let ambientEnabled: Bool?
  let updatedAt: Double

  var ledger: [AmbientBot] {
    bots.map { AmbientBot(name: $0.key, policy: $0.value) }
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }
}

struct AmbientPolicyResponse: Decodable { let policy: AmbientPolicy }

struct ChannelHeaderPin: Decodable {
  let configured: Bool?
  var `default`: Bool?
}

@MainActor @Observable
final class ChannelPolicyModel {
  let client: APIClient
  let scopeId: String
  let supportsHeaderPin: Bool
  var orders = "" { didSet { if orders != oldValue { justSaved = false } } }
  var ambient = NativeTriState.default { didSet { if ambient != oldValue { justSaved = false } } }
  private(set) var bots: [AmbientBot] = []
  private(set) var saved: AmbientPolicy?
  private(set) var saving = false
  private(set) var error: String?
  private(set) var justSaved = false
  private(set) var headerPin: ChannelHeaderPin?
  private(set) var headerPinError: String?
  private(set) var updatingHeaderPin = false
  private let loader = LoadGuard()
  private let pinLoader = LoadGuard()

  init?(client: APIClient, scopeId: String) {
    guard let kind = ScopeKind(scopeId: scopeId), [.channel, .group].contains(kind) else {
      return nil
    }
    self.client = client
    self.scopeId = scopeId
    supportsHeaderPin = kind == .channel
  }

  var loaded: Bool { saved != nil }

  var dirty: Bool {
    guard let saved else { return false }
    return orders != saved.orders || ambient != NativeTriState(saved.ambientEnabled)
      || bots != saved.ledger
  }

  var headerPinState: NativeTriState { NativeTriState(headerPin?.configured) }
  var headerPinDefaultLabel: String { "Default (\(headerPin?.default == true ? "on" : "off"))" }

  private var policyPath: String { "api/contexts/\(scopeId.apiComponent)/ambient-policy" }

  func load() async {
    async let pin: Void = await loadHeaderPin()
    if !dirty {
      await loader.run {
        try await client.fetch(policyPath) as AmbientPolicyResponse
      } apply: { response in
        guard !dirty else { return }
        apply(response.policy)
        error = nil
      } failed: {
        error = $0.localizedDescription
      }
    }
    await pin
  }

  private func loadHeaderPin() async {
    guard supportsHeaderPin, !updatingHeaderPin else { return }
    await pinLoader.run {
      try await client.fetch(
        "api/channel-header-pin", query: [.init(name: "scopeId", value: scopeId)])
        as ChannelHeaderPin
    } apply: { pin in
      headerPin = pin
      headerPinError = nil
    } failed: {
      headerPinError = $0.localizedDescription
    }
  }

  private func apply(_ policy: AmbientPolicy) {
    orders = policy.orders
    ambient = NativeTriState(policy.ambientEnabled)
    bots = policy.ledger
    saved = policy
  }

  func removeBot(_ bot: AmbientBot) {
    bots.removeAll { $0.id == bot.id }
    justSaved = false
  }

  func save() async {
    guard !saving, let saved else { return }
    saving = true
    error = nil
    justSaved = false
    loader.cancel()
    defer { saving = false }
    let body: [String: Any] = [
      "orders": orders,
      "bots": Dictionary(uniqueKeysWithValues: bots.map { ($0.name, $0.policy.body) }),
      "ambientEnabled": ambient.body,
      "baseUpdatedAt": saved.updatedAt,
    ]
    do {
      let result: AmbientPolicyResponse = try await client.fetch(
        policyPath, body: body, method: "PUT")
      apply(result.policy)
      justSaved = true
    } catch { self.error = error.localizedDescription }
  }

  func setHeaderPin(_ state: NativeTriState) async {
    guard !updatingHeaderPin, state != headerPinState else { return }
    updatingHeaderPin = true
    headerPinError = nil
    pinLoader.cancel()
    defer { updatingHeaderPin = false }
    do {
      var updated: ChannelHeaderPin = try await client.fetch(
        "api/channel-header-pin", body: ["scopeId": scopeId, "on": state.body], method: "PUT")
      updated.default = updated.default ?? headerPin?.default
      headerPin = updated
    } catch { headerPinError = error.localizedDescription }
  }
}

struct ChannelPolicySection: View {
  @Bindable var model: ChannelPolicyModel

  var body: some View {
    Section("Agent behavior") {
      Group {
        Picker("Ambient behavior", selection: $model.ambient) {
          ForEach(NativeTriState.allCases) { Text($0.label).tag($0) }
        }
        VStack(alignment: .leading, spacing: 6) {
          Text("Standing orders").font(.caption).foregroundStyle(.secondary)
          TextField("None", text: $model.orders, axis: .vertical).lineLimit(3...10)
        }
        ForEach(model.bots) { bot in
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text(bot.name)
              Text(bot.policy.label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Remove", role: .destructive) { model.removeBot(bot) }
              .font(.caption).buttonStyle(.borderless)
          }
        }
      }.disabled(!model.loaded || model.saving)
      if model.loaded || model.error == nil {
        Button {
          Task { await model.save() }
        } label: {
          NativeActionLabel(title: "Save", busyTitle: "Saving…", busy: model.saving)
        }.disabled(!model.dirty || model.saving)
      } else {
        Button("Try again") { Task { await model.load() } }
      }
      if let error = model.error ?? model.headerPinError {
        Text(error).font(.caption).foregroundStyle(.red)
      } else {
        Text(model.justSaved ? "Saved" : model.loaded ? "" : "Loading…")
          .font(.caption).lineLimit(2, reservesSpace: true).foregroundStyle(.secondary)
      }
      if model.supportsHeaderPin {
        Picker(
          "Pinned header",
          selection: Binding(
            get: { model.headerPinState },
            set: { state in Task { await model.setHeaderPin(state) } })
        ) {
          ForEach(NativeTriState.allCases) { state in
            Text(state == .default ? model.headerPinDefaultLabel : state.label).tag(state)
          }
        }.disabled(model.headerPin == nil || model.updatingHeaderPin)
      }
    }
  }
}

struct DirectoryPerson: Decodable, Identifiable {
  let principalId: String
  let displayName: String
  let type: String
  var id: String { principalId }
}
struct DirectoryMatches: Decodable { let matches: [DirectoryPerson] }

struct ProjectMemberPicker: View {
  @Bindable var model: ProjectsModel
  let project: WorkspaceProject
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var matches: [DirectoryPerson] = []
  @State private var searching = false
  @State private var error: String?
  @State private var selected: DirectoryPerson?
  private var matchingPeople: [DirectoryPerson] {
    matches.filter { !project.memberIds.contains($0.id) }
  }

  var body: some View {
    NavigationStack {
      QMList {
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
        ForEach(matchingPeople) { person in
          Button {
            selected = person
          } label: {
            Label(person.displayName, systemImage: "person.badge.plus")
          }.disabled(model.busy)
        }
        if matchingPeople.isEmpty && !searching && error == nil && model.error == nil {
          Text(
            query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2
              ? "Search for a person in your workspace."
              : matches.isEmpty
                ? "No matching people." : "Everyone found is already in this project."
          )
          .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Add people")
      .searchable(text: $query, prompt: "Name or email")
      .toolbar { Button("Done") { dismiss() }.disabled(model.busy) }
      .overlay { if searching || model.busy { ProgressView() } }
      .task(id: query) {
        matches = []
        error = nil
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard term.count >= 2 else {
          searching = false
          return
        }
        searching = true
        do {
          try await Task.sleep(for: .milliseconds(250))
          let result: DirectoryMatches = try await model.client.fetch(
            "api/directory/resolve", query: [.init(name: "q", value: term)])
          try Task.checkCancellation()
          matches = result.matches.filter { $0.type == "internal" }
          searching = false
        } catch {
          guard !Task.isCancelled else { return }
          self.error = error.localizedDescription
          searching = false
        }
      }
      .confirmationDialog(
        "Add this person to the project?",
        isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })
      ) {
        if let selected {
          Button("Add \(selected.displayName)") {
            Task {
              if await model.mutate(
                "api/projects/\(project.id.apiComponent)/members",
                body: ["memberId": selected.principalId]) != nil
              {
                dismiss()
              }
            }
          }
        }
      } message: {
        Text("They will gain access to the project's conversations and resources.")
      }
      .interactiveDismissDisabled(model.busy)
    }
  }
}
