import XCTest

@testable import QM

@MainActor
final class ConnectionAuthorizationTests: XCTestCase {
  let base = URL(string: "https://qm.example")!
  let state = String(repeating: "s", count: 43)

  private func request(target: String = "/settings?slackReturn=original") throws
    -> ConnectionRequest
  {
    try ConnectionRequest(
      body: [
        "authorizeUrl": "https://connect.example/authorize?state=provider", "state": state,
        "returnTo": target,
      ],
      base: base)
  }

  private func callback(target: String, state: String? = nil) -> URL {
    var parts = URLComponents(string: "qm://connection/callback")!
    parts.queryItems = [
      .init(name: "state", value: state ?? self.state), .init(name: "returnTo", value: target),
    ]
    return parts.url!
  }

  func testValidCallbackPreservesOriginalContextAndVerifiedOutcomeFields() throws {
    let result = try request().result(
      callback(target: "/settings?slackReturn=original&status=success&connectedAccountId=ca_test"))
    let target = URLComponents(string: result)!
    XCTAssertEqual(target.path, "/settings")
    XCTAssertEqual(target.queryItems?.first { $0.name == "slackReturn" }?.value, "original")
    XCTAssertEqual(target.queryItems?.first { $0.name == "connectedAccountId" }?.value, "ca_test")
    XCTAssertNoThrow(
      try request(target: "/keychain").result(
        callback(target: "/keychain?connector=google&status=connected")))
    XCTAssertNoThrow(
      try request().result(callback(target: "/settings?slackReturn=original&error=access_denied")))
  }

  func testCallbackCannotChangeAttemptDestinationOrContext() throws {
    let request = try request()
    XCTAssertThrowsError(
      try request.result(callback(target: "/settings?slackReturn=original", state: "different")))
    for target in [
      "https://evil.example/settings?slackReturn=original", "//evil.example/settings",
      "/auth/login",
      "/keychain?slackReturn=original", "/settings?slackReturn=changed", "/settings",
      "/settings?slackReturn=original&slackReturn=original",
      "/settings?slackReturn=original&code=credential",
      "/settings?slackReturn=original&status=a&status=b", "/settings?slackReturn=original#fragment",
      "/settings?slackReturn=original&error=" + String(repeating: "x", count: 513),
    ] {
      XCTAssertThrowsError(try request.result(callback(target: target)), target)
    }
    for raw in [
      "qm://auth/callback", "https://connection/callback", "qm://user@connection/callback",
      "qm://connection:443/callback",
    ] {
      XCTAssertThrowsError(try request.result(URL(string: raw)!))
    }
    let valid = callback(target: "/settings?slackReturn=original")
    XCTAssertThrowsError(try request.result(URL(string: valid.absoluteString + "&state=" + state)!))
  }

  func testInitiationRejectsUnsafeURLsAndUnsupportedReturnParameters() {
    for address in [
      "http://provider.example/auth", "file:///tmp/test", "https://secret@provider.example",
      "javascript:alert(1)",
    ] {
      XCTAssertThrowsError(
        try ConnectionRequest(
          body: ["authorizeUrl": address, "state": state, "returnTo": "/settings"], base: base))
    }
    for target in [
      "//evil.example", "/api/turn", "/settings?code=credential", "/settings?tab=a&tab=b",
      "/settings\\evil", "/settings#fragment",
    ] {
      XCTAssertThrowsError(try request(target: target))
    }
  }
}
