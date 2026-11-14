import SwiftUI

extension EnvironmentValues {
  @Entry var qmIdentity: Identity? = nil
  @Entry var qmSessionID: String? = nil
  @Entry var qmCustomEmoji: [String: URL] = [:]
}

@main
struct QMApp: App {
  @State private var model = AppModel()
  var body: some Scene {
    WindowGroup { RootView(model: model).tint(QMTheme.ink) }
  }
}

struct RootView: View {
  private enum Page: Hashable {
    case workspace, search, waiting, archived, setup
  }

  @State private var homePath: [Page] = []
  @Bindable var model: AppModel
  @State private var selectedConversation: Conversation?
  @State private var showingConversations = true
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("webOnly") private var webOnly = false
  @State private var search = ""
  @State private var rename: Conversation?
  @State private var renamedTitle = ""
  @State private var choosingWorkspace = false
  @State private var confirmingSignOut = false
  @Environment(\.scenePhase) private var phase

  private var conversationSyncURL: URL? {
    guard phase == .active, showingConversations, homePath.isEmpty, model.client?.hasSession == true
    else {
      return nil
    }
    return model.client?.baseURL
  }

  private var openConversation: Conversation? {
    showingConversations ? nil : selectedConversation
  }

  private var searchTerm: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var narrowing: Bool {
    model.narrowing || model.search != searchTerm || model.webOnly != webOnly
  }

  private var visibleConversations: [Conversation] {
    model.visibleConversations(search: searchTerm, webOnly: webOnly)
  }

  private var home: some View {
    let contexts = Dictionary(uniqueKeysWithValues: model.contexts.map { ($0.scopeId, $0) })
    return NavigationStack(path: $homePath) {
      Group {
        if let identity = model.identity {
          QMList {
            if webOnly {
              HStack {
                Text("Web conversations").foregroundStyle(.secondary)
                Spacer()
                Button("Show all") { webOnly = false }
                  .buttonStyle(.borderless)
                  .accessibilityLabel("Show all conversations")
              }
              .font(.subheadline)
              .listRowSeparator(.hidden)
            }
            if model.showingInitialConversationLoad {
              NativeConversationListLoading()
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                .listRowSeparator(.hidden)
            }
            NativeConversationSections(
              conversations: visibleConversations, contexts: contexts, search: search,
              selectedID: selectedConversation?.id, updatingIDs: model.updatingConversationIDs,
              onOpen: open, actions: conversationActions
            )
            .id(model.client?.baseURL)
            loadMoreRow
            emptyState(identity)
              .listRowBackground(QMTheme.paper)
              .listRowSeparator(.hidden)
          }
          .listStyle(.plain)
          .listSectionSpacing(0)
          .listRowSpacing(0)
          .environment(\.defaultMinListRowHeight, 40)
          .frame(maxWidth: QMTheme.conversationWidth)
          .frame(maxWidth: .infinity)
          .scrollContentBackground(.hidden)
          .background(QMTheme.paper)
          .refreshable { await model.refresh() }
          .toolbar { homeToolbar }
        } else if model.client?.hasSession == true {
          workspaceConnection
        } else {
          WelcomeView(model: model, choosingWorkspace: $choosingWorkspace)
        }
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        if let identity = model.identity {
          VStack(spacing: 8) {
            if !model.conversations.isEmpty {
              ConversationErrorBanner(model: model)
            }
            HStack(spacing: 10) {
              HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                  .foregroundStyle(.secondary)
                TextField("Find a conversation", text: $search)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .submitLabel(.search)
                  .accessibilityIdentifier("conversationSearch")
                if !search.isEmpty {
                  Button {
                    search = ""
                  } label: {
                    Image(systemName: "xmark.circle.fill")
                      .foregroundStyle(.secondary)
                  }
                  .accessibilityLabel("Clear conversation search")
                }
              }
              .padding(.horizontal, 16)
              .frame(height: 48)
              .background(.thinMaterial, in: Capsule())
              accountMenu(identity)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
          }
        }
      }
      .navigationDestination(for: Page.self) { page in
        if let client = model.client, let identity = model.identity {
          switch page {
          case .workspace: BrowseView(identity: identity, client: client)
          case .search: SearchView(client: client, user: identity.user)
          case .waiting: waitingConversations
          case .archived:
            archivedConversations
              .task { await model.select(.archived) }
              .onDisappear { Task { await model.select(.active) } }
          case .setup: NativeSetupView(client: client, identity: identity)
          }
        }
      }
    }
  }

  var body: some View {
    NativeConversationDrawer(
      isOpen: $showingConversations, hasSelection: selectedConversation != nil,
      showsSidebarPage: !homePath.isEmpty
    ) {
      home
    } detail: {
      if let conversation = selectedConversation, let client = model.client,
        let identity = model.identity
      {
        NavigationStack {
          ChatView(
            model: ChatModel(
              conversation: conversation, client: client, user: identity.user,
              knownSession: conversation.localOnly != true),
            showsConversations: showingConversations,
            onShowConversations: { showingConversations = true })
        }
        .id(conversation.id)
        .environment(\.scenePhase, homePath.isEmpty ? phase : .background)
      }
    }
    .environment(\.qmIdentity, model.identity)
    .environment(\.qmCustomEmoji, model.customEmoji)
    .environment(model)
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
    .confirmationDialog(
      "Sign out of QM?", isPresented: $confirmingSignOut, titleVisibility: .visible
    ) {
      Button("Sign out", role: .destructive) {
        selectedConversation = nil
        homePath = []
        showingConversations = true
        model.signOut()
      }
    } message: {
      Text("Signing out clears unsent drafts for this account on this device.")
    }
    .onChange(of: model.client?.baseURL) {
      selectedConversation = nil
      homePath = []
      showingConversations = true
      search = ""
    }
    .onChange(of: openConversation?.threadRef) {
      let opened = openConversation
      Task { await model.open(opened) }
    }
    .task(id: conversationSyncURL) {
      if conversationSyncURL != nil { await model.watchConversations() }
    }
    .task(id: [searchTerm, String(webOnly)]) {
      if !searchTerm.isEmpty {
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
      }
      await model.narrow(search: searchTerm, webOnly: webOnly)
    }
    .onChange(of: model.client?.hasSession) { _, hasSession in
      if hasSession == false {
        selectedConversation = nil
        homePath = []
        showingConversations = true
        model.resetAfterSessionLoss()
      }
    }
  }

  private func open(_ conversation: Conversation) {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    selectedConversation = conversation
    homePath = []
    showingConversations = false
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
          NativeActionLabel(title: "Try again", busyTitle: "Connecting…", busy: model.loading)
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
    if visibleConversations.isEmpty && !model.showingInitialConversationLoad && !narrowing {
      if model.error != nil && model.conversations.isEmpty {
        ContentUnavailableView {
          Label("Couldn’t load conversations", systemImage: "wifi.exclamationmark")
        } description: {
          Text("Check your connection and try again.")
        } actions: {
          Button {
            Task { await model.load() }
          } label: {
            NativeActionLabel(title: "Try again", busyTitle: "Loading…", busy: model.loading)
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
        let empty = ConversationEmptyState(filter: model.filter)
        ContentUnavailableView(
          empty.title, systemImage: empty.systemImage, description: Text(empty.description))
        if model.filter == .active, model.client != nil {
          NavigationLink("Set up QM", value: Page.setup)
        }
      }
    }
  }

  private func accountMenu(_ identity: Identity) -> some View {
    Menu {
      Text(identity.displayName ?? identity.user)
      NavigationLink("Waiting on you", value: Page.waiting)
      NavigationLink("Archived conversations", value: Page.archived)
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
      Button("Sign out", role: .destructive) { confirmingSignOut = true }
    } label: {
      Image(systemName: "person.crop.circle")
        .font(.system(size: 24))
        .frame(width: 48, height: 48)
        .background(.thinMaterial, in: Circle())
    }
    .accessibilityLabel("Account")
  }

  @ToolbarContentBuilder
  private var homeToolbar: some ToolbarContent {
    let wordmark = ToolbarItem(placement: .topBarLeading) {
      Text("QM")
        .font(.custom("IowanOldStyle-Roman", size: 28, relativeTo: .title))
        .fixedSize()
    }
    if #available(iOS 26.0, *) {
      wordmark.sharedBackgroundVisibility(.hidden)
    } else {
      wordmark
    }
    ToolbarItem(placement: .topBarTrailing) {
      if model.client != nil {
        NavigationLink(value: Page.search) {
          Image(systemName: "magnifyingglass")
        }.accessibilityLabel("Search workspace")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      if model.client != nil {
        NavigationLink(value: Page.workspace) {
          Image(systemName: "square.grid.2x2")
        }.accessibilityLabel("Browse workspace")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        if let conversation = model.newConversation() { open(conversation) }
      } label: {
        Image(systemName: "square.and.pencil")
      }
      .accessibilityLabel("New conversation")
    }
  }

  @ViewBuilder
  private var loadMoreRow: some View {
    if model.nextCursor != nil, !model.showingInitialConversationLoad {
      Button {
        Task { await model.loadMore() }
      } label: {
        NativeActionLabel(title: "Load more", busyTitle: "Loading…", busy: model.loadingMore)
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .disabled(model.loadingMore)
      .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
      .listRowSeparator(.hidden)
      .listRowBackground(QMTheme.paper)
    }
  }

  private var waitingConversations: some View {
    let showing = model.filter == .waiting
    let rows = showing ? visibleConversations : []
    let empty = ConversationEmptyState(filter: .waiting)
    return QMList {
      if !showing || model.showingInitialConversationLoad {
        NativeConversationListLoading()
          .listRowSeparator(.hidden)
      }
      conversationRows(rows)
      if showing { loadMoreRow }
    }
    .navigationTitle("Waiting on you")
    .safeAreaInset(edge: .bottom) { ConversationErrorBanner(model: model) }
    .refreshable { await model.refresh() }
    .overlay {
      if showing, !model.showingInitialConversationLoad, model.error == nil, rows.isEmpty {
        ContentUnavailableView(
          empty.title, systemImage: empty.systemImage, description: Text(empty.description))
      }
    }
    .task { await model.select(.waiting) }
    .onDisappear { Task { await model.select(.active) } }
  }

  private var archivedConversations: some View {
    let contexts = Dictionary(uniqueKeysWithValues: model.contexts.map { ($0.scopeId, $0) })
    return QMList {
      if model.showingInitialConversationLoad {
        NativeConversationListLoading()
          .listRowSeparator(.hidden)
      }
      ForEach(
        sidebarConversations(model.conversations).filter { $0.archived == true }
      ) { conversation in
        Button {
          open(conversation)
        } label: {
          NativeConversationRow(
            conversation: conversation,
            contextTitle: contexts[conversation.scopeId].flatMap { $0.isPersonal ? nil : $0.title },
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

  private func conversationRows(_ conversations: [Conversation]) -> some View {
    ForEach(conversations) { conversation in
      Button {
        open(conversation)
      } label: {
        NativeConversationRow(
          conversation: conversation,
          contextTitle: model.contexts.first { $0.scopeId == conversation.scopeId }.flatMap {
            $0.isPersonal ? nil : $0.title
          },
          updating: model.updatingConversationIDs.contains(conversation.id))
      }
      .buttonStyle(.plain)
      .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowSeparator(.hidden)
      .listRowBackground(QMTheme.paper)
      .contextMenu { conversationActions(conversation) }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        conversationActions(conversation)
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

struct ConversationEmptyState {
  let title: String
  let systemImage: String
  let description: String

  init(filter: ConversationFilter) {
    switch filter {
    case .active:
      title = "Give QM something to do"
      systemImage = "bubble.left.and.text.bubble.right"
      description = "Start a conversation. Your work stays in sync with QM on the web."
    case .waiting:
      title = "Nothing is waiting on you"
      systemImage = "checkmark.circle"
      description = "Conversations that need your approval or an answer will appear here."
    case .archived:
      title = "No archived conversations"
      systemImage = "archivebox"
      description = "Archive a conversation to keep it out of the way without deleting it."
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
            NativeActionLabel(title: "Reload", busyTitle: "Loading…", busy: model.loading)
          }.disabled(model.loading)
        }
        .padding().frame(maxWidth: .infinity).background(.regularMaterial)
        .accessibilityIdentifier("conversationErrorBanner")
      }
    }
  }
}
