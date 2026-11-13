import SwiftUI

struct NativeConnector: Decodable {
  let connected: Bool?
  let needsReconnect: Bool?
  let available: Bool?
  let refreshError: String?
}
struct NativeConnectors: Decodable { let providers: [String: NativeConnector] }
struct NativeCredential: Decodable, Identifiable {
  let id: String
  let service: String
  let kind: String?
  let envKey: String?
  let accountLabel: String?
  let host: String?
  let fingerprint: String?
  let expiresAt: Double?
}
struct NativeCredentialGrant: Decodable, Identifiable {
  let id: String
  let credentialId: String
  let audienceScopeId: String
  let mode: String
  let purpose: String
  let status: String
  let expiresAt: Double?
}
struct NativeCredentialAsk: Decodable, Identifiable {
  let id: String
  let credentialId: String
  let requesterId: String
  let requesterScopeId: String?
  let requestedMode: String?
  let purpose: String
  let expiresAt: Double
}
private struct NativeAskDecision: Decodable {
  struct Ask: Decodable { let status: String }
  let ask: Ask
}
extension APIClient {
  func decideCredentialAsk(_ id: String, decision: String) async throws -> String {
    let result: NativeAskDecision = try await fetch(
      "api/keychain/approvals/\(id.apiComponent)", body: ["decision": decision])
    return result.ask.status
  }
}
struct NativeConnectorCredential: Decodable {
  let credentialId: String
  let host: String
  let accountType: String?
  let expiresAt: Double?
}
struct NativeKeychainOverview: Decodable {
  let connectorCredentials: [NativeConnectorCredential]?
  let credentials: [NativeCredential]?
  let grants: [NativeCredentialGrant]?
  let asks: [NativeCredentialAsk]?
  let scopeNames: [String: String]?
}

@MainActor @Observable
final class KeychainModel {
  let client: APIClient
  var providers: [String: NativeConnector] = [:]
  var overview: NativeKeychainOverview?
  var error: String?
  var busy = false
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  private let authorization = ConnectionAuthorization()
  private var authorizationRevision = UUID()
  init(client: APIClient) { self.client = client }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      async let connectors: NativeConnectors = try await client.fetch("api/connectors")
      async let keys: NativeKeychainOverview = try await client.fetch("api/keychain/overview")
      return try await (connectors, keys)
    } apply: { connectors, keys in
      providers = connectors.providers.filter {
        $0.value.available == true || $0.value.connected == true || $0.value.needsReconnect == true
      }
      overview = keys
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func connect(_ provider: String) async {
    guard !busy else { return }
    let attempt = UUID()
    authorizationRevision = attempt
    busy = true
    error = nil
    loader.cancel()
    defer { busy = false }
    do {
      struct Start: Decodable { let authorizeUrl: String }
      let state = UUID().uuidString
      let start: Start = try await client.fetch(
        "api/connectors/\(provider.apiComponent)/start",
        body: ["state": state, "returnTo": "/keychain", "mobileReturn": true])
      guard authorizationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
      let request = try ConnectionRequest(
        body: ["authorizeUrl": start.authorizeUrl, "state": state, "returnTo": "/keychain"],
        base: client.baseURL)
      let outcome = try await authorization.authorize(request, client: client)
      let refusal = ConnectionAuthorization.refusal(in: outcome)
      guard refusal == nil,
        URLComponents(string: outcome)?.queryItems?.first(where: { $0.name == "status" })?.value
          != "error"
      else {
        throw QMError.message(
          "The provider did not complete authorization\(refusal.map { " (\($0))" } ?? ""). Try connecting again."
        )
      }
      await load(afterMutation: true)
    } catch is CancellationError {
      if authorizationRevision == attempt { await load(afterMutation: true) }
    } catch {
      if authorizationRevision == attempt && !Task.isCancelled {
        self.error = error.localizedDescription
      }
    }
  }
  func cancel() {
    authorizationRevision = UUID()
    authorization.cancel()
  }
  func mutate(_ path: String, body: [String: Any] = [:], method: String = "POST") async {
    guard !busy else { return }
    busy = true
    error = nil
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(path, body: body, method: method)
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeKeychainView: View {
  @State private var model: KeychainModel
  @State private var adding = false
  @State private var revokingProvider: String?
  init(client: APIClient) { _model = State(initialValue: KeychainModel(client: client)) }
  private var credentials: [NativeCredential] {
    let stored = model.overview?.credentials ?? []
    let ids = Set(stored.map(\.id))
    return stored
      + (model.overview?.connectorCredentials ?? []).filter { !ids.contains($0.credentialId) }.map {
        NativeCredential(
          id: $0.credentialId, service: $0.host, kind: "connector", envKey: nil,
          accountLabel: $0.accountType, host: $0.host, fingerprint: nil, expiresAt: $0.expiresAt)
      }
  }
  private func label(_ provider: String) -> String {
    [
      "google": "Google Workspace", "github": "GitHub", "slack": "Slack", "notion": "Notion",
      "linear": "Linear", "dropbox": "Dropbox", "x": "X (Twitter)",
    ][provider] ?? provider.capitalized
  }
  var body: some View {
    QMList {
      if model.busy {
        NativeActionLabel(
          title: "Update keychain", busyTitle: "Updating keychain…", busy: model.busy)
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.loading && model.overview == nil && model.error == nil {
        NativeCollectionLoading(label: "Loading keychain", symbol: "key")
      }
      Section("Connections") {
        NavigationLink("Browse app connections") { NativeConnectedApps(client: model.client) }
        ForEach(model.providers.keys.sorted(), id: \.self) { provider in
          if let connection = model.providers[provider] {
            NativeConnectionRow(
              service: provider, name: label(provider),
              detail: connection.needsReconnect == true
                ? "Needs reconnection"
                : connection.connected == true ? "Connected" : "Not connected",
              needsAttention: connection.needsReconnect == true
            ) {
              if connection.connected != true || connection.needsReconnect == true {
                Button(connection.needsReconnect == true ? "Reconnect" : "Connect") {
                  Task { await model.connect(provider) }
                }
                .primaryConnectionAction()
              }
              if connection.connected == true || connection.needsReconnect == true {
                Button("Disconnect", role: .destructive) { revokingProvider = provider }
              }
            }
          }
        }
        if model.providers.isEmpty && model.overview != nil && model.error == nil {
          Text("No providers are configured for this workspace.").foregroundStyle(.secondary)
        }
      }
      Section("Stored credentials") {
        ForEach(credentials.sorted { $0.service < $1.service }) {
          credential in
          NavigationLink {
            NativeCredentialDetail(model: model, credential: credential)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(credential.service).font(.headline)
              if let account = credential.accountLabel ?? credential.envKey {
                Text(account).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        Button("Add credential", systemImage: "key.badge.ellipsis") { adding = true }
      }
    }
    .disabled(model.busy).navigationTitle("Keychain")
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.overview != nil || model.error != nil) && !model.busy,
        label: "Refreshing keychain")
    )
    .task { await model.load() }.refreshable { await model.load() }
    .onDisappear { model.cancel() }
    .sheet(isPresented: $adding, onDismiss: { Task { await model.load() } }) {
      NativeCredentialCreation(client: model.client)
    }
    .confirmationDialog(
      "Disconnect this provider?",
      isPresented: Binding(
        get: { revokingProvider != nil }, set: { if !$0 { revokingProvider = nil } })
    ) {
      if let provider = revokingProvider {
        Button("Disconnect", role: .destructive) {
          Task { await model.mutate("api/connectors/revoke", body: ["provider": provider]) }
        }
      }
    } message: {
      Text("QM will lose access through this connection, including any grants backed by it.")
    }
  }
}

struct NativeCredentialDetail: View {
  @Bindable var model: KeychainModel
  let credential: NativeCredential
  @Environment(\.dismiss) private var dismiss
  @State private var deleting = false
  @State private var revoke: NativeCredentialGrant?
  var body: some View {
    QMList {
      if model.busy {
        NativeActionLabel(
          title: "Update credential", busyTitle: "Updating credential…", busy: model.busy)
      }
      Section("Credential") {
        if let account = credential.accountLabel { LabeledContent("Account", value: account) }
        if let host = credential.host { LabeledContent("Host", value: host) }
        if let key = credential.envKey { LabeledContent("Environment key", value: key) }
        if let fingerprint = credential.fingerprint {
          LabeledContent("Fingerprint", value: fingerprint)
        }
        if let expiry = credential.expiresAt {
          LabeledContent("Expires", value: Date(timeIntervalSince1970: expiry / 1000).formatted())
        }
      }
      Section("Access grants") {
        ForEach(
          (model.overview?.grants ?? []).filter {
            $0.credentialId == credential.id && $0.status == "active"
          }
        ) { grant in
          VStack(alignment: .leading, spacing: 6) {
            Text(model.overview?.scopeNames?[grant.audienceScopeId] ?? grant.audienceScopeId).font(
              .headline)
            Text(grant.purpose)
            Text("\(grant.mode) · \(grant.status)").font(.caption).foregroundStyle(.secondary)
            if grant.status == "active" {
              Button("Revoke access", role: .destructive) { revoke = grant }
            }
          }
        }
      }
      Section("Requests") {
        ForEach((model.overview?.asks ?? []).filter { $0.credentialId == credential.id }) { ask in
          VStack(alignment: .leading, spacing: 6) {
            Text(
              ask.requesterScopeId.map { model.overview?.scopeNames?[$0] ?? $0 } ?? ask.requesterId
            ).font(.headline)
            Text(ask.purpose)
            Text(
              "\(ask.requestedMode == "once" ? "One-time" : "Standing") access · expires \(Date(timeIntervalSince1970: ask.expiresAt / 1000).formatted())"
            ).font(.caption).foregroundStyle(.secondary)
            Text("Respond to this request in your conversation with QM.").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if credential.kind != "connector" {
        Button("Delete credential", role: .destructive) { deleting = true }
      }
    }
    .disabled(model.busy).navigationTitle(credential.service)
    .confirmationDialog("Permanently delete this credential?", isPresented: $deleting) {
      Button("Delete credential", role: .destructive) {
        Task {
          await model.mutate(
            "api/keychain/credentials/\(credential.id.apiComponent)", method: "DELETE")
          if model.error == nil { dismiss() }
        }
      }
    } message: {
      Text("Access grants that rely on this credential will no longer work.")
    }
    .confirmationDialog(
      "Revoke this grant?",
      isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })
    ) {
      if let revoke {
        Button("Revoke", role: .destructive) {
          Task { await model.mutate("api/keychain/grants/\(revoke.id.apiComponent)/revoke") }
        }
      }
    }
  }
}

struct NativeCredentialCreation: View {
  let client: APIClient
  @Environment(\.dismiss) private var dismiss
  @State private var service = ""
  @State private var envKey = ""
  @State private var purpose = ""
  @State private var secret = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMForm {
        Section("Credential") {
          TextField("Service", text: $service)
          TextField("Environment key (optional)", text: $envKey).textInputAutocapitalization(
            .characters
          ).autocorrectionDisabled()
          TextField("Purpose", text: $purpose, axis: .vertical)
          SecureField("Secret", text: $secret).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        Text("Stored in your workspace keychain. The secret is not saved on this device.").font(
          .caption)
        if let error { Text(error).foregroundStyle(.red) }
      }
      .disabled(busy).navigationTitle("Add credential")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task { await save() }
          } label: {
            NativeActionLabel(title: "Save", busyTitle: "Saving…", busy: busy, compact: true)
          }.disabled(
            busy
              || [service, purpose, secret].contains {
                $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              })
        }
      }.interactiveDismissDisabled(busy)
    }
  }
  static func redemption(_ raw: String, base: URL) throws -> (path: String, query: [URLQueryItem]) {
    guard let url = URL(string: raw, relativeTo: base)?.absoluteURL,
      APIClient.sameOrigin(url, base), url.user == nil, url.password == nil,
      url.fragment == nil,
      url.path.range(of: "^/drop/[a-zA-Z0-9_-]+/form$", options: .regularExpression) != nil,
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.count == 1, items[0].name == "t", items[0].value?.isEmpty == false
    else { throw QMError.message("Could not verify the credential save destination.") }
    return (String(url.path.dropFirst().dropLast(5)), items)
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      struct Drop: Decodable { let url: String }
      let result: Drop = try await client.fetch(
        "api/keychain/drops",
        body: [
          "service": service.trimmingCharacters(in: .whitespacesAndNewlines),
          "envKey": envKey.trimmingCharacters(in: .whitespacesAndNewlines),
          "purpose": purpose.trimmingCharacters(in: .whitespacesAndNewlines),
        ])
      let target = try Self.redemption(result.url, base: client.baseURL)
      let _: MutationReceipt = try await client.fetch(
        target.path, body: ["secret": secret], query: target.query)
      secret = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
