import XCTest
import os

@testable import QM

private final class SubagentMonitoringProtocol: URLProtocol, @unchecked Sendable {
  enum Phase: Sendable, Equatable { case pending, working, waiting, reactivated, failed }

  struct State: Sendable {
    var phase = Phase.pending
    var requests: [URLRequest] = []
    var stream: SubagentMonitoringProtocol?
  }

  static let registry = OSAllocatedUnfairLock(initialState: [String: State]())
  private static let session =
    #""id":"agent","scopeId":"personal:test","threadRef":"web:test:agent","surface":"web","canContinue":true,"parentSessionId":"parent""#

  static func advance(_ host: String, to phase: Phase) {
    let stream = registry.withLock { states in
      states[host]!.phase = phase
      let stream = states[host]!.stream
      if phase == .waiting || phase == .failed { states[host]!.stream = nil }
      return stream
    }
    switch phase {
    case .waiting:
      stream?.emit(
        #"{"status":"done","result":{"status":"pending_approval","reply":"Needs permission"}}"#)
    case .failed:
      stream?.emit(#"{"status":"failed","result":{"status":"failed","reason":"Review failed"}}"#)
    case .working:
      stream?.emit(#"{"status":"running","partial":"Checking the task"}"#)
    case .pending, .reactivated:
      break
    }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let url = request.url!
    let phase = Self.registry.withLock { states -> Phase? in
      guard states[url.host!] != nil else { return nil }
      states[url.host!]!.requests.append(request)
      if url.path.hasSuffix("/events") { states[url.host!]!.stream = self }
      return states[url.host!]!.phase
    }
    guard let phase else {
      client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
      return
    }
    let body: String
    var contentType = "application/json"
    switch url.path {
    case "/api/sessions/agent":
      body = "{\"session\":{\(Self.session)},\"entries\":[]}"
    case "/api/sessions/row":
      let status: String
      switch phase {
      case .pending, .working, .reactivated:
        status = #", "working":true,"workingSince":1000"#
      case .waiting: status = #", "awaitingInput":true"#
      case .failed: status = #", "lastTurnFailed":true"#
      }
      body = "{\"session\":{\(Self.session)\(status)}}"
    case "/api/runs/active":
      switch phase {
      case .pending, .working: body = #"{"runId":"run"}"#
      case .reactivated: body = #"{"runId":"next"}"#
      case .waiting, .failed: body = #"{"runId":null}"#
      }
    case "/api/runs/run/events", "/api/runs/next/events":
      contentType = "text/event-stream"
      let partial = phase == .reactivated ? "Second pass" : "Checking the task"
      let run =
        phase == .pending
        ? #"{"status":"pending"}"#
        : "{\"status\":\"running\",\"partial\":\"\(partial)\"}"
      body = "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":\(run)}\n\n"
    default:
      XCTFail("Unexpected request: \(url.path)")
      body = "{}"
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": contentType])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    if contentType != "text/event-stream" { client?.urlProtocolDidFinishLoading(self) }
  }

  private func emit(_ run: String) {
    let event = "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":\(run)}\n\n"
    client?.urlProtocol(self, didLoad: Data(event.utf8))
  }

  override func stopLoading() {
    Self.registry.withLock { states in
      guard let host = request.url?.host, states[host]?.stream === self else { return }
      states[host]?.stream = nil
    }
  }
}

@MainActor
final class NativeSubagentMonitoringTests: XCTestCase {
  private func until(_ condition: () -> Bool) async throws {
    for _ in 0..<600 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("The agent did not reach the expected monitoring state")
  }

  func testReadOnlyAgentShowsPendingThenWorkingAndReactivatesWithAuthoritativeStatus() async throws
  {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SubagentMonitoringProtocol.self]
    let base = URL(string: "https://\(UUID().uuidString).example.test")!
    let host = base.host!
    SubagentMonitoringProtocol.registry.withLock { $0[host] = .init() }
    let client = APIClient(baseURL: base, configuration: configuration)
    try client.saveSession("test")
    let chat = ChatModel(
      conversation: Conversation(
        id: "agent", scopeId: "personal:test", threadRef: "web:test:agent", canContinue: true,
        working: true, parentSessionId: "parent"),
      client: client, user: "test", knownSession: true)
    let queued = QueuedInputsModel(
      client: client, threadRef: chat.conversation.threadRef, scopeID: chat.conversation.scopeId
    ) { await chat.reconcileActivity($0) }
    await chat.resume()
    let polling = Task { await queued.poll() }
    defer {
      polling.cancel()
      queued.stop()
      chat.pause()
      client.signOut()
      DraftStore.removeAccount(chat.attachmentAccount)
      SubagentMonitoringProtocol.registry.withLock { $0[host] = nil }
    }

    try await until { chat.activeRunID == "run" && chat.workStatus == .pending }
    XCTAssertTrue(chat.displayedPartial.isEmpty)
    XCTAssertFalse(chat.conversation.canReply)
    let pendingSections = NativeChatTranscriptSection.grouped(
      chat.timeline.items, activeRunID: chat.activeRunID, status: chat.workStatus)
    XCTAssertEqual(pendingSections.count, 1)
    XCTAssertEqual(pendingSections.last?.status, .pending)

    SubagentMonitoringProtocol.advance(host, to: .working)
    try await until { chat.activeRunID == "run" && chat.displayedPartial == "Checking the task" }
    XCTAssertEqual(chat.workStatus, .working)
    XCTAssertFalse(chat.conversation.canReply)
    XCTAssertEqual(chat.conversation.working, true)

    SubagentMonitoringProtocol.advance(host, to: .waiting)
    try await until { chat.activeRunID == nil && chat.conversation.awaitingInput == true }
    XCTAssertEqual(NativeReadOnlyWorkStatus(conversation: chat.conversation), .awaitingInput)
    XCTAssertEqual(chat.workStatus, .awaitingInput)
    XCTAssertNotEqual(chat.conversation.working, true)

    SubagentMonitoringProtocol.advance(host, to: .reactivated)
    try await until { chat.activeRunID == "next" && chat.displayedPartial == "Second pass" }
    XCTAssertEqual(chat.workStatus, .working)
    XCTAssertEqual(chat.conversation.working, true)
    XCTAssertNotEqual(chat.conversation.awaitingInput, true)

    SubagentMonitoringProtocol.advance(host, to: .failed)
    try await until { chat.activeRunID == nil && chat.conversation.lastTurnFailed == true }
    XCTAssertNotEqual(chat.conversation.working, true)
    XCTAssertEqual(chat.messages.last?.role, "error")
    XCTAssertEqual(chat.messages.last?.text, "Review failed")
    XCTAssertNil(chat.error)
    XCTAssertNil(chat.workStatus)
    XCTAssertFalse(chat.conversation.canReply)
    let requests = SubagentMonitoringProtocol.registry.withLock { $0[host]!.requests }
    XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" })
    XCTAssertFalse(requests.contains { $0.url?.path.hasSuffix("/approvals") == true })
    XCTAssertTrue(requests.contains { $0.url?.path == "/api/runs/run/events" })
    XCTAssertTrue(requests.contains { $0.url?.path == "/api/runs/next/events" })
  }
}
