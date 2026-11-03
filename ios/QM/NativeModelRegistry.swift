import SwiftUI

struct NativeRegistrySpec: Codable, Equatable, Identifiable {
  struct Tier: Codable, Equatable {
    var inputTokensAbove: Int?
    var input: Double?
    var output: Double?
    var cacheRead: Double?
    var cacheWrite: Double?
  }
  struct Cost: Codable, Equatable {
    var input: Double?
    var output: Double?
    var cacheRead: Double?
    var cacheWrite: Double?
    var tiers: [Tier]?
  }
  var id: String
  var name: String?
  var provider: String?
  var template: String?
  var contextWindow: Int?
  var maxTokens: Int?
  var cost: Cost?
  var fastMode: Bool?
  var base: Bool?
  var webui: Bool?
  var auxiliary: Bool?
  func verifiedPayload() throws -> [String: Any] {
    guard !id.isEmpty, !(name ?? "").isEmpty, ["openai", "anthropic"].contains(provider),
      !(template ?? "").isEmpty, let contextWindow, let maxTokens,
      contextWindow > 0, maxTokens > 0, maxTokens < contextWindow, let cost
    else { throw QMError.message("Complete the name, provider, template and token limits.") }
    func valid(_ values: [Double?]) -> Bool {
      values.allSatisfy {
        if let value = $0 { return value.isFinite && value >= 0 }
        return false
      }
    }
    guard valid([cost.input, cost.output, cost.cacheRead, cost.cacheWrite]) else {
      throw QMError.message("Enter all four nonnegative prices per million tokens.")
    }
    var previous = 0
    for tier in cost.tiers ?? [] {
      guard let threshold = tier.inputTokensAbove, threshold > previous, threshold < contextWindow,
        valid([tier.input, tier.output, tier.cacheRead, tier.cacheWrite])
      else {
        throw QMError.message(
          "Complete each pricing tier with increasing thresholds below the context limit.")
      }
      previous = threshold
    }
    guard fastMode != true || provider == "anthropic" else {
      throw QMError.message("Registry fast mode requires an Anthropic model.")
    }
    var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
    body["verify"] = true
    return body
  }
}

struct NativeModelRegistryResponse: Decodable {
  struct Entry: Decodable, Identifiable {
    let spec: NativeRegistrySpec
    let disabled: Bool
    let unavailableReason: String?
    let verifiedAt: Double?
    var id: String { spec.id }
  }
  let models: [Entry]
  let templates: [NativeRegistrySpec]
}

struct NativeModelRegistry: View {
  let client: APIClient
  @State private var registry: NativeModelRegistryResponse?
  @State private var editing: NativeRegistrySpec?
  @State private var adding = false
  @State private var removing: NativeModelRegistryResponse.Entry?
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    QMList {
      Section {
        Text("Organization model definitions and verified generation access.").font(.caption)
        Button("Look up or add model", systemImage: "plus") { adding = true }.disabled(
          registry == nil)
      }
      ForEach(registry?.models ?? []) { entry in
        Section(entry.spec.name ?? entry.id) {
          Text(entry.id).font(.caption).textSelection(.enabled)
          Text(entry.disabled ? "Disabled" : "Enabled")
          if let reason = entry.unavailableReason { Text(reason).foregroundStyle(.orange) }
          if let at = entry.verifiedAt {
            LabeledContent("Verified", value: Date(timeIntervalSince1970: at / 1000).formatted())
          }
          Button("Review and verify") { editing = entry.spec }
          if !entry.disabled { Button("Disable", role: .destructive) { removing = entry } }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if registry == nil && error == nil { ProgressView() }
    }.disabled(busy).navigationTitle("Model registry").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
      .sheet(item: $editing, onDismiss: { Task { await load() } }) { spec in
        NativeRegistryEditor(client: client, original: spec, templates: registry?.templates ?? [])
      }
      .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
        NativeRegistryEditor(client: client, original: nil, templates: registry?.templates ?? [])
      }
      .confirmationDialog(
        "Disable this model?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
      ) {
        if let removing {
          Button("Disable model", role: .destructive) { Task { await disable(removing) } }
        }
      } message: {
        Text(
          "The model will no longer be available for generation. Its definition remains available for re-verification."
        )
      }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      registry = try await client.fetch("admin/api/model-registry")
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func disable(_ entry: NativeModelRegistryResponse.Entry) async {
    guard !busy else { return }
    busy = true
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/model-registry/\(entry.id.apiComponent)", method: "DELETE")
      registry = try await client.fetch("admin/api/model-registry")
      error = nil
    } catch { self.error = error.localizedDescription }
    busy = false
  }
}

struct NativeRegistryEditor: View {
  struct Lookup: Decodable {
    let kind: String
    let spec: NativeRegistrySpec
    let source: String
    let message: String
  }
  let client: APIClient
  let original: NativeRegistrySpec?
  let templates: [NativeRegistrySpec]
  @Environment(\.dismiss) private var dismiss
  @State private var spec: NativeRegistrySpec
  @State private var lookup: Lookup?
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(client: APIClient, original: NativeRegistrySpec?, templates: [NativeRegistrySpec]) {
    self.client = client
    self.original = original
    self.templates = templates
    _spec = State(initialValue: original ?? Self.empty)
  }
  private static var empty: NativeRegistrySpec { .init(id: "", provider: "openai") }
  private var dirty: Bool { spec != (original ?? Self.empty) }
  private var builtin: Bool { lookup?.kind == "builtin" }
  var body: some View {
    NavigationStack {
      QMForm {
        Section("Model identity") {
          TextField("Model ID", text: $spec.id).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .disabled(original != nil || lookup != nil)
          Picker(
            "Provider",
            selection: Binding(get: { spec.provider ?? "openai" }, set: { spec.provider = $0 })
          ) {
            Text("OpenAI").tag("openai")
            Text("Anthropic").tag("anthropic")
          }.disabled(original != nil || lookup != nil)
          if original == nil && lookup == nil {
            Button("Look up model") { Task { await lookUp() } }.disabled(spec.id.isEmpty)
          }
          if let lookup {
            Text(lookup.source).font(.caption.bold())
            Text(lookup.message).font(.caption)
          }
        }
        if original != nil || lookup != nil {
          definition
          if let error { Text(error).foregroundStyle(.red) }
          Button("Verify and enable") { confirming = true }
        } else if let error {
          Text(error).foregroundStyle(.red)
        }
      }.disabled(busy).navigationTitle("Model definition").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { if dirty { discarding = true } else { dismiss() } }.disabled(busy)
          }
        }.interactiveDismissDisabled(dirty || busy)
        .confirmationDialog("Verify and enable this model?", isPresented: $confirming) {
          Button("Verify and enable") { Task { await save() } }
        } message: {
          Text(
            "QM sends a small billable synthetic request using organization credentials. Success enables this model for organization use, including reactivating a disabled definition. The organization default is unchanged."
          )
        }
        .confirmationDialog("Discard model edits?", isPresented: $discarding) {
          Button("Discard", role: .destructive) { dismiss() }
        }
    }
  }
  private var definition: some View {
    Group {
      Section("Definition") {
        TextField("Name", text: optional(\.name))
        Picker("Protocol template", selection: optional(\.template)) {
          Text("Choose a template").tag("")
          ForEach(templates.filter { $0.provider == spec.provider }) {
            Text($0.name ?? $0.id).tag($0.id)
          }
        }
        TextField("Context tokens", value: $spec.contextWindow, format: .number).keyboardType(
          .numberPad)
        TextField("Maximum output tokens", value: $spec.maxTokens, format: .number).keyboardType(
          .numberPad)
        Toggle("Base model", isOn: flag(\.base, default: true))
        Toggle("Show in model picker", isOn: flag(\.webui, default: true))
        Toggle("Auxiliary tasks", isOn: flag(\.auxiliary, default: false))
        if spec.provider == "anthropic" {
          Toggle("Fast mode support", isOn: flag(\.fastMode, default: false))
        }
      }
      Section("Price per million tokens") {
        price("Input", \.input)
        price("Output", \.output)
        price("Cache read", \.cacheRead)
        price("Cache write", \.cacheWrite)
      }
      ForEach(Array((spec.cost?.tiers ?? []).indices), id: \.self) { index in
        Section("Pricing tier \(index + 1)") {
          TextField("Above input tokens", value: tier(index, \.inputTokensAbove), format: .number)
            .keyboardType(.numberPad)
          TextField("Input", value: tier(index, \.input), format: .number).keyboardType(.decimalPad)
          TextField("Output", value: tier(index, \.output), format: .number).keyboardType(
            .decimalPad)
          TextField("Cache read", value: tier(index, \.cacheRead), format: .number).keyboardType(
            .decimalPad)
          TextField("Cache write", value: tier(index, \.cacheWrite), format: .number).keyboardType(
            .decimalPad)
          Button("Remove tier", role: .destructive) { spec.cost?.tiers?.remove(at: index) }
        }
      }
      Button("Add pricing tier") {
        if spec.cost == nil { spec.cost = .init() }
        if spec.cost?.tiers == nil { spec.cost?.tiers = [] }
        spec.cost?.tiers?.append(.init())
      }.disabled((spec.cost?.tiers?.count ?? 0) >= 20)
    }.disabled(builtin)
  }
  private func optional(_ path: WritableKeyPath<NativeRegistrySpec, String?>) -> Binding<String> {
    Binding(
      get: { spec[keyPath: path] ?? "" }, set: { spec[keyPath: path] = $0.isEmpty ? nil : $0 })
  }
  private func flag(_ path: WritableKeyPath<NativeRegistrySpec, Bool?>, default value: Bool)
    -> Binding<Bool>
  {
    Binding(get: { spec[keyPath: path] ?? value }, set: { spec[keyPath: path] = $0 })
  }
  private func price(_ title: String, _ path: WritableKeyPath<NativeRegistrySpec.Cost, Double?>)
    -> some View
  {
    TextField(
      title,
      value: Binding(
        get: { spec.cost?[keyPath: path] },
        set: {
          if spec.cost == nil { spec.cost = .init() }
          spec.cost?[keyPath: path] = $0
        }), format: .number
    ).keyboardType(.decimalPad)
  }
  private func tier<T>(_ index: Int, _ path: WritableKeyPath<NativeRegistrySpec.Tier, T?>)
    -> Binding<T?>
  {
    Binding(
      get: { spec.cost?.tiers?[index][keyPath: path] },
      set: { spec.cost?.tiers?[index][keyPath: path] = $0 })
  }
  private func lookUp() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: Lookup = try await client.fetch(
        "admin/api/model-registry/lookup",
        body: [
          "provider": spec.provider ?? "openai",
          "id": spec.id.trimmingCharacters(in: .whitespacesAndNewlines),
        ])
      lookup = result
      spec = result.spec
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let path = "admin/api/model-registry/\(spec.id.apiComponent)"
      let body =
        builtin ? ["provider": spec.provider ?? "", "verify": true] : try spec.verifiedPayload()
      let _: MutationReceipt = try await client.fetch(
        builtin ? path + "/enable" : path, body: body, method: builtin ? "POST" : "PUT")
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
