import CryptoKit
import XCTest
import os

@testable import QM

final class AttachmentSubmissionProtocol: URLProtocol, @unchecked Sendable {
  static let requests = OSAllocatedUnfairLock(initialState: [URLRequest]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    captured.httpBody = request.bodyData
    let snapshot = captured
    Self.requests.withLock { $0.append(snapshot) }
    let path = request.url!.path
    var status = 503
    var body = "{}"
    if path == "/api/blobs" {
      status = 200
      let bytes = captured.httpBody ?? Data()
      body = #"{"blobId":"\#(SHA256.hash(data: bytes).hex)","sizeBytes":\#(bytes.count)}"#
    } else if request.url!.host!.hasPrefix("blocked-"), path == "/api/turn" {
      status = 200
      body =
        #"{"status":"pending_approval","reason":"This conversation is waiting for someone else to resolve a pending approval."}"#
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
  func testSendingIntoAConversationBlockedOnAnApprovalKeepsTheMessage() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let base = URL(string: "https://blocked-\(UUID().uuidString).example.test")!
    let client = APIClient(baseURL: base, configuration: configuration)
    defer { DraftStore.removeAccount(base.absoluteString + "test") }
    let chat = ChatModel(
      conversation: Conversation(
        id: "shared", scopeId: "group:web-project-p1", threadRef: "web:test:shared",
        surface: "web", canContinue: true),
      client: client, user: "test", knownSession: true)
    chat.draft = "Ship it once the approval clears"

    await chat.send()

    XCTAssertEqual(chat.draft, "Ship it once the approval clears")
    XCTAssertNil(chat.pending)
    XCTAssertEqual(
      chat.error,
      "This conversation is waiting for someone else to resolve a pending approval.")
  }

  func testUnpreparedAttachmentCanBeRemovedAndDraftEditedAfterRelaunch() async throws {
    for sha in [nil, String(repeating: "f", count: 64)] as [String?] {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
      let base = URL(string: "https://\(UUID().uuidString).example.test")!
      let client = APIClient(baseURL: base, configuration: configuration)
      let account = base.absoluteString + "test"
      defer { DraftStore.removeAccount(account) }
      let conversation = Conversation(
        id: "draft", scopeId: "personal:test", threadRef: "web:test:draft", surface: "web",
        localOnly: true)
      let chat = ChatModel(
        conversation: conversation, client: client, user: "test", knownSession: false)
      let attachment = UploadAttachment(
        name: "notes.txt", mimetype: "text/plain", sizeBytes: 3, blobId: "expired",
        localSHA: sha, uploadedAt: 0)
      chat.draft = "Send these notes"
      chat.attachments = [attachment]

      await chat.send()

      XCTAssertNotNil(chat.error)
      XCTAssertFalse(chat.sending)
      XCTAssertNil(chat.pending)
      XCTAssertEqual(chat.draft, "Send these notes")
      XCTAssertEqual(chat.attachments, [attachment])
      XCTAssertFalse(
        AttachmentSubmissionProtocol.requests.withLock {
          $0.contains { $0.url?.host == base.host }
        })

      let restored = ChatModel(
        conversation: conversation, client: client, user: "test", knownSession: false)
      XCTAssertNil(restored.pending)
      XCTAssertEqual(restored.draft, "Send these notes")
      XCTAssertEqual(restored.attachments, [attachment])
      restored.attachments.removeAll()
      restored.draft = "Send the revised text instead"
      await restored.send()

      let turns = AttachmentSubmissionProtocol.requests.withLock {
        $0.filter { $0.url?.host == base.host && $0.url?.path == "/api/turn" }
      }
      XCTAssertEqual(turns.count, 1)
      let body = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: XCTUnwrap(turns.first?.httpBody)) as? [String: Any])
      XCTAssertEqual(body["text"] as? String, "Send the revised text instead")
      XCTAssertEqual((body["attachments"] as? [[String: Any]])?.count, 0)
    }
  }

  func testPreparationFailureOnUncertainRetryKeepsOriginalSubmission() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let base = URL(string: "https://\(UUID().uuidString).example.test")!
    let client = APIClient(baseURL: base, configuration: configuration)
    let account = base.absoluteString + "test"
    defer { DraftStore.removeAccount(account) }
    let conversation = Conversation(
      id: "draft", scopeId: "personal:test", threadRef: "web:test:draft", surface: "web",
      localOnly: true)
    let chat = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    chat.draft = "Send exactly once"
    chat.attachments = [
      UploadAttachment(
        name: "notes.txt", mimetype: "text/plain", sizeBytes: 3, blobId: "uploaded",
        localSHA: String(repeating: "f", count: 64), uploadedAt: Date().timeIntervalSince1970)
    ]
    await chat.send()
    var pending = try XCTUnwrap(chat.pending)
    let originalKey = pending.idempotencyKey
    pending.attachments?[0].uploadedAt = 0
    let store = DraftStore(account: account, thread: conversation.threadRef)
    try store.write(
      .init(
        text: chat.draft, pending: pending, conversation: conversation,
        attachments: pending.attachments))
    let restored = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)

    await restored.send()

    XCTAssertNotNil(restored.error)
    XCTAssertEqual(restored.pending?.idempotencyKey, originalKey)
    XCTAssertEqual(restored.pending?.text, "Send exactly once")
    XCTAssertEqual(restored.pending?.attachments?.first?.blobId, "uploaded")
    XCTAssertEqual(store.read().pending?.idempotencyKey, originalKey)
    XCTAssertEqual(
      AttachmentSubmissionProtocol.requests.withLock {
        $0.filter { $0.url?.host == base.host && $0.url?.path == "/api/turn" }.count
      }, 1)
  }

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

  func testEditingAfterAFailedSendSubmitsTheEditedTextUnderANewKey() async throws {
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
    chat.draft = "First wording"
    await chat.send()
    XCTAssertEqual(chat.draft, "First wording")
    chat.draft = "Second wording"
    await chat.send()
    let bodies = try AttachmentSubmissionProtocol.requests.withLock { $0 }
      .filter { $0.url?.host == base.host && $0.url?.path == "/api/turn" }
      .map { turn in
        try XCTUnwrap(
          try JSONSerialization.jsonObject(with: XCTUnwrap(turn.httpBody)) as? [String: Any])
      }
    XCTAssertEqual(bodies.map { $0["text"] as? String }, ["First wording", "Second wording"])
    XCTAssertNotEqual(
      bodies.first?["idempotencyKey"] as? String, bodies.last?["idempotencyKey"] as? String)
    XCTAssertEqual(chat.draft, "")
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
    XCTAssertEqual(first.attachments?.first?.blobId, sha)
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
      XCTAssertEqual(attachments.first?["blobId"] as? String, sha)
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
