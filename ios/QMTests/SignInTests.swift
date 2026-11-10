import CryptoKit
import XCTest
import os

@testable import QM

final class SignInProtocol: URLProtocol, @unchecked Sendable {
  private struct Redemptions: Sendable {
    var arrived: Set<String> = []
    var held: [String: @Sendable () -> Void] = [:]
  }
  private static let redemptions = OSAllocatedUnfairLock(initialState: Redemptions())

  static func arrived(_ host: String) -> Bool {
    redemptions.withLock { $0.arrived.contains(host) }
  }

  static func release(_ host: String) {
    redemptions.withLock { $0.held.removeValue(forKey: host) }?()
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 1024)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
      }
    }
    let fields =
      URLComponents(string: "https://example.test/?" + String(decoding: data, as: UTF8.self))?
      .queryItems ?? []
    let code = fields.first { $0.name == "code" }?.value ?? ""
    let verifier = fields.first { $0.name == "verifier" }?.value ?? ""
    let state = fields.first { $0.name == "state" }?.value ?? ""
    let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    let valid =
      code == challenge + ":" + state + "+/&=" && verifier.count == 43
      && request.url?.path == "/auth/desktop/redeem" && request.httpMethod == "POST"
      && request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded"
      && request.value(forHTTPHeaderField: "Origin") == "https://\(request.url!.host!)"
      && request.value(forHTTPHeaderField: "Cookie") == nil
    let missingCookie = request.url!.host!.hasPrefix("missing")
    let malformed = request.url!.host!.hasPrefix("malformed")
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: request.url!.host!.hasPrefix("unauthorized") ? 401 : (valid ? 200 : 400),
      httpVersion: nil,
      headerFields: missingCookie
        ? [:]
        : [
          "Set-Cookie":
            "portal_session=test-session; Path=/; Secure; HttpOnly, portal_user=alice; Path=/; Secure, portal_impersonate=; Path=/; Max-Age=0"
        ])!
    let respond: @Sendable () -> Void = { [self] in
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data((malformed ? "{}" : "{\"ok\":\(valid)}").utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
    let host = request.url!.host!
    if host.hasPrefix("held") {
      Self.redemptions.withLock {
        $0.arrived.insert(host)
        $0.held[host] = respond
      }
    } else {
      DispatchQueue.global().async(execute: respond)
    }
  }
  override func stopLoading() {}
}

@MainActor
final class SignInTests: XCTestCase {
  private func client(_ prefix: String = "success") -> APIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SignInProtocol.self]
    return APIClient(
      baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
  }

  private func redemption(
    _ client: APIClient, file: StaticString = #filePath, line: UInt = #line
  ) async throws {
    for _ in 0..<500 {
      if SignInProtocol.arrived(client.baseURL.host!) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("The redemption request never arrived", file: file, line: line)
  }

  private func signIn(
    wrongState: Bool = false, scheme: String = "qm-desktop", duplicate: String? = nil
  ) -> SignIn {
    SignIn(
      authentication: WebAuthentication { url, completion in
        XCTAssertEqual(url.path, "/auth/desktop")
        let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        let challenge = fields.first { $0.name == "challenge" }!.value!
        let state = fields.first { $0.name == "state" }!.value!
        XCTAssertEqual(challenge.count, 43)
        XCTAssertEqual(state.count, 43)
        var callback = URLComponents(string: "\(scheme)://auth/callback")!
        callback.queryItems = [
          .init(name: "state", value: wrongState ? "wrong" : state),
          .init(name: "code", value: challenge + ":" + state + "+/&="),
        ]
        if let duplicate { callback.queryItems!.append(.init(name: duplicate, value: "duplicate")) }
        return .init(
          start: {
            completion(callback.url, nil)
            return true
          }, cancel: {})
      })
  }

  func testDesktopHandshakeVerifiesPKCEAndPersistsSession() async throws {
    let client = client()
    defer { client.signOut() }
    try await signIn().authenticate(client: client)
    XCTAssertEqual(client.vault.read(), "test-session")
    XCTAssertTrue(client.hasSession)
  }

  func testWrongStateAndSchemeCannotCreateSession() async {
    for signIn in [
      signIn(wrongState: true), signIn(scheme: "qm"), signIn(duplicate: "state"),
      signIn(duplicate: "code"),
    ] {
      let client = client()
      do {
        try await signIn.authenticate(client: client)
        XCTFail("Invalid callback succeeded")
      } catch {}
      XCTAssertFalse(client.hasSession)
      XCTAssertNil(client.vault.read())
    }
  }

  func testMissingCookieAndMalformedResponseCannotCreateSession() async {
    for prefix in ["missing", "malformed"] {
      let client = client(prefix)
      do {
        try await signIn().authenticate(client: client)
        XCTFail("Invalid exchange succeeded")
      } catch {}
      XCTAssertFalse(client.hasSession)
      XCTAssertNil(client.vault.read())
    }
  }

  func testFailedRedemptionCannotClearAnotherSession() async throws {
    let client = client("unauthorized")
    defer { client.signOut() }
    try client.saveSession("existing-session")
    do {
      try await signIn().authenticate(client: client)
      XCTFail("Unauthorized exchange succeeded")
    } catch {}
    XCTAssertEqual(client.vault.read(), "existing-session")
    XCTAssertTrue(client.hasSession)
  }

  func testCancelDuringRedemptionCannotPersistSession() async throws {
    let client = client("held")
    let signIn = signIn()
    let task = Task { try await signIn.authenticate(client: client) }
    try await redemption(client)
    signIn.cancel()
    SignInProtocol.release(client.baseURL.host!)
    do {
      try await task.value
      XCTFail("Cancelled exchange succeeded")
    } catch is CancellationError {}
    XCTAssertFalse(client.hasSession)
    XCTAssertNil(client.vault.read())
  }

  func testSignOutDuringRedemptionCannotPersistSession() async throws {
    let client = client("held")
    let signIn = signIn()
    let task = Task { try await signIn.authenticate(client: client) }
    try await redemption(client)
    client.signOut()
    SignInProtocol.release(client.baseURL.host!)
    do {
      try await task.value
      XCTFail("Signed-out exchange succeeded")
    } catch is CancellationError {}
    XCTAssertFalse(client.hasSession)
    XCTAssertNil(client.vault.read())
  }
}
