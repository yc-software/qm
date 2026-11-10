import XCTest
import os

@testable import QM

final class NotebookHistoryProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var failing = false
    var empty = false
    var started: XCTestExpectation?
    var pending: NotebookHistoryProtocol?
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
    let snapshot = Self.state.withLock { $0 }
    if snapshot.failing {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
    let body =
      snapshot.empty
      ? #"{"revisions":[]}"#
      : #"{"revisions":[{"revision":"r1","content":"Earlier notebook","operation":"save","author":"Alice","at":1000}]}"#
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class NativeNotebookHistoryTests: XCTestCase {
  private func model() -> NotebookModel {
    NotebookHistoryProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NotebookHistoryProtocol.self]
    return NotebookModel(
      client: APIClient(
        baseURL: URL(string: "https://notebook-history.example.test")!,
        configuration: configuration))
  }

  func testHistoryFailureDoesNotReplaceNotebookDraftOrSaveError() async {
    let model = model()
    model.content = "Saved notebook"
    model.draft = "Unsaved additions"
    model.revision = "r2"
    model.error = "Notebook save failed"
    NotebookHistoryProtocol.state.withLock { $0.failing = true }

    await model.loadHistory()

    XCTAssertNotNil(model.historyError)
    XCTAssertFalse(model.historyLoaded)
    XCTAssertFalse(model.historyLoading)
    XCTAssertEqual(model.error, "Notebook save failed")
    XCTAssertEqual(model.content, "Saved notebook")
    XCTAssertEqual(model.draft, "Unsaved additions")
    XCTAssertEqual(model.revision, "r2")
  }

  func testRetryReplacesHistoryFailureWithSuccessfulEmptyResult() async {
    let model = model()
    NotebookHistoryProtocol.state.withLock { $0.failing = true }
    await model.loadHistory()
    XCTAssertNotNil(model.historyError)

    NotebookHistoryProtocol.state.withLock {
      $0.failing = false
      $0.empty = true
    }
    await model.loadHistory()

    XCTAssertNil(model.historyError)
    XCTAssertTrue(model.historyLoaded)
    XCTAssertFalse(model.historyLoading)
    XCTAssertTrue(model.history.isEmpty)
    XCTAssertNil(model.error)
  }

  func testFailedRefreshRetainsPreviouslyLoadedHistory() async {
    let model = model()
    await model.loadHistory()
    XCTAssertEqual(model.history.map(\.revision), ["r1"])
    NotebookHistoryProtocol.state.withLock { $0.failing = true }

    await model.loadHistory()

    XCTAssertNotNil(model.historyError)
    XCTAssertTrue(model.historyLoaded)
    XCTAssertEqual(model.history.map(\.revision), ["r1"])
    XCTAssertNil(model.error)
  }

  func testPendingHistoryRequestIsLoadingUntilResponseArrives() async {
    let model = model()
    let started = expectation(description: "History request started")
    NotebookHistoryProtocol.state.withLock { $0.started = started }
    let load = Task { await model.loadHistory() }
    await fulfillment(of: [started], timeout: 2)

    XCTAssertTrue(model.historyLoading)
    XCTAssertFalse(model.historyLoaded)
    XCTAssertNil(model.historyError)

    let pending = NotebookHistoryProtocol.state.withLock { state in
      let pending = state.pending
      state.pending = nil
      state.started = nil
      return pending
    }
    XCTAssertNotNil(pending)
    pending?.finish()
    if pending == nil { load.cancel() }
    await load.value

    XCTAssertFalse(model.historyLoading)
    XCTAssertTrue(model.historyLoaded)
    XCTAssertEqual(model.history.map(\.revision), ["r1"])
  }
}
