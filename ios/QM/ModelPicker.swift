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

/// A saved model with its effort and speed. The web picker's loadout uses the same shape.
struct ModelPick: Codable, Equatable {
  var value: String
  var effort: String
  var fast: Bool
}

/// The person's saved picks, kept in the `model-picks` ui-state key so web and iOS share them.
@MainActor @Observable
final class ModelPicks {
  static let key = "model-picks"
  private(set) var entries: [ModelPick] = []
  private let client: APIClient

  init(client: APIClient) { self.client = client }

  func load() async {
    struct Record: Decodable { let value: [ModelPick]? }
    do {
      let record: Record = try await client.fetch(
        "api/ui-state", query: [.init(name: "key", value: Self.key)])
      entries = record.value ?? []
    } catch {
      Log.background.failure("Loading model picks", error)
    }
  }

  func save(_ next: [ModelPick]) {
    guard next != entries else { return }
    entries = next
    let body: [String: Any] = [
      "key": Self.key,
      "value": next.map { ["value": $0.value, "effort": $0.effort, "fast": $0.fast] },
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
    ]
    Task {
      struct Receipt: Decodable { let ok: Bool }
      do {
        let _: Receipt = try await client.fetch("api/ui-state", body: body, method: "PUT")
      } catch {
        Log.background.failure("Saving model picks", error)
      }
    }
  }
}

/// Provider marks and names, matching the web picker's gateway presentation.
enum ModelBrand {
  static func provider(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let provider = configuration.modelCatalog[id]?.provider ?? "other"
    guard provider == "qm:gateway" else { return provider }
    let name = id.split(separator: "/").last.map(String.init) ?? id
    if name.hasPrefix("claude-") { return "anthropic" }
    if name.hasPrefix("gpt-") { return "openai" }
    if name.hasPrefix("gemini-") { return "google" }
    return provider
  }

  static func label(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let label = configuration.modelCatalog[id]?.label ?? id
    guard id.hasPrefix("gateway/"), label == id || label == String(id.dropFirst(8)) else {
      return label
    }
    let name = id.split(separator: "/").last.map(String.init) ?? id
    let prefixes = [("claude-", ""), ("gpt-", "GPT-"), ("gemini-", "Gemini ")]
    guard let (family, prefix) = prefixes.first(where: { name.hasPrefix($0.0) }) else {
      return label
    }
    let words = String(name.dropFirst(family.count))
      .replacing(/(\d+)-(\d+)(?=-|$)/) { "\($0.1).\($0.2)" }
      .split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }
    return prefix + words.joined(separator: " ")
  }

  static func groupName(_ provider: String) -> String {
    switch provider {
    case "anthropic": "Anthropic"
    case "openai": "OpenAI"
    case "google": "Google"
    case "qm:gateway": "Gateway"
    default:
      provider.split(whereSeparator: { $0 == "-" || $0 == "_" })
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
  }

  static func order(_ provider: String) -> Int {
    ["anthropic", "openai", "google"].firstIndex(of: provider) ?? 3
  }
}

struct ModelLogo: View {
  let provider: String
  var size: CGFloat = 28

  var body: some View {
    Group {
      switch provider {
      case "anthropic":
        Image("Service-claude").resizable().renderingMode(.template).scaledToFit()
          .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
      case "openai":
        Image("Service-openai").resizable().renderingMode(.template).scaledToFit()
          .foregroundStyle(QMTheme.ink)
      case "google": GeminiMark().fill(Color(red: 0.26, green: 0.52, blue: 0.96))
      default:
        Image(systemName: "sparkle").resizable().scaledToFit().foregroundStyle(.secondary)
      }
    }
    .padding(size * 0.2)
    .frame(width: size, height: size)
    .background(QMTheme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.28))
    .accessibilityHidden(true)
  }
}

private struct GeminiMark: Shape {
  func path(in rect: CGRect) -> Path {
    let s = min(rect.width, rect.height) / 24
    let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
    var path = Path()
    path.move(to: p(12, 1))
    path.addCurve(to: p(1, 12), control1: p(10.5, 8.5), control2: p(8.5, 10.5))
    path.addCurve(to: p(12, 23), control1: p(8.5, 13.5), control2: p(10.5, 15.5))
    path.addCurve(to: p(23, 12), control1: p(13.5, 15.5), control2: p(15.5, 13.5))
    path.addCurve(to: p(12, 1), control1: p(15.5, 10.5), control2: p(13.5, 8.5))
    return path
  }
}

/// Opens on the person's saved picks; one tap switches, and "Add a model" searches the catalog.
@MainActor
struct ModelPicker: View {
  let model: ChatModel
  @Environment(\.dismiss) private var dismiss
  @State private var picks: ModelPicks
  @State private var revealed: String?

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
      await picks.load()
    }
  }

  private func list(_ configuration: RuntimeConfiguration) -> some View {
    let current = selection(configuration)
    let shown = shownPicks(configuration)
    return QMList {
      Section {
        ForEach(shown, id: \.value) { pick in
          row(pick, configuration, active: pick.value == current.modelId) {
            revealed = nil
            picks.save(shown.filter { $0.value != pick.value })
          }
          .contextMenu {
            if pick.value != current.modelId {
              Button("Remove from picks", systemImage: "minus.circle") {
                picks.save(shown.filter { $0.value != pick.value })
              }
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
        Text("Your picks")
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

  @ViewBuilder
  private func row(
    _ pick: ModelPick, _ configuration: RuntimeConfiguration, active: Bool,
    remove: @escaping () -> Void
  ) -> some View {
    let label = HStack(spacing: 12) {
      ModelLogo(provider: ModelBrand.provider(pick.value, configuration))
      VStack(alignment: .leading, spacing: 2) {
        Text(ModelBrand.label(pick.value, configuration)).lineLimit(1)
        Text(summary(pick, configuration)).font(.footnote).foregroundStyle(.secondary)
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
        if revealed == pick.value { revealed = nil } else { choose(pick, configuration) }
      } label: {
        label.contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .modifier(
        SwipeToReveal(
          isOpen: Binding(
            get: { revealed == pick.value },
            set: { open in
              if open { revealed = pick.value } else if revealed == pick.value { revealed = nil }
            }),
          action: remove)
      )
      .accessibilityAction(named: "Remove", remove)
    }
  }

  private func summary(_ pick: ModelPick, _ configuration: RuntimeConfiguration) -> String {
    var parts: [String] = []
    if configuration.efforts(model: pick.value).count > 1 {
      parts.append(RuntimeSelection.effortLabel(pick.effort))
    }
    if pick.fast { parts.append("Fast") }
    return parts.isEmpty
      ? ModelBrand.groupName(ModelBrand.provider(pick.value, configuration))
      : parts.joined(separator: " · ")
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

  /// Saved picks this workspace can run; the model in use is always listed with its live settings.
  private func shownPicks(_ configuration: RuntimeConfiguration) -> [ModelPick] {
    let active = activePick(configuration)
    var shown: [ModelPick] = []
    let listed = { (id: String) in shown.contains(where: { $0.value == id }) }
    for pick in picks.entries where configuration.models.contains(pick.value) && !listed(pick.value)
    {
      shown.append(pick.value == active.value ? active : pick)
    }
    if configuration.models.contains(active.value), !listed(active.value) { shown.append(active) }
    if picks.entries.isEmpty, shown.count == 1,
      let other = configuration.models.first(where: {
        ModelBrand.provider($0, configuration) != ModelBrand.provider(active.value, configuration)
      })
    {
      shown.append(ModelPick(value: other, effort: "auto", fast: false))
    }
    return shown
  }

  private func choose(_ pick: ModelPick, _ configuration: RuntimeConfiguration) {
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

  private func update(_ configuration: RuntimeConfiguration, effort: String?, fast: Bool?) {
    var draft = RuntimeDraft(selection(configuration))
    if let effort { draft.effort = effort }
    if let fast { draft.fast = fast }
    draft.normalize(using: configuration)
    model.selectRuntime(draft.selection)
    picks.save(shownPicks(configuration))
  }
}

/// Every model the workspace can run, grouped by provider and searchable.
struct ModelCatalog: View {
  let configuration: RuntimeConfiguration
  let saved: Set<String>
  let onAdd: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  private var groups: [(provider: String, ids: [String])] {
    let matches = configuration.models.filter {
      query.isEmpty || ModelBrand.label($0, configuration).localizedCaseInsensitiveContains(query)
        || ModelBrand.groupName(ModelBrand.provider($0, configuration))
          .localizedCaseInsensitiveContains(query)
    }
    return Dictionary(grouping: matches) { ModelBrand.provider($0, configuration) }
      .map { (provider: $0.key, ids: $0.value) }
      .sorted {
        (ModelBrand.order($0.provider), ModelBrand.groupName($0.provider))
          < (ModelBrand.order($1.provider), ModelBrand.groupName($1.provider))
      }
  }

  var body: some View {
    QMList {
      ForEach(groups, id: \.provider) { group in
        Section {
          ForEach(group.ids, id: \.self) { id in
            Button {
              onAdd(id)
              dismiss()
            } label: {
              HStack(spacing: 12) {
                ModelLogo(provider: group.provider)
                Text(ModelBrand.label(id, configuration)).lineLimit(1)
                Spacer(minLength: 8)
                Text(saved.contains(id) ? "Saved" : "Add")
                  .font(.subheadline.weight(saved.contains(id) ? .regular : .medium))
                  .foregroundStyle(saved.contains(id) ? .secondary : .primary)
              }
              .contentShape(Rectangle())
            }
          }
        } header: {
          HStack(spacing: 6) {
            ModelLogo(provider: group.provider, size: 18)
            Text(ModelBrand.groupName(group.provider))
          }
        }
      }
    }
    .overlay { if groups.isEmpty { ContentUnavailableView.search(text: query) } }
    .searchable(
      text: $query, placement: .navigationBarDrawer(displayMode: .always),
      prompt: "Search \(configuration.models.count) models"
    )
    .navigationTitle("Add a model")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// Reasoning effort as a stepped track, plus fast mode when the model offers it.
struct ModelEffortView: View {
  let model: ChatModel
  let configuration: RuntimeConfiguration
  let update: (_ effort: String?, _ fast: Bool?) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let current = RuntimeDraft(model.effectiveRuntime ?? configuration.effective)
    let levels = configuration.efforts(model: current.model)
    VStack(spacing: 24) {
      Spacer(minLength: 0)
      if levels.count > 1 { slider(current, levels) }
      Spacer(minLength: 0)
      if configuration.supportsFastMode(model: current.model) {
        Toggle(
          "Fast mode", isOn: Binding(get: { current.fast }, set: { update(nil, $0) })
        )
        .tint(QMTheme.switchOn)
        .padding(.horizontal, 16).frame(minHeight: 52)
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 16))
      }
    }
    .padding(.horizontal, 20).padding(.vertical, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(QMTheme.paper)
    .foregroundStyle(QMTheme.ink)
    .navigationTitle(ModelBrand.label(current.model, configuration))
    .navigationBarTitleDisplayMode(.inline)
  }

  static func explanation(_ effort: String) -> String {
    switch effort {
    case "auto": "The model decides how long to think for each message."
    case "default": "Uses the provider's standard amount of thinking."
    case "adaptive": "Thinks more on hard messages and less on easy ones."
    case "none": "Answers without extra thinking. Fastest and cheapest."
    case "minimal": "Barely thinks before answering. Very fast and cheap."
    case "low": "Light thinking for quick answers. Fast and low cost."
    case "medium": "Enough thinking for most everyday work."
    case "high": "Thinks longer on harder problems. Slower and costs more."
    case "xhigh": "Thinks much longer for complex work. Noticeably slower and costlier."
    case "max": "Thinks as long as it needs. Slowest and most expensive."
    default: "Higher effort thinks longer and costs more; lower effort answers faster."
    }
  }

  private func slider(_ current: RuntimeDraft, _ levels: [String]) -> some View {
    let index = levels.firstIndex(of: current.effort) ?? 0
    let label = RuntimeSelection.effortLabel(current.effort)
    let step = { (offset: Int) in
      let next = min(max(index + offset, 0), levels.count - 1)
      if next != index { update(levels[next], nil) }
    }
    return VStack(spacing: 16) {
      VStack(spacing: 4) {
        Text("Workspace default").font(.caption.weight(.medium)).foregroundStyle(.secondary)
          .opacity(current.effort == (configuration.effective.effortLevel ?? "auto") ? 1 : 0)
        Text(label).font(.title3.weight(.medium)).contentTransition(.interpolate)
      }
      GeometryReader { geometry in
        let stop = geometry.size.width / CGFloat(max(levels.count, 1))
        ZStack(alignment: .leading) {
          Capsule().fill(QMTheme.ink.opacity(0.08))
          Capsule().fill(QMTheme.ink).frame(width: stop * CGFloat(index + 1))
          HStack(spacing: 0) {
            ForEach(levels.indices, id: \.self) { i in
              Group {
                if i == index {
                  Circle().strokeBorder(QMTheme.paper, lineWidth: 2).frame(width: 12, height: 12)
                } else {
                  Circle().fill(i < index ? QMTheme.paper.opacity(0.7) : QMTheme.ink.opacity(0.3))
                    .frame(width: 5, height: 5)
                }
              }
              .frame(maxWidth: .infinity)
            }
          }
        }
        .contentShape(Capsule())
        .gesture(
          DragGesture(minimumDistance: 0).onChanged { value in
            step(min(max(Int(value.location.x / stop), 0), levels.count - 1) - index)
          })
      }
      .frame(height: 52)
      .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: index)
      .sensoryFeedback(.selection, trigger: index)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Reasoning effort")
      .accessibilityValue(label)
      .accessibilityAdjustableAction { direction in
        step(direction == .increment ? 1 : direction == .decrement ? -1 : 0)
      }
      Text(Self.explanation(current.effort))
        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        .frame(minHeight: 36, alignment: .top)
        .contentTransition(.opacity)
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: current.effort)
    }
  }
}

/// Swiping a row left slides it aside to show a plain "Remove" text button behind it.
/// System swipe actions always draw a filled button, which read as disabled here.
private struct SwipeToReveal: ViewModifier {
  @Binding var isOpen: Bool
  let action: () -> Void
  @State private var drag: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let width: CGFloat = 84

  func body(content: Content) -> some View {
    let offset = min(0, max(-width * 1.4, (isOpen ? -width : 0) + drag))
    content
      .offset(x: offset)
      .background(alignment: .trailing) {
        Button("Remove", action: action)
          .font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
          .frame(width: width).frame(maxHeight: .infinity).contentShape(Rectangle())
          .buttonStyle(.plain)
          .opacity(Double(min(1, -offset / width)))
          .allowsHitTesting(isOpen)
          .accessibilityHidden(true)
      }
      .simultaneousGesture(
        DragGesture(minimumDistance: 16)
          .onChanged { value in
            guard abs(value.translation.width) > abs(value.translation.height) else { return }
            drag = value.translation.width
          }
          .onEnded { value in
            let horizontal = abs(value.translation.width) > abs(value.translation.height)
            let end = (isOpen ? -width : 0) + value.predictedEndTranslation.width
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) {
              if horizontal { isOpen = end < -width / 2 }
              drag = 0
            }
          })
  }
}
