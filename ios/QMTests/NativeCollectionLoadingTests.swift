import XCTest
import os

@testable import QM

@MainActor
final class NativeCollectionLoadingTests: XCTestCase {
  private let server = NativeRouteProtocol.Server(
    fallback: .init(
      body:
        #"{"selected":[],"available":[],"items":[],"total":0,"filter":"human"}"#))
  private let route = "GET /api/inbox"
  private func client() -> APIClient { server.client() }

  private func holdNextRequest() -> XCTestExpectation {
    let started = expectation(description: "Collection request started")
    server.hold(route)
    server.state.withLock { $0.onCall = { _ in started.fulfill() } }
    return started
  }

  private func finishRequest() {
    XCTAssertTrue(server.isHeld(route))
    server.state.withLock { $0.onCall = nil }
    server.release(route)
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
    server.state.withLock { $0.fallback.failure = .notConnectedToInternet }
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
    server.state.withLock { $0.fallback.failure = .notConnectedToInternet }
    await model.load(view: "open", loop: "all")

    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.loaded)
    XCTAssertNotNil(model.error)

    server.state.withLock { $0.fallback.failure = nil }
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
