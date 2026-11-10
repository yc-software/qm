import SwiftUI

extension EnvironmentValues {
  @Entry var qmIdentity: Identity? = nil
  @Entry var qmSessionID: String? = nil
}

@main
struct QMApp: App {
  @State private var model = AppModel()
  var body: some Scene {
    WindowGroup { RootView(model: model).tint(QMTheme.ink) }
  }
}

struct RootView: View {
  @Bindable var model: AppModel
  @State private var path: [Conversation] = []
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("webOnly") private var webOnly = false
  @State private var search = ""
  @State private var rename: Conversation?
  @State private var renamedTitle = ""
  @State private var choosingWorkspace = false
  @Environment(\.scenePhase) private var phase

  private var conversationSyncURL: URL? {
    guard phase == .active, path.isEmpty, model.client?.hasSession == true else { return nil }
    return model.client?.baseURL
  }

  private var visibleConversations: [Conversation] {
    sidebarConversations(model.conversations).filter {
      $0.archived != true
        && (!webOnly || $0.surface == "web")
        && (search.isEmpty || $0.label.localizedCaseInsensitiveContains(search))
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let identity = model.identity {
          QMList {
            HStack {
              Text(webOnly ? "Web conversations" : "Conversations")
                .foregroundStyle(.secondary)
              Spacer()
              if webOnly {
                Button("Show all") { webOnly = false }
                  .buttonStyle(.borderless)
                  .accessibilityLabel("Show all conversations")
              }
            }
            .font(.subheadline.weight(.medium))
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            .listRowBackground(QMTheme.paper)
            .listRowSeparator(.hidden)
            if model.showingInitialConversationLoad {
              NativeConversationListLoading()
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                .listRowSeparator(.hidden)
            }
            ForEach(visibleConversations) { conversation in
              NavigationLink(value: conversation) {
                NativeConversationRow(
                  conversation: conversation,
                  updating: model.updatingConversationIDs.contains(conversation.id))
              }
              .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
              .listRowSeparator(.hidden)
              .listRowBackground(QMTheme.paper)
              .contextMenu { conversationActions(conversation) }
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                conversationActions(conversation)
              }
            }
            emptyState(identity)
              .listRowBackground(QMTheme.paper)
              .listRowSeparator(.hidden)
          }
          .listStyle(.plain)
          .listSectionSpacing(0)
          .frame(maxWidth: QMTheme.conversationWidth)
          .frame(maxWidth: .infinity)
          .scrollContentBackground(.hidden)
          .background(QMTheme.paper)
          .searchable(text: $search, prompt: "Find a conversation")
          .refreshable { await model.load() }
          .toolbar { homeToolbar(identity) }
        } else if model.client?.hasSession == true {
          workspaceConnection
        } else {
          WelcomeView(model: model, choosingWorkspace: $choosingWorkspace)
        }
      }
      .navigationTitle(model.identity == nil ? "" : "QM")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        if model.identity != nil, !model.conversations.isEmpty {
          ConversationErrorBanner(model: model)
        }
      }
      .navigationDestination(for: Conversation.self) { conversation in
        if let client = model.client, let identity = model.identity {
          ChatView(
            model: ChatModel(
              conversation: conversation, client: client, user: identity.user,
              knownSession: conversation.localOnly != true))
        }
      }
    }
    .environment(\.qmIdentity, model.identity)
    .alert(
      "Rename conversation",
      isPresented: Binding(get: { rename != nil }, set: { if !$0 { rename = nil } })
    ) {
      TextField("Title", text: $renamedTitle)
      Button("Cancel", role: .cancel) { rename = nil }
      Button("Save") {
        if let conversation = rename {
          Task { await model.update(conversation, patch: ["title": renamedTitle]) }
        }
        rename = nil
      }
      .disabled(rename.map { model.updatingConversationIDs.contains($0.id) } ?? true)
    }
    .preferredColorScheme(
      appearance == "custom"
        ? NativeThemeStore.shared.palette.map { $0.dark ? .dark : .light }
        : appearance == "dark" ? .dark : appearance == "light" ? .light : nil
    )
    .onChange(of: appearance) { NativeThemeStore.shared.enabled = appearance == "custom" }
    .sheet(isPresented: $choosingWorkspace) { WorkspacePicker(model: model) }
    .onChange(of: model.client?.baseURL) {
      path = []
      search = ""
    }
    .task(id: conversationSyncURL) {
      if conversationSyncURL != nil { await model.watchConversations() }
    }
    .onChange(of: model.client?.hasSession) { _, hasSession in
      if hasSession == false {
        path = []
        model.resetAfterSessionLoss()
      }
    }
  }

  @ViewBuilder
  private var workspaceConnection: some View {
    if model.error != nil {
      ContentUnavailableView {
        Label("Couldn’t connect to your workspace", systemImage: "wifi.exclamationmark")
      } description: {
        Text("Your sign-in is saved. We’ll reconnect when your workspace is available.")
      } actions: {
        Button {
          Task { await model.restore() }
        } label: {
          NativeActionLabel(title: "Try again", busyTitle: "Connecting...", busy: model.loading)
        }.disabled(model.loading)
        Button("Change workspace") { choosingWorkspace = true }
      }
      .accessibilityIdentifier("workspaceConnectionError")
    } else {
      NativeTwinSailsLoading(label: "Loading your workspace")
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(QMTheme.paper.ignoresSafeArea())
    }
  }

  @ViewBuilder
  private func emptyState(_ identity: Identity) -> some View {
    if visibleConversations.isEmpty && !model.showingInitialConversationLoad {
      if model.error != nil && model.conversations.isEmpty {
        ContentUnavailableView {
          Label("Couldn’t load conversations", systemImage: "wifi.exclamationmark")
        } description: {
          Text("Check your connection and try again.")
        } actions: {
          Button {
            Task { await model.load() }
          } label: {
            NativeActionLabel(title: "Try again", busyTitle: "Loading...", busy: model.loading)
          }.disabled(model.loading)
        }
        .accessibilityIdentifier("conversationLoadError")
      } else if webOnly {
        ContentUnavailableView {
          Label(
            search.isEmpty ? "No web conversations" : "No matching web conversations",
            systemImage: search.isEmpty ? "bubble.left" : "magnifyingglass")
        } description: {
          Text("Your conversation filter is hiding Slack conversations.")
        } actions: {
          Button("Show all conversations") { webOnly = false }
        }
      } else if !search.isEmpty {
        ContentUnavailableView.search(text: search)
      } else {
        ContentUnavailableView(
          "Give QM something to do", systemImage: "bubble.left.and.text.bubble.right",
          description: Text(
            "Start a conversation. Your work stays in sync with QM on the web."))
        if let client = model.client {
          NavigationLink("Set up QM") {
            NativeSetupView(client: client, identity: identity)
          }
        }
      }
    }
  }

  @ToolbarContentBuilder
  private func homeToolbar(_ identity: Identity) -> some ToolbarContent {
    ToolbarItem(placement: .principal) {
      Text("QM").font(.custom("IowanOldStyle-Roman", size: 28, relativeTo: .title))
    }
    ToolbarItem(placement: .topBarLeading) {
      Menu {
        Text(identity.displayName ?? identity.user)
        NavigationLink("Archived conversations") { archivedConversations }
        Toggle("Web conversations only", isOn: $webOnly)
        Button("Change workspace") { choosingWorkspace = true }
        Picker("App appearance", selection: $appearance) {
          Text("System").tag("system")
          Text("Light").tag("light")
          Text("Dark").tag("dark")
          if let palette = NativeThemeStore.shared.palette {
            Text(palette.name).tag("custom")
          }
        }
        Button("Sign out", role: .destructive) {
          path = []
          model.signOut()
        }
      } label: {
        Image(systemName: "person.crop.circle")
      }
      .accessibilityLabel("Account")
    }
    ToolbarItem(placement: .topBarTrailing) {
      if let client = model.client {
        NavigationLink {
          SearchView(client: client, user: identity.user)
        } label: {
          Image(systemName: "magnifyingglass")
        }.accessibilityLabel("Search all messages")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      if let client = model.client {
        NavigationLink {
          BrowseView(identity: identity, client: client)
        } label: {
          Image(systemName: "square.grid.2x2")
        }.accessibilityLabel("Browse workspace")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        if let conversation = model.newConversation() { path.append(conversation) }
      } label: {
        Image(systemName: "square.and.pencil")
      }
      .accessibilityLabel("New conversation")
    }
  }

  private var archivedConversations: some View {
    QMList {
      if model.showingInitialConversationLoad {
        NativeConversationListLoading()
          .listRowSeparator(.hidden)
      }
      ForEach(
        sidebarConversations(model.conversations).filter { $0.archived == true }
      ) { conversation in
        NavigationLink(value: conversation) {
          NativeConversationRow(
            conversation: conversation,
            updating: model.updatingConversationIDs.contains(conversation.id))
        }
        .contextMenu { conversationActions(conversation) }
        .swipeActions { conversationActions(conversation) }
      }
    }
    .navigationTitle("Archived conversations")
    .safeAreaInset(edge: .bottom) { ConversationErrorBanner(model: model) }
    .refreshable { await model.load() }
    .overlay {
      if !model.showingInitialConversationLoad, model.error == nil,
        !sidebarConversations(model.conversations).contains(where: {
          $0.archived == true
        })
      {
        ContentUnavailableView("No archived conversations", systemImage: "archivebox")
      }
    }
  }

  @ViewBuilder
  private func conversationActions(_ conversation: Conversation) -> some View {
    if conversation.localOnly != true {
      Button(conversation.pinned == true ? "Unpin" : "Pin", systemImage: "pin") {
        Task {
          await model.update(conversation, patch: ["pinned": conversation.pinned != true])
        }
      }
      .tint(QMTheme.ink)
      .disabled(model.updatingConversationIDs.contains(conversation.id))
      Button("Rename", systemImage: "pencil") {
        renamedTitle = conversation.label
        rename = conversation
      }
      .tint(QMTheme.ink.opacity(0.55))
      .disabled(model.updatingConversationIDs.contains(conversation.id))
      Button(
        conversation.archived == true ? "Restore" : "Archive", systemImage: "archivebox"
      ) {
        Task {
          await model.update(conversation, patch: ["archived": conversation.archived != true])
        }
      }
      .tint(QMTheme.navy)
      .disabled(model.updatingConversationIDs.contains(conversation.id))
    }
  }
}

private struct ConversationErrorBanner: View {
  @Bindable var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      if model.identity != nil, let error = model.error {
        HStack {
          Text(error).font(.footnote)
          Button {
            Task { await model.restore() }
          } label: {
            NativeActionLabel(title: "Reload", busyTitle: "Loading...", busy: model.loading)
          }.disabled(model.loading)
        }
        .padding().frame(maxWidth: .infinity).background(.regularMaterial)
        .accessibilityIdentifier("conversationErrorBanner")
      }
    }
  }
}

struct NativeConversationRow: View {
  let conversation: Conversation
  var showsContext = true
  var updating = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 9) {
        if conversation.working == true {
          NativeWave().frame(width: 18, height: 10).foregroundStyle(.blue)
        } else if conversation.awaitingInput == true {
          Circle().fill(.orange).frame(width: 6, height: 6)
        }
        Text(conversation.label).font(.body)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        if let emoji = conversation.status?.emoji, !emoji.isEmpty {
          Text(emoji).font(.body)
        }
      }
      if updating {
        NativeActionLabel(title: "", busyTitle: "Updating...", busy: true)
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .frame(minHeight: 44)
  }
}
