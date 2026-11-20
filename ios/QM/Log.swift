import Foundation
import os

enum Log {
  static let background = Logger(subsystem: "org.qm", category: "background")
  static let drafts = Logger(subsystem: "org.qm", category: "drafts")
  static let decoding = Logger(subsystem: "org.qm", category: "decoding")
  static let markdown = Logger(subsystem: "org.qm", category: "markdown")
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

extension KeyedDecodingContainer {
  func logged<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
    do {
      return try decodeIfPresent(type, forKey: key)
    } catch {
      Log.decoding.failure("Decoding \(key.stringValue)", error)
      return nil
    }
  }
}
