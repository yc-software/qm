import SwiftUI
import os

@MainActor @Observable
final class AppModel {
  private(set) var client: APIClient?
  var identity: Identity?
  var conversations: [Conversation] = []
  var error: String?
  var loading = false
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
    guard !loading else { throw QMError.message("Wait for the current connection to finish.") }
    guard let url = Self.workspaceURL(raw) else {
      throw QMError.message("Enter a workspace HTTPS address without a path or sign-in details.")
    }
    if url == client?.baseURL { return }
    signOut()
    client = APIClient(baseURL: url)
    defaults.set(url.absoluteString, forKey: "workspaceOrigin")
  }

  static func workspaceURL(_ raw: String) -> URL? {
    guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    else { return nil }
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
      return url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)
    #else
      return false
    #endif
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
      error = nil
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled, self.client === client, loadRevision == revision,
        current == client.generation || !client.hasSession
      else { return }
      self.error = error.localizedDescription
      if case QMError.signedOut = error {
        identity = nil
        conversations = []
      }
    }
  }

  func update(_ conversation: Conversation, patch: [String: Any]) async {
    guard let client, conversation.localOnly != true else { return }
    let generation = client.generation
    do {
      let _: ConversationUpdate = try await client.fetch(
        "api/sessions/\(conversation.id)", body: patch)
      guard self.client === client, client.generation == generation else { return }
      await load()
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
    loadRevision = UUID()
    loading = false
    if let client, let identity {
      DraftStore.removeAccount(client.baseURL.absoluteString + identity.user)
    }
    client?.signOut()
    cleanedAccount = nil
    identity = nil
    conversations = []
    error = nil
  }
}
