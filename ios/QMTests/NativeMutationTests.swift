import XCTest
import os

@testable import QM

final class NativeMutationProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var changed = false
    var reloadStarted = false
    var authorizationStarted = false
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let mutation = request.httpMethod != "GET"
    let delayed = Self.state.withLock { state in
      if request.url!.path.hasSuffix("/start") {
        state.authorizationStarted = true
        return true
      }
      if mutation { state.changed = true }
      let delayed = state.changed && !mutation
      if delayed { state.reloadStarted = true }
      return delayed
    }
    let body =
      request.url!.path.hasSuffix("/start")
      ? #"{"authorizeUrl":"https://accounts.example/authorize"}"#
      : request.url!.path == "/api/skills"
        ? #"{"skills":[]}"# : request.url!.path == "/api/contexts" ? #"{"contexts":[]}"# : "{}"
    let finish: @Sendable () -> Void = { [self] in
      client?.urlProtocol(
        self,
        didReceive: HTTPURLResponse(
          url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
    if delayed {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.15, execute: finish)
    } else {
      finish()
    }
  }
  override func stopLoading() {}
}

@MainActor
final class NativeMutationTests: XCTestCase {
  func testSkillEditorRemainsLockedThroughPostSaveRefresh() async throws {
    NativeMutationProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeMutationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://mutation.example")!, configuration: configuration)
    let model = SkillsModel(client: client, user: "alice")
    let save = Task {
      await model.mutate(path: "api/skills/s1", method: "PUT", body: ["body": "Changed"])
    }
    for _ in 0..<100 {
      if NativeMutationProtocol.state.withLock({ $0.reloadStarted }) { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(NativeMutationProtocol.state.withLock { $0.reloadStarted })
    XCTAssertTrue(model.busy)
    let duplicate = await model.mutate(path: "api/skills/s1", method: "PUT")
    XCTAssertFalse(duplicate)
    let saved = await save.value
    XCTAssertTrue(saved)
    XCTAssertFalse(model.busy)
  }

  func testDismissedConnectorIgnoresDelayedAuthorizationResponse() async throws {
    NativeMutationProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeMutationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://mutation.example")!, configuration: configuration)
    let model = KeychainModel(client: client)
    let connect = Task { await model.connect("google") }
    for _ in 0..<100 {
      if NativeMutationProtocol.state.withLock({ $0.authorizationStarted }) { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    model.cancel()
    await connect.value
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testCredentialDropRedemptionRejectsUntrustedDestinations() throws {
    let base = URL(string: "https://qm.example")!
    let target = try NativeCredentialCreation.redemption(
      "https://qm.example/drop/id-123/form?t=one-time", base: base)
    XCTAssertEqual(target.path, "drop/id-123")
    XCTAssertEqual(target.query, [.init(name: "t", value: "one-time")])
    for url in [
      "https://evil.example/drop/id/form?t=secret", "https://qm.example/api/other?t=secret",
      "https://qm.example/drop/id/form?t=one&t=two",
      "https://user@qm.example/drop/id/form?t=secret", "https://qm.example/drop/id/form?t=secret#x",
    ] {
      XCTAssertThrowsError(try NativeCredentialCreation.redemption(url, base: base))
    }
  }
}
