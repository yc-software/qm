import XCTest

@testable import QM

final class LateResponseProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Set-Cookie": "portal_session=late-renewal; Path=/; HttpOnly"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(#"{"user":"alice"}"#.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}
}

final class ClientTests: XCTestCase {
  func testServerActionMessagesAreShownWithoutRenderingRawErrorBodies() {
    XCTAssertEqual(
      APIClient.errorMessage(
        status: 403,
        data: Data(#"{"message":"Ask your administrator to enable app connections."}"#.utf8)),
      "Ask your administrator to enable app connections.")
    XCTAssertEqual(
      APIClient.errorMessage(status: 403, data: Data("<html>Proxy error</html>".utf8)),
      "You don’t have access to this action or feature.")
    XCTAssertFalse(APIClient.errorMessage(status: 404, data: nil).contains("message and try"))
  }

  @MainActor
  func testLateResponseCannotRestoreSignedOutSession() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LateResponseProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("initial-session")
    let pending = Task {
      let identity: Identity = try await client.fetch("me")
      return identity
    }
    try await Task.sleep(for: .milliseconds(20))
    client.signOut()
    do {
      _ = try await pending.value
      XCTFail("A signed-out request must not return identity")
    } catch is CancellationError {}
    XCTAssertFalse(client.hasSession)
    XCTAssertNil(client.vault.read())
  }
}
