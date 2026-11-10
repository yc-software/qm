import XCTest
import os

@testable import QM

final class ConnectedAppsProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var cursors: [String] = []
    var heldCursor: String?
    var pending: ConnectedAppsProtocol?
    var onHold: (@Sendable () -> Void)?
    var repeatsCursor = false
    var failsPage = false
    var authorizationRequests = 0
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  private let stopped = OSAllocatedUnfairLock(initialState: false)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  private var cursor: String {
    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
      $0.name == "cursor"
    }?.value ?? ""
  }
  override func startLoading() {
    let held = Self.state.withLock { state in
      if request.url!.path == "/api/composio/authorize" { state.authorizationRequests += 1 }
      guard request.url!.path == "/api/composio/toolkits" else { return false }
      state.cursors.append(cursor)
      guard state.heldCursor == cursor else { return false }
      state.pending = self
      return true
    }
    if held {
      Self.state.withLock { $0.onHold }?()
    } else {
      respond()
    }
  }
  static func release() {
    let pending = state.withLock { state in
      let pending = state.pending
      state.pending = nil
      state.heldCursor = nil
      return pending
    }
    pending?.respond()
  }
  private func respond() {
    guard !stopped.withLock({ $0 }) else { return }
    let snapshot = Self.state.withLock { $0 }
    let github = #"{"id":"github","name":"GitHub","description":"Repositories"}"#
    let linear = #"{"id":"linear","name":"Linear","description":"Project planning"}"#
    let calendar = #"{"id":"calendar","name":"Calendar","description":"Meetings"}"#
    let body: String
    var status = 200
    if request.url!.path == "/api/composio/authorize" {
      status = 503
      body = #"{"message":"Connection unavailable"}"#
    } else if request.url!.path == "/api/composio/connections" {
      body = #"{"items":[]}"#
    } else if cursor.isEmpty {
      body = "{\"items\":[\(github)],\"nextCursor\":\"page2\"}"
    } else if cursor == "page2" && snapshot.failsPage {
      status = 503
      body = #"{"error":"Catalog unavailable"}"#
    } else if cursor == "page2" {
      let next = snapshot.repeatsCursor ? "page2" : "page3"
      body = "{\"items\":[\(github),\(linear)],\"nextCursor\":\"\(next)\"}"
    } else {
      body = "{\"items\":[\(calendar)]}"
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {
    stopped.withLock { $0 = true }
  }
}

@MainActor
final class NativeConnectedAppsTests: XCTestCase {
  private func model() -> ConnectedAppsModel {
    ConnectedAppsProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ConnectedAppsProtocol.self]
    return ConnectedAppsModel(
      client: APIClient(
        baseURL: URL(string: "https://connected-apps.example")!, configuration: configuration))
  }

  func testBrowsingLoadsOnlyTheFirstPage() async {
    let model = model()
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")
    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.cursors }, [""])
    XCTAssertFalse(model.busy)
  }

  func testSearchFindsLaterPagesAndDeduplicatesApps() async {
    let model = model()
    await model.search()
    model.query = "LINEAR"
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertEqual(model.toolkits.map(\.id), ["github", "linear", "calendar"])
    XCTAssertNil(model.nextCursor)
    XCTAssertNil(model.error)
    model.query = "planning"
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.cursors }, ["", "page2", "page3"])
  }

  func testSearchWaitsForTheInitialLoad() async {
    let model = model()
    let held = expectation(description: "Initial catalog request")
    ConnectedAppsProtocol.state.withLock {
      $0.heldCursor = ""
      $0.onHold = { held.fulfill() }
    }
    let initial = Task { await model.load() }
    await fulfillment(of: [held], timeout: 2)
    XCTAssertTrue(model.loading)
    XCTAssertFalse(model.loadingMore)
    model.query = "Linear"
    let search = Task { await model.search() }
    ConnectedAppsProtocol.release()
    let loaded = await initial.value
    await search.value
    XCTAssertTrue(loaded)
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.cursors }, ["", "page2", "page3"])
    XCTAssertFalse(model.busy)
  }

  func testCancelledSearchDoesNotApplyThePendingPageAndCanResume() async {
    let model = model()
    await model.search()
    let held = expectation(description: "Second catalog page")
    ConnectedAppsProtocol.state.withLock {
      $0.heldCursor = "page2"
      $0.onHold = { held.fulfill() }
    }
    model.query = "Linear"
    let search = Task { await model.search() }
    await fulfillment(of: [held], timeout: 2)
    XCTAssertTrue(model.busy)
    XCTAssertTrue(model.loadingMore)
    model.query = ""
    search.cancel()
    await search.value
    XCTAssertFalse(model.busy)
    XCTAssertFalse(model.loadingMore)
    XCTAssertNil(model.error)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")
    ConnectedAppsProtocol.release()
    model.query = "Linear"
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertNil(model.nextCursor)
    XCTAssertEqual(
      ConnectedAppsProtocol.state.withLock { $0.cursors }, ["", "page2", "page2", "page3"])
  }

  func testRepeatedCursorStopsSearchAndReportsFailure() async {
    let model = model()
    ConnectedAppsProtocol.state.withLock { $0.repeatsCursor = true }
    model.query = "Calendar"
    await model.search()
    XCTAssertNotNil(model.error)
    XCTAssertNil(model.nextCursor)
    XCTAssertFalse(model.busy)
    XCTAssertTrue(model.matchingToolkits.isEmpty)
    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.cursors }, ["", "page2"])
  }

  func testLoadedResultCanConnectWhileSearchPageIsPending() async throws {
    let model = model()
    await model.search()
    let held = expectation(description: "Second catalog page")
    ConnectedAppsProtocol.state.withLock {
      $0.heldCursor = "page2"
      $0.onHold = { held.fulfill() }
    }
    model.query = "GitHub"
    let search = Task { await model.search() }
    await fulfillment(of: [held], timeout: 2)
    XCTAssertTrue(model.loading)
    XCTAssertTrue(model.loadingMore)
    let toolkit = try XCTUnwrap(model.matchingToolkits.first)

    await model.connect(toolkit)

    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.authorizationRequests }, 1)
    XCTAssertEqual(model.error, "Connection unavailable")
    XCTAssertFalse(model.busy)
    XCTAssertFalse(model.loadingMore)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")

    ConnectedAppsProtocol.release()
    await search.value

    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")
    XCTAssertEqual(model.error, "Connection unavailable")
    XCTAssertFalse(model.busy)
    XCTAssertEqual(ConnectedAppsProtocol.state.withLock { $0.cursors }, ["", "page2"])
  }

  func testFailedPageRetainsResultsAndRetryCompletesSearch() async {
    let model = model()
    ConnectedAppsProtocol.state.withLock { $0.failsPage = true }
    model.query = "Linear"
    await model.search()
    XCTAssertNotNil(model.error)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertFalse(model.busy)
    XCTAssertFalse(model.loadingMore)
    ConnectedAppsProtocol.state.withLock { $0.failsPage = false }
    await model.load()
    await model.search()
    XCTAssertNil(model.error)
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertNil(model.nextCursor)
    XCTAssertFalse(model.busy)
  }
}
