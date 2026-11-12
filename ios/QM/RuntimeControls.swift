import SwiftUI

struct RuntimeSelection: Codable, Equatable {
  let modelId: String
  let effortLevel: String?
  let fastMode: Bool?

  var turnOptions: [String: Any] {
    var options: [String: Any] = ["model": modelId]
    if let effortLevel { options["thinkingLevel"] = effortLevel }
    if let fastMode { options["fastMode"] = fastMode }
    return options
  }
}

struct RuntimeModelMetadata: Decodable {
  let id: String
  let label: String
  let provider: String?
  let reasoning: Bool?
  let effortLevels: [String]
}

struct RuntimeConfiguration: Decodable {
  let scopeId: String
  let models: [String]
  let modelCatalog: [String: RuntimeModelMetadata]
  let orgDefault: RuntimeSelection
  let scopeOverride: RuntimeSelection?
  let effective: RuntimeSelection
  let unavailableReason: String?
  let fastModeModelIds: [String]

  func efforts(model: String) -> [String] {
    modelCatalog[model]?.effortLevels ?? []
  }

  func supportsFastMode(model: String) -> Bool {
    fastModeModelIds.contains(model)
  }
}

struct RuntimeDraft {
  var model: String
  var effort: String
  var fast: Bool

  init(_ selection: RuntimeSelection) {
    model = selection.modelId
    effort = selection.effortLevel ?? "auto"
    fast = selection.fastMode == true
  }

  mutating func normalize(using configuration: RuntimeConfiguration) {
    if !configuration.efforts(model: model).contains(effort) { effort = "auto" }
    if !configuration.supportsFastMode(model: model) { fast = false }
  }

  var selection: RuntimeSelection {
    RuntimeSelection(modelId: model, effortLevel: effort, fastMode: fast)
  }

  func body(scopeID: String) -> [String: Any] {
    ["scopeId": scopeID, "modelId": model, "effortLevel": effort, "fastMode": fast]
  }
}

@MainActor
struct RuntimeControlsView: View {
  let client: APIClient
  let scopeID: String
  var showsCancel = false
  var selected: RuntimeSelection? = nil
  var onSelect: ((RuntimeSelection?) -> Void)? = nil
  @Environment(\.dismiss) private var dismiss
  @State private var configuration: RuntimeConfiguration?
  @State private var draft: RuntimeDraft?
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    QMForm {
      if let configuration, let draft {
        Section("Model") {
          if onSelect == nil {
            Text(
              "Sets the model default for this space. Existing running tasks keep their current model."
            )
            .font(.footnote).foregroundStyle(.secondary)
          }
          if let reason = configuration.unavailableReason {
            Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(QMTheme.warning)
          }
          if configuration.models.isEmpty {
            Text("No models are available. Connect a model account or ask your administrator.")
          } else {
            Picker("Model", selection: modelBinding) {
              if !configuration.models.contains(draft.model) {
                Text("\(draft.model) (unavailable)").tag(draft.model)
              }
              ForEach(configuration.models, id: \.self) { id in
                Text(configuration.modelCatalog[id]?.label ?? id).tag(id)
              }
            }
            if configuration.efforts(model: draft.model).count > 1 {
              Picker("Reasoning effort", selection: effortBinding) {
                ForEach(
                  configuration.efforts(model: draft.model), id: \.self
                ) {
                  Text($0 == "xhigh" ? "Extra high" : $0.capitalized).tag($0)
                }
              }
            }
            if configuration.supportsFastMode(model: draft.model) {
              Toggle("Fast mode", isOn: fastBinding)
            }
          }
        }
        Section {
          if onSelect != nil {
            LabeledContent(
              "Workspace default",
              value: configuration.modelCatalog[configuration.effective.modelId]?.label
                ?? configuration.effective.modelId)
            Button("Use workspace default") {
              onSelect?(nil)
              dismiss()
            }
          } else {
            LabeledContent(
              "Organization default",
              value: configuration.modelCatalog[configuration.orgDefault.modelId]?.label
                ?? configuration.orgDefault.modelId)
            if configuration.scopeOverride != nil {
              Button("Use organization default") { Task { await save(inherit: true) } }
            } else {
              Text("Following the organization default").foregroundStyle(.secondary)
            }
          }
        }
      } else if busy {
        VStack(alignment: .leading, spacing: 22) {
          Text("Loading models...").font(.subheadline).foregroundStyle(.secondary)
          ForEach(0..<3) { row in
            VStack(alignment: .leading, spacing: 10) {
              NativeSkeletonLine(fraction: 0.45, height: 14)
              NativeSkeletonLine(fraction: 0.8)
            }
            .modifier(NativeLoadingPulse(phaseOffset: Double(row) * 0.18))
          }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading models")
      }
      if let error {
        Section {
          Text(error).foregroundStyle(.red)
          if configuration == nil { Button("Try again") { Task { await load() } } }
        }
      }
    }
    .disabled(busy)
    .scrollContentBackground(.hidden)
    .background(QMTheme.paper)
    .navigationTitle("Model settings")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if showsCancel {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button {
          Task { await save(inherit: false) }
        } label: {
          NativeActionLabel(
            title: "Save", busyTitle: "Saving…", busy: busy && configuration != nil, compact: true)
        }.disabled(busy || !canSave)
      }
    }
    .interactiveDismissDisabled(busy)
    .task(id: scopeID) { await load() }
  }

  private var canSave: Bool {
    guard let draft, let configuration else { return false }
    return configuration.models.contains(draft.model)
  }

  private var modelBinding: Binding<String> {
    Binding(
      get: { draft?.model ?? "" },
      set: { value in
        guard let configuration, var next = draft else { return }
        next.model = value
        next.normalize(using: configuration)
        draft = next
      })
  }

  private var effortBinding: Binding<String> {
    Binding(get: { draft?.effort ?? "auto" }, set: { draft?.effort = $0 })
  }

  private var fastBinding: Binding<Bool> {
    Binding(get: { draft?.fast ?? false }, set: { draft?.fast = $0 })
  }

  private func load() async {
    guard !busy else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let loaded: RuntimeConfiguration = try await client.fetch(
        "api/runtime-config", query: [.init(name: "scopeId", value: scopeID)])
      configuration = loaded
      var next = RuntimeDraft(selected ?? loaded.effective)
      next.normalize(using: loaded)
      draft = next
    } catch {
      self.error = "Could not load model settings. \(error.localizedDescription)"
    }
  }

  private func save(inherit: Bool) async {
    guard !busy, let draft, let configuration, inherit || canSave else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      var normalized = draft
      normalized.normalize(using: configuration)
      if let onSelect {
        onSelect(normalized.selection)
        dismiss()
        return
      }
      let body: [String: Any] =
        inherit
        ? ["scopeId": scopeID, "inherit": true] : normalized.body(scopeID: scopeID)
      let _: RuntimeConfiguration = try await client.fetch(
        "api/runtime-config", body: body, method: "PUT")
      dismiss()
    } catch {
      self.error = "Model settings were not saved. \(error.localizedDescription)"
    }
  }
}
