import Foundation

struct RunReasoning: Decodable, Identifiable {
  let step: String
  let index: Int
  let text: String

  var id: String { "\(step):\(index)" }
}

extension Item {
  var stepID: String? { body?.wire?.message?.id }
  var stepIndex: Int? { step }

  var reasoningID: String? { kind == "Reasoning" ? stepIdentity : nil }

  var stepIdentity: String? {
    guard let id = stepID, let index = stepIndex
    else { return nil }
    return "\(id):\(index)"
  }
}
