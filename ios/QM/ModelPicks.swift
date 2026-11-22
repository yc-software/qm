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
