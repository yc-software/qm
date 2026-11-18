import XCTest
import os

@testable import QM

final class NativeServerContractTests: XCTestCase {
  private let server = NativeRouteProtocol.Server()

  func testInboxFeedDecodesWithoutMigrationField() throws {
    let json = #"{"selected":[],"available":[],"items":[],"total":0,"filter":"human"}"#
    let feed = try JSONDecoder().decode(NativeInboxFeed.self, from: Data(json.utf8))
    XCTAssertEqual(feed.total, 0)
    XCTAssertNil(feed.nextCursor)
  }

  func testSentChatTextIsTrimmedToServerLimitAndReported() throws {
    func email(_ body: String) throws -> NativeSentEmail {
      let object: [String: Any] = [
        "id": "m", "threadId": "t", "to": "a@example.com", "subject": "s", "sentAt": 1,
        "body": body,
      ]
      return try JSONDecoder().decode(
        NativeSentEmail.self, from: JSONSerialization.data(withJSONObject: object))
    }
    let short = try email("hello")
    XCTAssertFalse(short.chatTrimmed)
    XCTAssertEqual(short.chatText, "hello")
    let exact = try email(String(repeating: "a", count: NativeSentEmail.chatLimit))
    XCTAssertFalse(exact.chatTrimmed)
    XCTAssertEqual(exact.chatText.utf16.count, NativeSentEmail.chatLimit)
    let long = try email(String(repeating: "😀", count: NativeSentEmail.chatLimit))
    XCTAssertTrue(long.chatTrimmed)
    XCTAssertLessThanOrEqual(long.chatText.utf16.count, NativeSentEmail.chatLimit)
    XCTAssertGreaterThan(long.chatText.utf16.count, NativeSentEmail.chatLimit - 2)
    XCTAssertTrue(long.chatSource.hasPrefix(long.chatText))
    let straddling = try email(String(repeating: "a", count: NativeSentEmail.chatLimit - 1) + "😀b")
    XCTAssertTrue(straddling.chatTrimmed)
    XCTAssertEqual(
      straddling.chatText, String(repeating: "a", count: NativeSentEmail.chatLimit - 1))
  }

  private static let policyRoute = "/api/contexts/channel:C1/ambient-policy"
  private static let pinRoute = "/api/channel-header-pin"

  private static func policy(
    _ orders: String, updatedAt: Int, ambient: String = "null", bots: [String] = ["zeta", "alpha"]
  ) -> NativeRouteProtocol.Reply {
    let ledger = bots.map {
      $0 == "alpha" ? #""alpha":{"mode":"rollup","rollupHours":6}"# : #""\#($0)":{"mode":"ignore"}"#
    }.joined(separator: ",")
    return .init(
      body: """
        {"policy":{"orders":"\(orders)","ambientEnabled":\(ambient),"updatedAt":\(updatedAt),
         "bots":{\(ledger)}}}
        """)
  }

  @MainActor
  private func channelPolicy(
    loads: [NativeRouteProtocol.Reply] = [policy("Flag delays", updatedAt: 5)],
    saves: [NativeRouteProtocol.Reply] = [],
    pins: [NativeRouteProtocol.Reply] = [],
    scope: String = "channel:C1"
  ) async throws -> ChannelPolicyModel {
    let model = try XCTUnwrap(
      ChannelPolicyModel(
        client: server.client([
          "GET \(Self.policyRoute)": loads, "PUT \(Self.policyRoute)": saves,
          "GET \(Self.pinRoute)": [
            .init(body: #"{"scopeId":"channel:C1","on":true,"configured":null,"default":true}"#)
          ], "PUT \(Self.pinRoute)": pins,
        ]),
        scopeId: scope))
    await model.load()
    return model
  }

  private func sentBody(_ index: Int) throws -> [String: Any] {
    let saves = server.calls.filter { $0.route.hasPrefix("PUT ") }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: saves[index].body) as? [String: Any])
  }

  @MainActor
  func testAgentBehaviorIsOfferedOnlyForChannelAndGroupScopes() throws {
    let client = server.client([:])
    XCTAssertNil(ChannelPolicyModel(client: client, scopeId: "personal:alice"))
    XCTAssertNil(ChannelPolicyModel(client: client, scopeId: "project:p1"))
    XCTAssertNil(ChannelPolicyModel(client: client, scopeId: "unscoped"))
    let channel = try XCTUnwrap(ChannelPolicyModel(client: client, scopeId: "channel:C1"))
    XCTAssertTrue(channel.supportsHeaderPin)
    let group = try XCTUnwrap(ChannelPolicyModel(client: client, scopeId: "group:p1"))
    XCTAssertFalse(group.supportsHeaderPin)
  }

  @MainActor
  func testChannelPolicyLoadsOrdersLedgerAndDefaultHeaderPin() async throws {
    let model = try await channelPolicy()
    XCTAssertTrue(model.loaded)
    XCTAssertFalse(model.dirty)
    XCTAssertEqual(model.orders, "Flag delays")
    XCTAssertEqual(model.ambient, .default)
    XCTAssertEqual(model.bots.map(\.name), ["alpha", "zeta"])
    XCTAssertEqual(
      model.bots.map(\.policy),
      [.init(mode: "rollup", rollupHours: 6), .init(mode: "ignore", rollupHours: nil)])
    XCTAssertEqual(model.headerPinState, .default)
    XCTAssertEqual(model.headerPin?.default, true)
    XCTAssertEqual(
      server.calls.sorted { $0.route < $1.route }.map {
        [$0.route, $0.query, String(decoding: $0.body, as: UTF8.self)]
      },
      [
        ["GET \(Self.pinRoute)", "scopeId=channel:C1", ""],
        ["GET \(Self.policyRoute)", nil, ""],
      ])
  }

  @MainActor
  func testHeaderPinLoadsWhileThePolicyIsStillLoading() async throws {
    let route = "GET \(Self.policyRoute)"
    let model = try await channelPolicy()
    let reloading = expectation(description: "Policy reload in flight")
    server.state.withLock {
      $0.holding.insert(route)
      $0.onCall = { if $0 == route { reloading.fulfill() } }
    }
    let reload = Task { await model.load() }
    await fulfillment(of: [reloading], timeout: 2)
    func pinLoads() -> Int {
      server.calls.filter { $0.route == "GET \(Self.pinRoute)" }.count
    }
    let deadline = ContinuousClock.now + .seconds(2)
    while pinLoads() < 2, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(pinLoads(), 2)
    server.release(route)
    await reload.value
  }

  @MainActor
  func testGroupPolicyNeverRequestsHeaderPin() async throws {
    let route = "GET /api/contexts/group:p1/ambient-policy"
    let model = try XCTUnwrap(
      ChannelPolicyModel(
        client: server.client([route: [Self.policy("", updatedAt: 0)]]),
        scopeId: "group:p1"))
    await model.load()
    XCTAssertTrue(model.loaded)
    XCTAssertNil(model.headerPin)
    XCTAssertNil(model.headerPinError)
    XCTAssertEqual(server.calls.map(\.route), [route])
  }

  @MainActor
  func testSavingPolicySendsEditsAgainstLoadedRevision() async throws {
    let model = try await channelPolicy(saves: [
      .init(
        body: """
          {"policy":{"orders":"Flag blockers","ambientEnabled":false,"updatedAt":9,
           "bots":{"alpha":{"mode":"rollup","rollupHours":6}}}}
          """)
    ])
    model.orders = "Flag blockers"
    model.ambient = .off
    model.removeBot(try XCTUnwrap(model.bots.last))
    XCTAssertTrue(model.dirty)
    await model.save()

    let body = try sentBody(0)
    XCTAssertEqual(body["orders"] as? String, "Flag blockers")
    XCTAssertEqual(body["ambientEnabled"] as? Bool, false)
    XCTAssertEqual(body["baseUpdatedAt"] as? Double, 5)
    let bots = try XCTUnwrap(body["bots"] as? [String: [String: Any]])
    XCTAssertEqual(Array(bots.keys), ["alpha"])
    XCTAssertEqual(bots["alpha"]?["mode"] as? String, "rollup")
    XCTAssertEqual(bots["alpha"]?["rollupHours"] as? Double, 6)
    XCTAssertFalse(model.dirty)
    XCTAssertTrue(model.justSaved)
    XCTAssertEqual(model.saved?.updatedAt, 9)
    XCTAssertNil(model.error)

    model.orders = "Flag blockers today"
    XCTAssertFalse(model.justSaved)
  }

  @MainActor
  func testSaveRefusedForANewerPolicyShowsTheServersReasonAndKeepsTheEdits() async throws {
    let model = try await channelPolicy(saves: [
      .init(status: 409, body: #"{"error":"conflict","message":"policy changed"}"#)
    ])
    model.orders = "Typed here"
    model.removeBot(try XCTUnwrap(model.bots.first { $0.name == "zeta" }))
    await model.save()
    XCTAssertEqual(model.error, "policy changed")
    XCTAssertFalse(model.justSaved)
    XCTAssertEqual(model.orders, "Typed here")
    XCTAssertEqual(model.bots.map(\.name), ["alpha"])
    XCTAssertEqual(model.saved?.updatedAt, 5)
    XCTAssertTrue(model.dirty)
    XCTAssertEqual(
      server.calls.filter { $0.route == "GET \(Self.policyRoute)" }.count, 1)
  }

  @MainActor
  func testOrdersTypedDuringReloadAreNotOverwritten() async throws {
    let route = "GET \(Self.policyRoute)"
    let model = try await channelPolicy(loads: [
      Self.policy("Flag delays", updatedAt: 5), Self.policy("Remote edit", updatedAt: 8),
    ])
    let reloading = expectation(description: "Policy reload in flight")
    server.state.withLock {
      $0.holding.insert(route)
      $0.onCall = { if $0 == route { reloading.fulfill() } }
    }
    let reload = Task { await model.load() }
    await fulfillment(of: [reloading], timeout: 2)
    model.orders = "Typed during reload"
    server.release(route)
    await reload.value
    XCTAssertEqual(model.orders, "Typed during reload")
    XCTAssertEqual(model.saved?.updatedAt, 5)
    XCTAssertTrue(model.dirty)
  }

  @MainActor
  func testHeaderPinNullIsDefaultAndSendsThreeStates() async throws {
    let model = try await channelPolicy(pins: [
      .init(body: #"{"scopeId":"channel:C1","on":false,"configured":false}"#),
      .init(body: #"{"scopeId":"channel:C1","on":true,"configured":null}"#),
    ])
    XCTAssertEqual(model.headerPinState, .default)
    await model.setHeaderPin(.default)
    XCTAssertTrue(server.calls.allSatisfy { $0.route.hasPrefix("GET ") })

    await model.setHeaderPin(.off)
    XCTAssertEqual(model.headerPinState, .off)
    XCTAssertEqual(model.headerPin?.default, true)
    let off = try sentBody(0)
    XCTAssertEqual(off["scopeId"] as? String, "channel:C1")
    XCTAssertEqual(off["on"] as? Bool, false)

    await model.setHeaderPin(.default)
    XCTAssertEqual(model.headerPinState, .default)
    XCTAssertTrue(try sentBody(1)["on"] is NSNull)
    XCTAssertNil(model.headerPinError)
  }
}
