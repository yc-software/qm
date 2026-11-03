import SwiftUI

struct NativeProviderStatus: Decodable, Identifiable {
  let provider: String
  let configured: Bool
  let source: String
  let updatedBy: String?
  var id: String { provider }
}
struct NativeCustomProvider: Decodable, Identifiable {
  struct Model: Codable, Equatable {
    var id: String
    var name: String?
    var contextWindow: Int?
    var maxTokens: Int?
    var input: Double?
    var output: Double?
  }
  let id: String
  let name: String
  let `protocol`: String
  let baseUrl: String
  let models: [Model]
  let disabled: Bool
  let hasKey: Bool
  func requireActivationConsent(_ consent: Bool) throws {
    if disabled && !consent {
      throw QMError.message("Confirm reactivation before saving a disabled provider.")
    }
  }
}

struct NativeAdminProviders: View {
  struct Providers: Decodable { let providers: [NativeProviderStatus] }
  struct Custom: Decodable { let providers: [NativeCustomProvider] }
  let client: APIClient
  @State private var providers: [NativeProviderStatus] = []
  @State private var custom: [NativeCustomProvider] = []
  @State private var editing: NativeCustomProvider?
  @State private var adding = false
  @State private var deleting: NativeCustomProvider?
  @State private var error: String?
  @State private var busy = false
  var body: some View {
    QMList {
      Section("Organization credentials") {
        Text(
          "Shared model credentials for this deployment. Individual account connections are managed in Settings."
        ).font(.caption).foregroundStyle(.secondary)
        ForEach(providers) { provider in
          NavigationLink {
            NativeProviderCredential(client: client, provider: provider)
          } label: {
            VStack(alignment: .leading) {
              Text(provider.provider.capitalized).font(.headline)
              Text(provider.configured ? "Configured · \(provider.source)" : "Not configured").font(
                .caption)
            }
          }
        }
      }
      Section("Custom providers") {
        ForEach(custom) { provider in
          VStack(alignment: .leading, spacing: 8) {
            Button(provider.name) { editing = provider }
            Text(provider.baseUrl).font(.caption).textSelection(.enabled)
            Text(
              "\(provider.models.count) models · \(provider.disabled ? "Disabled" : "Enabled") · \(provider.hasKey ? "Key stored" : "No stored key")"
            ).font(.caption)
            Button("Remove provider", role: .destructive) { deleting = provider }
          }
        }
        Button("Add custom provider", systemImage: "plus") { adding = true }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Model providers")
      .task { await load() }.refreshable { await load() }
      .sheet(item: $editing, onDismiss: { Task { await load() } }) {
        NativeCustomProviderEditor(client: client, original: $0)
      }
      .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
        NativeCustomProviderEditor(client: client, original: nil)
      }
      .confirmationDialog(
        "Remove custom provider?",
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
      ) {
        if let provider = deleting {
          Button("Remove provider", role: .destructive) { Task { await remove(provider) } }
        }
      } message: {
        Text("Models served by \(deleting?.name ?? "this provider") will no longer be available.")
      }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let builtins: Providers = try await client.fetch(
        "admin/api/model-providers", query: [.init(name: "catalog", value: "cached")])
      providers = builtins.providers
      let extras: Custom = try await client.fetch("admin/api/custom-providers")
      custom = extras.providers
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func remove(_ provider: NativeCustomProvider) async {
    guard !busy else { return }
    busy = true
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/custom-providers/\(provider.id.apiComponent)", method: "DELETE")
      custom.removeAll { $0.id == provider.id }
      error = nil
    } catch { self.error = error.localizedDescription }
    busy = false
  }
}

struct NativeProviderCredential: View {
  let client: APIClient
  let provider: NativeProviderStatus
  @Environment(\.dismiss) private var dismiss
  @State private var key = ""
  @State private var busy = false
  @State private var error: String?
  @State private var operation: String?
  var body: some View {
    QMForm {
      Section {
        LabeledContent("Provider", value: provider.provider.capitalized)
        LabeledContent("Credential source", value: provider.source)
        if let by = provider.updatedBy { LabeledContent("Last changed by", value: by) }
      }
      Section("Replace organization key") {
        SecureField("API key", text: $key).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Text(
          "QM validates the key with the provider and stores it on the server. Existing key values are never sent to this app."
        ).font(.caption)
        Button("Validate and save key") { operation = "PUT" }.disabled(
          key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      if provider.source == "admin" {
        Button("Remove saved key", role: .destructive) { operation = "DELETE" }
        Text("Removing the saved key may restore an environment-provided key if one exists.").font(
          .caption)
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle(provider.provider.capitalized).navigationBarBackButtonHidden(
      busy
    )
    .onDisappear { key = "" }
    .confirmationDialog(
      operation == "DELETE" ? "Remove organization key?" : "Replace organization key?",
      isPresented: Binding(get: { operation != nil }, set: { if !$0 { operation = nil } })
    ) {
      if let operation {
        Button(
          operation == "DELETE" ? "Remove key" : "Validate and save",
          role: operation == "DELETE" ? .destructive : nil
        ) { Task { await save(operation) } }
      }
    } message: {
      Text("This affects shared \(provider.provider) model access for the organization.")
    }
  }
  private func save(_ method: String) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/model-providers/\(provider.provider.apiComponent)",
        body: method == "PUT"
          ? ["apiKey": key.trimmingCharacters(in: .whitespacesAndNewlines)] : nil, method: method)
      key = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeCustomProviderEditor: View {
  let client: APIClient
  let original: NativeCustomProvider?
  @Environment(\.dismiss) private var dismiss
  @State private var id: String
  @State private var name: String
  @State private var wire: String
  @State private var address: String
  @State private var models: [NativeCustomProvider.Model]
  @State private var key = ""
  @State private var validate = true
  @State private var reactivate = false
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(client: APIClient, original: NativeCustomProvider?) {
    self.client = client
    self.original = original
    _id = State(initialValue: original?.id ?? "")
    _name = State(initialValue: original?.name ?? "")
    _wire = State(initialValue: original?.protocol ?? "openai")
    _address = State(initialValue: original?.baseUrl ?? "")
    _models = State(initialValue: original?.models ?? [.init(id: "")])
  }
  private var dirty: Bool {
    id != (original?.id ?? "") || name != (original?.name ?? "")
      || wire != (original?.protocol ?? "openai") || address != (original?.baseUrl ?? "")
      || models != (original?.models ?? [.init(id: "")]) || !key.isEmpty || !validate
  }
  var body: some View {
    NavigationStack {
      QMForm {
        if original?.disabled == true {
          Section("Disabled provider") {
            Text(
              "Saving this configuration reactivates the provider and restores access to its models using its stored credential."
            )
            Toggle("Reactivate this provider", isOn: $reactivate)
          }
        }
        Section("Provider") {
          TextField("Identifier", text: $id).disabled(original != nil).textInputAutocapitalization(
            .never
          ).autocorrectionDisabled()
          TextField("Name", text: $name)
          Picker("Protocol", selection: $wire) {
            Text("OpenAI Chat Completions").tag("openai")
            Text("OpenAI Responses").tag("openai-responses")
            Text("Anthropic Messages").tag("anthropic")
          }
          TextField("Base URL", text: $address).keyboardType(.URL).textInputAutocapitalization(
            .never
          ).autocorrectionDisabled()
          SecureField(
            original?.hasKey == true ? "Replacement key (optional)" : "API key (optional)",
            text: $key
          ).textInputAutocapitalization(.never).autocorrectionDisabled()
          Toggle("Validate new key", isOn: $validate)
          Text(
            "A new key is sent to this provider’s endpoint for validation. Skip validation only for endpoints without a models listing."
          ).font(.caption)
        }
        ForEach(models.indices, id: \.self) { index in
          Section("Model \(index + 1)") {
            TextField("Model ID", text: $models[index].id).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            TextField(
              "Display name",
              text: Binding(
                get: { models[index].name ?? "" },
                set: { models[index].name = $0.isEmpty ? nil : $0 }))
            TextField(
              "Context window (optional)", value: $models[index].contextWindow, format: .number
            ).keyboardType(.numberPad)
            TextField(
              "Maximum output tokens (optional)", value: $models[index].maxTokens, format: .number
            ).keyboardType(.numberPad)
            TextField("Input cost per million tokens", value: $models[index].input, format: .number)
              .keyboardType(.decimalPad)
            TextField(
              "Output cost per million tokens", value: $models[index].output, format: .number
            ).keyboardType(.decimalPad)
            Button("Remove model", role: .destructive) { models.remove(at: index) }
          }
        }
        Button("Add model") { models.append(.init(id: "")) }
        if let error { Text(error).foregroundStyle(.red) }
      }.disabled(busy).navigationTitle(original == nil ? "Add provider" : "Edit provider")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { if dirty { discarding = true } else { dismiss() } }.disabled(busy)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(original?.disabled == true ? "Reactivate" : "Save") { confirming = true }
              .disabled(
                busy || (!dirty && !reactivate) || (original?.disabled == true && !reactivate)
                  || id.isEmpty || name.isEmpty || address.isEmpty || models.isEmpty
                  || models.contains { $0.id.isEmpty })
          }
        }.interactiveDismissDisabled(busy || dirty).onDisappear { key = "" }
        .confirmationDialog(
          original?.disabled == true ? "Reactivate provider?" : "Save provider configuration?",
          isPresented: $confirming
        ) {
          Button(original?.disabled == true ? "Reactivate provider" : "Save provider") {
            Task { await save() }
          }
        } message: {
          Text(
            "\(original?.disabled == true ? "This restores model access using the stored credential. " : "")Models will use \(address). \(!key.isEmpty && validate ? "The new API key will be sent there for validation." : "")"
          )
        }
        .confirmationDialog("Discard provider edits?", isPresented: $discarding) {
          Button("Discard", role: .destructive) {
            key = ""
            dismiss()
          }
        }
    }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      guard let url = URL(string: address), ["https", "http"].contains(url.scheme ?? ""),
        url.host != nil, url.user == nil, url.password == nil
      else {
        throw QMError.message("Enter a valid provider base URL without embedded credentials.")
      }
      try original?.requireActivationConsent(reactivate)
      let rows = try JSONSerialization.jsonObject(with: JSONEncoder().encode(models))
      var body: [String: Any] = [
        "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "protocol": wire,
        "baseUrl": address.trimmingCharacters(in: .whitespacesAndNewlines), "models": rows,
        "validate": validate,
      ]
      if !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        body["apiKey"] = key.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      let _: MutationReceipt = try await client.fetch(
        "admin/api/custom-providers/\(id.trimmingCharacters(in: .whitespacesAndNewlines).apiComponent)",
        body: body, method: "PUT")
      key = ""
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
