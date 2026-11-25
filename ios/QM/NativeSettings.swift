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
  var loading: Bool { loader.loading }
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
    error = nil
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
    error = nil
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

struct NativeActionLabel: View {
  let title: String
  let busyTitle: String
  let busy: Bool
  var compact = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 18

  var body: some View {
    let symbolSize = min(iconSize, compact ? 18 : 24)
    HStack(spacing: 8) {
      if busy {
        Image(systemName: "arrow.triangle.2.circlepath")
          .font(.system(size: symbolSize))
          .symbolEffect(
            .rotate, options: .repeating, isActive: !reduceMotion && scenePhase == .active
          )
          .symbolEffectsRemoved(reduceMotion || scenePhase != .active)
          .frame(width: symbolSize * 1.5, height: symbolSize * 1.5)
          .accessibilityHidden(true)
      }
      Text(busy ? busyTitle : title)
        .lineLimit(compact ? 1 : nil)
        .fixedSize(horizontal: false, vertical: !compact)
        .dynamicTypeSize(...(compact ? DynamicTypeSize.xxxLarge : .accessibility5))
    }
    .accessibilityElement(children: .combine)
  }
}

/// Home-screen actions the settings page can offer when it is pushed from the conversation list.
struct HomeSettingsActions {
  let changeWorkspace: () -> Void
  let signOut: () -> Void
}

extension EnvironmentValues {
  @Entry var qmHomeSettingsActions: HomeSettingsActions? = nil
}

/// Settings laid out like the desktop General page: titled sections over rounded cards of rows,
/// each row a title and a short note with its control on the trailing edge.
struct NativeSettingsView: View {
  let client: APIClient
  let identity: Identity
  @Environment(\.qmHomeSettingsActions) private var home
  @AppStorage("appearance") private var appearance = "system"
  @AppStorage("webOnly") private var webOnly = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        SettingsSection("Plan") {
          SettingsLink(title: "AI access", note: "Use company access or your own subscription.") {
            NativeModelAccountsView(client: client)
          }
          SettingsLink(title: "Model and effort", note: "Defaults for new conversations.") {
            RuntimeControlsView(client: client, scopeID: "personal:\(identity.user)")
          }
        }
        SettingsSection("Appearance") {
          VStack(alignment: .leading, spacing: 12) {
            SettingsCopy(
              title: "Theme", note: "System follows your device’s light or dark setting.")
            Picker("Theme", selection: $appearance) {
              Text("System").tag("system")
              Text("Light").tag("light")
              Text("Dark").tag("dark")
              if let palette = NativeThemeStore.shared.palette { Text(palette.name).tag("custom") }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
          }
          .settingsRowPadding()
          NativeThemeImport()
        }
        SettingsSection("Conversations") {
          Toggle(isOn: $webOnly) {
            SettingsCopy(
              title: "Web conversations only", note: "Hide Slack conversations from your list.")
          }
          .settingsRowPadding()
          if home != nil {
            SettingsValueLink(
              title: "Waiting on you", note: "Conversations that need your reply.",
              value: HomePage.waiting)
            SettingsValueLink(title: "Archived conversations", note: nil, value: HomePage.archived)
          }
        }
        SettingsSection("Connections") {
          SettingsLink(title: "Set up QM", note: "Connect the apps and accounts QM works with.") {
            NativeSetupView(client: client, identity: identity)
          }
          SettingsLink(title: "Slack account", note: nil, service: "slack") {
            NativeSlackAccountView(client: client)
          }
          SettingsLink(
            title: "Connections and credentials", note: "Keys and logins QM can use for you."
          ) {
            NativeKeychainView(client: client)
          }
        }
        SettingsSection("Account") {
          SettingsRow(title: "Account", note: accountNote) {
            if let home {
              Button("Sign out", action: home.signOut).buttonStyle(.bordered).controlSize(.small)
            }
          }
          SettingsRow(title: "Workspace", note: client.baseURL.host) {
            if let home {
              Button("Change", action: home.changeWorkspace).buttonStyle(.bordered).controlSize(
                .small)
            }
          }
        }
        SettingsSection("About") {
          Link(destination: URL(string: "https://github.com/yc-software/qm")!) {
            SettingsRow(title: "About QM", note: nil) {
              Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(
                .tertiary)
            }
          }
          .buttonStyle(.plain)
          SettingsRow(title: "Version", note: nil) {
            Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
              .foregroundStyle(.secondary)
          }
          SettingsLink(title: "Open source licenses", note: nil) {
            ScrollView {
              Text(
                (try? String(
                  contentsOf: Bundle.main.url(
                    forResource: "ThirdPartyNotices", withExtension: "txt")
                    ?? URL(fileURLWithPath: "/nonexistent"), encoding: .utf8))
                  ?? "See the licenses included with QM."
              ).font(.footnote).textSelection(.enabled).padding()
            }.navigationTitle("Licenses")
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 32)
      .frame(maxWidth: QMTheme.conversationWidth)
      .frame(maxWidth: .infinity)
    }
    .foregroundStyle(QMTheme.ink)
    .background(QMTheme.paper)
    .toolbarBackground(QMTheme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
  }
}

/// A titled settings section: a medium-weight heading over a rounded card whose rows are divided
/// by hairlines, matching the desktop `.settings-section` and `.settings-card`.
struct SettingsSection<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title)
        .font(.subheadline.weight(.medium))
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
      VStack(spacing: 0) {
        Group(subviews: content) { rows in
          ForEach(rows) { row in
            row
            if row.id != rows.last?.id {
              Rectangle().fill(QMTheme.ink.opacity(0.07)).frame(height: 1)
                .padding(.leading, 16)
            }
          }
        }
      }
      .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(QMTheme.ink.opacity(0.09), lineWidth: 1)
      )
    }
  }
}

/// A row's title and its muted note.
struct SettingsCopy: View {
  let title: String
  let note: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.body)
      if let note { Text(note).font(.footnote).foregroundStyle(.secondary) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SettingsRow<Accessory: View>: View {
  let title: String
  let note: String?
  var service: String?
  let accessory: Accessory

  init(
    title: String, note: String?, service: String? = nil, @ViewBuilder accessory: () -> Accessory
  ) {
    self.title = title
    self.note = note
    self.service = service
    self.accessory = accessory()
  }

  var body: some View {
    HStack(spacing: 12) {
      if let service, NativeServiceLogo.mark(service, size: 20) != nil {
        NativeServiceLogo(service: service, size: 20)
      }
      SettingsCopy(title: title, note: note)
      accessory
    }
    .settingsRowPadding()
    .contentShape(Rectangle())
  }
}

private struct SettingsChevron: View {
  var body: some View {
    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
  }
}

struct SettingsLink<Destination: View>: View {
  let title: String
  let note: String?
  var service: String?
  let destination: () -> Destination

  init(
    title: String, note: String?, service: String? = nil,
    @ViewBuilder destination: @escaping () -> Destination
  ) {
    self.title = title
    self.note = note
    self.service = service
    self.destination = destination
  }

  var body: some View {
    NavigationLink {
      destination()
    } label: {
      SettingsRow(title: title, note: note, service: service) { SettingsChevron() }
    }
    .buttonStyle(.plain)
  }
}

struct SettingsValueLink<Value: Hashable>: View {
  let title: String
  let note: String?
  let value: Value
  var body: some View {
    NavigationLink(value: value) {
      SettingsRow(title: title, note: note) { SettingsChevron() }
    }
    .buttonStyle(.plain)
  }
}

extension View {
  func settingsRowPadding() -> some View {
    padding(.horizontal, 16).padding(.vertical, 13).frame(minHeight: 52)
  }
}

struct NativeModelAccountsView: View {
  @State private var model: ModelAccountsModel
  @State private var connecting: String?
  @State private var disconnecting: String?
  init(client: APIClient) { _model = State(initialValue: ModelAccountsModel(client: client)) }
  var body: some View {
    QMList {
      if model.busy {
        NativeActionLabel(title: "Update accounts", busyTitle: "Updating accounts…", busy: true)
      }
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
            let connection = status.connections.first { $0.provider == key }
            NativeConnectionRow(
              service: provider == "claude" ? "claude" : "openai",
              name: provider == "claude" ? "Claude" : "ChatGPT / Codex",
              detail: connection.map {
                $0.kind == "oauth" ? "Subscription connected" : "API key connected"
              } ?? "Not connected"
            ) {
              Button(connection == nil ? "Connect" : "Replace account") { connecting = provider }
                .primaryConnectionAction()
              if connection != nil {
                Button("Disconnect", role: .destructive) { disconnecting = provider }
              }
            }
          }
        }
      } else if model.loading {
        ProgressView("Loading accounts…")
      }
      if let error = model.error, !model.loading {
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
          Button {
            Task { await saveKey() }
          } label: {
            NativeActionLabel(title: "Save API key", busyTitle: "Saving…", busy: busy)
          }.disabled(
            busy || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else if let device {
          if polling && error == nil {
            NativeConnectionLoading(status: "Waiting for sign-in…")
          }
          Text("Enter this code when you sign in:")
          Text(device.userCode).font(.title.monospaced()).textSelection(.enabled)
          if let url = Self.httpsURL(device.verificationUrl) {
            Link(destination: url) {
              NativeServiceLabel(title: "Continue to ChatGPT", service: "openai")
            }
          }
          Text("Return here after signing in. QM will complete the connection.").font(.caption)
          Button("Start again") {
            self.device = nil
            error = nil
          }
        } else if let claude {
          if let url = Self.httpsURL(claude.authorizeUrl) {
            Link(destination: url) {
              NativeServiceLabel(title: "Continue to Claude", service: "claude")
            }
          }
          SecureField("Authorization code", text: $code).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button {
            Task { await completeClaude(claude) }
          } label: {
            NativeActionLabel(title: "Complete sign-in", busyTitle: "Connecting…", busy: busy)
          }.disabled(
            busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else {
          Button {
            Task { await start() }
          } label: {
            NativeServiceLabel(service: provider == "claude" ? "claude" : "openai") {
              NativeActionLabel(
                title: "Sign in with \(provider == "claude" ? "Claude" : "ChatGPT")",
                busyTitle: "Connecting…", busy: busy)
            }
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
    error = nil
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
    error = nil
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
    guard !Task.isCancelled else { return }
    polling = true
    error = nil
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
      NativeConnectionRow(
        service: "slack", name: "Slack",
        detail: status.map { $0.connected ? "Connected" : "Not connected" } ?? "Checking…"
      ) {
        Button {
          Task { await connect() }
        } label: {
          NativeActionLabel(
            title: status?.connected == true ? "Reconnect" : "Connect",
            busyTitle: "Connecting…", busy: busy)
        }
        .primaryConnectionAction()
        .disabled(busy)
      }
      if let user = status?.user { LabeledContent("Account", value: user) }
      if let workspace = status?.workspace { LabeledContent("Workspace", value: workspace) }
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
    error = nil
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
      let outcome = try await authorization.authorize(request, client: client)
      guard authorizationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
      if let refusal = ConnectionAuthorization.refusal(in: outcome) {
        throw QMError.message(
          "Slack authorization was not completed (\(refusal)). Your QM account has not been linked."
        )
      }
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
