import SwiftUI

struct ModelPick: Codable, Equatable {
  var value: String
  var effort: String
  var fast: Bool
}

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
    Task {
      struct Receipt: Decodable { let ok: Bool }
      do {
        let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(next))
        let body: [String: Any] = [
          "key": Self.key, "value": value, "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
        ]
        let _: Receipt = try await client.fetch("api/ui-state", body: body, method: "PUT")
      } catch {
        Log.background.failure("Saving model picks", error)
      }
    }
  }
}

enum ModelBrand {
  static func provider(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    let metadata = configuration.modelCatalog[id]
    return metadata?.displayProvider ?? metadata?.provider ?? "other"
  }

  static func label(_ id: String, _ configuration: RuntimeConfiguration) -> String {
    configuration.modelCatalog[id]?.label ?? id
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
