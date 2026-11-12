import Foundation
import os

enum Log {
  static let background = Logger(subsystem: "org.qm", category: "background")
  static let drafts = Logger(subsystem: "org.qm", category: "drafts")
}

extension Logger {
  func failure(_ action: String, _ error: Error) {
    guard !Task.isCancelled, !(error is CancellationError),
      (error as? URLError)?.code != .cancelled
    else { return }
    self.error(
      "\(action, privacy: .public) failed: \(String(describing: error), privacy: .public)")
  }
}
