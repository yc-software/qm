import XCTest
import os

@testable import QM

enum ConnectedAppsFixture {
  struct State {
    var cursors: [String] = []
    var heldCursor: String?
    let server = NativeRouteProtocol.Server()
    var onHold: (@Sendable () -> Void)?
    var repeatsCursor = false
    var failsPage = false
    var authorizationRequests = 0
    var authorizationState = ""
    var authorizedAccount: String?
    var authorizationError: String?
    var accounts: [String] = []
    var disconnectStatus = 200
    var disconnected: [String] = []
  }
  static let githubAccount =
    #"{"id":"ca_1","toolkit":"github","userId":"alice","missingScopes":[]}"#
  static let staleLinearAccount =
    #"{"id":"ca_2","toolkit":"linear","userId":"alice","missingScopes":["issues:write"]}"#
  static let freshLinearAccount =
    #"{"id":"ca_3","toolkit":"linear","userId":"alice","missingScopes":[]}"#
  static let state = OSAllocatedUnfairLock(initialState: State())
  static var server: NativeRouteProtocol.Server { state.withLock { $0.server } }
  static func install() {
    server.state.withLock { state in
      state.responder = { call in answer(call) }
      state.onCall = { route in
        if route == "GET /api/composio/toolkits", let callback = Self.state.withLock({ $0.onHold }),
          !server.state.withLock({ $0.held.isEmpty })
        {
          callback()
        }
      }
    }
  }
  private static func answer(_ call: NativeRouteProtocol.Call) -> NativeRouteProtocol.Reply {
    let cursor = call.parameters["cursor"] ?? ""
    let held = Self.state.withLock { state in
      let requestBody = call.json
      if call.url.path == "/api/composio/authorize" {
        state.authorizationRequests += 1
        state.authorizationState = requestBody["state"] as? String ?? ""
        if let account = state.authorizedAccount { state.accounts.append(account) }
      }
      if call.url.path == "/api/composio/disconnect",
        let accountId = requestBody["accountId"] as? String
      {
        state.disconnected.append(accountId)
        if state.disconnectStatus == 200 { state.accounts.removeAll { $0.contains(accountId) } }
      }
      guard call.url.path == "/api/composio/toolkits" else { return false }
      state.cursors.append(cursor)
      guard state.heldCursor == cursor else { return false }
      return true
    }
    if held { server.hold(call.exact) }
    let snapshot = Self.state.withLock { $0 }
    let github = #"{"id":"github","name":"GitHub","description":"Repositories"}"#
    let linear = #"{"id":"linear","name":"Linear","description":"Project planning"}"#
    let calendar = #"{"id":"calendar","name":"Calendar","description":"Meetings"}"#
    let body: String
    var status = 200
    if call.url.path == "/api/composio/authorize", snapshot.authorizedAccount != nil {
      body = #"{"url":"https://connect.composio.dev/link/lk_test","accountId":"ca_3"}"#
    } else if call.url.path == "/api/composio/authorize" {
      status = 503
      body = #"{"message":"Connection unavailable"}"#
    } else if call.url.path == "/api/composio/disconnect" {
      status = snapshot.disconnectStatus
      body =
        status == 200
        ? #"{"disconnected":"ca_1","toolkit":"github"}"#
        : #"{"error":"composio_unavailable","message":"Could not disconnect."}"#
    } else if call.url.path == "/api/composio/connections" {
      body = "{\"items\":[\(snapshot.accounts.joined(separator: ","))]}"
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
    return .init(status: status, body: body)
  }
  static func release() {
    state.withLock {
      $0.heldCursor = nil
      $0.onHold = nil
    }
    let routes = server.state.withLock { $0.holding }
    routes.forEach(server.release)
  }
}

@MainActor
final class NativeConnectedAppsTests: XCTestCase {
  private func model() -> ConnectedAppsModel {
    ConnectedAppsFixture.state.withLock { $0 = .init() }
    ConnectedAppsFixture.install()
    let provider = WebAuthentication { _, reply in
      .init(
        start: {
          var callback = URLComponents(string: "qm://connection/callback")!
          let (state, refusal) = ConnectedAppsFixture.state.withLock {
            ($0.authorizationState, $0.authorizationError)
          }
          callback.queryItems = [
            .init(name: "state", value: state),
            .init(
              name: "returnTo",
              value: "/settings?composioReturn=\(state)" + (refusal.map { "&error=\($0)" } ?? "")),
          ]
          reply(callback.url, nil)
          return true
        }, cancel: {})
    }
    return ConnectedAppsModel(
      client: ConnectedAppsFixture.server.client(),
      authorization: ConnectionAuthorization(authentication: provider))
  }

  func testOnlyCatalogLogosFromTheLogoServiceAreShown() throws {
    let logos = try [
      "https://logos.composio.dev/api/hubspot", "https://logos.composio.dev/api/google_drive-2",
      "https://evil.example/api/hubspot", "http://logos.composio.dev/api/hubspot",
      "https://logos.composio.dev/api/hubspot?next=1", "https://logos.composio.dev/other/hubspot",
      "https://logos.composio.dev/api/Hub Spot",
    ].map { address in
      try JSONDecoder().decode(
        NativeToolkit.self,
        from: JSONSerialization.data(withJSONObject: [
          "id": "app", "name": "App", "description": "", "logoUrl": address,
        ])
      ).logo?.absoluteString
    }
    XCTAssertEqual(
      logos,
      [
        "https://logos.composio.dev/api/hubspot", "https://logos.composio.dev/api/google_drive-2",
        nil, nil, nil, nil, nil,
      ])
  }

  func testBrowsingLoadsOnlyTheFirstPage() async {
    let model = model()
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.cursors }, [""])
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
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.cursors }, ["", "page2", "page3"])
  }

  func testSearchWaitsForTheInitialLoad() async {
    let model = model()
    let held = expectation(description: "Initial catalog request")
    ConnectedAppsFixture.state.withLock {
      $0.heldCursor = ""
      $0.onHold = { held.fulfill() }
    }
    let initial = Task { await model.load() }
    await fulfillment(of: [held], timeout: 2)
    XCTAssertTrue(model.loading)
    XCTAssertFalse(model.loadingMore)
    model.query = "Linear"
    let search = Task { await model.search() }
    ConnectedAppsFixture.release()
    let loaded = await initial.value
    await search.value
    XCTAssertTrue(loaded)
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.cursors }, ["", "page2", "page3"])
    XCTAssertFalse(model.busy)
  }

  func testConnectedAccountsLoadWhileTheCatalogIsStillLoading() async throws {
    let model = model()
    let held = expectation(description: "Initial catalog request")
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.githubAccount]
      $0.heldCursor = ""
      $0.onHold = { held.fulfill() }
    }
    let initial = Task { await model.load() }
    await fulfillment(of: [held], timeout: 2)
    let deadline = ContinuousClock.now + .seconds(2)
    while model.accounts.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(model.accounts.map(\.id), ["ca_1"])
    XCTAssertTrue(model.toolkits.isEmpty)
    ConnectedAppsFixture.release()
    let loaded = await initial.value
    XCTAssertTrue(loaded)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
  }

  func testCancelledSearchDoesNotApplyThePendingPageAndCanResume() async {
    let model = model()
    await model.search()
    let held = expectation(description: "Second catalog page")
    ConnectedAppsFixture.state.withLock {
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
    ConnectedAppsFixture.release()
    model.query = "Linear"
    await model.search()
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertNil(model.nextCursor)
    XCTAssertEqual(
      ConnectedAppsFixture.state.withLock { $0.cursors }, ["", "page2", "page2", "page3"])
  }

  func testRepeatedCursorStopsSearchAndReportsFailure() async {
    let model = model()
    ConnectedAppsFixture.state.withLock { $0.repeatsCursor = true }
    model.query = "Calendar"
    await model.search()
    XCTAssertNotNil(model.error)
    XCTAssertNil(model.nextCursor)
    XCTAssertFalse(model.busy)
    XCTAssertTrue(model.matchingToolkits.isEmpty)
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.cursors }, ["", "page2"])
  }

  func testLoadedResultCanConnectWhileSearchPageIsPending() async throws {
    let model = model()
    await model.search()
    let held = expectation(description: "Second catalog page")
    ConnectedAppsFixture.state.withLock {
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

    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.authorizationRequests }, 1)
    XCTAssertEqual(model.error, "Connection unavailable")
    XCTAssertFalse(model.busy)
    XCTAssertFalse(model.loadingMore)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")

    ConnectedAppsFixture.release()
    await search.value

    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertEqual(model.nextCursor, "page2")
    XCTAssertEqual(model.error, "Connection unavailable")
    XCTAssertFalse(model.busy)
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.cursors }, ["", "page2"])
  }

  func testFailedPageRetainsResultsAndRetryCompletesSearch() async {
    let model = model()
    ConnectedAppsFixture.state.withLock { $0.failsPage = true }
    model.query = "Linear"
    await model.search()
    XCTAssertNotNil(model.error)
    XCTAssertEqual(model.toolkits.map(\.id), ["github"])
    XCTAssertFalse(model.busy)
    XCTAssertFalse(model.loadingMore)
    ConnectedAppsFixture.state.withLock { $0.failsPage = false }
    await model.load()
    await model.search()
    XCTAssertNil(model.error)
    XCTAssertEqual(model.matchingToolkits.map(\.id), ["linear"])
    XCTAssertNil(model.nextCursor)
    XCTAssertFalse(model.busy)
  }

  func testDisconnectingTheLastAccountClearsTheToolkitConnection() async throws {
    let model = model()
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.githubAccount, ConnectedAppsFixture.staleLinearAccount]
    }
    await model.search()
    XCTAssertTrue(model.isConnected("github"))
    let github = try XCTUnwrap(model.accounts.first { $0.toolkit == "github" })
    XCTAssertFalse(github.needsReconnect)
    let linear = try XCTUnwrap(model.accounts.first { $0.toolkit == "linear" })
    XCTAssertTrue(linear.needsReconnect)
    XCTAssertEqual(model.toolkit(for: linear).id, "linear")
    XCTAssertEqual(model.toolkit(for: linear).name, "linear")

    await model.disconnect(github)

    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.disconnected }, ["ca_1"])
    XCTAssertFalse(model.isConnected("github"))
    XCTAssertEqual(model.accounts.map(\.id), ["ca_2"])
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
    await model.load()
    XCTAssertEqual(model.accounts.map(\.id), ["ca_2"])
  }

  func testReconnectingLeavesOnlyTheNewAccount() async throws {
    let model = model()
    try model.client.saveSession("token")
    defer { model.client.signOut() }
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.staleLinearAccount]
      $0.authorizedAccount = ConnectedAppsFixture.freshLinearAccount
    }
    await model.search()
    let stale = try XCTUnwrap(model.accounts.first)
    XCTAssertTrue(stale.needsReconnect)

    await model.reconnect(stale)

    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.authorizationRequests }, 1)
    XCTAssertEqual(ConnectedAppsFixture.state.withLock { $0.disconnected }, ["ca_2"])
    XCTAssertEqual(model.accounts.map(\.id), ["ca_3"])
    XCTAssertFalse(model.accounts.contains(where: \.needsReconnect))
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
    await model.load()
    XCTAssertEqual(model.accounts.map(\.id), ["ca_3"])
  }

  func testAuthorizationTheProviderRefusedShowsItsReasonAndConnectsNothing() async throws {
    let model = model()
    try model.client.saveSession("token")
    defer { model.client.signOut() }
    ConnectedAppsFixture.state.withLock {
      $0.authorizedAccount = ConnectedAppsFixture.freshLinearAccount
      $0.authorizationError = "access_denied"
    }
    await model.search()

    let connected = await model.connect(.init(id: "linear", name: "Linear", description: ""))

    XCTAssertNil(connected)
    XCTAssertEqual(model.error?.contains("access_denied"), true)
    XCTAssertTrue(model.accounts.isEmpty)
    XCTAssertFalse(model.busy)
  }

  func testFailedReconnectKeepsTheStaleAccount() async throws {
    let model = model()
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.staleLinearAccount]
    }
    await model.search()

    await model.reconnect(try XCTUnwrap(model.accounts.first))

    XCTAssertEqual(model.error, "Connection unavailable")
    XCTAssertTrue(ConnectedAppsFixture.state.withLock { $0.disconnected }.isEmpty)
    XCTAssertEqual(model.accounts.map(\.id), ["ca_2"])
    XCTAssertFalse(model.busy)
  }

  func testFailedDisconnectKeepsTheAccountAndReportsTheError() async throws {
    let model = model()
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.githubAccount]
      $0.disconnectStatus = 503
    }
    await model.search()
    let github = try XCTUnwrap(model.accounts.first)

    await model.disconnect(github)

    XCTAssertEqual(model.error, "Could not disconnect.")
    XCTAssertTrue(model.isConnected("github"))
    XCTAssertFalse(model.busy)
  }

  func testDisconnectingAnAlreadyRemovedAccountSucceeds() async throws {
    let model = model()
    ConnectedAppsFixture.state.withLock {
      $0.accounts = [ConnectedAppsFixture.githubAccount]
      $0.disconnectStatus = 404
    }
    await model.search()
    let github = try XCTUnwrap(model.accounts.first)

    await model.disconnect(github)

    XCTAssertNil(model.error)
    XCTAssertFalse(model.isConnected("github"))
  }
}
