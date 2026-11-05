import XCTest

@testable import QM

@MainActor
final class WebAuthenticationTests: XCTestCase {
  private let provider = URL(string: "https://provider.example/authorize")!
  private let callback = URL(string: "qm://auth/callback?code=test")!

  func testExplicitCancelCompletesWithoutBrowserCallbackAndIgnoresLateCallback() async throws {
    let started = expectation(description: "Browser started")
    var completion: WebAuthentication.Completion?
    var cancellations = 0
    let authentication = WebAuthentication { _, reply in
      completion = reply
      return .init(
        start: {
          started.fulfill()
          return true
        }, cancel: { cancellations += 1 })
    }
    let attempt = Task { try await authentication.open(provider) }
    await fulfillment(of: [started], timeout: 2)
    authentication.cancel()
    do {
      _ = try await attempt.value
      XCTFail("Cancelled authorization succeeded")
    } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
    XCTAssertEqual(cancellations, 1)
    completion?(callback, nil)
    authentication.cancel()
    await Task.yield()
    XCTAssertEqual(cancellations, 1)
  }

  func testStartFailureAndLateCallbackDoNotSettleNextAttempt() async throws {
    var callbacks: [WebAuthentication.Completion] = []
    let secondStarted = expectation(description: "Second browser started")
    let authentication = WebAuthentication { _, reply in
      callbacks.append(reply)
      let index = callbacks.count
      return .init(
        start: {
          if index == 2 { secondStarted.fulfill() }
          return index == 2
        }, cancel: {})
    }
    do {
      _ = try await authentication.open(provider)
      XCTFail("Failed start succeeded")
    } catch {}
    let second = Task { try await authentication.open(provider) }
    await fulfillment(of: [secondStarted], timeout: 2)
    callbacks[0](nil, CancellationError())
    let expected = URL(string: "qm://auth/callback?code=second")!
    callbacks[1](expected, nil)
    let result = try await second.value
    XCTAssertEqual(result, expected)
    callbacks[1](callback, nil)
    await Task.yield()
  }

  func testTaskCancellationDismissesBrowserAndCompletesWithoutCallback() async {
    let started = expectation(description: "Browser started")
    var cancellations = 0
    let authentication = WebAuthentication { _, _ in
      .init(
        start: {
          started.fulfill()
          return true
        }, cancel: { cancellations += 1 })
    }
    let attempt = Task { try await authentication.open(provider) }
    await fulfillment(of: [started], timeout: 2)
    attempt.cancel()
    do {
      _ = try await attempt.value
      XCTFail("Cancelled task succeeded")
    } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
    XCTAssertEqual(cancellations, 1)
  }
}
