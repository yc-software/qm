import Network
import SwiftUI
import os

extension ConversationFilter {
  var query: [URLQueryItem] {
    self == .active ? [] : [URLQueryItem(name: "status", value: rawValue.lowercased())]
  }
}

extension Conversation {
  var tracksUnread: Bool { surface == "web" }
}

@MainActor @Observable
final class AppModel {
  private(set) var client: APIClient?
  var identity: Identity?
  var conversations: [Conversation] = []
  var contexts: [WorkspaceContext] = []
  var customEmoji: [String: URL] = [:]
  private var customEmojiLoad: Task<Void, Never>?
  private var contextsLoaded = false
  var error: String?
  var loading = false
  private(set) var filter = ConversationFilter.active
  private(set) var search = ""
  private(set) var webOnly = false
  private(set) var narrowing = false
  private(set) var nextCursor: String?
  private(set) var loadingMore = false
  private(set) var openThread: String?
  private(set) var hasLoadedConversations = false
  private(set) var updatingConversationIDs = Set<String>()
  var showingInitialConversationLoad: Bool {
    loading && !hasLoadedConversations && conversations.isEmpty && error == nil
  }
  private let signIn = SignIn()
  private var cleanedAccount: String?
  private let defaults: UserDefaults
  private var loadRevision = UUID()
  private var pageRevision = UUID()
  private var paged = false
  private var leftThreads = Set<String>()

  init(
    defaults: UserDefaults = .standard, configuredURL: String? = nil,
    configuration: URLSessionConfiguration = .ephemeral
  ) {
    self.defaults = defaults
    let raw =
      defaults.string(forKey: "workspaceOrigin") ?? configuredURL
      ?? (Bundle.main.object(forInfoDictionaryKey: "QMBaseURL") as? String ?? "")
    if let url = Self.workspaceURL(raw) {
      client = APIClient(baseURL: url, configuration: configuration)
    } else {
      client = nil
    }
  }

  func selectWorkspace(_ raw: String) throws {
    guard let url = Self.workspaceURL(raw) else {
      throw QMError.message("That isn’t a valid workspace address. \(Self.workspaceAddressHint)")
    }
    if url == client?.baseURL { return }
    signOut()
    client = APIClient(baseURL: url)
    defaults.set(url.absoluteString, forKey: "workspaceOrigin")
  }

  static func workspaceURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let input = workspaceInputWithScheme(trimmed)
    guard var parts = URLComponents(string: input) else { return nil }
    parts.scheme = parts.scheme?.lowercased()
    parts.host = parts.host?.lowercased()
    guard let candidate = parts.url, allowedURL(candidate) else { return nil }
    parts.path = ""
    if (parts.scheme == "https" && parts.port == 443)
      || (parts.scheme == "http" && parts.port == 80)
    {
      parts.port = nil
    }
    return parts.url
  }

  static func allowedURL(_ url: URL) -> Bool {
    guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/", let host = url.host, !host.isEmpty
    else { return false }
    if url.scheme == "https" { return true }
    #if DEBUG
      return url.scheme == "http" && isLocalDevelopmentHost(host)
    #else
      return false
    #endif
  }

  static var workspaceAddressHint: String {
    #if DEBUG
      "Use HTTPS for hosted workspaces; local development addresses may use HTTP."
    #else
      "Use the HTTPS origin without a path or sign-in details."
    #endif
  }

  private static func workspaceInputWithScheme(_ input: String) -> String {
    guard !input.contains("://") else { return input }
    return "https://\(input)"
  }

  private static func isLocalDevelopmentHost(_ rawHost: String) -> Bool {
    let host = rawHost.lowercased().trimmingCharacters(
      in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
    if let address = IPv6Address(host) {
      let bytes = address.rawValue
      return address == .loopback || bytes[0] & 0xfe == 0xfc
        || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80)
    }
    guard let address = IPv4Address(host) else { return false }
    let octets = address.rawValue
    return octets[0] == 10 || octets[0] == 127
      || (octets[0] == 172 && (16...31).contains(octets[1]))
      || (octets[0] == 192 && octets[1] == 168)
      || (octets[0] == 169 && octets[1] == 254)
  }

  func restore() async {
    guard client?.hasSession == true else { return }
    await load()
  }

  func watchConversations(interval: Duration = .seconds(5)) async {
    guard let client else { return }
    let generation = client.generation
    var refreshContext = true
    while !Task.isCancelled, self.client === client, client.generation == generation,
      client.hasSession
    {
      if !loading {
        await load(refreshIdentity: false, refreshContexts: refreshContext)
        refreshContext = false
      }
      do { try await Task.sleep(for: interval) } catch { return }
    }
  }

  func authenticate() async {
    guard let client, !loading else { return }
    let generation = client.generation
    loading = true
    error = nil
    do {
      try await signIn.authenticate(client: client)
      guard self.client === client, client.generation == generation else { return }
      loading = false
      await load()
    } catch is CancellationError {
      guard self.client === client, client.generation == generation else { return }
      loading = false
    } catch {
      guard self.client === client, client.generation == generation else { return }
      self.error = error.localizedDescription
      loading = false
    }
  }

  func load(refreshIdentity: Bool = true, refreshContexts: Bool = false) async {
    guard let client else { return }
    let current = client.generation
    let revision = UUID()
    loadRevision = revision
    loading = true
    defer { if loadRevision == revision { loading = false } }
    do {
      async let fetchedList: ConversationList = client.fetch("api/sessions", query: listQuery)
      if refreshIdentity || refreshContexts { contextsLoaded = false }
      async let fetchedContexts: WorkspaceContexts? =
        !contextsLoaded
        ? client.fetch("api/contexts") : nil
      let user: Identity
      if !refreshIdentity, let identity {
        user = identity
      } else {
        user = try await client.fetch("me")
      }
      guard self.client === client, current == client.generation, loadRevision == revision else {
        return
      }
      let account = client.baseURL.absoluteString + user.user
      if cleanedAccount != account {
        try DraftStore.pruneAttachments(account)
        cleanedAccount = account
      }
      guard self.client === client, current == client.generation, loadRevision == revision else {
        return
      }
      identity = user
      let list = try await fetchedList
      guard self.client === client, current == client.generation, loadRevision == revision else {
        return
      }
      conversations = DraftStore.merging(firstPage(list), account: account)
      error = nil
      hasLoadedConversations = true
      if let result = try await fetchedContexts {
        guard self.client === client, current == client.generation, loadRevision == revision else {
          return
        }
        contexts = result.contexts
        contextsLoaded = true
        if customEmojiLoad == nil, contexts.contains(where: { $0.projectIcon?.kind == "custom" }) {
          customEmojiLoad = Task { await loadCustomEmoji(client) }
        }
      }
      error = nil
      let left = leftThreads
      leftThreads = []
      await markRead(left)
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled, self.client === client, loadRevision == revision,
        current == client.generation || !client.hasSession
      else { return }
      self.error = error.localizedDescription
      if case QMError.signedOut = error {
        resetAfterSessionLoss()
      }
    }
  }

  func visibleConversations(search: String, webOnly: Bool) -> [Conversation] {
    let matchingScopes = Set(
      contexts.filter { $0.title.localizedCaseInsensitiveContains(search) }.map(\.scopeId))
    return sidebarConversations(conversations).filter {
      filter.includes($0)
        && (!webOnly || $0.surface == "web")
        && (search.isEmpty || $0.label.localizedCaseInsensitiveContains(search)
          || $0.contextLabel?.localizedCaseInsensitiveContains(search) == true
          || matchingScopes.contains($0.scopeId))
    }
  }

  private var listQuery: [URLQueryItem] {
    filter.query
      + (webOnly ? [URLQueryItem(name: "surface", value: "web")] : [])
      + (search.isEmpty ? [] : [URLQueryItem(name: "q", value: search)])
  }

  func narrow(search: String, webOnly: Bool) async {
    guard search != self.search || webOnly != self.webOnly else { return }
    self.search = search
    self.webOnly = webOnly
    resetPaging()
    nextCursor = nil
    narrowing = true
    await load(refreshIdentity: false)
    if search == self.search, webOnly == self.webOnly { narrowing = false }
  }

  private func firstPage(_ list: ConversationList) -> [Conversation] {
    guard paged, list.nextCursor != nil, let floor = list.sessions.last?.lastActivityAt else {
      paged = false
      nextCursor = list.nextCursor
      return list.sessions
    }
    let servedIDs = Set(list.sessions.map(\.id))
    return list.sessions
      + conversations.filter { row in
        !servedIDs.contains(row.id) && row.localOnly != true && filter.includes(row)
          && (filter == .archived || row.pinned != true) && (row.lastActivityAt ?? 0) <= floor
      }
  }

  private func resetPaging() {
    pageRevision = UUID()
    paged = false
    loadingMore = false
  }

  func refresh() async {
    resetPaging()
    await load()
  }

  func select(_ filter: ConversationFilter) async {
    guard filter != self.filter else { return }
    self.filter = filter
    resetPaging()
    nextCursor = nil
    conversations = []
    hasLoadedConversations = false
    error = nil
    await load(refreshIdentity: false)
  }

  func loadMore() async {
    guard let client, let identity, let cursor = nextCursor, !loadingMore else { return }
    let generation = client.generation
    let revision = pageRevision
    loadingMore = true
    defer { if self.client === client, pageRevision == revision { loadingMore = false } }
    do {
      let page: ConversationList = try await client.fetch(
        "api/sessions", query: listQuery + [URLQueryItem(name: "before", value: cursor)])
      guard self.client === client, client.generation == generation, pageRevision == revision
      else { return }
      let loaded = conversations.filter { $0.localOnly != true }
      let known = Set(loaded.map(\.id))
      let older = page.sessions.filter { !known.contains($0.id) }
      conversations = DraftStore.merging(
        loaded + older, account: client.baseURL.absoluteString + identity.user)
      nextCursor = page.nextCursor
      paged = true
    } catch QMError.signedOut {
      if self.client === client { resetAfterSessionLoss() }
    } catch is CancellationError {
    } catch {
      guard self.client === client, client.generation == generation, pageRevision == revision
      else { return }
      self.error = error.localizedDescription
    }
  }

  private func mutate(
    _ conversation: Conversation,
    _ operation: (APIClient) async throws -> (inout Conversation) -> Void
  ) async {
    guard let client, conversation.localOnly != true,
      updatingConversationIDs.insert(conversation.id).inserted
    else { return }
    let generation = client.generation
    defer {
      if self.client === client, client.generation == generation {
        updatingConversationIDs.remove(conversation.id)
      }
    }
    do {
      let apply = try await operation(client)
      guard self.client === client, client.generation == generation else { return }
      if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
        apply(&conversations[index])
      }
      await load()
    } catch QMError.signedOut {
      if self.client === client { resetAfterSessionLoss() }
    } catch is CancellationError {
    } catch {
      guard self.client === client, client.generation == generation else { return }
      self.error = error.localizedDescription
    }
  }

  func update(_ conversation: Conversation, patch: [String: Any]) async {
    await mutate(conversation) { client in
      let updated: ConversationUpdate = try await client.fetch(
        "api/sessions/\(conversation.id)", body: patch)
      let resolved = updated.session
      return { row in
        guard resolved.id == row.id else { return }
        row.title = resolved.title
        row.pinned = resolved.pinned
        row.archived = resolved.archived
        row.color = resolved.color
        row.unread = resolved.unread
      }
    }
  }

  func open(_ conversation: Conversation?) async {
    if let left = openThread, left != conversation?.threadRef { leftThreads.insert(left) }
    openThread = conversation?.threadRef
    if let openThread { await markRead([openThread]) }
  }

  func left(_ threadRef: String) {
    leftThreads.insert(threadRef)
  }

  private func markRead(_ threads: Set<String>) async {
    guard let client else { return }
    var ids: [String] = []
    for index in conversations.indices
    where conversations[index].unread == true && threads.contains(conversations[index].threadRef) {
      conversations[index].unread = false
      ids.append(conversations[index].id)
    }
    let generation = client.generation
    await withTaskGroup(of: Void.self) { group in
      for id in ids {
        group.addTask { await self.markRead(id, client: client, generation: generation) }
      }
    }
  }

  private func markRead(_ id: String, client: APIClient, generation: UUID) async {
    guard client.generation == generation else { return }
    do {
      let _: ConversationUpdate = try await client.fetch(
        "api/sessions/\(id)", body: ["unread": false])
    } catch { Log.background.failure("Marking a conversation read", error) }
  }

  func newConversation() -> Conversation? {
    identity.map { .draft(user: $0.user) }
  }

  func signOut() {
    signIn.cancel()
    if let client, let identity {
      DraftStore.removeAccount(client.baseURL.absoluteString + identity.user)
    }
    client?.signOut()
    resetAfterSessionLoss()
    error = nil
  }

  func resetAfterSessionLoss() {
    guard client?.hasSession != true else { return }
    loadRevision = UUID()
    resetPaging()
    loading = false
    cleanedAccount = nil
    identity = nil
    conversations = []
    filter = .active
    nextCursor = nil
    openThread = nil
    leftThreads = []
    contexts = []
    contextsLoaded = false
    customEmojiLoad?.cancel()
    customEmojiLoad = nil
    customEmoji = [:]
    hasLoadedConversations = false
    updatingConversationIDs = []
  }

  private func loadCustomEmoji(_ client: APIClient) async {
    struct Catalog: Decodable { let emoji: [String: String]? }
    do {
      let catalog: Catalog = try await client.fetch("api/custom-emoji")
      guard self.client === client else { return }
      customEmoji = (catalog.emoji ?? [:]).compactMapValues(URL.init(string:))
    } catch {
      Log.background.failure("Loading custom emoji", error)
      // Let the next contexts load try again.
      if self.client === client { customEmojiLoad = nil }
    }
  }
}
