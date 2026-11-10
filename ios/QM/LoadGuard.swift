import Foundation

@MainActor @Observable
final class LoadGuard {
  var loading = false
  private(set) var revision = UUID()

  func cancel() {
    revision = UUID()
    loading = false
  }

  @discardableResult
  func run<Value>(
    restart: Bool = true, _ fetch: () async throws -> Value, apply: (Value) throws -> Void,
    failed: (any Error) -> Void
  ) async -> Bool {
    if restart { revision = UUID() }
    let current = revision
    loading = true
    defer { if revision == current { loading = false } }
    do {
      let value = try await fetch()
      try Task.checkCancellation()
      guard revision == current else { return false }
      try apply(value)
      return true
    } catch {
      if revision == current && !Task.isCancelled { failed(error) }
      return false
    }
  }
}
