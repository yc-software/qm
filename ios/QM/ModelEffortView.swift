import SwiftUI

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
