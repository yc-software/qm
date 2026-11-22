import SwiftUI

enum ModelBrand {
  static func provider(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let metadata = configuration.modelCatalog[id]
    return metadata?.provider ?? "other"
  }

  static func label(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let metadata = configuration.modelCatalog[id]
    return metadata?.label ?? id
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
      case "openai": NativeServiceLogo(service: "openai", size: size * 0.6)
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
