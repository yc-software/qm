import XCTest
import os

@testable import QM

private final class NativeAgentPromptProtocol: URLProtocol, @unchecked Sendable {
  enum Scenario: Sendable { case earlierPrompt, queuedPrompt }

  struct State: Sendable {
    let scenario: Scenario
    var failHistory = false
    var earlierReads = 0
    var queuedRunReads = 0
    var failedHistoryReads = 0
  }

  private static let states = OSAllocatedUnfairLock(initialState: [String: State]())
  private static let prompt =
    #"{"seq":1,"createdAt":1000,"kind":"UserMessage","turnId":"current","text":"Earlier human prompt","body":{}}"#

  static func configure(_ host: String, scenario: Scenario) {
    states.withLock { $0[host] = State(scenario: scenario) }
  }

  static func state(_ host: String) -> State? { states.withLock { $0[host] } }

  static func failHistory(_ host: String) {
    states.withLock { $0[host]?.failHistory = true }
  }

  static func remove(_ host: String) {
    _ = states.withLock { $0.removeValue(forKey: host) }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let url = request.url!
    let before = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
      .first { $0.name == "beforeSeq" }?.value
    guard
      let state = Self.states.withLock({ states -> State? in
        guard var state = states[url.host!] else { return nil }
        if url.path == "/api/sessions/chat" {
          if before != nil { state.earlierReads += 1 }
          if state.failHistory { state.failedHistoryReads += 1 }
        }
        if url.path == "/api/runs/next" { state.queuedRunReads += 1 }
        states[url.host!] = state
        return state
      })
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
      return
    }
    var status = 200
    var contentType = "application/json"
    var finish = true
    let body: String
    switch url.path {
    case "/api/sessions/chat":
      if state.failHistory {
        status = 503
        body = #"{"message":"Transcript temporarily unavailable"}"#
      } else if state.scenario == .earlierPrompt, before == nil {
        let items = (2...26).map { sequence in
          let content =
            sequence.isMultiple(of: 2)
            ? #""hidden":true,"text":"Continue the task""#
            : #""text":"<wake reason=\"subagent\" name=\"Worker\" sessionId=\"child\" kind=\"final_answer\">Finished</wake>""#
          return
            "{\"kind\":\"UserMessage\",\"seq\":\(sequence),\"createdAt\":\(3000 + sequence),\(content),\"body\":{}}"
        }
        body = "{\"items\":[\(items.joined(separator: ","))],\"earlierItems\":1}"
      } else {
        body = "{\"items\":[\(Self.prompt)],\"earlierItems\":0}"
      }
    case "/api/sessions/chat/approvals":
      body = #"{"approvals":[]}"#
    case "/api/runs/active":
      body = #"{"runId":"current","queued":[]}"#
    case "/api/runs/current/events", "/api/runs/next/events":
      contentType = "text/event-stream"
      finish = false
      let input =
        url.path == "/api/runs/next/events"
        ? #", "input":{"runId":"next","seq":null,"text":"Next prompt","createdAt":5000}"#
        : ""
      body =
        "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"running\",\"partial\":\"\"\(input)}}\n\n"
    default:
      status = 404
      body = #"{"message":"Unexpected request"}"#
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: url, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": contentType])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    if finish { client?.urlProtocolDidFinishLoading(self) }
  }

  override func stopLoading() {}
}

@MainActor
final class NativeAgentPromptTests: XCTestCase {
  private func chat(_ scenario: NativeAgentPromptProtocol.Scenario) throws -> ChatModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeAgentPromptProtocol.self]
    let url = URL(string: "https://agent-prompt-\(UUID().uuidString).example.test")!
    NativeAgentPromptProtocol.configure(url.host!, scenario: scenario)
    addTeardownBlock {
      NativeAgentPromptProtocol.remove(url.host!)
      DraftStore.removeAccount(url.absoluteString + "test")
    }
    let client = APIClient(baseURL: url, configuration: configuration)
    try client.saveSession("test")
    return ChatModel(
      conversation: Conversation(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true)
  }

  private var finishedAgent: [NativeAgentBranch] {
    NativeAgentBranch.rows(
      [
        Conversation(
          id: "child", scopeId: "personal:test", threadRef: "agent:child",
          lastActivityAt: 2000, parentSessionId: "chat")
      ], rootID: "chat")
  }

  func testReopenedChatRecoversEarlierPromptWithoutExpandingDisplayedHistory() async throws {
    let chat = try chat(.earlierPrompt)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    let refreshed = await chat.refresh()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(chat.latestPromptAt, 1000)
    XCTAssertEqual(chat.items.compactMap(\.seq), Array(2...26))
    XCTAssertEqual(chat.earlierItems, 1)
    XCTAssertEqual(chat.messages.count, 12)
    XCTAssertTrue(chat.messages.allSatisfy { $0.role == "notice" })
    XCTAssertEqual(
      NativeAgentBranch.current(finishedAgent, since: chat.latestPromptAt).map(\.id), ["child"])
    let refreshedAgain = await chat.refresh()
    XCTAssertTrue(refreshedAgain)
    XCTAssertEqual(chat.latestPromptAt, 1000)
    XCTAssertEqual(chat.items.compactMap(\.seq), Array(2...26))
    XCTAssertEqual(NativeAgentPromptProtocol.state(chat.client.baseURL.host!)?.earlierReads, 1)
  }

  func testQueuedPromptKeepsFinishedAgentsUntilItsRunStarts() async throws {
    let chat = try chat(.queuedPrompt)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    XCTAssertEqual(chat.latestPromptAt, 1000)
    await chat.reconcileActivity(
      .init(
        runId: "current",
        queued: [.init(runId: "next", text: "Next prompt", hasAttachments: nil)]))
    XCTAssertEqual(chat.latestPromptAt, 1000)
    XCTAssertEqual(
      NativeAgentBranch.current(finishedAgent, since: chat.latestPromptAt).map(\.id), ["child"])
    XCTAssertFalse(chat.messages.contains { $0.text == "Next prompt" })
    let host = chat.client.baseURL.host!
    XCTAssertEqual(NativeAgentPromptProtocol.state(host)?.queuedRunReads, 0)
    NativeAgentPromptProtocol.failHistory(host)
    await chat.reconcileActivity(.init(runId: "next", queued: []))
    for _ in 0..<500 {
      if chat.latestPromptAt == 5000 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(chat.activeRunID, "next")
    XCTAssertEqual(chat.latestPromptAt, 5000)
    XCTAssertTrue(NativeAgentBranch.current(finishedAgent, since: chat.latestPromptAt).isEmpty)
    XCTAssertGreaterThan(NativeAgentPromptProtocol.state(host)?.failedHistoryReads ?? 0, 0)
    XCTAssertEqual(chat.messages.last?.text, "Next prompt")
  }
}
