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
            #"{"items":[{"seq":0,"createdAt":1,"kind":"UserMessage","text":"Earlier","body":{"speakerId":"alice"}},{"seq":1,"createdAt":2,"kind":"AgentMessage","text":"Answer","body":{}}],"earlierItems":0}"#
        } else if request.url!.host!.hasPrefix("history-") {
          body =
            #"{"items":[{"seq":2,"createdAt":3,"kind":"UserMessage","text":"Current","body":{"speakerId":"alice"}}],"earlierItems":2}"#
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
  func testAgentPromptBoundaryIgnoresHiddenInputsAndSubagentReturns() throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1000,"kind":"UserMessage","text":"Review this","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2000,"kind":"UserMessage","hidden":true,"text":"Continue","body":{}},{"seq":3,"createdAt":3000,"kind":"UserMessage","text":"<wake reason=\"subagent\" name=\"Scout\" sessionId=\"child\" kind=\"final_answer\">Done</wake>","body":{}},{"seq":4,"createdAt":4000,"kind":"AgentMessage","text":"Here is the result","body":{}}]"#
          .utf8))
    XCTAssertEqual(chat.latestPromptAt, 1000)
    chat.draft = "A new draft"
    chat.pending = PendingSend(text: chat.draft, idempotencyKey: "retry")
    XCTAssertEqual(chat.latestPromptAt, 1000)
    chat.items.append(
      try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"seq":5,"createdAt":5000,"kind":"UserMessage","text":"The next question","body":{"speakerId":"alice"}}"#
            .utf8)))
    XCTAssertEqual(chat.latestPromptAt, 5000)
  }

  func testWorkingStatusPersistsAcrossToolsAndQuietPartialGapsUntilTheRunStops() throws {
    let chat = model()
    XCTAssertNil(chat.workStatus)
    chat.activeRunID = "run"
    XCTAssertEqual(chat.workStatus, .working)
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","turnId":"run","text":"Check","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2,"kind":"Reasoning","text":"Consider the question","body":{}}]"#
          .utf8))
    XCTAssertEqual(chat.workStatus, .working)
    chat.items.append(
      try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"search","tool":"search","body":{}}"#
            .utf8)))
    XCTAssertEqual(chat.workStatus, .working)
    chat.items.append(
      try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"search","body":{"ok":true}}"#
            .utf8)))
    XCTAssertEqual(chat.workStatus, .working)
    chat.partial = "Here is the answer"
    XCTAssertEqual(chat.workStatus, .working)
    XCTAssertEqual(chat.displayedPartial, "Here is the answer")
    chat.partial = ""
    XCTAssertEqual(chat.workStatus, .working)
    chat.approvals = [try approval()]
    XCTAssertEqual(chat.workStatus, .awaitingInput)
    chat.approvals = []
    chat.error = "The next prompt could not be sent"
    XCTAssertEqual(chat.workStatus, .working)
    chat.error = nil
    chat.activeRunID = nil
    XCTAssertNil(chat.workStatus)
  }

  func testSlackMessagesShowNamesAndLinksInsteadOfWireTokens() throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"UserMessage","externalId":"1.1","text":"<@U1|ada> and <!here>: see <https://docs.example/plan|the plan> in <#C1|launch> &lt;today&gt; &amp; reply","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2,"kind":"SteeringMessage","externalId":"queued-steer:web:test:chat:run","text":"Return Result<T, E> &amp; ping <@U1|ada>","body":{}}]
        """#.utf8))
    XCTAssertEqual(
      chat.messages.map(\.text),
      [
        "<@U1|ada> and <!here>: see <https://docs.example/plan|the plan> in <#C1|launch> &lt;today&gt; &amp; reply",
        "Return Result<T, E> &amp; ping <@U1|ada>",
      ])
    chat.conversation.surface = "slack"
    XCTAssertEqual(
      chat.messages.map(\.text),
      [
        #"@ada and @here: see [the plan](https://docs.example/plan) in #launch \<today> & reply"#,
        #"Return Result\<T, E> & ping @ada"#,
      ])
    XCTAssertEqual(
      SlackText.plain("<@U1|ada> see <https://docs.example/plan|the plan> &lt;3 <not a token"),
      "@ada see the plan <3 <not a token")
  }

  func testAgentActivityRetainsCurrentCompletedSpawnsAfterTheRunEnds() throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":0,"createdAt":1000,"kind":"UserMessage","turnId":"old","text":"Earlier question","body":{"speakerId":"alice"}},{"seq":1,"createdAt":1100,"kind":"ToolCall","callId":"old-spawn","tool":"subagents","body":{"action":"open"}},{"seq":2,"createdAt":1200,"kind":"ToolResult","callId":"old-spawn","body":{"ok":true,"sessionId":"old-agent"}},{"seq":3,"createdAt":2000,"kind":"UserMessage","turnId":"current","text":"Current question","body":{"speakerId":"alice"}},{"seq":4,"createdAt":2100,"kind":"ToolCall","callId":"pending-spawn","tool":"subagents","body":{"action":"open"}},{"seq":5,"createdAt":2200,"kind":"ToolCall","callId":"started-spawn","tool":"subagents","body":{"action":"open"}},{"seq":6,"createdAt":2300,"kind":"ToolResult","callId":"started-spawn","body":{"ok":true,"sessionId":"current-agent"}}]
        """#.utf8))
    chat.activeRunID = "current"
    XCTAssertEqual(
      chat.agentActivity.compactMap { $0.entry.callId },
      ["pending-spawn", "started-spawn"])
    XCTAssertEqual(chat.agentActivity.map { $0.state(active: true) }, [.running, .complete])
    chat.activeRunID = nil
    XCTAssertEqual(chat.agentActivity.compactMap(\.agentSessionID), ["current-agent"])
    XCTAssertEqual(chat.agentActivity.first?.entry.callId, "started-spawn")
    chat.items.append(
      try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"seq":7,"createdAt":3000,"kind":"UserMessage","turnId":"next","text":"Next question","body":{"speakerId":"alice"}}"#
            .utf8)))
    XCTAssertTrue(chat.agentActivity.isEmpty)
  }

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

  func testServerDeniedMutationsAreBlockedAndPermittedMutationsReachTheServer() async throws {
    let file = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).txt")
    try Data("abc".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    for parent in [nil, "parent"] as [String?] {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
      let base = URL(string: "https://\(UUID().uuidString).example.test")!
      let chat = ChatModel(
        conversation: Conversation(
          id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
          canContinue: parent == nil, parentSessionId: parent),
        client: APIClient(baseURL: base, configuration: configuration), user: "test",
        knownSession: true)
      defer { DraftStore.removeAccount(chat.attachmentAccount) }
      chat.draft = "Check the task"
      chat.pending = PendingSend(text: chat.draft, idempotencyKey: "saved")
      chat.activeRunID = "run"
      let approval = try approval()
      chat.approvals = [approval]

      await chat.send()
      await chat.decide(approval, approved: true)
      await chat.stop()
      let fork = await chat.fork()
      XCTAssertNil(fork)
      chat.addAttachments([.file(file)])
      await chat.attachmentUploadTask?.value
      await chat.uploadAttachments([.file(file)])

      let paths = Set(
        AttachmentSubmissionProtocol.requests.withLock {
          $0.filter { $0.url?.host == base.host }.compactMap { $0.url?.path }
        })
      if parent == nil {
        XCTAssertEqual(
          paths,
          [
            "/api/turn", "/api/approvals/approval", "/api/runs/run/signal",
            "/api/sessions/chat/fork", "/api/blobs",
          ])
      } else {
        XCTAssertTrue(paths.isEmpty)
        XCTAssertEqual(chat.draft, "Check the task")
        XCTAssertEqual(chat.pending?.idempotencyKey, "saved")
        XCTAssertEqual(chat.approvals.map(\.id), [approval.id])
        XCTAssertTrue(chat.attachments.isEmpty)
        XCTAssertNil(chat.attachmentUploadTask)
        XCTAssertNil(chat.error)
      }
    }
  }

  func testSubagentDoesNotRestoreWritableDraftOrOfferForkPoints() throws {
    let chat = model()
    defer { DraftStore.removeAccount(chat.attachmentAccount) }
    chat.draft = "Previously saved input"
    chat.pending = PendingSend(text: chat.draft, idempotencyKey: "saved")
    chat.attachments = [
      .init(name: "notes.txt", mimetype: "text/plain", sizeBytes: 3, blobId: "blob")
    ]
    chat.saveDraft()
    var child = chat.conversation
    child.parentSessionId = "parent"
    let restored = ChatModel(
      conversation: child, client: chat.client, user: chat.user, knownSession: true)
    restored.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1,"kind":"UserMessage","text":"Check","body":{"speakerId":"alice"}},{"seq":2,"createdAt":2,"kind":"AgentMessage","text":"Done","body":{}}]"#
          .utf8))
    XCTAssertEqual(restored.messages.map(\.text), ["Check", "Done"])
    XCTAssertTrue(restored.draft.isEmpty)
    XCTAssertNil(restored.pending)
    XCTAssertTrue(restored.attachments.isEmpty)
    XCTAssertTrue(restored.forkableMessageIDs.isEmpty)
    let original = ChatModel(
      conversation: chat.conversation, client: chat.client, user: chat.user, knownSession: true)
    XCTAssertEqual(original.draft, "Previously saved input")
    XCTAssertEqual(original.pending?.idempotencyKey, "saved")
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

  func testRejectedSendCanBeEditedWithoutRetiringAgents() async throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":1,"createdAt":1000,"kind":"UserMessage","text":"Previous question","body":{"speakerId":"alice"}}]"#
          .utf8))
    chat.draft = "An oversized request"
    await chat.send()
    XCTAssertNil(chat.pending)
    XCTAssertEqual(chat.draft, "An oversized request")
    XCTAssertNotNil(chat.error)
    XCTAssertEqual(chat.latestPromptAt, 1000)
  }

  func testConcurrentPaginationDoesNotDuplicateMessages() async throws {
    let chat = model()
    chat.items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"[{"seq":2,"createdAt":3,"kind":"UserMessage","text":"Current","body":{"speakerId":"alice"}}]"#
          .utf8))
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
        && chat.reconnecting
      {
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.messages.last?.text, "Keep the answer")
    XCTAssertTrue(chat.reconnecting)
    XCTAssertNil(chat.error)
  }
}
