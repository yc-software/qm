import XCTest
import os

@testable import QM

final class QueuedRunsTests: XCTestCase {
  func testAbsentQueueDecodesAsEmptyState() throws {
    let response = try JSONDecoder().decode(
      QueuedInputsResponse.self, from: Data(#"{"runId":null}"#.utf8))
    XCTAssertNil(response.queued)
  }

  func testAttachmentOnlyQueuedInputCanKeepAttachmentsWhenEdited() {
    var edit = QueuedInputEdit(QueuedInput(runId: "queued", text: "Old text", hasAttachments: true))
    edit.text = ""
    XCTAssertTrue(edit.canSave)
    XCTAssertEqual(edit.body["expectedText"] as? String, "Old text")
    XCTAssertEqual(edit.body["text"] as? String, "")
  }

  func testEmptyTextWithoutAttachmentsCannotSave() {
    var edit = QueuedInputEdit(QueuedInput(runId: "queued", text: "Original", hasAttachments: nil))
    XCTAssertFalse(edit.canSave)
    edit.text = " \n "
    XCTAssertFalse(edit.canSave)
    edit.text = "Revised"
    XCTAssertTrue(edit.canSave)
    XCTAssertEqual(edit.original, "Original")
  }

  func testQueueResponsePreservesServerOrderAndAttachmentFlag() throws {
    let response = try JSONDecoder().decode(
      QueuedInputsResponse.self,
      from: Data(
        #"{"runId":"active","queued":[{"runId":"first","text":"One"},{"runId":"second","text":"","hasAttachments":true}]}"#
          .utf8))
    XCTAssertEqual(response.queued?.map(\.id), ["first", "second"])
    XCTAssertEqual(response.queued?.last?.hasAttachments, true)
  }
}

final class QueuedSteerProtocol: URLProtocol, @unchecked Sendable {
  static let activeRequests = OSAllocatedUnfairLock(initialState: [String: Int]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let rejected = request.url!.host!.hasPrefix("rejected-")
    let replayed = request.url!.host!.hasPrefix("replayed-")
    let lost = request.url!.host!.hasPrefix("lost-")
    var status = 200
    var body = "{}"
    if request.url!.path == "/api/runs/active/signal" {
      XCTAssertEqual(request.httpMethod, "POST")
      let payload =
        try! JSONSerialization.jsonObject(with: request.bodyData) as! [String: String]
      XCTAssertEqual(
        payload,
        [
          "kind": "steer", "text": "Queued instruction", "queuedRunId": "queued",
          "threadRef": "web:test:chat", "scopeId": "group:test",
        ])
      if lost {
        client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        return
      }
      status = rejected || replayed ? 409 : 200
      body =
        rejected
        ? #"{"accepted":false,"reason":"queued_changed"}"#
        : replayed
          ? #"{"accepted":false,"reason":"terminal","replayed":true}"#
          : #"{"accepted":true}"#
    } else if request.url!.path == "/api/runs/active" {
      let host = request.url!.host!
      let count = Self.activeRequests.withLock { requests in
        requests[host, default: 0] += 1
        return requests[host]!
      }
      if host.hasPrefix("flaky-"), count == 1 { status = 503 }
      body =
        rejected || lost
        ? #"{"runId":"active","queued":[{"runId":"queued","text":"Queued instruction"}]}"#
        : #"{"runId":"active","queued":[]}"#
    } else {
      XCTFail("Unexpected queued steer request")
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class QueuedSteerTests: XCTestCase {
  func testEmptyQueueDoesNotShowAnUnrelatedConnectionError() async throws {
    let model = try model(outcome: "flaky")
    model.inputs = []
    await model.refresh()
    XCTAssertTrue(model.inputs.isEmpty)
    XCTAssertNil(model.error)
    await model.refresh()
    XCTAssertEqual(model.activeRunID, "active")
    XCTAssertNil(model.error)
  }

  func testExplicitRefreshStaysPendingUntilCompletionOrStop() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForegroundSyncProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example")!, configuration: configuration)
    try client.saveSession("test")
    defer { client.signOut() }
    let model = QueuedInputsModel(
      client: client, threadRef: "web:test:chat", scopeID: "personal:test", onSnapshot: { _ in })
    let key = client.url(
      "api/runs/active", query: [.init(name: "threadRef", value: "web:test:chat")]
    )
    .absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 1 }
    model.retryRefresh()
    XCTAssertTrue(model.retrying)
    model.retryRefresh()
    for _ in 0..<100 {
      if ForegroundSyncProtocol.counts.withLock({ $0[key] == 1 }) { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 1)
    XCTAssertTrue(model.retrying)
    model.stop()
    XCTAssertFalse(model.retrying)
    model.retryRefresh()
    for _ in 0..<100 {
      if !model.retrying { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertFalse(model.retrying)
    XCTAssertNil(model.error)
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 2)
  }

  func model(outcome: String = "accepted") throws -> QueuedInputsModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [QueuedSteerProtocol.self]
    let client = APIClient(
      baseURL: URL(
        string: "https://\(outcome)-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    try client.saveSession("test")
    addTeardownBlock { @MainActor in client.signOut() }
    let model = QueuedInputsModel(
      client: client, threadRef: "web:test:chat", scopeID: "group:test", onSnapshot: { _ in })
    model.activeRunID = "active"
    model.inputs = [QueuedInput(runId: "queued", text: "Queued instruction", hasAttachments: nil)]
    return model
  }

  func settle(_ model: QueuedInputsModel) async throws {
    for _ in 0..<100 {
      if !model.mutating && model.inputs.isEmpty { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertFalse(model.mutating)
  }

  func testRecoveredQueueRefreshClearsOnlyTheTransientConnectionError() async throws {
    let model = try model(outcome: "flaky")
    await model.refresh()
    XCTAssertTrue(model.error?.contains("Could not refresh queued messages") == true)
    XCTAssertEqual(model.inputs.count, 1)
    await model.refresh()
    XCTAssertNil(model.error)
    XCTAssertTrue(model.inputs.isEmpty)
  }

  func testAcceptedSteerRefreshesQueueAndPreservesUnsavedEdit() async throws {
    let model = try model()
    let input = model.inputs[0]
    model.edit = QueuedInputEdit(input)
    model.edit?.text = "Keep my unsaved edit"
    model.steer(input)
    try await settle(model)
    XCTAssertTrue(model.inputs.isEmpty)
    XCTAssertNil(model.error)
    XCTAssertEqual(model.edit?.text, "Keep my unsaved edit")
    XCTAssertEqual(model.steering, [input])
  }

  func testSteeringMessageClearsWhenItsRunEndsWithoutRecordingIt() async throws {
    let model = try model()
    model.steer(model.inputs[0])
    try await settle(model)
    XCTAssertEqual(model.steering.count, 1)
    model.apply(.init(runId: "active", queued: []))
    XCTAssertEqual(model.steering.count, 1)
    model.apply(.init(runId: nil, queued: []))
    XCTAssertTrue(model.steering.isEmpty)
  }

  func testUnconfirmedSteerKeepsQueueAndReportsUncertainty() async throws {
    let model = try model(outcome: "rejected")
    model.steer(model.inputs[0])
    try await settle(model)
    XCTAssertEqual(model.inputs.count, 1)
    XCTAssertTrue(model.error?.contains("Steering was not confirmed") == true)
  }

  func testTerminalReplayIsConfirmedAndQueueReconciles() async throws {
    let model = try model(outcome: "replayed")
    model.steer(model.inputs[0])
    try await settle(model)
    XCTAssertTrue(model.inputs.isEmpty)
    XCTAssertNil(model.error)
    XCTAssertTrue(model.steering.isEmpty)
  }

  func testLostAcknowledgmentPreservesQueueForReconciliation() async throws {
    let model = try model(outcome: "lost")
    model.steer(model.inputs[0])
    try await settle(model)
    XCTAssertEqual(model.inputs.first?.runId, "queued")
    XCTAssertTrue(model.error?.contains("Steering was not confirmed") == true)
  }

  func testSteerNeedsLiveRunAndCurrentQueuedInput() throws {
    let model = try model()
    let input = model.inputs[0]
    model.activeRunID = nil
    model.steer(input)
    XCTAssertFalse(model.mutating)
    model.activeRunID = "active"
    model.inputs = []
    model.steer(input)
    XCTAssertFalse(model.mutating)
  }
}
