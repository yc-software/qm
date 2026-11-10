import XCTest
import os

@testable import QM

final class ForegroundSyncProtocol: URLProtocol, @unchecked Sendable {
  static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let held = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let stopped = OSAllocatedUnfairLock(initialState: [String: Int]())
  private let holding = OSAllocatedUnfairLock(initialState: false)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let key = request.url!.absoluteString
    let count = Self.counts.withLock { values in
      values[key, default: 0] += 1
      return values[key]!
    }
    if Self.held.withLock({ $0[key] == count }) {
      holding.withLock { $0 = true }
      return
    }
    let body: String
    switch request.url!.path {
    case "/me":
      body = #"{"user":"test"}"#
    case "/api/sessions":
      body =
        count == 1
        ? #"{"sessions":[{"id":"one","scopeId":"personal:test","threadRef":"web:test:one","surface":"web","canContinue":true,"working":true}]}"#
        : #"{"sessions":[{"id":"one","scopeId":"personal:test","threadRef":"web:test:one","surface":"web","canContinue":true,"working":false,"awaitingInput":true},{"id":"two","scopeId":"personal:test","threadRef":"web:test:two","surface":"web","canContinue":true}]}"#
    case "/api/runs/active":
      body = #"{"runId":null}"#
    case let path where path.hasSuffix("/approvals"):
      body = #"{"approvals":[]}"#
    default:
      body =
        "{\"items\":[{\"kind\":\"UserMessage\",\"seq\":\(count),\"createdAt\":\(count),\"text\":\"Update \(count)\",\"body\":{}}]}"
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {
    guard holding.withLock({ $0 }) else { return }
    let key = request.url!.absoluteString
    Self.stopped.withLock { $0[key, default: 0] += 1 }
  }
}

@MainActor
final class ForegroundSyncTests: XCTestCase {
  private func configuration() -> URLSessionConfiguration {
    let result = URLSessionConfiguration.ephemeral
    result.protocolClasses = [ForegroundSyncProtocol.self]
    return result
  }

  private func eventually(
    _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line
  ) async throws {
    for _ in 0..<500 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("The expected state was never reached", file: file, line: line)
  }

  func testVisibleHistoryReceivesNewConversationsAndApprovalStateAndStopsWhenCancelled()
    async throws
  {
    let suite = UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(
      defaults: defaults, configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration())
    let client = try XCTUnwrap(model.client)
    try client.saveSession("test")
    defer { model.signOut() }
    let key = client.url("api/sessions").absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 3 }
    let watch = Task { await model.watchConversations(interval: .milliseconds(20)) }
    try await eventually { model.conversations.count == 2 }
    XCTAssertEqual(model.conversations.count, 2)
    XCTAssertEqual(model.conversations.first { $0.id == "one" }?.working, false)
    XCTAssertEqual(model.conversations.first { $0.id == "one" }?.awaitingInput, true)
    let identityKey = client.url("me").absoluteString
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[identityKey] }, 1)
    try await eventually { ForegroundSyncProtocol.counts.withLock { $0[key] } == 3 }
    watch.cancel()
    try await eventually { ForegroundSyncProtocol.stopped.withLock { $0[key] } == 1 }
    await watch.value
    XCTAssertEqual(model.conversations.count, 2)
  }

  func testReadOnlyTranscriptReceivesNewMessagesUntilPaused() async throws {
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example")!, configuration: configuration())
    try client.saveSession("test")
    defer { client.signOut() }
    let chat = ChatModel(
      conversation: Conversation(
        id: "slack", scopeId: "personal:test", threadRef: "slack:channel:thread"),
      client: client, user: "test", knownSession: true)
    let key = client.url("api/sessions/slack", query: [.init(name: "tailTurns", value: "25")])
      .absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 3 }
    await chat.resume(refreshInterval: .milliseconds(20))
    try await eventually { (chat.items.last?.seq ?? 0) >= 2 }
    XCTAssertEqual(chat.items.last?.seq, 2)
    try await eventually { ForegroundSyncProtocol.counts.withLock { $0[key] } == 3 }
    chat.pause()
    try await eventually { ForegroundSyncProtocol.stopped.withLock { $0[key] } == 1 }
    XCTAssertEqual(chat.items.last?.seq, 2)
  }
  func testSeededDestinationDoesNotDownloadHistoryOrSessionListAgain() async throws {
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example")!, configuration: configuration())
    try client.saveSession("test")
    defer { client.signOut() }
    let transcript = try JSONDecoder().decode(
      Transcript.self,
      from: Data(
        #"{"items":[{"kind":"UserMessage","seq":1,"createdAt":1,"text":"Loaded directly","body":{}}],"earlierItems":12}"#
          .utf8))
    let chat = ChatModel(
      conversation: Conversation(
        id: "direct", scopeId: "personal:test", threadRef: "web:test:direct", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true, transcript: transcript)
    await chat.resume()
    chat.pause()
    XCTAssertEqual(chat.items.first?.text, "Loaded directly")
    XCTAssertEqual(chat.earlierItems, 12)
    XCTAssertTrue(chat.hasLoadedTranscript)
    let base = client.baseURL.absoluteString
    let requests = ForegroundSyncProtocol.counts.withLock { $0.filter { $0.key.hasPrefix(base) } }
    XCTAssertEqual(requests.count, 2)
    XCTAssertFalse(
      requests.keys.contains { $0.contains("tailTurns") || $0.hasSuffix("api/sessions") })
  }

}
