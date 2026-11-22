import SwiftUI

enum ModelBrand {
  static func provider(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let metadata = configuration.modelCatalog[id]
    return metadata?.displayProvider ?? metadata?.provider ?? "other"
  }

  static func label(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let metadata = configuration.modelCatalog[id]
    return metadata?.displayLabel ?? metadata?.label ?? id
  }

  static func groupName(_ provider: String) -> String {
    switch provider {
    case "anthropic": "Anthropic"
    case "openai": "OpenAI"
    case "google": "Google"
    case "qm:gateway": "Gateway"
    case "openrouter": "OpenRouter"
    case "arcee-ai": "Arcee AI"
    case "meta-llama": "Meta"
    case "mistralai": "Mistral AI"
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
      case "google": Image("Service-gemini").resizable().scaledToFit()
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
