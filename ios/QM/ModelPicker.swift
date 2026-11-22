import SwiftUI

extension View {
  func modelPicker(isPresented: Binding<Bool>, model: ChatModel) -> some View {
    sheet(isPresented: isPresented) {
      NavigationStack { ModelPicker(model: model) }
        .presentationDetents([.fraction(0.72)])
        .presentationDragIndicator(.visible)
        .presentationBackground(QMTheme.paper)
        .presentationContentInteraction(.scrolls)
    }
  }
}

@MainActor
struct ModelPicker: View {
  let model: ChatModel
  @Environment(\.dismiss) private var dismiss
  @State private var picks: ModelPicks

  init(model: ChatModel) {
    self.model = model
    _picks = State(initialValue: ModelPicks(client: model.client))
  }

  var body: some View {
    Group {
      if let configuration = model.runtimeConfiguration {
        if configuration.models.isEmpty {
          ContentUnavailableView(
            "No models available", systemImage: "cpu",
            description: Text("Connect a model account or ask your administrator."))
        } else {
          list(configuration)
        }
      } else {
        ProgressView("Loading models…").frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .background(QMTheme.paper)
    .navigationTitle("Model")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
        }
        .accessibilityLabel("Close")
      }
    }
    .task {
      if model.runtimeConfiguration == nil { await model.loadRuntime() }
    }
  }

  private func list(_ configuration: RuntimeConfiguration) -> some View {
    let current = selection(configuration)
    let shown = shownPicks(configuration)
    return QMList {
      Section {
        ForEach(shown, id: \.value) { pick in
          row(pick, configuration, active: pick.value == current.modelId)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
              if pick.value != current.modelId {
                Button {
                  picks.save(shown.filter { $0.value != pick.value })
                } label: {
                  Image(uiImage: removeIcon).accessibilityLabel("Remove")
                }
                .tint(QMTheme.ink.opacity(0.07))
              }
            }
        }
        NavigationLink {
          ModelCatalog(configuration: configuration, saved: Set(shown.map(\.value))) { id in
            add(id, configuration)
          }
        } label: {
          HStack(spacing: 12) {
            Image(systemName: "plus").font(.system(size: 14, weight: .semibold))
              .frame(width: 28, height: 28)
              .background(QMTheme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
              .accessibilityHidden(true)
            Text("Add a model")
          }
        }
      } header: {
        Text("Presets")
      } footer: {
        if let caption = caption(configuration) { Text(caption) }
      }
      Section {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Workspace default")
            Text(ModelBrand.label(configuration.effective.modelId, configuration))
              .font(.footnote).foregroundStyle(.secondary)
          }
          Spacer()
          if model.runtimeSelection == nil {
            Text("In use").font(.subheadline).foregroundStyle(.secondary)
          } else {
            Button("Use") { model.selectRuntime(nil) }.font(.subheadline.weight(.medium))
          }
        }
      }
    }
  }

  private var removeIcon: UIImage {
    let symbol = UIImage(
      systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(weight: .semibold))
    return symbol?.withTintColor(UIColor(QMTheme.ink), renderingMode: .alwaysOriginal) ?? UIImage()
  }

  @ViewBuilder
  private func row(_ pick: ModelPick, _ configuration: RuntimeConfiguration, active: Bool)
    -> some View
  {
    let label = HStack(spacing: 12) {
      ModelLogo(provider: ModelBrand.provider(pick.value, configuration))
      VStack(alignment: .leading, spacing: 2) {
        Text(ModelBrand.label(pick.value, configuration)).lineLimit(1)
        if let summary = summary(pick, configuration) {
          Text(summary).font(.footnote).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 8)
      if active {
        Image(systemName: "checkmark").font(.body.weight(.semibold))
          .accessibilityLabel("Selected")
      }
    }
    if active {
      NavigationLink {
        ModelEffortView(model: model, configuration: configuration) { effort, fast in
          update(configuration, effort: effort, fast: fast)
        }
      } label: {
        label
      }
    } else {
      Button {
        choose(pick, configuration)
      } label: {
        label.contentShape(Rectangle())
      }
    }
  }

  private func summary(_ pick: ModelPick, _ configuration: RuntimeConfiguration) -> String? {
    var parts: [String] = []
    if configuration.efforts(model: pick.value).count > 1 {
      parts.append(RuntimeSelection.effortLabel(pick.effort))
    }
    if pick.fast { parts.append("Fast") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private func caption(_ configuration: RuntimeConfiguration) -> String? {
    if let reason = configuration.unavailableReason { return reason }
    let current = selection(configuration)
    guard !configuration.models.contains(current.modelId) else { return nil }
    return "\(current.modelId) is no longer available. Pick another model."
  }

  private func selection(_ configuration: RuntimeConfiguration) -> RuntimeSelection {
    model.effectiveRuntime ?? configuration.effective
  }

  private func activePick(_ configuration: RuntimeConfiguration) -> ModelPick {
    let draft = RuntimeDraft(selection(configuration))
    return ModelPick(value: draft.model, effort: draft.effort, fast: draft.fast)
  }

  private func shownPicks(_ configuration: RuntimeConfiguration) -> [ModelPick] {
    let active = activePick(configuration)
    var shown: [ModelPick] = []
    let listed = { (id: String) in shown.contains(where: { $0.value == id }) }
    for pick in picks.entries where configuration.models.contains(pick.value) && !listed(pick.value)
    {
      shown.append(pick.value == active.value ? active : pick)
    }
    if configuration.models.contains(active.value), !listed(active.value) { shown.append(active) }
    return shown
  }

  func choose(_ pick: ModelPick, _ configuration: RuntimeConfiguration) {
    picks.save(shownPicks(configuration))
    var draft = RuntimeDraft(
      RuntimeSelection(modelId: pick.value, effortLevel: pick.effort, fastMode: pick.fast))
    draft.normalize(using: configuration)
    model.selectRuntime(draft.selection)
  }

  private func add(_ id: String, _ configuration: RuntimeConfiguration) {
    let current = RuntimeDraft(selection(configuration))
    let pick = ModelPick(value: id, effort: current.effort, fast: false)
    var next = shownPicks(configuration)
    if !next.contains(where: { $0.value == id }) { next.append(pick) }
    picks.save(next)
    choose(next.first(where: { $0.value == id }) ?? pick, configuration)
  }

  func update(_ configuration: RuntimeConfiguration, effort: String?, fast: Bool?) {
    var draft = RuntimeDraft(selection(configuration))
    if let effort { draft.effort = effort }
    if let fast { draft.fast = fast }
    draft.normalize(using: configuration)
    model.selectRuntime(draft.selection)
    picks.save(shownPicks(configuration))
  }
}

struct ModelCatalog: View {
  let configuration: RuntimeConfiguration
  let saved: Set<String>
  let onAdd: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var expanded: Set<String> = []
  private static let preview = 4

  private var groups: [(name: String, ids: [String])] {
    let matches = configuration.models.filter {
      !saved.contains($0)
        && (query.isEmpty
          || ModelBrand.label($0, configuration).localizedCaseInsensitiveContains(query))
    }
    let grouped = Dictionary(grouping: matches) {
      ModelBrand.groupName(ModelBrand.provider($0, configuration))
    }
    let rank = { (ids: [String]) in ModelBrand.order(ModelBrand.provider(ids[0], configuration)) }
    return grouped.map { (name: $0.key, ids: $0.value) }
      .sorted { (rank($0.ids), $0.name) < (rank($1.ids), $1.name) }
  }

  var body: some View {
    QMList {
      ForEach(groups, id: \.name) { group in
        let open = !query.isEmpty || expanded.contains(group.name)
        let shown = open ? group.ids : Array(group.ids.prefix(Self.preview))
        Section(group.name) {
          ForEach(shown, id: \.self) { id in
            Button {
              onAdd(id)
              dismiss()
            } label: {
              HStack(spacing: 12) {
                ModelLogo(provider: ModelBrand.provider(id, configuration))
                Text(ModelBrand.label(id, configuration)).lineLimit(1)
                Spacer(minLength: 8)
                Text("Add").font(.subheadline.weight(.medium))
              }
              .contentShape(Rectangle())
            }
          }
          if shown.count < group.ids.count {
            Button("\(group.ids.count - shown.count) more") { expanded.insert(group.name) }
              .foregroundStyle(.secondary)
              .accessibilityLabel("Show \(group.ids.count - shown.count) more \(group.name) models")
          }
        }
      }
    }
    .overlay { if groups.isEmpty { ContentUnavailableView.search(text: query) } }
    .searchable(
      text: $query, placement: .navigationBarDrawer(displayMode: .always),
      prompt: "Search models"
    )
    .navigationTitle("Add a model")
    .navigationBarTitleDisplayMode(.inline)
  }
}
