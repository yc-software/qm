import SwiftUI
import XCTest
import os

@testable import QM

final class ForegroundSyncProtocol: URLProtocol, @unchecked Sendable {
  static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let held = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let stopped = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let statusCodes = OSAllocatedUnfairLock(initialState: [String: [Int: Int]]())
  static let pending = OSAllocatedUnfairLock(
    initialState: [String: [Int: ForegroundSyncProtocol]]())
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
      Self.pending.withLock { $0[key, default: [:]][count] = self }
      return
    }
    finish(count: count)
  }
  static func release(_ key: String, count: Int) {
    let request = pending.withLock { $0[key]?.removeValue(forKey: count) }
    request?.finish(count: count)
  }
  private func finish(count: Int) {
    let body: String
    switch request.url!.path {
    case "/me":
      body = #"{"user":"test"}"#
    case "/api/contexts":
      body = #"{"contexts":[]}"#
    case "/api/sessions":
      body =
        count == 1
        ? #"{"sessions":[{"id":"one","scopeId":"personal:test","threadRef":"web:test:one","surface":"web","canContinue":true,"working":true}]}"#
        : #"{"sessions":[{"id":"one","scopeId":"personal:test","threadRef":"web:test:one","surface":"web","canContinue":true,"working":false,"awaitingInput":true},{"id":"two","scopeId":"personal:test","threadRef":"web:test:two","surface":"web","canContinue":true}]}"#
    case "/api/runs/active":
      body = #"{"runId":null}"#
    case let path where path.hasSuffix("/approvals"):
      body = #"{"approvals":[]}"#
    case let path where path.hasPrefix("/api/sessions/") && request.httpMethod == "POST":
      body =
        #"{"session":{"id":"one","scopeId":"personal:test","threadRef":"web:test:one","surface":"web"}}"#
    default:
      body =
        "{\"items\":[{\"kind\":\"UserMessage\",\"seq\":\(count),\"createdAt\":\(count),\"text\":\"Update \(count)\",\"body\":{}}]}"
    }
    let status = Self.statusCodes.withLock { $0[request.url!.absoluteString]?[count] ?? 200 }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {
    guard holding.withLock({ $0 }) else { return }
    let key = request.url!.absoluteString
    Self.pending.withLock { requests in
      requests[key] = requests[key]?.filter { $0.value !== self }
    }
    Self.stopped.withLock { $0[key, default: 0] += 1 }
  }
}

@MainActor
final class ForegroundSyncTests: XCTestCase {
  private struct ForegroundRoot: View {
    let model: AppModel
    var phase: ScenePhase

    var body: some View {
      RootView(model: model).environment(\.scenePhase, phase)
    }
  }

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

  private func withRoot(
    _ model: AppModel,
    _ action: (UIHostingController<ForegroundRoot>) async throws -> Void
  ) async throws {
    let controller = UIHostingController(rootView: ForegroundRoot(model: model, phase: .active))
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousWindow = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previousWindow?.makeKey()
    }
    controller.view.layoutIfNeeded()
    try await action(controller)
  }

  private func capture(_ controller: UIViewController, named name: String) {
    controller.view.layoutIfNeeded()
    let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
      controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testSavedSessionRecoversOnForegroundAfterWorkspaceConnectionFails() async throws {
    let suite = UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(
      defaults: defaults, configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration())
    let client = try XCTUnwrap(model.client)
    try client.saveSession("test")
    defer { model.signOut() }
    let identityKey = client.url("me").absoluteString
    ForegroundSyncProtocol.statusCodes.withLock { $0[identityKey] = [1: 503] }

    try await withRoot(model) { controller in
      try await self.eventually { model.error != nil && !model.loading }
      XCTAssertTrue(client.hasSession)
      XCTAssertNil(model.identity)
      XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[identityKey] }, 1)
      self.capture(controller, named: "Saved sign-in during workspace interruption")

      controller.rootView.phase = .background
      try await Task.sleep(for: .milliseconds(100))
      controller.rootView.phase = .active

      try await self.eventually { model.hasLoadedConversations }
      XCTAssertEqual(model.identity?.user, "test")
      XCTAssertFalse(model.conversations.isEmpty)
      XCTAssertNil(model.error)
      XCTAssertTrue(client.hasSession)
      XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[identityKey] }, 2)
      self.capture(controller, named: "Workspace recovered without signing in again")
    }
  }

  func testExpiredSavedSessionStopsReconnecting() async throws {
    let suite = UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(
      defaults: defaults, configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration())
    let client = try XCTUnwrap(model.client)
    try client.saveSession("test")
    defer { model.signOut() }
    let identityKey = client.url("me").absoluteString
    ForegroundSyncProtocol.statusCodes.withLock { $0[identityKey] = [1: 401] }

    try await withRoot(model) { controller in
      try await self.eventually { !client.hasSession && !model.loading }
      XCTAssertNil(model.identity)
      XCTAssertTrue(model.conversations.isEmpty)

      controller.rootView.phase = .background
      try await Task.sleep(for: .milliseconds(100))
      controller.rootView.phase = .active
      try await Task.sleep(for: .milliseconds(100))

      XCTAssertFalse(client.hasSession)
      XCTAssertNil(model.identity)
      XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[identityKey] }, 1)
    }
  }

  func testConversationPlaceholdersOnlyCoverInitialLoadAndResetWithWorkspace() async throws {
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
    ForegroundSyncProtocol.held.withLock { $0[key] = 1 }
    let first = Task { await model.load() }
    defer { first.cancel() }
    try await eventually {
      model.identity != nil && model.showingInitialConversationLoad
        && ForegroundSyncProtocol.pending.withLock { $0[key]?[1] != nil }
    }
    XCTAssertFalse(model.hasLoadedConversations)
    first.cancel()
    await first.value
    XCTAssertFalse(model.showingInitialConversationLoad)

    await model.load()
    XCTAssertTrue(model.hasLoadedConversations)
    model.conversations = []
    ForegroundSyncProtocol.held.withLock { $0[key] = 3 }
    let refresh = Task { await model.load(refreshIdentity: false) }
    defer { refresh.cancel() }
    try await eventually { ForegroundSyncProtocol.pending.withLock { $0[key]?[3] != nil } }
    XCTAssertTrue(model.loading)
    XCTAssertFalse(model.showingInitialConversationLoad)
    refresh.cancel()
    await refresh.value
    XCTAssertTrue(model.hasLoadedConversations)

    try model.selectWorkspace("https://\(UUID().uuidString).example")
    XCTAssertFalse(model.hasLoadedConversations)
    XCTAssertFalse(model.showingInitialConversationLoad)
  }

  func testFailedInitialLoadKeepsErrorVisibleDuringQuietPoll() async throws {
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
    ForegroundSyncProtocol.statusCodes.withLock { $0[key] = [1: 503] }

    await model.load()
    let error = try XCTUnwrap(model.error)
    XCTAssertNotNil(model.identity)
    XCTAssertTrue(model.conversations.isEmpty)
    XCTAssertFalse(model.hasLoadedConversations)

    ForegroundSyncProtocol.held.withLock { $0[key] = 2 }
    let watch = Task { await model.watchConversations() }
    defer { watch.cancel() }
    try await eventually { ForegroundSyncProtocol.pending.withLock { $0[key]?[2] != nil } }
    XCTAssertTrue(model.loading)
    XCTAssertFalse(model.showingInitialConversationLoad)
    XCTAssertEqual(model.error, error)
    watch.cancel()
    await watch.value
    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.hasLoadedConversations)
    XCTAssertEqual(model.error, error)
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
        #"{"items":[{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Loaded directly","body":{"speakerId":"alice"}}],"earlierItems":12}"#
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
