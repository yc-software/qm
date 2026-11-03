import SwiftUI

struct NativeMCPServer: Decodable, Identifiable, Equatable {
  var id: String
  var name: String
  var url: String
  var auth: String
  var credentialScope: String?
  var credentialHost: String?
  var credentialAccountType: String?
  var clientId: String?
  var readOnly: Bool
  var enabled: Bool
  var hasBearerToken: Bool
  var hasClientSecret: Bool
}

struct NativeMCPResponse: Decodable {
  struct Tool: Decodable, Identifiable {
    let name: String
    let serverId: String
    let description: String
    let readOnly: Bool
    var id: String { serverId + ":" + name }
  }
  let servers: [NativeMCPServer]
  let tools: [Tool]?
  let available: Bool
  enum CodingKeys: String, CodingKey { case servers, tools }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    available = values.contains(.servers)
    servers = try values.decodeIfPresent([NativeMCPServer].self, forKey: .servers) ?? []
    tools = try values.decodeIfPresent([Tool].self, forKey: .tools)
  }
}

struct NativeAdminMCP: View {
  let client: APIClient
  @State private var response: NativeMCPResponse?
  @State private var editing: NativeMCPServer?
  @State private var adding = false
  @State private var removing: NativeMCPServer?
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    QMList {
      Section {
        Text("Registered MCP servers provide tools to QM across the organization.").font(.caption)
        Button("Add server", systemImage: "plus") { adding = true }.disabled(
          response?.available != true)
      }
      ForEach(response?.servers ?? []) { server in
        Section(server.name) {
          Button("Configure server") { editing = server }
          Text(server.url).font(.caption).textSelection(.enabled)
          LabeledContent("Status", value: server.enabled ? "Enabled" : "Disabled")
          LabeledContent("Tools", value: server.readOnly ? "Read only" : "May change data")
          ForEach((response?.tools ?? []).filter { $0.serverId == server.id }) { tool in
            DisclosureGroup(tool.name) {
              Text(tool.description).font(.caption).textSelection(.enabled)
              Text(tool.readOnly ? "Read only" : "May change data").font(.caption)
            }
          }
          Button("Remove server", role: .destructive) { removing = server }
        }
      }
      if response?.available == false {
        Text("MCP server management is not enabled on this deployment.").foregroundStyle(.secondary)
      }
      if let error { Text(error).foregroundStyle(.red) }
      if response == nil && error == nil { ProgressView() }
    }.disabled(busy).navigationTitle("MCP servers").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
      .sheet(item: $editing, onDismiss: { Task { await load() } }) {
        NativeMCPEditor(client: client, original: $0)
      }
      .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
        NativeMCPEditor(client: client, original: nil)
      }
      .confirmationDialog(
        "Remove MCP server?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
      ) {
        if let removing {
          Button("Remove server", role: .destructive) { Task { await remove(removing) } }
        }
      } message: {
        Text("Its tools and saved server credentials will be removed from this organization.")
      }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      response = try await client.fetch("admin/api/mcp-servers", accepting: [404])
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func remove(_ server: NativeMCPServer) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/mcp-servers/\(server.id.apiComponent)", method: "DELETE")
      response = try await client.fetch("admin/api/mcp-servers", accepting: [404])
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeMCPDraft: Equatable {
  var server: NativeMCPServer
  var bearer = ""
  var secret = ""
  var validate = true
  init(_ original: NativeMCPServer?) {
    server =
      original
      ?? .init(
        id: "", name: "", url: "", auth: "none", credentialScope: "shared",
        credentialAccountType: "default", readOnly: true, enabled: true, hasBearerToken: false,
        hasClientSecret: false)
  }
  func payload() throws -> [String: Any] {
    guard let url = URL(string: server.url), ["https", "http"].contains(url.scheme),
      url.host != nil,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
    else {
      throw QMError.message(
        "Enter an HTTP or HTTPS endpoint without credentials, query or fragment.")
    }
    var body: [String: Any] = [
      "name": server.name, "url": server.url, "auth": server.auth,
      "credentialScope": server.credentialScope ?? "shared", "readOnly": server.readOnly,
      "enabled": server.enabled, "validate": validate,
    ]
    if server.credentialScope == "per-user" {
      body["credentialHost"] = server.credentialHost ?? ""
      body["credentialAccountType"] = server.credentialAccountType ?? "default"
    }
    if server.auth == "bearer" && !bearer.isEmpty { body["bearerToken"] = bearer }
    if server.auth == "client-credentials" {
      if let id = server.clientId { body["clientId"] = id }
      if !secret.isEmpty { body["clientSecret"] = secret }
    }
    return body
  }
}

struct NativeMCPEditor: View {
  let client: APIClient
  let original: NativeMCPServer?
  @Environment(\.dismiss) private var dismiss
  @State private var draft: NativeMCPDraft
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(client: APIClient, original: NativeMCPServer?) {
    self.client = client
    self.original = original
    _draft = State(initialValue: .init(original))
  }
  private var dirty: Bool { draft != NativeMCPDraft(original) }
  var body: some View {
    NavigationStack {
      QMForm {
        Section("Server") {
          TextField("Identifier", text: $draft.server.id).textInputAutocapitalization(.never)
            .autocorrectionDisabled().disabled(original != nil)
          TextField("Display name", text: $draft.server.name)
          TextField("Endpoint URL", text: $draft.server.url).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Toggle("Enabled", isOn: $draft.server.enabled)
          Toggle("Read-only tools", isOn: $draft.server.readOnly)
        }
        Section("Server authentication") {
          Picker("Authentication", selection: $draft.server.auth) {
            Text("None").tag("none")
            Text("Bearer token").tag("bearer")
            Text("Client credentials").tag("client-credentials")
          }
          if draft.server.auth == "bearer" {
            SecureField(
              draft.server.hasBearerToken ? "Replacement token (optional)" : "Bearer token",
              text: $draft.bearer
            )
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          }
          if draft.server.auth == "client-credentials" {
            TextField("Client ID", text: optional(\.clientId)).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            SecureField(
              draft.server.hasClientSecret ? "Replacement secret (optional)" : "Client secret",
              text: $draft.secret
            )
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          }
          Text("Saved secrets stay on the server. Leave replacement fields empty to retain them.")
            .font(.caption)
        }
        Section("User credentials") {
          Picker("Credential scope", selection: optional(\.credentialScope, default: "shared")) {
            Text("Shared").tag("shared")
            Text("Per user").tag("per-user")
          }
          if draft.server.credentialScope == "per-user" {
            TextField("Credential host", text: optional(\.credentialHost))
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            Picker("Account", selection: optional(\.credentialAccountType, default: "default")) {
              Text("Default").tag("default")
              Text("Personal").tag("personal")
              Text("Company").tag("company")
            }
          }
        }
        Section {
          Toggle("Validate connection", isOn: $draft.validate)
          Text(
            "Validation contacts the endpoint with the configured server credential to list tools."
          ).font(.caption)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.disabled(busy).navigationTitle(original == nil ? "Add MCP server" : "Configure MCP")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { if dirty { discarding = true } else { dismiss() } }.disabled(busy)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") { confirming = true }.disabled(
              !dirty || busy || draft.server.id.isEmpty || draft.server.url.isEmpty)
          }
        }.interactiveDismissDisabled(dirty || busy)
        .onDisappear {
          draft.bearer = ""
          draft.secret = ""
        }
        .confirmationDialog("Save organization MCP server?", isPresented: $confirming) {
          Button("Save server") { Task { await save() } }
        } message: {
          Text(
            "QM will use \(draft.server.url). \(draft.server.enabled ? "Its tools will be available across the organization." : "The server will remain disabled.") \(draft.validate ? "Validation sends the configured credential to this endpoint." : "Connection validation is disabled.")"
          )
        }
        .confirmationDialog("Discard server edits?", isPresented: $discarding) {
          Button("Discard", role: .destructive) { dismiss() }
        }
    }
  }
  private func optional(
    _ path: WritableKeyPath<NativeMCPServer, String?>, default value: String = ""
  ) -> Binding<String> {
    Binding(
      get: { draft.server[keyPath: path] ?? value },
      set: { draft.server[keyPath: path] = $0.isEmpty ? nil : $0 })
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/mcp-servers/\(draft.server.id.apiComponent)", body: draft.payload(),
        method: "PUT")
      draft.bearer = ""
      draft.secret = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
