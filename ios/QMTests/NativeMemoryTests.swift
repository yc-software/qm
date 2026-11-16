import XCTest
import os

@testable import QM

@MainActor
final class NativeMemoryTests: XCTestCase {
  private let server = NativeRouteProtocol.Server()
  private let list = "GET /api/memory"
  private let edit = "PATCH /api/memory"
  private let forget = "DELETE /api/memory"

  private func facts(_ facts: [(String, String, Double)]) -> String {
    let rows = facts.map { id, text, at in
      #"{"id":"\#(id)","text":"\#(text)","createdAt":\#(at),"updatedAt":\#(at)}"#
    }
    return #"{"scopeId":"personal:alice","facts":[\#(rows.joined(separator: ","))]}"#
  }

  private func model() -> MemoryModel {
    let changed = NativeRouteProtocol.Reply(body: facts([("b", "Newer note", 2000)]))
    return MemoryModel(
      client: server.client([
        list: [.init(body: facts([("a", "Older note", 1000), ("b", "Newer note", 2000)]))],
        edit: [changed], forget: [changed],
      ]))
  }

  func testLoadDecodesServerFactsNewestFirst() async {
    let model = model()
    await model.load()
    XCTAssertNil(model.error)
    XCTAssertTrue(model.loaded)
    XCTAssertFalse(model.busy)
    XCTAssertEqual(model.facts.map(\.id), ["b", "a"])
    XCTAssertEqual(model.facts.first?.captured, Date(timeIntervalSince1970: 2))
    XCTAssertEqual(server.calls.map(\.route), [list])
  }

  func testSearchFiltersFactsCaseInsensitively() async {
    let model = model()
    await model.load()
    model.query = "NEWER"
    XCTAssertEqual(model.visible.map(\.id), ["b"])
    model.query = "missing"
    XCTAssertTrue(model.visible.isEmpty)
    XCTAssertEqual(model.facts.count, 2)
  }

  func testEditPatchesOneFactAndAdoptsTheReplacedList() async {
    let model = model()
    await model.load()
    server.reply(edit, facts([("b", "Rewritten", 2000), ("c", "Added", 3000)]))
    let saved = await model.edit(model.facts[1], text: "  Rewritten \n")
    XCTAssertTrue(saved)
    XCTAssertNil(model.error)
    let patch = server.calls.last
    XCTAssertEqual(patch?.route, edit)
    XCTAssertEqual(
      patch?.json["facts"] as? [[String: String]], [["id": "a", "text": "Rewritten"]])
    XCTAssertEqual(model.facts.map(\.id), ["c", "b"])
    XCTAssertEqual(model.facts.map(\.text), ["Added", "Rewritten"])
  }

  func testEmptyEditIsRefusedWithoutARequest() async {
    let model = model()
    await model.load()
    let saved = await model.edit(model.facts[0], text: " \n\t")
    XCTAssertFalse(saved)
    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(model.facts.map(\.id), ["b", "a"])
    XCTAssertFalse(model.busy)
  }

  func testFailedForgetKeepsTheFact() async {
    let model = model()
    await model.load()
    let remaining = facts([("b", "Newer note", 2000)])
    server.reply(forget, status: 500, remaining)
    let forgotten = await model.forget(model.facts[0])
    XCTAssertFalse(forgotten)
    XCTAssertNotNil(model.error)
    XCTAssertEqual(model.facts.map(\.id), ["b", "a"])
    XCTAssertEqual(server.calls.last?.route, forget)
    XCTAssertFalse(model.busy)
    server.reply(forget, remaining)
    let forgottenAfterRetry = await model.forget(model.facts[1])
    XCTAssertTrue(forgottenAfterRetry)
    XCTAssertNil(model.error)
    XCTAssertEqual(model.facts.map(\.id), ["b"])
  }

  func testRefreshDuringAnEditIsDroppedAndTheEditResultWins() async {
    let model = model()
    await model.load()
    let started = expectation(description: "Edit request started")
    server.state.withLock { [edit] in
      $0.holding.insert(edit)
      $0.onCall = { _ in started.fulfill() }
    }
    let editing = Task { await model.edit(model.facts[0], text: "Changed") }
    await fulfillment(of: [started], timeout: 2)
    XCTAssertTrue(model.saving)
    XCTAssertTrue(model.busy)

    await model.load()
    XCTAssertFalse(model.loading)
    XCTAssertEqual(server.calls.map(\.route), [list, edit])

    XCTAssertTrue(server.isHeld(edit))
    server.release(edit)
    let saved = await editing.value
    XCTAssertTrue(saved)
    XCTAssertFalse(model.busy)
    XCTAssertEqual(model.facts.map(\.id), ["b"])
  }

  func testForgetTargetsOnlyTheChosenFactAmongIdenticalTexts() async {
    let model = model()
    server.reply(list, facts([("a", "Same text", 1000), ("b", "Same text", 2000)]))
    server.reply(forget, facts([("a", "Same text", 1000)]))
    await model.load()
    XCTAssertEqual(model.facts.map(\.id), ["b", "a"])
    let forgotten = await model.forget(model.facts[0])
    XCTAssertTrue(forgotten)
    let delete = server.calls.last
    XCTAssertEqual(delete?.route, forget)
    XCTAssertEqual(delete?.json["ids"] as? [String], ["b"])
    XCTAssertEqual(model.facts.map(\.id), ["a"])
  }

  func testRetryAfterAFailedLoadClearsTheError() async {
    let model = model()
    server.state.withLock { [list] in
      $0.replies[list]?.insert(.init(failure: .notConnectedToInternet), at: 0)
    }
    await model.load()
    XCTAssertNotNil(model.error)
    XCTAssertFalse(model.loaded)
    XCTAssertFalse(model.loading)
    await model.load()
    XCTAssertNil(model.error)
    XCTAssertTrue(model.loaded)
    XCTAssertEqual(model.facts.count, 2)
  }
}
