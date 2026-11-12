import XCTest
import os

@testable import QM

private final class ChatRecoveryProtocol: URLProtocol, @unchecked Sendable {
  enum Scenario: Sendable {
    case unavailable(Int, disconnected: Bool)
    case malformed
    case fallback
    case transient
    case transientSendFailure
    case openingUnavailable(activeLookupFails: Bool)
  }

  struct State: Sendable {
    let scenario: Scenario
    var recovered = false
    var requests: [String: Int] = [:]
  }

  private static let registry = OSAllocatedUnfairLock(initialState: [String: State]())
  private static let answer =
    #"{"status":"done","result":{"status":"ok","reply":"Recovered answer"}}"#
  private static let history =
    #"{"entries":[{"type":"user","seq":1,"createdAt":1,"payload":{"text":"Earlier question"}},{"type":"assistant","seq":2,"createdAt":2,"payload":{"text":"Earlier answer"}},{"type":"user","seq":3,"createdAt":3,"payload":{"text":"Question","runId":"run"}}]}"#

  static func configure(_ host: String, scenario: Scenario) {
    registry.withLock { $0[host] = State(scenario: scenario) }
  }

  static func recover(_ host: String) {
    registry.withLock { $0[host]?.recovered = true }
  }

  static func count(_ host: String, path: String) -> Int {
    registry.withLock { $0[host]?.requests[path, default: 0] ?? 0 }
  }

  static func remove(_ host: String) {
    _ = registry.withLock { $0.removeValue(forKey: host) }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let url = request.url!
    let known = Self.registry.withLock { states -> State? in
      states[url.host!]?.requests[url.path, default: 0] += 1
      return states[url.host!]
    }
    guard let state = known else {
      client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
      return
    }
    var status = 200
    var body = "{}"
    var contentType = "application/json"
    var finish = true
    switch url.path {
    case "/api/runs/active":
      if case .openingUnavailable(let activeLookupFails) = state.scenario, !state.recovered {
        status = activeLookupFails ? 503 : 200
        body = #"{"runId":null}"#
      } else {
        body =
          state.requests["/api/turn", default: 0] > 0
          ? #"{"runId":"run","queued":[{"runId":"next","text":"New follow-up"}]}"#
          : #"{"runId":"run","queued":[]}"#
      }
    case "/api/turn":
      if case .transientSendFailure = state.scenario {
        status = 503
        body = #"{"message":"Could not send follow-up."}"#
      } else {
        status = 202
        body = #"{"runId":"next","status":"queued"}"#
      }
    case "/api/sessions/chat":
      body = Self.history
      if case .openingUnavailable = state.scenario, !state.recovered { status = 503 }
    case "/api/sessions/chat/approvals":
      body = #"{"approvals":[]}"#
    case "/api/runs/run/events":
      contentType = "text/event-stream"
      if state.recovered
        || (isTransient(state.scenario) && state.requests[url.path, default: 0] > 1)
      {
        if case .transientSendFailure = state.scenario {
          body =
            "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":{\"status\":\"running\",\"partial\":\"Recovered response\"}}\n\n"
          finish = false
        } else {
          body = "data: {\"type\":\"CUSTOM\",\"name\":\"run\",\"value\":\(Self.answer)}\n\n"
        }
      } else {
        switch state.scenario {
        case .unavailable(_, disconnected: true), .transient, .transientSendFailure:
          client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
          return
        default:
          status = 404
          body = #"{"message":"Streaming is unavailable."}"#
        }
      }
    case "/api/runs/run":
      if state.recovered {
        body = Self.answer
      } else {
        switch state.scenario {
        case .unavailable(let code, _):
          status = code
          body = #"{"message":"This run can no longer be accessed."}"#
        case .malformed:
          body = #"{"status":7}"#
        case .fallback, .openingUnavailable:
          body = Self.answer
        case .transient, .transientSendFailure:
          status = 503
          body = #"{"message":"The run service is temporarily unavailable."}"#
        }
      }
    default:
      status = 404
    }
    let response = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: nil,
      headerFields: ["Content-Type": contentType])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    if finish { client?.urlProtocolDidFinishLoading(self) }
  }

  private func isTransient(_ scenario: Scenario) -> Bool {
    switch scenario {
    case .transient, .transientSendFailure: true
    default: false
    }
  }

  override func stopLoading() {}
}

@MainActor
final class ChatRecoveryTests: XCTestCase {
  private let history = ["Earlier question", "Earlier answer", "Question"]

  private func chat(_ scenario: ChatRecoveryProtocol.Scenario) throws -> ChatModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatRecoveryProtocol.self]
    let url = URL(string: "https://recovery-\(UUID().uuidString).example.test")!
    ChatRecoveryProtocol.configure(url.host!, scenario: scenario)
    addTeardownBlock {
      ChatRecoveryProtocol.remove(url.host!)
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

  private func count(_ chat: ChatModel, _ path: String) -> Int {
    ChatRecoveryProtocol.count(chat.client.baseURL.host!, path: path)
  }

  private func until(
    _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line
  ) async throws -> Bool {
    for _ in 0..<800 {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("The chat never reached the expected recovery state", file: file, line: line)
    return false
  }

  func testRejectedRunStopsAutomaticRecoveryAndExplicitRetryCanSucceed() async throws {
    for scenario in [
      ChatRecoveryProtocol.Scenario.unavailable(404, disconnected: false),
      .unavailable(403, disconnected: true),
    ] {
      let chat = try chat(scenario)
      defer {
        chat.pause()
        chat.client.signOut()
      }
      chat.draft = "Keep my unsent message"
      await chat.resume()
      guard
        try await until({
          chat.activeRunID == nil && chat.error == "This run can no longer be accessed."
        })
      else { continue }
      XCTAssertEqual(chat.messages.map(\.text), history)
      XCTAssertEqual(chat.draft, "Keep my unsent message")
      XCTAssertEqual(count(chat, "/api/runs/run/events"), 1)
      XCTAssertEqual(count(chat, "/api/runs/run"), 1)
      await chat.reconcileActivity(.init(runId: "run", queued: []))
      await chat.reconcileActivity(.init(runId: nil, queued: []))
      XCTAssertNil(chat.activeRunID)
      XCTAssertEqual(chat.error, "This run can no longer be accessed.")
      XCTAssertEqual(count(chat, "/api/runs/run/events"), 1)
      ChatRecoveryProtocol.recover(chat.client.baseURL.host!)
      await chat.resume()
      guard
        try await until({
          chat.activeRunID == nil && chat.messages.last?.text == "Recovered answer"
        })
      else { continue }
      XCTAssertEqual(chat.messages.map(\.text), history + ["Recovered answer"])
      XCTAssertEqual(chat.draft, "Keep my unsent message")
      XCTAssertEqual(count(chat, "/api/runs/run/events"), 2)
      XCTAssertEqual(count(chat, "/api/turn"), 0)
      XCTAssertNil(chat.error)
    }
  }

  func testUnavailableStreamStillRecoversCompletedRunThroughPolling() async throws {
    let chat = try chat(.fallback)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    guard
      try await until({ chat.activeRunID == nil && chat.messages.last?.text == "Recovered answer" })
    else { return }
    XCTAssertEqual(chat.messages.map(\.text), history + ["Recovered answer"])
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 1)
    XCTAssertEqual(count(chat, "/api/runs/run"), 1)
    XCTAssertNil(chat.error)
  }

  func testExplicitSendAfterMonitoringFailureResumesTheSameActiveRun() async throws {
    let chat = try chat(.unavailable(404, disconnected: false))
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    guard
      try await until({
        chat.activeRunID == nil && chat.error == "This run can no longer be accessed."
      })
    else { return }
    XCTAssertEqual(count(chat, "/api/turn"), 0)
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 1)
    ChatRecoveryProtocol.recover(chat.client.baseURL.host!)
    chat.draft = "New follow-up"
    await chat.send()
    guard
      try await until({
        chat.activeRunID == nil && chat.messages.last?.text == "Recovered answer"
          && chat.error == nil
      })
    else { return }
    XCTAssertEqual(chat.messages.map(\.text), history + ["Recovered answer"])
    XCTAssertEqual(count(chat, "/api/turn"), 1)
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 2)
    XCTAssertEqual(count(chat, "/api/runs/next/events"), 0)
    XCTAssertTrue(chat.draft.isEmpty)
    XCTAssertNil(chat.pending)
    XCTAssertNil(chat.error)
  }

  func testDisconnectedStreamAndTemporaryPollingFailureReconnectToSameRun() async throws {
    let chat = try chat(.transient)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    guard try await until({ chat.reconnecting }) else { return }
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(chat.messages.map(\.text), history)
    XCTAssertFalse(chat.showsWorkingStatus)
    XCTAssertNil(chat.error)
    guard
      try await until({ chat.activeRunID == nil && chat.messages.last?.text == "Recovered answer" })
    else { return }
    XCTAssertEqual(chat.messages.map(\.text), history + ["Recovered answer"])
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 2)
    XCTAssertEqual(count(chat, "/api/runs/run"), 1)
    XCTAssertEqual(count(chat, "/api/turn"), 0)
    XCTAssertFalse(chat.reconnecting)
    XCTAssertNil(chat.error)
  }

  func testReconnectedResponseDoesNotEraseAFailedFollowUp() async throws {
    let chat = try chat(.transientSendFailure)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    guard try await until({ chat.reconnecting }) else { return }
    chat.draft = "Keep this follow-up"
    await chat.send()
    XCTAssertEqual(chat.error, "Could not send follow-up.")
    guard try await until({ chat.partial == "Recovered response" }) else { return }
    XCTAssertFalse(chat.reconnecting)
    XCTAssertEqual(chat.error, "Could not send follow-up.")
    XCTAssertEqual(chat.pending?.text, "Keep this follow-up")
    XCTAssertEqual(chat.draft, "Keep this follow-up")
    XCTAssertEqual(chat.activeRunID, "run")
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 2)
    XCTAssertEqual(count(chat, "/api/turn"), 1)
    await chat.refresh()
    XCTAssertEqual(chat.error, "Could not send follow-up.")
    ChatRecoveryProtocol.recover(chat.client.baseURL.host!)
    await chat.reconcileActivity(.init(runId: nil, queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.messages.last?.text, "Recovered answer")
    XCTAssertEqual(chat.error, "Could not send follow-up.")
    XCTAssertEqual(chat.pending?.text, "Keep this follow-up")
  }

  func testOpeningWithoutAConnectionRecoversWithoutRetryOrResending() async throws {
    for activeLookupFails in [true, false] {
      let chat = try chat(.openingUnavailable(activeLookupFails: activeLookupFails))
      defer {
        chat.pause()
        chat.client.signOut()
      }
      chat.draft = "Keep my draft"
      await chat.resume(refreshInterval: .milliseconds(20))
      XCTAssertTrue(chat.reconnecting)
      XCTAssertFalse(chat.hasLoadedTranscript)
      XCTAssertNil(chat.error)
      ChatRecoveryProtocol.recover(chat.client.baseURL.host!)
      guard
        try await until({
          chat.activeRunID == nil && chat.messages.last?.text == "Recovered answer"
        })
      else { continue }
      XCTAssertEqual(chat.messages.map(\.text), history + ["Recovered answer"])
      XCTAssertEqual(chat.draft, "Keep my draft")
      XCTAssertGreaterThanOrEqual(count(chat, "/api/runs/active"), 2)
      XCTAssertEqual(count(chat, "/api/turn"), 0)
      XCTAssertTrue(chat.hasLoadedTranscript)
      XCTAssertFalse(chat.reconnecting)
      XCTAssertNil(chat.error)
    }
  }

  func testMalformedRunStopsMonitoringWithReadableErrorAndKeepsHistory() async throws {
    let chat = try chat(.malformed)
    defer {
      chat.pause()
      chat.client.signOut()
    }
    await chat.resume()
    guard try await until({ chat.activeRunID == nil && chat.error != nil }) else { return }
    let error = try XCTUnwrap(chat.error)
    XCTAssertFalse(error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    XCTAssertFalse(error.contains("Reconnecting"))
    XCTAssertEqual(chat.messages.map(\.text), history)
    await chat.reconcileActivity(.init(runId: "run", queued: []))
    XCTAssertNil(chat.activeRunID)
    XCTAssertEqual(chat.error, error)
    XCTAssertEqual(count(chat, "/api/runs/run/events"), 1)
    XCTAssertEqual(count(chat, "/api/runs/run"), 1)
  }
}
