import XCTest
import os

@testable import QM

final class AttachmentSubmissionProtocol: URLProtocol, @unchecked Sendable {
  static let requests = OSAllocatedUnfairLock(initialState: [URLRequest]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if captured.httpBody == nil, let stream = captured.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
      }
      captured.httpBody = data
    }
    let snapshot = captured
    Self.requests.withLock { $0.append(snapshot) }
    let path = request.url!.path
    var status = 503
    var body = "{}"
    if path == "/api/blobs" {
      status = 200
      body = #"{"blobId":"restaged","sizeBytes":3}"#
    } else if request.url!.host!.hasPrefix("completed-") {
      if path == "/api/turn" {
        let attempts = Self.requests.withLock { $0.filter { $0.url == request.url }.count }
        if attempts > 1 {
          status = 200
          body = #"{"status":"ok","reply":"Completed exactly once"}"#
        }
      } else if path == "/api/sessions" {
        status = 200
        body = #"{"sessions":[]}"#
      } else if path == "/api/runs/active" {
        status = 200
        body = #"{"runId":null}"#
      }
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class AttachmentSubmissionTests: XCTestCase {
  func testCompletedReplayClearsDraftWithoutCreatingAnotherSubmission() async throws {
    AttachmentSubmissionProtocol.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let base = URL(string: "https://completed-\(UUID().uuidString).example.test")!
    let client = APIClient(baseURL: base, configuration: configuration)
    defer { DraftStore.removeAccount(base.absoluteString + "test") }
    let chat = ChatModel(
      conversation: .init(
        id: "draft", scopeId: "personal:test", threadRef: "web:test:draft", surface: "web",
        localOnly: true),
      client: client, user: "test", knownSession: false)
    chat.draft = "Do this once"
    await chat.send()
    let key = try XCTUnwrap(chat.pending?.idempotencyKey)
    await chat.send()
    XCTAssertNil(chat.pending)
    XCTAssertEqual(chat.draft, "")
    XCTAssertEqual(chat.messages.last?.text, "Completed exactly once")
    await chat.send()
    let turns = AttachmentSubmissionProtocol.requests.withLock {
      $0.filter { $0.url?.path == "/api/turn" }
    }
    XCTAssertEqual(turns.count, 2)
    for turn in turns {
      let body = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: XCTUnwrap(turn.httpBody)) as? [String: Any])
      XCTAssertEqual(body["idempotencyKey"] as? String, key)
    }
  }

  func testExpiredAttachmentRestagesAndUncertainRetryKeepsItsKey() async throws {
    AttachmentSubmissionProtocol.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let base = URL(string: "https://\(UUID().uuidString).example.test")!
    let client = APIClient(baseURL: base, configuration: configuration)
    let account = base.absoluteString + "test"
    let conversation = Conversation(
      id: "draft", scopeId: "personal:test", threadRef: "web:test:draft", surface: "web",
      localOnly: true)
    let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    defer { DraftStore.removeAccount(account) }
    try AttachmentCache.write(
      attachmentFixture(), account: account, generation: AttachmentCache.generation)
    let chat = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    chat.attachments = [
      .init(
        name: "proof.txt", mimetype: "text/plain", sizeBytes: 3, blobId: "expired",
        localSHA: sha, uploadedAt: Date().timeIntervalSince1970 - 8 * 60 * 60)
    ]
    await chat.send()
    let first = try XCTUnwrap(chat.pending)
    XCTAssertEqual(first.attachments?.first?.blobId, "restaged")
    XCTAssertFalse(DraftStore.conversations(account).isEmpty)
    let restored = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    await restored.send()
    XCTAssertEqual(restored.pending?.idempotencyKey, first.idempotencyKey)
    let requests = AttachmentSubmissionProtocol.requests.withLock { $0 }
    XCTAssertEqual(requests.filter { $0.url?.path == "/api/blobs" }.count, 1)
    XCTAssertEqual(requests.first { $0.url?.path == "/api/blobs" }?.httpBody, Data("abc".utf8))
    let turns = requests.filter { $0.url?.path == "/api/turn" }
    XCTAssertEqual(turns.count, 2)
    for turn in turns {
      let body = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: XCTUnwrap(turn.httpBody)) as? [String: Any])
      let attachments = try XCTUnwrap(body["attachments"] as? [[String: Any]])
      XCTAssertEqual(attachments.first?["blobId"] as? String, "restaged")
      XCTAssertNil(attachments.first?["localSHA"])
      XCTAssertNil(attachments.first?["uploadedAt"])
      XCTAssertEqual(body["idempotencyKey"] as? String, first.idempotencyKey)
    }
  }
  func testRetryRetainsOriginalRuntimeAndFutureDraftKeepsNewSelection() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let base = URL(string: "https://completed-\(UUID().uuidString).example.test")!
    let client = APIClient(baseURL: base, configuration: configuration)
    defer { DraftStore.removeAccount(base.absoluteString + "test") }
    let conversation = Conversation(
      id: "runtime", scopeId: "personal:test", threadRef: "web:test:runtime", surface: "web",
      localOnly: true)
    let chat = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    let first = RuntimeSelection(modelId: "first", effortLevel: "high", fastMode: false)
    let second = RuntimeSelection(modelId: "second", effortLevel: "low", fastMode: true)
    chat.selectRuntime(first)
    chat.draft = "Runtime QA"
    await chat.send()
    chat.selectRuntime(second)
    let restored = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    XCTAssertEqual(restored.runtimeSelection, second)
    XCTAssertEqual(restored.pending?.runtime, first)
    await restored.send()
    let requests = AttachmentSubmissionProtocol.requests.withLock { $0 }
    let turns = requests.filter { $0.url?.host == base.host && $0.url?.path == "/api/turn" }
    XCTAssertEqual(turns.count, 2)
    for request in turns {
      let body = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
      XCTAssertEqual(body["model"] as? String, "first")
      XCTAssertEqual(body["thinkingLevel"] as? String, "high")
      XCTAssertEqual(body["fastMode"] as? Bool, false)
    }
    XCTAssertFalse(requests.contains { $0.url?.host == base.host && $0.httpMethod == "PUT" })
    XCTAssertEqual(
      ChatModel(conversation: conversation, client: client, user: "test", knownSession: false)
        .runtimeSelection, second)
  }

}
