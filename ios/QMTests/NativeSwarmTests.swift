import XCTest

@testable import QM

@MainActor
final class NativeSwarmTests: XCTestCase {
  private func swarm(_ prefix: String) throws -> SwarmModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatReconciliationProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(prefix)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("test")
    return SwarmModel(client: client, sessionID: "chat")
  }

  private func key(_ model: SwarmModel) -> String {
    model.client.baseURL.host! + "/api/sessions/chat/swarm"
  }

  private func controlled(_ model: SwarmModel) -> [[String: String]] {
    (ChatReconciliationProtocol.log.bodies[key(model)] ?? []).compactMap {
      try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String]
    }.sorted { ($0["memberId"] ?? "") < ($1["memberId"] ?? "") }
  }

  func testWorkersLoadResolveInheritedStatusesAndControlMembers() async throws {
    let model = try swarm("swarm")
    defer { model.client.signOut() }
    await model.load()
    let swarm = try XCTUnwrap(model.view)
    XCTAssertEqual(swarm.ordered.map(\.id), ["root", "worker-one", "worker-two", "worker-three"])
    XCTAssertEqual(
      swarm.ordered.map { swarm.status(of: $0) }, ["active", "active", "paused", "paused"])
    XCTAssertEqual(swarm.ordered.map(swarm.canControl), [false, true, true, true])
    XCTAssertEqual(swarm.targets(for: "paused"), ["worker-one"])
    XCTAssertEqual(swarm.targets(for: "active"), ["worker-two"])
    XCTAssertEqual(swarm.targets(for: "stopped"), ["worker-one", "worker-two"])
    XCTAssertTrue(swarm.canControlAll)

    await model.control(["worker-one", "worker-two"], state: "paused")
    XCTAssertEqual(
      controlled(model),
      ["worker-one", "worker-two"].map {
        ["action": "control", "memberId": $0, "state": "paused"]
      })
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(model)], 4)
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testWithoutWorkersOrWithoutASwarmTheWorkerListIsHidden() async throws {
    for prefix in ["swarm-empty", "swarm-missing"] {
      let model = try swarm(prefix)
      defer { model.client.signOut() }
      await model.load()
      XCTAssertNil(model.view, prefix)
      XCTAssertNil(model.error, prefix)
      XCTAssertEqual(ChatReconciliationProtocol.log.received[key(model)], 1, prefix)
    }
  }

  func testControllingSeveralWorkersSendsTheirRequestsTogetherAndReloadsOnce() async throws {
    let model = try swarm("swarm-held")
    defer { model.client.signOut() }
    let requests = key(model)
    let bothSent = expectation(description: "Both workers were sent their control")
    let waiting = ChatReconciliationProtocol.wait(
      until: { $0.received[requests] == 2 }, then: { bothSent.fulfill() })
    let control = Task { await model.control(["worker-one", "worker-two"], state: "stopped") }
    await fulfillment(of: [bothSent], timeout: 5)
    ChatReconciliationProtocol.stopWaiting(waiting)
    XCTAssertTrue(model.busy)
    ChatReconciliationProtocol.release("\(requests)#1")
    ChatReconciliationProtocol.release("\(requests)#2")
    await control.value

    XCTAssertEqual(controlled(model).map { $0["memberId"] }, ["worker-one", "worker-two"])
    XCTAssertEqual(ChatReconciliationProtocol.log.received[requests], 3)
    XCTAssertNotNil(model.view)
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testRefusedControlsReportHowManyFailedAndTheServersReason() async throws {
    let model = try swarm("swarm-refused")
    defer { model.client.signOut() }
    await model.control(["worker-one", "worker-two"], state: "paused")
    XCTAssertEqual(
      model.error, "Could not update 2 of 2 workers. stopped workers cannot be resumed")
    XCTAssertEqual(ChatReconciliationProtocol.log.received[key(model)], 3)
    XCTAssertNotNil(model.view)
    XCTAssertFalse(model.busy)
  }
}
