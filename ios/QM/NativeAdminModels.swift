import SwiftUI

struct NativeAdminModelConfiguration: Decodable {
  struct Model: Decodable, Identifiable {
    let id: String
    let name: String?
    var label: String { name ?? id }
  }
  let runtime: RuntimeSelection?
  let baseModel: String?
  let baseModelDefault: String
  let harnessDefault: String
  let approvedHarnesses: [String]?
  let harnessOptions: [String]
  let modelsByHarness: [String: [Model]]
  let thinkingLevelsByHarness: [String: [String]]
  let fastModeModelIds: [String]
  let fastModeHarnessIds: [String]
  let browseModel: String?
  let browseModelOptions: [Model]
  let webuiModels: [String]?
  var allModels: [Model] {
    var seen = Set<String>()
    return modelsByHarness.keys.sorted().flatMap { modelsByHarness[$0] ?? [] }.filter {
      seen.insert($0.id).inserted
    }
  }
}

struct NativeAdminRuntimeDraft: Equatable {
  var inherit: Bool
  var harness: String
  var model: String
  var effort: String
  var fast: Bool
  init(_ configuration: NativeAdminModelConfiguration) {
    inherit = configuration.runtime == nil && configuration.baseModel == nil
    harness = configuration.runtime?.harnessId ?? configuration.harnessDefault
    model =
      configuration.runtime?.modelId ?? configuration.baseModel ?? configuration.baseModelDefault
    effort = configuration.runtime?.effortLevel ?? "auto"
    fast = configuration.runtime?.fastMode ?? false
  }
  func supportsFast(_ configuration: NativeAdminModelConfiguration) -> Bool {
    configuration.fastModeHarnessIds.contains(harness)
      && configuration.fastModeModelIds.contains(model)
  }
  mutating func changedHarness(_ configuration: NativeAdminModelConfiguration) {
    if !(configuration.modelsByHarness[harness] ?? []).contains(where: { $0.id == model }) {
      model = configuration.modelsByHarness[harness]?.first?.id ?? ""
    }
    if !(configuration.thinkingLevelsByHarness[harness] ?? []).contains(effort) { effort = "auto" }
    if !supportsFast(configuration) { fast = false }
  }
  func payload(_ configuration: NativeAdminModelConfiguration) throws -> [String: Any] {
    if inherit { return ["inherit": true] }
    guard configuration.harnessOptions.contains(harness),
      (configuration.modelsByHarness[harness] ?? []).contains(where: { $0.id == model }),
      (configuration.thinkingLevelsByHarness[harness] ?? []).contains(effort)
    else { throw QMError.message("Select an available runtime, model and reasoning level.") }
    return [
      "harnessId": harness, "modelId": model, "effortLevel": effort,
      "fastMode": fast && supportsFast(configuration),
    ]
  }
}

struct NativeAdminModels: View {
  let client: APIClient
  let scope: String
  @State private var configuration: NativeAdminModelConfiguration?
  @State private var error: String?
  var body: some View {
    QMList {
      if let configuration {
        Section("Conversation defaults") {
          NavigationLink("Runtime and model") {
            NativeAdminRuntimeEditor(client: client, scope: scope, configuration: configuration)
          }
          Text("These defaults apply to this scope. Conversations may have their own overrides.")
            .font(.caption).foregroundStyle(.secondary)
        }
        if scope.hasPrefix("org:") {
          Section("Browser tasks") {
            NavigationLink("Browser model") {
              NativeAdminModelPicker(
                client: client, scope: scope, configuration: configuration, browser: true)
            }
          }
          Section("Model availability") {
            NavigationLink("Approved runtimes") {
              NativeApprovedRuntimes(client: client, scope: scope, configuration: configuration)
            }
            NavigationLink("Model picker list") {
              NativeAdminModelPicker(
                client: client, scope: scope, configuration: configuration, browser: false)
            }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if configuration == nil && error == nil { ProgressView() }
    }.navigationTitle("Models and runtime").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      configuration = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)",
        query: [.init(name: "view", value: "models")])
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminRuntimeEditor: View {
  let client: APIClient
  let scope: String
  let configuration: NativeAdminModelConfiguration
  @Environment(\.dismiss) private var dismiss
  @State private var draft: NativeAdminRuntimeDraft
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(client: APIClient, scope: String, configuration: NativeAdminModelConfiguration) {
    self.client = client
    self.scope = scope
    self.configuration = configuration
    _draft = State(initialValue: .init(configuration))
  }
  private var dirty: Bool { draft != NativeAdminRuntimeDraft(configuration) }
  var body: some View {
    QMForm {
      Section {
        Toggle("Inherit default", isOn: $draft.inherit)
        Text("Scope: \(scope)").font(.caption).textSelection(.enabled)
      }
      if !draft.inherit {
        Section("Runtime") {
          Picker("Agent runtime", selection: $draft.harness) {
            ForEach(configuration.harnessOptions, id: \.self) { Text($0.capitalized).tag($0) }
          }.onChange(of: draft.harness) { draft.changedHarness(configuration) }
          Picker("Model", selection: $draft.model) {
            ForEach(configuration.modelsByHarness[draft.harness] ?? []) {
              Text($0.label).tag($0.id)
            }
          }.onChange(of: draft.model) {
            if !draft.supportsFast(configuration) { draft.fast = false }
          }
          Picker("Reasoning", selection: $draft.effort) {
            ForEach(configuration.thinkingLevelsByHarness[draft.harness] ?? [], id: \.self) {
              Text($0.capitalized).tag($0)
            }
          }
          if draft.supportsFast(configuration) { Toggle("Fast mode", isOn: $draft.fast) }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Runtime and model").navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(dirty || busy)
      .toolbar {
        if dirty || busy {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { discarding = true }.disabled(busy)
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { confirming = true }.disabled(busy || !dirty)
        }
      }.confirmationDialog("Change runtime defaults?", isPresented: $confirming) {
        Button("Save defaults") { Task { await save() } }
      } message: {
        Text("This changes the default runtime for \(scope).")
      }
      .confirmationDialog("Discard runtime edits?", isPresented: $discarding) {
        Button("Discard", role: .destructive) { dismiss() }
      }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/runtime",
        body: draft.payload(configuration), method: "PUT")
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminModelPicker: View {
  let client: APIClient
  let scope: String
  let configuration: NativeAdminModelConfiguration
  let browser: Bool
  @Environment(\.dismiss) private var dismiss
  @State private var selected: [String]
  @State private var browseModel: String
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(
    client: APIClient, scope: String, configuration: NativeAdminModelConfiguration, browser: Bool
  ) {
    self.client = client
    self.scope = scope
    self.configuration = configuration
    self.browser = browser
    _selected = State(initialValue: configuration.webuiModels ?? [])
    _browseModel = State(initialValue: configuration.browseModel ?? "")
  }
  private var dirty: Bool {
    browser
      ? browseModel != (configuration.browseModel ?? "")
      : selected != (configuration.webuiModels ?? [])
  }
  var body: some View {
    QMList {
      if browser {
        Picker("Model", selection: $browseModel) {
          Text("Deployment default").tag("")
          if !browseModel.isEmpty
            && !configuration.browseModelOptions.contains(where: { $0.id == browseModel })
          {
            Text("\(browseModel) (configured)").tag(browseModel)
          }
          ForEach(configuration.browseModelOptions) { Text($0.label).tag($0.id) }
        }
      } else {
        Section("Shown in order") {
          Text("An empty list restores the default model picker.").font(.caption)
          ForEach(selected, id: \.self) { id in
            Text(configuration.allModels.first(where: { $0.id == id })?.label ?? id)
          }.onDelete { selected.remove(atOffsets: $0) }
            .onMove { selected.move(fromOffsets: $0, toOffset: $1) }
        }
        Section("Add model") {
          ForEach(configuration.allModels.filter { !selected.contains($0.id) }) { model in
            Button(model.label, systemImage: "plus") { selected.append(model.id) }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.environment(\.editMode, .constant(.active)).disabled(busy)
      .navigationTitle(browser ? "Browser model" : "Model picker list")
      .navigationBarTitleDisplayMode(.inline).navigationBarBackButtonHidden(dirty || busy)
      .toolbar {
        if dirty || busy {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { discarding = true }.disabled(busy)
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { confirming = true }.disabled(busy || !dirty)
        }
      }.confirmationDialog("Change model configuration?", isPresented: $confirming) {
        Button("Save configuration") { Task { await save() } }
      } message: {
        Text("This changes model configuration for \(scope).")
      }
      .confirmationDialog("Discard model edits?", isPresented: $discarding) {
        Button("Discard", role: .destructive) { dismiss() }
      }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let resource = browser ? "browse-model" : "webui-models"
      let body: [String: Any] = browser ? ["modelId": browseModel] : ["ids": selected]
      let _: MutationReceipt = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/\(resource)",
        body: body, method: "PUT")
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeApprovedRuntimes: View {
  let client: APIClient
  let scope: String
  let configuration: NativeAdminModelConfiguration
  @Environment(\.dismiss) private var dismiss
  @State private var selected: Set<String>
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var discarding = false
  init(client: APIClient, scope: String, configuration: NativeAdminModelConfiguration) {
    self.client = client
    self.scope = scope
    self.configuration = configuration
    _selected = State(initialValue: Set(configuration.approvedHarnesses ?? []))
  }
  private var dirty: Bool { selected != Set(configuration.approvedHarnesses ?? []) }
  private var options: [String] {
    Set(configuration.modelsByHarness.keys.filter { $0 != "mock" }).union(selected).sorted()
  }
  var body: some View {
    QMForm {
      Section {
        Text(
          "Choose which agent runtimes people may use. An empty list restores the deployment default (\(configuration.harnessDefault)). Removing a runtime prevents new selections of it."
        ).font(.caption)
        ForEach(options, id: \.self) { id in
          Toggle(
            id.capitalized,
            isOn: Binding(
              get: { selected.contains(id) },
              set: { if $0 { selected.insert(id) } else { selected.remove(id) } }))
        }
        Button("Use deployment default") { selected = [] }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Approved runtimes").navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(dirty || busy)
      .toolbar {
        if dirty || busy {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { discarding = true }.disabled(busy)
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { confirming = true }.disabled(!dirty || busy)
        }
      }.confirmationDialog("Change approved runtimes?", isPresented: $confirming) {
        Button("Save approval list") { Task { await save() } }
      } message: {
        Text("This changes available agent runtimes across the organization.")
      }
      .confirmationDialog("Discard runtime edits?", isPresented: $discarding) {
        Button("Discard", role: .destructive) { dismiss() }
      }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/approved-harnesses",
        body: ["ids": selected.sorted()], method: "PUT")
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
