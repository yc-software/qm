import SwiftUI

struct NativeFeatureFlag: Decodable, Identifiable {
  let featureName: String
  let label: String?
  let personalOnly: Bool?
  let hint: String?
  let enabledScopes: [String]
  var id: String { featureName }
  var title: String { label ?? featureName.replacingOccurrences(of: "_", with: " ") }
  func accepts(_ scopeId: String) -> Bool {
    personalOnly != true || scopeId.hasPrefix("personal:")
  }
}

struct NativeAdminFlags: View {
  struct Configuration: Decodable { let featureFlags: [NativeFeatureFlag]? }
  struct Change: Identifiable {
    let feature: String
    let scope: String
    let on: Bool
    var id: String { feature + scope }
  }
  let client: APIClient
  let scope: String
  @State private var flags: [NativeFeatureFlag] = []
  @State private var scopes: [NativeAdminScope] = []
  @State private var feature = ""
  @State private var selectedScope = ""
  @State private var change: Change?
  @State private var busy = false
  @State private var loaded = false
  @State private var error: String?
  var body: some View {
    QMList {
      Section {
        Text(
          "Organization enablement includes every scope. Removing a narrower entry does not override organization enablement."
        ).font(.caption)
      }
      ForEach(flags) { flag in
        Section(flag.title) {
          let enabled = flag.enabledScopes
          if enabled.isEmpty { Text("No enabled scopes").foregroundStyle(.secondary) }
          ForEach(enabled, id: \.self) { target in
            HStack {
              Text(scopes.first { $0.id == target }?.label ?? target)
              Spacer()
              Button("Remove", role: .destructive) {
                change = .init(feature: flag.featureName, scope: target, on: false)
              }
            }
          }
        }
      }
      Section("Enable for a scope") {
        Picker("Feature", selection: $feature) {
          ForEach(flags) { Text($0.title).tag($0.featureName) }
        }.onChange(of: feature) {
          if selected?.accepts(selectedScope) == false { selectedScope = "" }
        }
        if let hint = selected?.hint { Text(hint).font(.caption) }
        Picker("Scope", selection: $selectedScope) {
          Text("Choose scope").tag("")
          if selected?.accepts(scope) != false { Text("Entire organization").tag(scope) }
          ForEach(scopes.filter { $0.id != scope && selected?.accepts($0.id) != false }) {
            Text($0.label ?? $0.id).tag($0.id)
          }
        }
        Button("Enable feature") {
          change = .init(feature: feature, scope: selectedScope, on: true)
        }.disabled(selectedScope.isEmpty || selected == nil || !loaded)
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Feature rollout").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
      .confirmationDialog(
        "Change feature rollout?",
        isPresented: Binding(get: { change != nil }, set: { if !$0 { change = nil } })
      ) {
        if let change {
          Button(
            change.on ? "Enable feature" : "Remove enablement", role: change.on ? nil : .destructive
          ) { Task { await save(change) } }
        }
      } message: {
        Text(
          "\(change?.feature ?? "Feature") · \(change?.scope ?? "")\(change?.scope == scope ? "\nThis affects the entire organization." : "")"
        )
      }
  }
  private var selected: NativeFeatureFlag? { flags.first { $0.featureName == feature } }
  private func show(_ rows: [NativeFeatureFlag]) {
    flags = rows
    if selected == nil { feature = rows.first?.featureName ?? "" }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: Configuration = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)", query: [.init(name: "view", value: "customize")])
      let listing: NativeAdminScopes = try await client.fetch("admin/api/scopes")
      show(result.featureFlags ?? [])
      scopes = listing.scopes
      loaded = true
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func save(_ change: Change) async {
    guard !busy, loaded else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/feature-flags",
        body: ["featureName": change.feature, "scopeId": change.scope, "on": change.on],
        method: "PUT")
      let result: Configuration = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)", query: [.init(name: "view", value: "customize")])
      show(result.featureFlags ?? [])
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAutoFlaggerSpec: Codable, Equatable {
  var harnessId: String
  var modelId: String
  var rubric: String
}

struct NativeAutoFlagger: View {
  struct Configuration: Decodable {
    let autoFlagger: NativeAutoFlaggerSpec?
    let autoFlaggerDefault: NativeAutoFlaggerSpec
    let modelsByHarness: [String: [NativeAdminModelConfiguration.Model]]
  }
  struct Result: Decodable {
    let sampled: Int
    let flagged: Int?
    let allowed: Int?
    let unscreened: Int?
    let errors: Int?
    let partial: Bool?
    let message: String?
  }
  let client: APIClient
  let scope: String
  @Environment(\.dismiss) private var dismiss
  @State private var configuration: Configuration?
  @State private var draft = NativeAutoFlaggerSpec(harnessId: "", modelId: "", rubric: "")
  @State private var initial: NativeAutoFlaggerSpec?
  @State private var busy = false
  @State private var error: String?
  @State private var result: Result?
  @State private var operation: String?
  @State private var discarding = false
  @State private var samples = 10
  private var dirty: Bool { initial != nil && initial != draft }
  var body: some View {
    QMForm {
      if let configuration {
        Section("External-content screening") {
          Text(
            "Auto posture uses this model and rubric to screen external content. Changing the rubric changes organization security behavior."
          ).font(.caption)
          Picker("Runtime", selection: $draft.harnessId) {
            ForEach(configuration.modelsByHarness.keys.filter { $0 != "mock" }.sorted(), id: \.self)
            { Text($0.capitalized).tag($0) }
          }.onChange(of: draft.harnessId) {
            if !(configuration.modelsByHarness[draft.harnessId] ?? []).contains(where: {
              $0.id == draft.modelId
            }) {
              draft.modelId = configuration.modelsByHarness[draft.harnessId]?.first?.id ?? ""
            }
          }
          Picker("Model", selection: $draft.modelId) {
            let models = configuration.modelsByHarness[draft.harnessId] ?? []
            if !draft.modelId.isEmpty && !models.contains(where: { $0.id == draft.modelId }) {
              Text(draft.modelId + " (configured)").tag(draft.modelId)
            }
            ForEach(models) { Text($0.label ?? $0.id).tag($0.id) }
          }
          TextEditor(text: $draft.rubric).frame(minHeight: 220)
          Button("Save screening configuration") { operation = "save" }.disabled(
            !dirty || draft.modelId.isEmpty
              || draft.rubric.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Button("Restore deployment default", role: .destructive) { operation = "reset" }
        }
        Section("Replay recorded screenings") {
          Stepper("Recent samples: \(samples)", value: $samples, in: 1...50)
          Button("Test this configuration") { operation = "test" }
          Text(
            "Runs the selected model on recorded screening inputs. This makes billable model requests and does not save the configuration."
          ).font(.caption)
          if let result {
            LabeledContent("Samples", value: String(result.sampled))
            if let value = result.flagged { LabeledContent("Flagged", value: String(value)) }
            if let value = result.allowed { LabeledContent("Allowed", value: String(value)) }
            if let value = result.unscreened { LabeledContent("Unscreened", value: String(value)) }
            if let value = result.errors { LabeledContent("Errors", value: String(value)) }
            if result.partial == true {
              Text("Replay stopped before all samples completed.").foregroundStyle(.orange)
            }
            if let message = result.message { Text(message) }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if configuration == nil && !busy { Button("Retry") { Task { await load() } } }
      if busy { ProgressView() }
    }.disabled(busy).navigationTitle("Auto screening").navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(dirty || busy)
      .toolbar {
        if dirty || busy {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { discarding = true }.disabled(busy)
          }
        }
      }.task { await load() }
      .onChange(of: draft) { result = nil }
      .onChange(of: samples) { result = nil }
      .confirmationDialog(
        operation == "test" ? "Replay screening inputs?" : "Change organization screening?",
        isPresented: Binding(get: { operation != nil }, set: { if !$0 { operation = nil } })
      ) {
        if let operation {
          Button(
            operation == "test"
              ? "Run billable test"
              : operation == "reset" ? "Restore default" : "Save configuration"
          ) { Task { await perform(operation) } }
        }
      } message: {
        Text(
          operation == "test"
            ? "This sends up to \(samples) recorded screening inputs to the selected model using organization credentials."
            : "This changes external-content screening across the organization.")
      }
      .confirmationDialog("Discard screening edits?", isPresented: $discarding) {
        Button("Discard", role: .destructive) { dismiss() }
      }
  }
  private func load() async {
    guard !busy, !dirty else { return }
    busy = true
    defer { busy = false }
    do {
      let value: Configuration = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)", query: [.init(name: "view", value: "governance")])
      configuration = value
      draft = value.autoFlagger ?? value.autoFlaggerDefault
      initial = draft
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func perform(_ operation: String) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let path = "admin/api/scopes/\(scope.apiComponent)/auto-flagger"
      var body =
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
      if operation == "test" {
        body["window"] = samples
        result = try await client.fetch(path + "/test", body: body, timeout: 150)
      } else {
        let _: MutationReceipt = try await client.fetch(
          path, body: operation == "reset" ? ["reset": true] : body, method: "PUT")
        if operation == "reset", let configuration { draft = configuration.autoFlaggerDefault }
        initial = draft
      }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
