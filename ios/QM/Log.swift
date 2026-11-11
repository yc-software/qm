import Foundation
import os

enum Log {
  static let background = Logger(subsystem: "org.qm", category: "background")
  static let drafts = Logger(subsystem: "org.qm", category: "drafts")
  static let decoding = Logger(subsystem: "org.qm", category: "decoding")
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

  func lossy<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
    logged(LossyList<T>.self, forKey: key)?.values
  }
}

struct LossyList<T: Decodable>: Decodable {
  let values: [T]

  private struct Skip: Decodable {
    init(from decoder: Decoder) throws {}
  }

  init(from decoder: Decoder) throws {
    var container = try decoder.unkeyedContainer()
    var values: [T] = []
    while !container.isAtEnd {
      do {
        values.append(try container.decode(T.self))
      } catch {
        Log.decoding.failure("Decoding \(T.self) element", error)
        _ = try? container.decode(Skip.self)
      }
    }
    self.values = values
  }
}

extension DecodingError {
  var summary: String {
    func path(_ context: Context) -> String {
      let parts = context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }
      return parts.isEmpty ? "the top level" : parts.joined(separator: ".")
    }
    switch self {
    case .keyNotFound(let key, let context):
      return "missing \"\(key.stringValue)\" at \(path(context))"
    case .valueNotFound(_, let context):
      return "null \(path(context))"
    case .typeMismatch(let type, let context):
      return "\(path(context)) is not \(type)"
    case .dataCorrupted(let context):
      return "unreadable data at \(path(context))"
    @unknown default:
      return String(describing: self)
    }
  }
}
