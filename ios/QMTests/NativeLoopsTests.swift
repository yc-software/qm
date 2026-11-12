import XCTest
import os

@testable import QM

final class LoopsFixtureProtocol: URLProtocol, @unchecked Sendable {
  struct Seen {
    let method: String
    let path: String
    let body: String
  }
  struct State {
    var loopState = "enabled"
    var triage: String?
    var triageAvailable = true
    var patchStatus = 200
    var previewStatus = 200
    var preview = "[]"
    var held: String?
    var pending: LoopsFixtureProtocol?
    var onHold: (@Sendable () -> Void)?
    var seen: [Seen] = []
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  private let stopped = OSAllocatedUnfairLock(initialState: false)
  private let reply = OSAllocatedUnfairLock(initialState: (status: 200, body: "{}"))
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  static func seen(_ method: String, _ path: String) -> [Seen] {
    state.withLock { $0.seen.filter { $0.method == method && $0.path == path } }
  }
  static func object(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
  }
  static func loop(_ state: State) -> String {
    let health = state.loopState == "quarantined" ? "quarantined" : "healthy"
    let triage = state.triage.map { #","triage":\#($0)"# } ?? ""
    return
      #"{"id":"l1","name":"Mail triage","playbook":"Sort mail","playbookVersion":1,"#
      + #""successCondition":"Sorted","shipActions":[{"action":"send","gate":"hold"}],"#
      + #""state":"\#(state.loopState)","health":"\#(health)","owner":"alice"\#(triage)}"#
  }
  override func startLoading() {
    let method = request.httpMethod ?? "GET"
    let path = request.url!.path
    let body = String(decoding: request.bodyData, as: UTF8.self)
    let held = Self.state.withLock { state in
      state.seen.append(.init(method: method, path: path, body: body))
      let answer = Self.answer(&state, method: method, path: path, body: body)
      reply.withLock { $0 = answer }
      guard state.held == "\(method) \(path)" else { return false }
      state.held = nil
      state.pending = self
      return true
    }
    if held {
      Self.state.withLock { $0.onHold }?()
    } else {
      respond()
    }
  }
  private static func answer(
    _ state: inout State, method: String, path: String, body: String
  ) -> (status: Int, body: String) {
    let sent = object(body)
    switch (method, path) {
    case ("GET", "/api/loops"):
      return (200, "{\"loops\":[\(loop(state))]}")
    case ("GET", "/api/loops/l1"):
      let items =
        #"[{"id":"i1","loopId":"l1","sourceKey":"gmail:i1","sourceSummary":"Invoice overdue","#
        + #""source":"gmail","status":"queued","attempts":0},"#
        + #"{"id":"i2","loopId":"l1","sourceKey":"ticket-7","status":"in_progress","attempts":2,"#
        + #""parkedReason":"Waiting on billing"}]"#
      let outputs =
        #"[{"id":"o1","title":"Reply to Ada","shipAction":"send","state":"ready"},"#
        + #"{"id":"o2","title":"Reply to Bo","shipAction":"send","state":"shipped","decidedBy":"alice","decisionNote":"Looks right"},"#
        + #"{"id":"o3","title":"Reply to Cy","shipAction":"send","state":"unconfirmed"},"#
        + #"{"id":"o4","title":"Reply to Di","shipAction":"send","state":"returned","decidedBy":"alice"}]"#
      return (
        200,
        "{\"loop\":\(loop(state)),\"items\":\(items),\"outputs\":\(outputs),\"grants\":[],"
          + #""vitals":{"queue":{"queued":0,"inProgress":0},"openOutputs":1},"#
          + "\"triageAvailable\":\(state.triageAvailable)}"
      )
    case ("GET", "/api/loops/l1/ingestion"):
      return (200, #"{"sources":[],"gmailAvailable":false}"#)
    case ("PATCH", "/api/loops/l1"):
      guard state.patchStatus == 200 else {
        return (state.patchStatus, #"{"error":"conflict","message":"Loop update refused"}"#)
      }
      if let next = sent["state"] as? String { state.loopState = next }
      if let triage = sent["triage"],
        let data = try? JSONSerialization.data(withJSONObject: triage)
      {
        state.triage = String(decoding: data, as: UTF8.self)
      }
      return (200, "{\"loop\":\(loop(state))}")
    case ("POST", "/api/loops/l1/triage/preview"):
      guard state.previewStatus == 200 else {
        return (state.previewStatus, #"{"error":"preview_failed","message":"Triage unavailable"}"#)
      }
      return (200, "{\"items\":\(state.preview)}")
    case ("GET", "/api/loops/l1/items/i1"):
      return (
        200,
        #"{"item":{"id":"i1","loopId":"l1","dedupeKey":"gmail:i1","state":"pending","source":"gmail","#
          + #""summary":"Invoice overdue","sourcePayload":{"title":"Invoice overdue"},"thread":[],"#
          + #""attempts":0,"outputIds":[],"createdAt":1,"updatedAt":2},"outputs":[]}"#
      )
    case ("GET", "/api/loops/l1/items/i2"):
      return (200, #"{"item":{"id":"i2","loopId":"l1"}}"#)
    default:
      return (404, #"{"error":"not_found"}"#)
    }
  }
  static func release() {
    let pending = state.withLock { state in
      let pending = state.pending
      state.pending = nil
      return pending
    }
    pending?.respond()
  }
  private func respond() {
    guard !stopped.withLock({ $0 }) else { return }
    let answer = reply.withLock { $0 }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {
    stopped.withLock { $0 = true }
  }
}

@MainActor
final class NativeLoopsTests: XCTestCase {
  private func list(_ prepare: (inout LoopsFixtureProtocol.State) -> Void = { _ in }) -> LoopsModel
  {
    var initial = LoopsFixtureProtocol.State()
    prepare(&initial)
    let prepared = initial
    LoopsFixtureProtocol.state.withLock { $0 = prepared }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoopsFixtureProtocol.self]
    return LoopsModel(
      client: APIClient(
        baseURL: URL(string: "https://loops.example.test")!, configuration: configuration))
  }
  private func detail(_ list: LoopsModel) async -> LoopDetailModel {
    await list.load()
    let model = LoopDetailModel(client: list.client, id: "l1", list: list)
    await model.load()
    return model
  }
  private func hold(_ request: String) -> XCTestExpectation {
    let held = expectation(description: request)
    LoopsFixtureProtocol.state.withLock {
      $0.held = request
      $0.onHold = { held.fulfill() }
    }
    return held
  }

  func testClearingQuarantineEnablesTheLoop() async {
    let model = await detail(list { $0.loopState = "quarantined" })
    XCTAssertEqual(model.detail?.loop.health, "quarantined")
    let cleared = await model.setState("enabled")
    XCTAssertTrue(cleared)
    let sent = LoopsFixtureProtocol.seen("PATCH", "/api/loops/l1").map {
      LoopsFixtureProtocol.object($0.body)["state"] as? String
    }
    XCTAssertEqual(sent, ["enabled"])
    XCTAssertEqual(model.detail?.loop.state, "enabled")
    XCTAssertEqual(model.detail?.loop.health, "healthy")
    XCTAssertNil(model.error)
  }

  func testEveryLoopIsListedAndSearchedByName() async {
    let loops = list { $0.loopState = "archived" }
    await loops.load()
    XCTAssertEqual(loops.loops(matching: "").map(\.id), ["l1"])
    XCTAssertTrue(loops.loops(matching: "calendar").isEmpty)
    XCTAssertEqual(loops.loops(matching: "mail").map(\.id), ["l1"])
  }

  func testStateChangeUpdatesTheListAndIgnoresAStaleList() async {
    let loops = list { $0.loopState = "archived" }
    let model = await detail(loops)
    let held = hold("GET /api/loops")
    async let stale: Void = loops.load()
    await fulfillment(of: [held], timeout: 2)
    let changed = await model.setState("enabled")
    XCTAssertTrue(changed)
    XCTAssertEqual(loops.loops.map(\.state), ["enabled"])
    LoopsFixtureProtocol.release()
    await stale
    XCTAssertEqual(loops.loops.map(\.state), ["enabled"])
    XCTAssertFalse(loops.loading)
    XCTAssertNil(loops.error)
  }

  func testRefusedStateChangeKeepsThePreviousState() async {
    for status in [409, 502] {
      let loops = list {
        $0.loopState = "archived"
        $0.patchStatus = status
      }
      let model = await detail(loops)
      let changed = await model.setState("enabled")
      XCTAssertFalse(changed)
      XCTAssertEqual(model.detail?.loop.state, "archived")
      XCTAssertEqual(loops.loops.map(\.state), ["archived"])
      XCTAssertEqual(model.error, "Loop update refused")
      XCTAssertFalse(model.busy)
    }
  }

  func testSavingTriageSendsTheEditedSettingAndUpdatesTheLoop() async {
    let model = await detail(list())
    XCTAssertNil(model.detail?.loop.triage(.prioritize))
    let saved = await model.saveTriage(.prioritize, enabled: true, instructions: "Outages first")
    XCTAssertTrue(saved)
    let sent = LoopsFixtureProtocol.seen("PATCH", "/api/loops/l1").map {
      LoopsFixtureProtocol.object($0.body)["triage"] as? [String: [String: AnyHashable]]
    }
    XCTAssertEqual(sent, [["prioritize": ["enabled": true, "instructions": "Outages first"]]])
    XCTAssertEqual(model.detail?.loop.triage(.prioritize)?.enabled, true)
    XCTAssertEqual(model.detail?.loop.triage(.prioritize)?.instructions, "Outages first")
    XCTAssertNil(model.detail?.loop.triage(.consolidate))
  }

  func testRefusedTriageSaveKeepsTheSavedSetting() async {
    let model = await detail(
      list {
        $0.triage = #"{"consolidate":{"enabled":true,"instructions":"Same sender"}}"#
        $0.patchStatus = 403
      })
    let saved = await model.saveTriage(.consolidate, enabled: false, instructions: "")
    XCTAssertFalse(saved)
    XCTAssertEqual(model.detail?.loop.triage(.consolidate)?.enabled, true)
    XCTAssertEqual(model.detail?.loop.triage(.consolidate)?.instructions, "Same sender")
    XCTAssertEqual(model.error, "Loop update refused")
  }

  func testPreviewWithEmptyInstructionsIsRefusedWithoutARequest() async {
    let model = await detail(list { $0.preview = #"[{"id":"i1","priority":"urgent"}]"# })
    let previewed = await model.previewTriage(.prioritize, instructions: "  \n ")
    XCTAssertFalse(previewed)
    XCTAssertNil(model.preview)
    XCTAssertTrue(LoopsFixtureProtocol.seen("POST", "/api/loops/l1/triage/preview").isEmpty)
  }

  func testPreviewListsTheReturnedItems() async {
    let model = await detail(
      list {
        $0.preview =
          #"[{"id":"i1","priority":"urgent","reason":"Payment is late"},{"id":"i7","groupId":"i1"}]"#
      })
    let previewed = await model.previewTriage(.prioritize, instructions: " Money first ")
    XCTAssertTrue(previewed)
    let sent = LoopsFixtureProtocol.seen("POST", "/api/loops/l1/triage/preview").map {
      LoopsFixtureProtocol.object($0.body)["triage"] as? [String: [String: AnyHashable]]
    }
    XCTAssertEqual(sent, [["prioritize": ["enabled": true, "instructions": "Money first"]]])
    XCTAssertEqual(model.preview?.map(\.id), ["i1", "i7"])
    XCTAssertEqual(model.preview?.map(\.priority), ["urgent", nil])
    XCTAssertEqual(model.preview?.map(\.reason), ["Payment is late", nil])
    XCTAssertEqual(model.preview?.map(\.groupId), [nil, "i1"])
    XCTAssertEqual(model.title(of: "i1"), "Invoice overdue")
    XCTAssertEqual(model.title(of: "i7"), "i7")
    XCTAssertFalse(model.previewing)
  }

  func testFailedPreviewStaysInTheEditorUntilItCloses() async {
    let model = await detail(list { $0.previewStatus = 502 })
    let previewed = await model.previewTriage(.consolidate, instructions: "Same sender")
    XCTAssertFalse(previewed)
    XCTAssertNil(model.preview)
    XCTAssertEqual(model.previewError, "Triage unavailable")
    XCTAssertNil(model.error)
    model.clearPreview()
    XCTAssertNil(model.previewError)
  }

  func testSuccessfulPreviewReplacesAnEarlierFailure() async {
    let model = await detail(list { $0.previewStatus = 502 })
    _ = await model.previewTriage(.prioritize, instructions: "Money first")
    XCTAssertNotNil(model.previewError)
    LoopsFixtureProtocol.state.withLock {
      $0.previewStatus = 200
      $0.preview = #"[{"id":"i1","priority":"low"}]"#
    }
    let previewed = await model.previewTriage(.prioritize, instructions: "Money first")
    XCTAssertTrue(previewed)
    XCTAssertNil(model.previewError)
    XCTAssertEqual(model.preview?.map(\.id), ["i1"])
  }

  func testClosingTheEditorDropsALatePreview() async {
    let model = await detail(list { $0.preview = #"[{"id":"i1","priority":"low"}]"# })
    let held = hold("POST /api/loops/l1/triage/preview")
    async let late = model.previewTriage(.prioritize, instructions: "Money first")
    await fulfillment(of: [held], timeout: 2)
    XCTAssertTrue(model.previewing)
    model.clearPreview()
    LoopsFixtureProtocol.release()
    let applied = await late
    XCTAssertFalse(applied)
    XCTAssertNil(model.preview)
    XCTAssertFalse(model.previewing)
  }

  func testTriageOffersEveryKindOnlyWhenTheFeatureIsAvailable() async {
    let available = await detail(list())
    XCTAssertEqual(available.detail?.triageKinds, [.prioritize, .consolidate])
    let unavailable = await detail(
      list {
        $0.triageAvailable = false
        $0.triage = #"{"prioritize":{"enabled":false}}"#
      })
    XCTAssertEqual(unavailable.detail?.triageKinds, [])
  }

  func testTriageLeftOnAfterTheFeatureIsRemovedCanOnlyBeTurnedOff() async {
    let model = await detail(
      list {
        $0.triageAvailable = false
        $0.triage =
          #"{"prioritize":{"enabled":false},"consolidate":{"enabled":true,"instructions":"Same sender"}}"#
      })
    XCTAssertEqual(model.detail?.triageKinds, [.consolidate])
    let saved = await model.saveTriage(.consolidate, enabled: false, instructions: "Same sender")
    XCTAssertTrue(saved)
    let sent = LoopsFixtureProtocol.seen("PATCH", "/api/loops/l1").map {
      LoopsFixtureProtocol.object($0.body)["triage"] as? [String: [String: AnyHashable]]
    }
    XCTAssertEqual(sent, [["consolidate": ["enabled": false, "instructions": "Same sender"]]])
    XCTAssertEqual(model.detail?.triageKinds, [])
    XCTAssertNil(model.error)
  }

  func testWorkItemsComeFromTheLoopItselfWithoutASecondRequest() async {
    let model = await detail(list())
    let items = model.detail?.items ?? []
    XCTAssertEqual(items.map(\.id), ["i1", "i2"])
    XCTAssertEqual(items.map(\.title), ["Invoice overdue", "ticket-7"])
    XCTAssertEqual(items.map(\.caption), ["queued", "in progress · 2 attempts"])
    XCTAssertEqual(items.map(\.parkedReason), [nil, "Waiting on billing"])
    XCTAssertEqual(items.map(\.source), ["gmail", nil])
    XCTAssertEqual(
      LoopsFixtureProtocol.state.withLock { $0.seen.map(\.path) }.sorted(),
      ["/api/loops", "/api/loops/l1", "/api/loops/l1/ingestion"])
  }

  func testEventSourcesAreRequestedWhileTheLoopIsStillLoading() async throws {
    let loops = list()
    let model = LoopDetailModel(client: loops.client, id: "l1", list: loops)
    let held = hold("GET /api/loops/l1")
    async let loading: Void = model.load()
    await fulfillment(of: [held], timeout: 2)
    let deadline = ContinuousClock.now + .seconds(2)
    while LoopsFixtureProtocol.seen("GET", "/api/loops/l1/ingestion").isEmpty,
      ContinuousClock.now < deadline
    {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(LoopsFixtureProtocol.seen("GET", "/api/loops/l1/ingestion").count, 1)
    XCTAssertNil(model.detail)
    LoopsFixtureProtocol.release()
    await loading
    XCTAssertNotNil(model.detail)
    XCTAssertNotNil(model.ingestion)
  }

  func testOpeningAWorkItemFetchesThatItemForTheInboxScreen() async throws {
    let model = await detail(list())
    await model.open(try XCTUnwrap(model.detail?.items.first))
    XCTAssertEqual(model.opened?.id, "i1")
    XCTAssertEqual(model.opened?.loopId, "l1")
    XCTAssertEqual(model.opened?.title, "Invoice overdue")
    XCTAssertEqual(LoopsFixtureProtocol.seen("GET", "/api/loops/l1/items/i1").count, 1)
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testWorkItemThatCannotBeReadAsAnInboxItemReportsTheErrorInsteadOfOpening() async throws {
    let model = await detail(list())
    await model.open(try XCTUnwrap(model.detail?.items.last))
    XCTAssertNil(model.opened)
    XCTAssertNotNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testDecidedOutputsAreSeparatedFromOutputsAwaitingReview() async {
    let model = await detail(list())
    let outputs = model.detail?.outputs ?? []
    XCTAssertEqual(outputs.filter(\.decided).map(\.id), ["o2", "o4"])
    XCTAssertEqual(outputs.filter { !$0.decided }.map(\.id), ["o1", "o3"])
    XCTAssertEqual(outputs.filter(\.decided).map(\.decidedBy), ["alice", "alice"])
    XCTAssertEqual(outputs.filter(\.decided).map(\.decisionNote), ["Looks right", nil])
  }

  func testOnlyOutputsAwaitingReviewCanBeReviewedAndAnUnconfirmedOneIsConfirmed() async {
    let model = await detail(list())
    let outputs = model.detail?.outputs ?? []
    XCTAssertEqual(outputs.filter(\.reviewable).map(\.id), ["o1", "o3"])
    XCTAssertEqual(
      outputs.filter(\.reviewable).map(\.approveLabel), ["Approve action", "Confirm shipped"])
  }
}
