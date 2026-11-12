import SwiftUI

struct NativeToolkit: Decodable, Identifiable {
  let id: String
  let name: String
  let description: String
  var logoUrl: String? = nil

  var logo: URL? {
    guard let logoUrl, let url = URL(string: logoUrl), url.scheme == "https",
      url.host == "logos.composio.dev", url.port == nil, url.user == nil, url.query == nil,
      url.fragment == nil, url.path.hasPrefix("/api/"),
      case let slug = url.path.dropFirst("/api/".count), !slug.isEmpty,
      slug.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "_" || $0 == "-") })
    else { return nil }
    return url
  }
}
struct NativeToolkitPage: Decodable {
  let items: [NativeToolkit]
  let nextCursor: String?
}
struct NativeConnectedAccount: Decodable, Identifiable {
  let id: String
  let toolkit: String
  let userId: String?
  let missingScopes: [String]?
  var needsReconnect: Bool { missingScopes?.isEmpty == false }
}
struct NativeConnectionPage: Decodable {
  let items: [NativeConnectedAccount]
  let nextCursor: String?
}

extension ConnectionAuthorization {
  static func refusal(in outcome: String) -> String? {
    URLComponents(string: outcome)?.queryItems?.first { $0.name == "error" }?.value
  }
}

@MainActor @Observable
final class ConnectedAppsModel {
  let client: APIClient
  var toolkits: [NativeToolkit] = []
  var accounts: [NativeConnectedAccount] = []
  var nextCursor: String?
  var query = ""
  var loading = false
  var connecting = false
  var disconnecting: String?
  var busy: Bool { loading || connecting || disconnecting != nil }
  var loadingMore: Bool { loading && loadingCursor != nil }
  var loaded = false
  var error: String?
  private var revision = UUID()
  private var searchRevision = UUID()
  private var cursors = Set<String>()
  private var loadingCursor: String?
  private let authorization: ConnectionAuthorization
  init(client: APIClient, authorization: ConnectionAuthorization = ConnectionAuthorization()) {
    self.client = client
    self.authorization = authorization
  }
  var matchingToolkits: [NativeToolkit] {
    toolkits.filter {
      query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
        || $0.description.localizedCaseInsensitiveContains(query)
    }
  }
  func isConnected(_ toolkitID: String) -> Bool {
    accounts.contains { $0.toolkit == toolkitID }
  }
  func toolkit(for account: NativeConnectedAccount) -> NativeToolkit {
    toolkits.first { $0.id == account.toolkit }
      ?? NativeToolkit(id: account.toolkit, name: account.toolkit, description: "")
  }
  func search() async {
    let current = searchRevision
    while !Task.isCancelled && current == searchRevision && !connecting && disconnecting == nil {
      if loading {
        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
        continue
      }
      guard error == nil, !loaded || (!query.isEmpty && nextCursor != nil) else { return }
      guard await load(more: loaded) else { return }
    }
  }
  func cancel() {
    revision = UUID()
    searchRevision = UUID()
    loading = false
    authorization.cancel()
  }
  @discardableResult
  func load(more: Bool = false) async -> Bool {
    guard !Task.isCancelled, !busy, !more || nextCursor != nil else { return false }
    loading = true
    loadingCursor = more ? nextCursor : nil
    let current = UUID()
    revision = current
    defer { if current == revision { loading = false } }
    do {
      let cursor = loadingCursor
      async let connected: Void = try await (more ? () : refreshAccounts(current: current))
      let page: NativeToolkitPage = try await client.fetch(
        "api/composio/toolkits", query: cursor.map { [.init(name: "cursor", value: $0)] } ?? [])
      try Task.checkCancellation()
      guard current == revision else { return false }
      if !more {
        toolkits = []
        cursors = []
      }
      let ids = Set(toolkits.map(\.id))
      toolkits += page.items.filter { !ids.contains($0.id) }
      nextCursor = page.nextCursor?.isEmpty == false ? page.nextCursor : nil
      if let cursor { cursors.insert(cursor) }
      if let nextCursor, cursors.contains(nextCursor) {
        self.nextCursor = nil
        throw QMError.message("The app catalog repeated a page. Refresh to try again.")
      }
      try await connected
      guard current == revision else { return false }
      loaded = true
      error = nil
      return true
    } catch {
      if current == revision && !Task.isCancelled { self.error = error.localizedDescription }
      return false
    }
  }
  private func refreshAccounts(current: UUID) async throws {
    var result: [NativeConnectedAccount] = []
    var cursor: String?
    var visited = Set<String>()
    repeat {
      let page: NativeConnectionPage = try await client.fetch(
        "api/composio/connections", query: cursor.map { [.init(name: "cursor", value: $0)] } ?? [])
      try Task.checkCancellation()
      guard current == revision else { throw CancellationError() }
      let ids = Set(result.map(\.id))
      result += page.items.filter { !ids.contains($0.id) }
      cursor = page.nextCursor?.isEmpty == false ? page.nextCursor : nil
      if let cursor, !visited.insert(cursor).inserted {
        throw QMError.message("Connection status repeated a page. Refresh to try again.")
      }
    } while cursor != nil
    accounts = result
  }
  func disconnect(_ account: NativeConnectedAccount) async {
    guard !connecting, disconnecting == nil else { return }
    disconnecting = account.id
    error = nil
    defer { disconnecting = nil }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/composio/disconnect", body: ["accountId": account.id], accepting: [404])
      accounts.removeAll { $0.id == account.id }
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
  func reconnect(_ stale: NativeConnectedAccount) async {
    guard let fresh = await connect(toolkit(for: stale)), fresh != stale.id else { return }
    await disconnect(stale)
  }
  @discardableResult
  func connect(_ toolkit: NativeToolkit) async -> String? {
    guard !connecting, disconnecting == nil else { return nil }
    connecting = true
    loading = false
    error = nil
    searchRevision = UUID()
    let current = UUID()
    revision = current
    defer { connecting = false }
    do {
      struct Start: Decodable {
        let url: String
        let accountId: String
      }
      let state = UUID().uuidString
      let start: Start = try await client.fetch(
        "api/composio/authorize",
        body: [
          "toolkit": toolkit.id, "returnTo": "/settings", "state": state, "mobileReturn": true,
        ])
      guard current == revision, !Task.isCancelled else { throw CancellationError() }
      guard let url = URL(string: start.url), url.scheme == "https",
        ["connect.composio.dev", "app.composio.dev"].contains(url.host ?? ""), url.port == nil
      else { throw QMError.message("Invalid app authorization destination.") }
      let request = try ConnectionRequest(
        body: [
          "authorizeUrl": start.url, "state": state,
          "returnTo": "/settings?composioReturn=\(state)",
        ], base: client.baseURL)
      let outcome = try await authorization.authorize(request, client: client)
      guard current == revision, !Task.isCancelled else { throw CancellationError() }
      if let refusal = ConnectionAuthorization.refusal(in: outcome) {
        throw QMError.message(
          "App authorization was not completed (\(refusal)). The app has not been connected.")
      }
      try await refreshAccounts(current: current)
      guard accounts.contains(where: { $0.id == start.accountId && $0.toolkit == toolkit.id })
      else {
        throw QMError.message(
          "The connection is not active yet. Refresh after completing provider authorization.")
      }
      error = nil
      return start.accountId
    } catch is CancellationError {
      if current == revision {
        do { try await refreshAccounts(current: current) } catch {
          Log.background.failure("Connected accounts refresh", error)
        }
      }
    } catch {
      if current == revision && !Task.isCancelled { self.error = error.localizedDescription }
    }
    return nil
  }
}

struct NativeConnectedApps: View {
  @State private var model: ConnectedAppsModel
  @State private var removing: NativeConnectedAccount?
  init(client: APIClient) { _model = State(initialValue: ConnectedAppsModel(client: client)) }
  var body: some View {
    QMList {
      if model.connecting {
        VStack(alignment: .leading, spacing: 10) {
          NativeActionLabel(title: "Connect app", busyTitle: "Connecting app…", busy: true)
          NativeLoadingRail()
        }
      }
      Section {
        Text(
          "Connect an account so QM can work with its apps. Review the provider’s requested permissions during sign-in."
        ).font(.caption)
      }
      if !model.accounts.isEmpty {
        Section("Connected") {
          ForEach(model.accounts) { account in
            let toolkit = model.toolkit(for: account)
            NativeConnectionRow(
              service: toolkit.id, logo: toolkit.logo, name: toolkit.name,
              detail: account.needsReconnect ? "Reconnect to grant access" : "Connected",
              needsAttention: account.needsReconnect
            ) {
              if account.needsReconnect {
                Button("Reconnect") { Task { await model.reconnect(account) } }
                  .primaryConnectionAction()
              }
              Button(role: .destructive) {
                removing = account
              } label: {
                NativeActionLabel(
                  title: "Disconnect", busyTitle: "Disconnecting…",
                  busy: model.disconnecting == account.id)
              }
            }
            .disabled(model.connecting || model.disconnecting != nil)
          }
        }
      }
      Section("Available apps") {
        ForEach(model.matchingToolkits) { toolkit in
          NativeConnectionRow(
            service: toolkit.id, logo: toolkit.logo, name: toolkit.name,
            detail: toolkit.description
          ) {
            Button(model.isConnected(toolkit.id) ? "Connect another account" : "Connect") {
              Task { await model.connect(toolkit) }
            }
            .primaryConnectionAction()
          }
          .disabled(model.connecting || model.disconnecting != nil)
        }
        if model.loading {
          NativeCatalogLoading(
            label: !model.query.isEmpty
              ? "Searching apps…"
              : model.loadingMore ? "Loading more apps…" : "Loading apps…")
        } else if model.nextCursor != nil && model.query.isEmpty {
          Button("Load more apps") { Task { await model.load(more: true) } }.disabled(model.busy)
        }
      }
      if let error = model.error, !model.busy {
        Text(error).foregroundStyle(.red)
        Button("Retry") {
          Task {
            await model.load()
            await model.search()
          }
        }
      }
    }.navigationTitle("App connections").navigationBarTitleDisplayMode(.inline)
      .searchable(text: $model.query, prompt: "Find an app")
      .task(id: model.query) { await model.search() }
      .refreshable {
        await model.load()
        await model.search()
      }
      .onDisappear { model.cancel() }
      .confirmationDialog(
        "Disconnect \(removing.map { model.toolkit(for: $0).name } ?? "this app")?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
      ) {
        if let removing {
          Button("Disconnect", role: .destructive) { Task { await model.disconnect(removing) } }
        }
      } message: {
        Text("QM will lose access to it until you connect it again.")
      }
  }
}
