import SwiftUI

struct ModelEffortView: View {
  let model: ChatModel
  let configuration: RuntimeConfiguration
  let update: (_ effort: String?, _ fast: Bool?) -> Void

  var body: some View {
    let current = RuntimeDraft(model.effectiveRuntime ?? configuration.effective)
    let levels = configuration.efforts(model: current.model)
    let workspaceEffort = configuration.effective.effortLevel ?? "auto"
    QMForm {
      if levels.count > 1 {
        Section("Effort") {
          ForEach(levels, id: \.self) { level in
            Button {
              if level != current.effort { update(level, nil) }
            } label: {
              HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(RuntimeSelection.effortLabel(level))
                  Text(Self.explanation(level)).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if level == workspaceEffort {
                  Text("Default").font(.footnote).foregroundStyle(.secondary)
                }
                if level == current.effort {
                  Image(systemName: "checkmark").font(.body.weight(.semibold))
                }
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(level == current.effort ? .isSelected : [])
          }
        }
      }
      if configuration.supportsFastMode(model: current.model) {
        Section {
          Toggle("Fast mode", isOn: Binding(get: { current.fast }, set: { update(nil, $0) }))
        }
      }
    }
    .sensoryFeedback(.selection, trigger: current.effort)
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
}
