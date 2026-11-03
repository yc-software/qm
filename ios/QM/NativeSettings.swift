import SwiftUI

struct ModelAccountStatus: Decodable {
  struct Connection: Decodable {
    let provider: String
    let kind: String
  }
  let account: String
  let individualModelAuth: Bool
  let required: Bool
  let connections: [Connection]
}
struct ModelDevicePrompt: Decodable {
  let deviceAuthId: String
  let userCode: String
  let verificationUrl: String
  let intervalMs: Double
  let expiresAt: Double
}
struct ModelClaudePrompt: Decodable {
  let authorizeUrl: String
  let verifier: String
}

@MainActor @Observable
final class ModelAccountsModel {
  let client: APIClient
  var status: ModelAccountStatus?
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  init(client: APIClient) { self.client = client }
  func load() async {
    guard !busy else { return }
    await loader.run {
      try await client.fetch("api/user-model-auth/status") as ModelAccountStatus
    } apply: { result in
      status = result
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func choose(_ account: String) async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      var body = ["account": account == "company" ? "company" : "personal"]
      if account != "company" { body["provider"] = account }
      let result: ModelAccountStatus = try await client.fetch(
        "api/user-model-auth/account", body: body)
      status = result
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  func disconnect(_ provider: String) async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/user-model-auth/disconnect", body: ["provider": provider])
      let result: ModelAccountStatus = try await client.fetch("api/user-model-auth/status")
      status = result
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeSettingsView: View {
  let client: APIClient
  let identity: Identity
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("webOnly") private var webOnly = false
  var body: some View {
    QMForm {
      Section("Workspace") {
        LabeledContent("Signed in as", value: identity.displayName ?? identity.user)
        LabeledContent("Workspace", value: identity.companyName ?? client.baseURL.host ?? "QM")
      }
      Section("Appearance") {
        Picker("Theme", selection: $appearance) {
          Text("System").tag("system")
          Text("Light").tag("light")
          Text("Dark").tag("dark")
          if let palette = NativeThemeStore.shared.palette { Text(palette.name).tag("custom") }
        }
        NativeThemeImport()
        Toggle("Web conversations only", isOn: $webOnly)
      }
      Section("Accounts") {
        NavigationLink("Set up QM") { NativeSetupView(client: client, identity: identity) }
        NavigationLink("AI accounts") { NativeModelAccountsView(client: client) }
        NavigationLink("Slack account") { NativeSlackAccountView(client: client) }
        NavigationLink("Connections and credentials") { NativeKeychainView(client: client) }
      }
      Section("Defaults") {
        NavigationLink("Model and effort") {
          RuntimeControlsView(client: client, scopeID: "personal:\(identity.user)")
        }
      }
      Section("About") {
        Link("About QM", destination: URL(string: "https://github.com/yc-software/qm")!)
        LabeledContent(
          "Version",
          value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
        NavigationLink("Open source licenses") {
          ScrollView {
            Text(
              (try? String(
                contentsOf: Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt")
                  ?? URL(fileURLWithPath: "/nonexistent"), encoding: .utf8))
                ?? "See the licenses included with QM."
            ).font(.footnote).textSelection(.enabled).padding()
          }.navigationTitle("Licenses")
        }
      }
    }.navigationTitle("Settings").scrollContentBackground(.hidden).background(QMTheme.paper)
  }
}

struct NativeModelAccountsView: View {
  @State private var model: ModelAccountsModel
  @State private var connecting: String?
  @State private var disconnecting: String?
  init(client: APIClient) { _model = State(initialValue: ModelAccountsModel(client: client)) }
  var body: some View {
    QMList {
      if let status = model.status {
        Section("Use for conversations") {
          if !status.required {
            Button {
              Task { await model.choose("company") }
            } label: {
              Label(
                "Company access",
                systemImage: status.account == "company" ? "checkmark.circle.fill" : "circle")
            }
          }
          ForEach(["anthropic", "openai"], id: \.self) { provider in
            Button {
              if status.connections.contains(where: { $0.provider == provider }) {
                Task { await model.choose(provider) }
              } else {
                connecting = provider == "anthropic" ? "claude" : "chatgpt"
              }
            } label: {
              Label(
                provider == "anthropic" ? "My Claude account" : "My OpenAI account",
                systemImage: status.account == provider ? "checkmark.circle.fill" : "circle")
            }
          }
        }
        Section("Connections") {
          ForEach(["claude", "chatgpt"], id: \.self) { provider in
            let key = provider == "claude" ? "anthropic" : "openai"
            VStack(alignment: .leading, spacing: 8) {
              Text(provider == "claude" ? "Claude" : "ChatGPT / Codex").font(.headline)
              if let connection = status.connections.first(where: { $0.provider == key }) {
                Text(connection.kind == "oauth" ? "Subscription connected" : "API key connected")
                  .font(.caption)
                Button("Disconnect", role: .destructive) { disconnecting = provider }
              } else {
                Text("Not connected").font(.caption).foregroundStyle(.secondary)
              }
              Button("Connect or replace account") { connecting = provider }
            }
          }
        }
      } else {
        ProgressView("Loading accounts…")
      }
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.load() } }
      }
    }
    .disabled(model.busy).navigationTitle("AI accounts")
    .task { await model.load() }.refreshable { await model.load() }
    .sheet(
      isPresented: Binding(get: { connecting != nil }, set: { if !$0 { connecting = nil } }),
      onDismiss: { Task { await model.load() } }
    ) {
      if let connecting { NativeModelConnection(client: model.client, provider: connecting) }
    }
    .confirmationDialog(
      "Disconnect this AI account?",
      isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } })
    ) {
      if let disconnecting {
        Button("Disconnect", role: .destructive) { Task { await model.disconnect(disconnecting) } }
      }
    } message: {
      Text("Conversations using this account may need another account before they can continue.")
    }
  }
}

struct NativeModelConnection: View {
  let client: APIClient
  let provider: String
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var method = "Subscription"
  @State private var apiKey = ""
  @State private var code = ""
  @State private var device: ModelDevicePrompt?
  @State private var claude: ModelClaudePrompt?
  @State private var busy = false
  @State private var polling = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMForm {
        Picker("Method", selection: $method) {
          Text("Subscription").tag("Subscription")
          Text("API key").tag("API key")
        }.disabled(busy)
        if method == "API key" {
          SecureField("API key", text: $apiKey).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Save API key") { Task { await saveKey() } }.disabled(
            busy || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else if let device {
          Text("Enter this code when you sign in:")
          Text(device.userCode).font(.title.monospaced()).textSelection(.enabled)
          if let url = Self.httpsURL(device.verificationUrl) {
            Link("Continue to ChatGPT", destination: url)
          }
          Text("Return here after signing in. QM will complete the connection.").font(.caption)
          if polling { ProgressView("Waiting for sign-in…") }
          Button("Start again") {
            self.device = nil
            error = nil
          }
        } else if let claude {
          if let url = Self.httpsURL(claude.authorizeUrl) {
            Link("Continue to Claude", destination: url)
          }
          SecureField("Authorization code", text: $code).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Complete sign-in") { Task { await completeClaude(claude) } }.disabled(
            busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else {
          Button("Sign in with \(provider == "claude" ? "Claude" : "ChatGPT")") {
            Task { await start() }
          }.disabled(busy)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle("Connect \(provider == "claude" ? "Claude" : "OpenAI")")
      .toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
      .interactiveDismissDisabled(busy)
      .task(id: "\(device?.deviceAuthId ?? "")|\(phase == .active)|\(method)") {
        guard let device, phase == .active, method == "Subscription" else { return }
        await poll(device)
      }
    }
  }
  static func httpsURL(_ raw: String) -> URL? {
    guard let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil,
      url.password == nil
    else { return nil }
    return url
  }
  private func start() async {
    guard !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      if provider == "claude" {
        let result: ModelClaudePrompt = try await client.fetch(
          "api/user-model-auth/claude/start", body: [:])
        guard Self.httpsURL(result.authorizeUrl) != nil else {
          throw QMError.message("Invalid authorization destination.")
        }
        claude = result
      } else {
        let result: ModelDevicePrompt = try await client.fetch(
          "api/user-model-auth/chatgpt/start", body: [:])
        guard Self.httpsURL(result.verificationUrl) != nil else {
          throw QMError.message("Invalid authorization destination.")
        }
        device = result
      }
    } catch { self.error = error.localizedDescription }
  }
  private func saveKey() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/user-model-auth/api-key",
        body: [
          "provider": provider, "apiKey": apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
        ])
      apiKey = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
  private func completeClaude(_ prompt: ModelClaudePrompt) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/user-model-auth/claude/complete",
        body: [
          "code": code.trimmingCharacters(in: .whitespacesAndNewlines), "verifier": prompt.verifier,
        ])
      code = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
  private func poll(_ prompt: ModelDevicePrompt) async {
    polling = true
    defer { polling = false }
    do {
      while !Task.isCancelled && Date().timeIntervalSince1970 * 1000 < prompt.expiresAt {
        struct Result: Decodable { let status: String }
        let result: Result = try await client.fetch(
          "api/user-model-auth/chatgpt/poll",
          body: ["deviceAuthId": prompt.deviceAuthId, "userCode": prompt.userCode])
        try Task.checkCancellation()
        if result.status == "connected" {
          dismiss()
          return
        }
        try await Task.sleep(for: .milliseconds(max(1000, prompt.intervalMs)))
      }
      if !Task.isCancelled { error = "That code expired. Start again to get a new code." }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeSlackAccountView: View {
  struct Status: Decodable {
    let connected: Bool
    let user: String?
    let workspace: String?
  }
  let client: APIClient
  @State private var status: Status?
  @State private var busy = false
  @State private var error: String?
  @State private var authorization = ConnectionAuthorization()
  @State private var authorizationRevision = UUID()
  var body: some View {
    QMForm {
      if let status {
        LabeledContent("Status", value: status.connected ? "Connected" : "Not connected")
        if let user = status.user { LabeledContent("Account", value: user) }
        if let workspace = status.workspace { LabeledContent("Workspace", value: workspace) }
      }
      Button(status?.connected == true ? "Reconnect Slack" : "Connect Slack") {
        Task { await connect() }
      }.disabled(busy)
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Slack account").task { await load() }
    .onDisappear {
      authorizationRevision = UUID()
      authorization.cancel()
    }
  }
  private func load() async {
    do { status = try await client.fetch("api/composio/slack") } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
  private func connect() async {
    guard !busy else { return }
    let attempt = UUID()
    authorizationRevision = attempt
    busy = true
    defer { busy = false }
    do {
      struct Start: Decodable {
        let url: String
        let ticket: String
      }
      let state = UUID().uuidString
      let result: Start = try await client.fetch(
        "api/composio/slack/authorize",
        body: ["state": state, "returnTo": "/settings", "mobileReturn": true])
      guard authorizationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
      guard let url = NativeModelConnection.httpsURL(result.url),
        ["connect.composio.dev", "app.composio.dev"].contains(url.host ?? "")
      else { throw QMError.message("Invalid Slack authorization destination.") }
      let request = try ConnectionRequest(
        body: [
          "authorizeUrl": result.url, "state": state, "returnTo": "/settings?slackReturn=\(state)",
        ], base: client.baseURL)
      _ = try await authorization.authorize(request, client: client)
      guard authorizationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
      let _: MutationReceipt = try await client.fetch(
        "api/composio/slack/complete", body: ["ticket": result.ticket])
      guard authorizationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
      await load()
      error = nil
    } catch is CancellationError {} catch {
      if authorizationRevision == attempt && !Task.isCancelled {
        self.error = error.localizedDescription
      }
    }
  }
}
