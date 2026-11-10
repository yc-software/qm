import SwiftUI

struct NativeToolkit: Decodable, Identifiable {
  let id: String
  let name: String
  let description: String
}
struct NativeToolkitPage: Decodable {
  let items: [NativeToolkit]
  let nextCursor: String?
}
struct NativeConnectedAccount: Decodable, Identifiable {
  let id: String
  let toolkit: String
}
struct NativeConnectionPage: Decodable {
  let items: [NativeConnectedAccount]
  let nextCursor: String?
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
  var busy: Bool { loading || connecting }
  var loadingMore: Bool { loading && loadingCursor != nil }
  var loaded = false
  var error: String?
  private var revision = UUID()
  private var searchRevision = UUID()
  private var cursors = Set<String>()
  private var loadingCursor: String?
  private let authorization = ConnectionAuthorization()
  init(client: APIClient) { self.client = client }
  var matchingToolkits: [NativeToolkit] {
    toolkits.filter {
      query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
        || $0.description.localizedCaseInsensitiveContains(query)
    }
  }
  func search() async {
    let current = searchRevision
    while !Task.isCancelled && current == searchRevision && !connecting {
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
      if !more { try await refreshAccounts(current: current) }
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
  func connect(_ toolkit: NativeToolkit) async {
    guard !connecting else { return }
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
      _ = try await authorization.authorize(request, client: client)
      guard current == revision, !Task.isCancelled else { throw CancellationError() }
      try await refreshAccounts(current: current)
      guard accounts.contains(where: { $0.id == start.accountId && $0.toolkit == toolkit.id })
      else {
        throw QMError.message(
          "The connection is not active yet. Refresh after completing provider authorization.")
      }
      error = nil
    } catch is CancellationError {} catch {
      if current == revision && !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
}

struct NativeConnectedApps: View {
  @State private var model: ConnectedAppsModel
  init(client: APIClient) { _model = State(initialValue: ConnectedAppsModel(client: client)) }
  var body: some View {
    QMList {
      if model.connecting {
        VStack(alignment: .leading, spacing: 10) {
          NativeActionLabel(title: "Connect app", busyTitle: "Connecting app...", busy: true)
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
            LabeledContent(
              model.toolkits.first { $0.id == account.toolkit }?.name ?? account.toolkit,
              value: "Connected")
          }
        }
      }
      Section("Available apps") {
        ForEach(model.matchingToolkits) { toolkit in
          VStack(alignment: .leading, spacing: 8) {
            Text(toolkit.name).font(.headline)
            Text(toolkit.description).font(.caption).lineLimit(4)
            Button(
              model.accounts.contains { $0.toolkit == toolkit.id }
                ? "Connect another account" : "Connect"
            ) {
              Task { await model.connect(toolkit) }
            }.disabled(model.connecting)
          }.padding(.vertical, 6)
        }
        if model.loading {
          NativeCatalogLoading(
            label: !model.query.isEmpty
              ? "Searching apps..."
              : model.loadingMore ? "Loading more apps..." : "Loading apps...")
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
  }
}
