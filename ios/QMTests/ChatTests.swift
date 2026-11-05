import XCTest

@testable import QM

final class ChatScenarioProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.03) { [self] in
      let path = request.url!.path
      var status = 200
      var body = "{}"
      var contentType = "application/json"
      if path == "/api/approvals/approval" {
        XCTAssertEqual(request.httpMethod, "POST")
        if request.url!.host!.hasPrefix("unconfirmed-") {
          body = #"{"reason":"Decision not confirmed"}"#
        } else if request.url!.host!.hasPrefix("lost-") {
          client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
          return
        } else if request.url!.host!.hasPrefix("forbidden-") {
          XCTFail("Unavailable approval scope must not be submitted")
        } else {
          body = #"{"status":"ok","reply":"Decision recorded"}"#
        }
      } else if path == "/api/turn" {
        status = 413
      } else if path == "/api/runs/active" {
        body = request.url!.host!.hasPrefix("completed-") ? "{}" : #"{"runId":"run"}"#
      } else if path == "/api/runs/next/events" {
        contentType = "text/event-stream"
        body = "data: {\"type\":\"RUN_FINISHED\"}\n\n"
      } else if path == "/api/runs/next" {
        body = #"{"status":"done","result":{"status":"ok","reply":"Queued successor completed"}}"#
      } else if path == "/api/runs/run/events" {
        contentType = "text/event-stream"
        body =
          "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"partial\":\"Keep the answer\",\"status\":\"done\"}}\n\ndata: {\"type\":\"RUN_FINISHED\"}\n\n"
      } else if path == "/api/runs/run" {
        body =
          #"{"status":"done","partial":"Keep the answer","result":{"status":"ok","reply":"Keep the answer"}}"#
      } else if path == "/api/sessions/chat" {
        if request.url?.query?.contains("beforeSeq") == true {
          body =
            #"{"items":[{"kind":"UserMessage","seq":0,"createdAt":1,"text":"Earlier","body":{}},{"kind":"AgentMessage","seq":1,"createdAt":2,"text":"Answer","body":{}}],"earlierItems":0}"#
        } else if request.url!.host!.hasPrefix("history-") {
          body =
            #"{"items":[{"kind":"UserMessage","seq":2,"createdAt":3,"text":"Current","body":{}}],"earlierItems":2}"#
        } else {
          status = 503
        }
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": contentType])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}
}

@MainActor
final class ChatTests: XCTestCase {
  func model(prefix: String = "") -> ChatModel {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ChatScenarioProtocol.self]
    let base = URL(string: "https://\(prefix)\(UUID().uuidString).example.test")!
    addTeardownBlock { DraftStore.removeAccount(base.absoluteString + "test") }
    return ChatModel(
      conversation: Conversation(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: APIClient(baseURL: base, configuration: config), user: "test", knownSession: true)
  }

  func approval() throws -> Approval {
    try JSONDecoder().decode(
      Approval.self,
      from: Data(
        #"{"requestId":"approval","command":"publish","grantModes":{"session":false,"always":false}}"#
          .utf8))
  }

  func testUnconfirmedApprovalKeepsDecisionAvailable() async throws {
    let chat = model(prefix: "unconfirmed-")
    let pending = try approval()
    chat.approvals = [pending]
    await chat.decide(pending, approved: true)
    XCTAssertEqual(chat.approvals.map(\.id), [pending.id])
    XCTAssertEqual(chat.error, "Decision not confirmed")
    XCTAssertFalse(chat.sending)
  }

  func testLostApprovalAcknowledgmentKeepsDecisionAvailable() async throws {
    let chat = model(prefix: "lost-")
    let pending = try approval()
    chat.approvals = [pending]
    await chat.decide(pending, approved: false)
    XCTAssertEqual(chat.approvals.map(\.id), [pending.id])
    XCTAssertNotNil(chat.error)
    XCTAssertFalse(chat.sending)
  }

  func testUnavailableApprovalGrantsCannotBeSubmitted() async throws {
    let chat = model(prefix: "forbidden-")
    let pending = try approval()
    chat.approvals = [pending]
    for scope in ["session", "always", "invalid"] {
      await chat.decide(pending, approved: true, scope: scope)
    }
    XCTAssertEqual(chat.approvals.map(\.id), [pending.id])
    XCTAssertNil(chat.error)
    XCTAssertFalse(chat.sending)
  }

  func testConfirmedApprovalSurvivesUnavailableTranscript() async throws {
    let chat = model(prefix: "completed-")
    let pending = try approval()
    chat.approvals = [pending]
    await chat.decide(pending, approved: true)
    XCTAssertTrue(chat.approvals.isEmpty)
    XCTAssertEqual(chat.messages.last?.text, "Decision recorded")
    XCTAssertFalse(chat.sending)
  }

  func testIdleReconciliationPreservesLoadedHistory() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatScenarioProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://history-\(UUID().uuidString).example.test")!,
      configuration: configuration)
    let chat = ChatModel(
      conversation: .init(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true)
    await chat.refresh()
    await chat.loadEarlier()
    XCTAssertEqual(chat.items.compactMap(\.seq), [0, 1, 2])
    await chat.refresh()
    XCTAssertEqual(chat.items.compactMap(\.seq), [0, 1, 2])
    XCTAssertEqual(chat.earlierItems, 0)
  }

  func testQueuedSuccessorResumesAfterPreviousRunFinishes() async throws {
    let chat = model()
    try chat.client.saveSession("test-session")
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    for _ in 0..<100 {
      if chat.activeRunID == nil && chat.messages.last?.text == "Keep the answer" { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    await chat.reconcileActivity(QueuedInputsResponse(runId: "next", queued: []))
    for _ in 0..<100 {
      if chat.activeRunID == nil && chat.messages.last?.text == "Queued successor completed" {
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.messages.map(\.text), ["Keep the answer", "Queued successor completed"])
  }

  func testRejectedSendCanBeEdited() async {
    let chat = model()
    chat.draft = "An oversized request"
    await chat.send()
    XCTAssertNil(chat.pending)
    XCTAssertEqual(chat.draft, "An oversized request")
    XCTAssertNotNil(chat.error)
  }

  func testConcurrentPaginationDoesNotDuplicateMessages() async throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(#"[{"kind":"UserMessage","seq":2,"createdAt":3,"text":"Current","body":{}}]"#.utf8)
    )
    async let first: Void = chat.loadEarlier()
    async let second: Void = chat.loadEarlier()
    _ = await (first, second)
    XCTAssertEqual(chat.items.compactMap(\.seq), [0, 1, 2])
  }

  func testTerminalReplySurvivesFailedTranscriptRefresh() async throws {
    let chat = model()
    await chat.resume()
    defer { chat.pause() }
    for _ in 0..<100 {
      if chat.activeRunID == nil && chat.messages.last?.text == "Keep the answer"
        && chat.error != nil
      {
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.messages.last?.text, "Keep the answer")
    XCTAssertNotNil(chat.error)
  }
}
