import XCTest
import os

@testable import QM

final class NativePeopleSearchProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var pending: [String: NativePeopleSearchProtocol] = [:]
    var onRequest: (@Sendable (String) -> Void)?
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  private let stopped = OSAllocatedUnfairLock(initialState: false)

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let query =
      URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "q" }?.value ?? ""
    let onRequest = Self.state.withLock { state in
      state.pending[query] = self
      return state.onRequest
    }
    onRequest?(query)
  }

  static func respond(to query: String, body: String, status: Int = 200) {
    let pending = state.withLock { $0.pending.removeValue(forKey: query) }
    pending?.respond(body: body, status: status)
  }

  private func respond(body: String, status: Int) {
    guard !stopped.withLock({ $0 }) else { return }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() { stopped.withLock { $0 = true } }
}

@MainActor
final class NativePeopleSearchTests: XCTestCase {
  private func model() -> NativePeopleSearchModel {
    NativePeopleSearchProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativePeopleSearchProtocol.self]
    return NativePeopleSearchModel(
      client: APIClient(
        baseURL: URL(string: "https://people.example")!, configuration: configuration))
  }

  func testSupersededResponseCannotClearTheNewSearchPendingState() async {
    let model = model()
    let first = expectation(description: "First directory query")
    let second = expectation(description: "Second directory query")
    NativePeopleSearchProtocol.state.withLock {
      $0.onRequest = { query in
        if query == "First" { first.fulfill() }
        if query == "Second" { second.fulfill() }
      }
    }
    model.query = "First"
    let oldSearch = Task { await model.search() }
    await fulfillment(of: [first], timeout: 2)
    model.query = "Second"
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    let newSearch = Task { await model.search() }
    await fulfillment(of: [second], timeout: 2)

    NativePeopleSearchProtocol.respond(
      to: "First",
      body: #"{"matches":[{"principalId":"first","displayName":"First","type":"internal"}]}"#)
    await oldSearch.value
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertTrue(model.matches.isEmpty)

    NativePeopleSearchProtocol.respond(
      to: "Second",
      body: #"{"matches":[{"principalId":"second","displayName":"Second","type":"internal"}]}"#)
    await newSearch.value
    XCTAssertFalse(model.searching)
    XCTAssertTrue(model.completed)
    XCTAssertEqual(model.matches.map(\.id), ["second"])
    XCTAssertNil(model.error)
  }

  func testTaskCancellationDoesNotPresentAnEmptyResult() async {
    let model = model()
    let pending = expectation(description: "Pending directory query")
    NativePeopleSearchProtocol.state.withLock { $0.onRequest = { _ in pending.fulfill() } }
    model.query = "Pending"
    let search = Task { await model.search() }
    await fulfillment(of: [pending], timeout: 2)
    search.cancel()
    await search.value
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertNil(model.error)
  }

  func testClearingQueryDropsDelayedFailure() async {
    let model = model()
    let pending = expectation(description: "Pending directory query")
    NativePeopleSearchProtocol.state.withLock { $0.onRequest = { _ in pending.fulfill() } }
    model.query = "Pending"
    let search = Task { await model.search() }
    await fulfillment(of: [pending], timeout: 2)
    model.query = ""
    XCTAssertFalse(model.searching)
    NativePeopleSearchProtocol.respond(
      to: "Pending", body: #"{"message":"Directory unavailable"}"#, status: 503)
    await search.value
    XCTAssertNil(model.error)
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertTrue(model.matches.isEmpty)
  }

  func testFailedSearchCanRetryAndOnlyCompletedResponseIsEmpty() async {
    let model = model()
    let failed = expectation(description: "Failed directory query")
    NativePeopleSearchProtocol.state.withLock { $0.onRequest = { _ in failed.fulfill() } }
    model.query = "Missing"
    let search = Task { await model.search() }
    await fulfillment(of: [failed], timeout: 2)
    NativePeopleSearchProtocol.respond(
      to: "Missing", body: #"{"message":"Directory unavailable"}"#, status: 503)
    await search.value
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertEqual(model.error, "Directory unavailable")

    let retried = expectation(description: "Retried directory query")
    NativePeopleSearchProtocol.state.withLock { $0.onRequest = { _ in retried.fulfill() } }
    let retry = Task { await model.search() }
    await fulfillment(of: [retried], timeout: 2)
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertNil(model.error)
    NativePeopleSearchProtocol.respond(to: "Missing", body: #"{"matches":[]}"#)
    await retry.value
    XCTAssertFalse(model.searching)
    XCTAssertTrue(model.completed)
    XCTAssertTrue(model.matches.isEmpty)
    XCTAssertNil(model.error)
  }
}
