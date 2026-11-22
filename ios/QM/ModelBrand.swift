import SwiftUI

enum ModelBrand {
  static func provider(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let provider = configuration.modelCatalog[id]?.provider ?? "other"
    switch provider {
    case "qm:gateway":
      let name = id.split(separator: "/").last ?? ""
      if name.hasPrefix("claude-") { return "anthropic" }
      if name.hasPrefix("gpt-") { return "openai" }
      if name.hasPrefix("gemini-") { return "google" }
      return provider
    case "openrouter":
      return id.split(separator: "/").first.map(String.init) ?? provider
    default:
      return provider
    }
  }

  static func label(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    configuration.modelCatalog[id]?.label ?? id
  }

  static func groupName(_ provider: String) -> String {
    switch provider {
    case "qm:gateway": "Gateway"
    case "anthropic": "Anthropic"
    case "openai", "openai-codex": "OpenAI"
    case "openrouter": "OpenRouter"
    case "google": "Google"
    case "arcee-ai": "Arcee AI"
    case "meta-llama": "Meta"
    case "mistralai": "Mistral AI"
    default:
      provider.split(whereSeparator: { $0 == "-" || $0 == "_" })
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
  }

  static func order(_ provider: String) -> Int {
    switch provider {
    case "anthropic": 0
    case "openai", "openai-codex": 1
    case "google": 2
    default: 3
    }
  }
}

struct ModelLogo: View {
  let provider: String
  var size: CGFloat = 28

  var body: some View {
    Group {
      switch provider {
      case "anthropic":
        NativeServiceLogo(service: "claude", size: size * 0.6)
          .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
      case "openai", "openai-codex": NativeServiceLogo(service: "openai", size: size * 0.6)
      case "google":
        NativeServiceLogo(service: "gemini", size: size * 0.6)
          .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96))
      default:
        Image(systemName: "sparkle").resizable().scaledToFit().padding(size * 0.2)
          .foregroundStyle(.secondary)
      }
    }
    .frame(width: size, height: size)
    .background(QMTheme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.28))
    .accessibilityHidden(true)
  }
}
