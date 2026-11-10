import SwiftUI
import os

@MainActor @Observable
final class AppModel {
  private(set) var client: APIClient?
  var identity: Identity?
  var conversations: [Conversation] = []
  var error: String?
  var loading = false
  private(set) var hasLoadedConversations = false
  private(set) var updatingConversationIDs = Set<String>()
  var showingInitialConversationLoad: Bool {
    loading && !hasLoadedConversations && conversations.isEmpty && error == nil
  }
  private let signIn = SignIn()
  private var cleanedAccount: String?
  private let defaults: UserDefaults
  private var loadRevision = UUID()

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
    #if DEBUG
      if let host = URLComponents(string: "http://\(input)")?.host,
        isLocalDevelopmentHost(host)
      {
        return "http://\(input)"
      }
    #endif
    return "https://\(input)"
  }

  private static func isLocalDevelopmentHost(_ rawHost: String) -> Bool {
    let host = rawHost.lowercased().trimmingCharacters(
      in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
    if host.contains(":")
      && (host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8")
        || host.hasPrefix("fe9") || host.hasPrefix("fea") || host.hasPrefix("feb"))
    {
      return true
    }

    let octets = host.split(separator: ".", omittingEmptySubsequences: false).compactMap {
      UInt8($0)
    }
    guard octets.count == 4 else { return false }
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
    while !Task.isCancelled, self.client === client, client.generation == generation,
      client.hasSession
    {
      if !loading { await load(refreshIdentity: false) }
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

  func load(refreshIdentity: Bool = true) async {
    guard let client else { return }
    let current = client.generation
    let revision = UUID()
    loadRevision = revision
    loading = true
    defer { if loadRevision == revision { loading = false } }
    do {
      async let fetchedList: ConversationList = client.fetch("api/sessions")
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
      conversations = DraftStore.merging(
        list.sessions, account: client.baseURL.absoluteString + user.user)
      hasLoadedConversations = true
      error = nil
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

  func update(_ conversation: Conversation, patch: [String: Any]) async {
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
      let _: ConversationUpdate = try await client.fetch(
        "api/sessions/\(conversation.id)", body: patch)
      guard self.client === client, client.generation == generation else { return }
      await load()
    } catch QMError.signedOut {
      if self.client === client { resetAfterSessionLoss() }
    } catch is CancellationError {
    } catch {
      guard self.client === client, client.generation == generation else { return }
      self.error = error.localizedDescription
    }
  }

  func newConversation() -> Conversation? {
    guard let identity else { return nil }
    let id = UUID().uuidString.lowercased()
    return Conversation(
      id: id, scopeId: "personal:\(identity.user)", threadRef: "web:\(identity.user):\(id)",
      surface: "web",
      localOnly: true)
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
    loading = false
    cleanedAccount = nil
    identity = nil
    conversations = []
    hasLoadedConversations = false
    updatingConversationIDs = []
  }
}
