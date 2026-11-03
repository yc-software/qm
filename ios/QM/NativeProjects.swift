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
  let scopeId: String
  let kind: String
  let name: String?
  let isPrivate: Bool?
  let sessionCount: Int
  let project: WorkspaceProject?
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
  var conversations: [Conversation] = []
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
      let result: WorkspaceContexts = try await client.fetch("api/contexts")
      let sessions: ConversationList = try await client.fetch("api/sessions")
      return (result, sessions)
    } apply: { result, sessions in
      contexts = result.contexts
      conversations = DraftStore.merging(
        sessions.sessions, account: client.baseURL.absoluteString + user)
      error = nil
    } failed: {
      error = $0.localizedDescription
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
        sessionCount: conversations.filter { $0.scopeId == result.project.scopeId }.count,
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
    model.contexts.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
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
      if visibleContexts.isEmpty && !model.loading && model.error == nil && !query.isEmpty {
        ContentUnavailableView {
          Label("No matching projects", systemImage: "magnifyingglass")
        } description: {
          Text("Try another project or channel name.")
        } actions: {
          Button("Clear search") { query = "" }
        }
      } else if model.contexts.isEmpty && !model.loading && model.error == nil {
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
    .overlay { if model.loading && model.contexts.isEmpty { ProgressView() } }
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
            Button(model.busy ? "Creating…" : "Create") {
              Task {
                if await model.mutate(
                  "api/projects",
                  body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines)]) != nil
                {
                  creating = false
                }
              }
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
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var context: WorkspaceContext {
    model.contexts.first { $0.id == original.id } ?? original
  }
  private var project: WorkspaceProject? { context.project }
  private var owner: Bool { project?.ownerId == identity.user }

  private var conversations: [Conversation] {
    sidebarConversations(model.conversations).filter {
      $0.scopeId == context.scopeId && $0.archived != true
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
          "\(conversations.count) \(conversations.count == 1 ? "conversation" : "conversations") · \(context.isPersonal ? "Your workspace" : "Shared workspace")"
      )
      resourceGrid
      if let error = model.error { Text(error).foregroundStyle(.red) }
      conversationsSection
      if let project { projectSections(project) }
    }
    .disabled(model.busy)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle(context.title).navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }
    .refreshable { await model.load() }
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
          NativeConversationRow(conversation: conversation, showsContext: false)
        }
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
        if owner { Button("Unlink channel", role: .destructive) { unlinkingSlack = true } }
      } else {
        Text("No linked channel").foregroundStyle(.secondary)
        if owner {
          Button("Link Slack channel") {
            slackChannel = ""
            editingSlack = true
          }
        }
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup {
      Button("New conversation", systemImage: "square.and.pencil") {
        let id = UUID().uuidString.lowercased()
        newConversation = Conversation(
          id: id, scopeId: context.scopeId,
          threadRef: "web:\(identity.user):\(id)", surface: "web", channelName: context.title,
          localOnly: true)
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

  var body: some View {
    NavigationStack {
      QMList {
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
        ForEach(matches.filter { person in !project.memberIds.contains(person.id) }) { person in
          Button {
            selected = person
          } label: {
            Label(person.displayName, systemImage: "person.badge.plus")
          }.disabled(model.busy)
        }
        if matches.isEmpty && !searching {
          Text(query.count < 2 ? "Search for a person in your workspace." : "No matching people.")
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
