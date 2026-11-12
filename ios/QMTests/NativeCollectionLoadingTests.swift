import XCTest
import os

@testable import QM

final class NativeCollectionLoadingProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var failing = false
    var started: XCTestExpectation?
    var pending: NativeCollectionLoadingProtocol?
  }
  static let state = OSAllocatedUnfairLock(initialState: State())

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let started = Self.state.withLock { state in
      if state.started != nil { state.pending = self }
      return state.started
    }
    if let started {
      started.fulfill()
    } else {
      finish()
    }
  }

  func finish() {
    if Self.state.withLock({ $0.failing }) {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
    let body = #"{"selected":[],"available":[],"items":[],"total":0,"filter":"human"}"#
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {
    Self.state.withLock { state in
      if state.pending === self { state.pending = nil }
    }
  }
}

@MainActor
final class NativeCollectionLoadingTests: XCTestCase {
  private func client() -> APIClient {
    NativeCollectionLoadingProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeCollectionLoadingProtocol.self]
    return APIClient(
      baseURL: URL(string: "https://collection-loading.example.test")!,
      configuration: configuration)
  }

  private func holdNextRequest() -> XCTestExpectation {
    let started = expectation(description: "Collection request started")
    NativeCollectionLoadingProtocol.state.withLock { $0.started = started }
    return started
  }

  private func finishRequest() {
    let pending = NativeCollectionLoadingProtocol.state.withLock { state in
      let pending = state.pending
      state.pending = nil
      state.started = nil
      return pending
    }
    XCTAssertNotNil(pending)
    pending?.finish()
  }

  func testEmptyInboxRemainsLoadedDuringRefreshAndAfterFailure() async {
    let model = InboxModel(client: client())
    await model.load(view: "open", loop: "all")
    XCTAssertTrue(model.loaded)
    XCTAssertTrue(model.items.isEmpty)
    XCTAssertTrue(model.showsEmptyState(view: "open", loop: "all"))

    let started = holdNextRequest()
    let refresh = Task { await model.load(view: "open", loop: "all") }
    await fulfillment(of: [started], timeout: 2)

    XCTAssertTrue(model.loading)
    XCTAssertTrue(model.loaded)
    XCTAssertTrue(model.items.isEmpty)
    XCTAssertTrue(model.showsEmptyState(view: "open", loop: "all"))
    NativeCollectionLoadingProtocol.state.withLock { $0.failing = true }
    finishRequest()
    await refresh.value

    XCTAssertFalse(model.loading)
    XCTAssertTrue(model.loaded)
    XCTAssertTrue(model.items.isEmpty)
    XCTAssertNotNil(model.error)
    XCTAssertFalse(model.showsEmptyState(view: "open", loop: "all"))
  }

  func testInboxEmptyStateWaitsForSelectedStatusAndSource() async {
    let model = InboxModel(client: client())
    await model.load(view: "open", loop: "all")
    XCTAssertTrue(model.showsEmptyState(view: "open", loop: "all"))

    for filter in [(view: "handled", loop: "all"), (view: "handled", loop: "source1")] {
      XCTAssertFalse(model.showsEmptyState(view: filter.view, loop: filter.loop))

      let started = holdNextRequest()
      let load = Task { await model.load(view: filter.view, loop: filter.loop) }
      await fulfillment(of: [started], timeout: 2)

      XCTAssertTrue(model.loading)
      XCTAssertTrue(model.loaded)
      XCTAssertTrue(model.items.isEmpty)
      XCTAssertFalse(model.showsEmptyState(view: filter.view, loop: filter.loop))

      finishRequest()
      await load.value

      XCTAssertFalse(model.loading)
      XCTAssertTrue(model.showsEmptyState(view: filter.view, loop: filter.loop))
      XCTAssertFalse(model.showsEmptyState(view: "open", loop: "all"))
    }
  }

  func testFailedInitialInboxLoadOnlyCompletesAfterSuccessfulRetry() async {
    let model = InboxModel(client: client())
    NativeCollectionLoadingProtocol.state.withLock { $0.failing = true }
    await model.load(view: "open", loop: "all")

    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.loaded)
    XCTAssertNotNil(model.error)

    NativeCollectionLoadingProtocol.state.withLock { $0.failing = false }
    await model.load(view: "open", loop: "all")

    XCTAssertFalse(model.loading)
    XCTAssertTrue(model.loaded)
    XCTAssertTrue(model.items.isEmpty)
    XCTAssertNil(model.error)
  }

  func testCancelledInitialInboxLoadDoesNotBecomeLoadedOrFailed() async {
    let model = InboxModel(client: client())
    let started = holdNextRequest()
    let load = Task { await model.load(view: "open", loop: "all") }
    await fulfillment(of: [started], timeout: 2)
    XCTAssertTrue(model.loading)

    load.cancel()
    await load.value

    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.loaded)
    XCTAssertNil(model.error)
    XCTAssertTrue(model.items.isEmpty)
  }
}
