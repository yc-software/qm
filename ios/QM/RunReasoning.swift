import Foundation

struct RunReasoning: Decodable, Identifiable {
  let step: String
  let index: Int
  let text: String

  var id: String { "\(step):\(index)" }
}

extension Entry {
  var stepID: String? { payload?.details?["step"]?["id"]?.string }
  var stepIndex: Int? {
    guard case .number(let index) = payload?.details?["step"]?["index"] else { return nil }
    return NSDecimalNumber(decimal: index).intValue
  }

  var reasoningID: String? {
    guard type == "thinking", let id = stepID, let index = stepIndex
    else { return nil }
    return "\(id):\(index)"
  }
}
