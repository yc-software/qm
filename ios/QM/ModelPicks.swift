import SwiftUI

struct ModelPick: Codable, Equatable {
  var value: String
  var effort: String
  var fast: Bool
}

@MainActor @Observable
final class ModelPicks {
  private(set) var entries: [ModelPick] = []
  private let key: String

  init(client: APIClient) {
    key = "model-picks:" + client.baseURL.absoluteString
    guard let data = UserDefaults.standard.data(forKey: key) else { return }
    do {
      entries = try JSONDecoder().decode([ModelPick].self, from: data)
    } catch {
      Log.background.failure("Loading model picks", error)
    }
  }

  func save(_ next: [ModelPick]) {
    guard next != entries else { return }
    entries = next
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(next), forKey: key)
    } catch {
      Log.background.failure("Saving model picks", error)
    }
  }
}
