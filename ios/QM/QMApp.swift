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
  private enum Page: Hashable {
    case workspace, search, waiting, archived, setup
  }

  @State private var section = ShellSection.home
  @State private var keyboardUp = false

  @State private var homePath: [Page] = []
  @Bindable var model: AppModel
  @State private var selectedConversation: Conversation?
  @State private var showingConversations = false
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("webOnly") private var webOnly = false
  @State private var search = ""
  @State private var rename: Conversation?
  @State private var renamedTitle = ""
  @State private var choosingWorkspace = false
  @State private var confirmingSignOut = false
  @Environment(\.scenePhase) private var phase

  private var searchTerm: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var narrowing: Bool {
    model.narrowing || model.search != searchTerm || model.webOnly != webOnly
  }

  private var visibleConversations: [Conversation] {
    model.visibleConversations(search: searchTerm, webOnly: webOnly)
  }

  private var home: some View { chatsStack }

  private var waitingCount: Int {
    model.conversations.filter { $0.awaitingInput == true && $0.archived != true }.count
  }

  private var chatsStack: some View {
    let contexts = Dictionary(uniqueKeysWithValues: model.contexts.map { ($0.scopeId, $0) })
    return NavigationStack(path: $homePath) {
      Group {
        if let identity = model.identity {
          QMList(background: QMTheme.sidebar) {
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
              .listRowBackground(QMTheme.sidebar)
              .listRowSeparator(.hidden)
          }
          .listStyle(.plain)
          .listSectionSpacing(0)
          .listRowSpacing(0)
          .environment(\.defaultMinListRowHeight, 40)
          .frame(maxWidth: QMTheme.conversationWidth)
          .frame(maxWidth: .infinity)
          .scrollContentBackground(.hidden)
          .background(QMTheme.sidebar)
          .refreshable { await model.refresh() }
          .contentMargins(.top, 4, for: .scrollContent)
          .toolbar(.hidden, for: .navigationBar)
          .safeAreaInset(edge: .top, spacing: 0) { listHeader(identity) }
        } else if model.client?.hasSession == true {
          workspaceConnection
        } else {
          WelcomeView(model: model, choosingWorkspace: $choosingWorkspace)
        }
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        if model.identity != nil {
          VStack(spacing: 8) {
            if !model.conversations.isEmpty { ConversationErrorBanner(model: model) }
            if showsNav { Color.clear.frame(height: ShellNav.height) }
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
      isOpen: $showingConversations, hasSelection: model.identity != nil && model.client != nil,
      showsSidebarPage: !homePath.isEmpty, fullWidth: true
    ) {
      home
    } detail: {
      shell
    }
    // One nav for the whole app, drawn above both the list and the main screen so it stays
    // put while they slide underneath it.
    .overlay(alignment: .bottom) {
      if showsNav { nav(plain: false, inList: showingConversations) }
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) {
      _ in keyboardUp = true
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) {
      _ in keyboardUp = false
    }
    .environment(\.qmIdentity, model.identity)
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
    .modifier(
      ConversationDrawerEffects(
        isOpen: $showingConversations, selected: selectedConversation,
        listVisible: homePath.isEmpty, phase: phase, model: model)
    )
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
    section = .home
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
      Image(systemName: "gearshape")
    }
    .accessibilityLabel("Account and settings")
  }

  // The main screen: the open conversation, Waiting or More, with a small nav underneath.
  @ViewBuilder
  private var shell: some View {
    if let client = model.client, let identity = model.identity {
      Group {
        switch section {
        case .home:
          if let conversation = selectedConversation {
            NavigationStack {
              ChatView(
                model: ChatModel(
                  conversation: conversation, client: client, user: identity.user,
                  knownSession: conversation.localOnly != true),
                onShowConversations: { showingConversations = true },
                bottomInset: showsNav ? ShellNav.height : 0)
            }
            .id(conversation.id)
            .environment(\.scenePhase, homePath.isEmpty ? phase : .background)
          } else {
            QMTheme.paper.ignoresSafeArea()
              .task { selectedConversation = model.newConversation() }
          }
        case .waiting:
          NavigationStack { waitingConversations.toolbar { menuToolbar }.modifier(navRoom) }
        case .more:
          NavigationStack {
            MoreGrid(identity: identity, client: client).toolbar { menuToolbar }.modifier(navRoom)
          }
        }
      }
    }
  }

  private var showsNav: Bool { model.identity != nil && model.client != nil && !keyboardUp }

  /// Keeps scrolling content clear of the bottom nav, which floats above every screen.
  private var navRoom: NavRoom { NavRoom(height: showsNav ? ShellNav.height : 0) }

  private func nav(plain: Bool, inList: Bool = false) -> ShellNav {
    let selected: ShellNavItem
    if inList {
      selected = .conversations
    } else {
      selected =
        switch section {
        case .more: .more
        case .waiting: .conversations
        case .home: selectedConversation?.localOnly == true ? .new : .conversations
        }
    }
    return ShellNav(selected: selected, waiting: waitingCount, plain: plain) { item in
      switch item {
      case .conversations: showingConversations = true
      case .new:
        // Already on a blank chat: just bring it back instead of doing nothing.
        if section == .home, selectedConversation?.localOnly == true {
          showingConversations = false
        } else if let conversation = model.newConversation() {
          open(conversation)
        }
      case .more:
        section = .more
        showingConversations = false
      }
    }
  }

  @ToolbarContentBuilder
  private var menuToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button {
        showingConversations = true
      } label: {
        Image(systemName: "line.3.horizontal")
      }
      .accessibilityLabel("Conversations")
    }
  }

  // An opaque bar with search and settings; the list starts right under it and scrolls beneath.
  private func listHeader(_ identity: Identity) -> some View {
    HStack(spacing: 4) {
      Spacer()
      NavigationLink(value: Page.search) {
        Image(systemName: "magnifyingglass").frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Search")
      accountMenu(identity).frame(width: 44, height: 44)
    }
    .font(.system(size: 19, weight: .medium))
    .foregroundStyle(QMTheme.ink)
    .padding(.horizontal, 12)
    .padding(.bottom, 4)
    .background(QMTheme.sidebar.ignoresSafeArea(edges: .top))
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
      .listRowBackground(QMTheme.sidebar)
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

// Reads the drawer's open state here rather than in RootView, so opening or closing the
// drawer re-runs this modifier alone instead of RootView and the conversation inside it.
private struct ConversationDrawerEffects: ViewModifier {
  @Binding var isOpen: Bool
  let selected: Conversation?
  let listVisible: Bool
  let phase: ScenePhase
  let model: AppModel

  private var syncURL: URL? {
    // Launch now opens on Home with the list closed, so also sync until the workspace loads.
    guard phase == .active, (isOpen && listVisible) || model.identity == nil,
      model.client?.hasSession == true
    else {
      return nil
    }
    return model.client?.baseURL
  }

  private var openConversation: Conversation? { isOpen ? nil : selected }

  func body(content: Content) -> some View {
    content
      .onChange(of: openConversation?.threadRef) {
        let opened = openConversation
        Task { await model.open(opened) }
      }
      .task(id: syncURL) {
        if syncURL != nil { await model.watchConversations() }
      }
  }
}

enum ShellSection: Hashable {
  case home, waiting, more
}

/// Small icon-only nav under the main screen, in the style of the ChatGPT app.
enum ShellNavItem {
  case conversations, new, more
}

struct ShellNav: View {
  /// Height above the home indicator: 8 top + 40 item, sitting right on the indicator area.
  static let height: CGFloat = 48

  let selected: ShellNavItem
  let waiting: Int
  /// Inside the conversation's own bottom bar, which already has a background and padding.
  var plain = false
  let action: (ShellNavItem) -> Void

  var body: some View {
    HStack(spacing: 24) {
      item(
        .conversations, icon: "line.3.horizontal", filled: "line.3.horizontal",
        label: "Conversations")
      item(.new, icon: "square.and.pencil", filled: "square.and.pencil", label: "New chat")
      item(.more, icon: "square.grid.2x2", filled: "square.grid.2x2.fill", label: "More")
    }
    .frame(maxWidth: .infinity)
    // Match the composer bar's padding so the nav sits at the same height on every screen.
    .padding(.top, plain ? 0 : 8)
    .background {
      // Blur what scrolls underneath; inside the composer bar there is already a background.
      if !plain { Rectangle().fill(.ultraThinMaterial).ignoresSafeArea(edges: .bottom) }
    }
  }

  private func item(
    _ target: ShellNavItem, icon: String, filled: String, label: String
  ) -> some View {
    let isSelected = selected == target
    return Button {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      action(target)
    } label: {
      Image(systemName: isSelected ? filled : icon)
        .font(.system(size: 20, weight: .medium))
        .frame(width: 64, height: 40)
        .background {
          if isSelected { Capsule().fill(QMTheme.ink.opacity(0.1)) }
        }
        .overlay(alignment: .topTrailing) {
          if target == .conversations, waiting > 0 {
            Circle().fill(QMTheme.unread).frame(width: 8, height: 8).offset(x: -12, y: 6)
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(NavPressStyle())
    .foregroundStyle(QMTheme.ink.opacity(isSelected ? 1 : 0.6))
    .accessibilityLabel(label)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

struct NavRoom: ViewModifier {
  let height: CGFloat
  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: height) }
  }
}

/// Shrinks on touch-down so a tap registers immediately.
private struct NavPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.88 : 1)
      .opacity(configuration.isPressed ? 0.7 : 1)
      .animation(.snappy(duration: 0.12), value: configuration.isPressed)
  }
}

/// Liquid Glass capsule on iOS 26, material before it.
struct GlassPill: ViewModifier {
  let prominent: Bool

  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content
        .foregroundStyle(prominent ? QMTheme.paper : QMTheme.ink)
        .glassEffect(
          prominent ? .regular.tint(QMTheme.ink).interactive() : .regular.interactive(),
          in: .capsule)
    } else {
      content
        .foregroundStyle(prominent ? QMTheme.paper : QMTheme.ink)
        .background(prominent ? AnyShapeStyle(QMTheme.ink) : AnyShapeStyle(.thinMaterial), in: Capsule())
    }
  }
}
