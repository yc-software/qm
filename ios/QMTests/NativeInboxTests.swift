import XCTest
import os

@testable import QM

final class InboxFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let paths = OSAllocatedUnfairLock(initialState: [String]())
  static let item =
    #"{"id":"i1","loopId":"l1","state":"processed","source":"gmail","sourcePayload":{"title":"Review this","from":"test@example.com"},"proposal":{"data":{"body":"Server draft","to":["test@example.com"]},"by":"agent","at":123},"thread":[],"updatedAt":123}"#
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.paths.withLock { $0.append(request.url!.path) }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(("{\"item\":" + Self.item + "}").utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class NativeInboxTests: XCTestCase {
  func model() throws -> InboxDetailModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [InboxFixtureProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID()).example.test")!, configuration: configuration)
    let item = try JSONDecoder().decode(
      NativeInboxItem.self, from: Data(InboxFixtureProtocol.item.utf8))
    return InboxDetailModel(client: client, user: "test", item: item)
  }
  func testInboxDraftSurvivesReopeningWithOriginalProposalVersion() async throws {
    let first = try model()
    let account = first.client.baseURL.absoluteString + "test"
    defer { DraftStore.removeAccount(account) }
    await first.load()
    first.text = "My unsaved reply"
    first.to = "review@example.com"
    first.persistDraft()
    let reopened = InboxDetailModel(client: first.client, user: "test", item: first.item)
    await reopened.load()
    XCTAssertEqual(reopened.text, "My unsaved reply")
    XCTAssertEqual(reopened.to, "review@example.com")
    XCTAssertEqual(reopened.proposalAt, 123)
    XCTAssertTrue(reopened.dirty)
    XCTAssertTrue(DraftStore.conversations(account).isEmpty)
    await reopened.discardDraft()
    XCTAssertEqual(reopened.text, "Server draft")
    XCTAssertNil(reopened.drafts.read().inbox)
  }
  func testFollowupSurvivesReopeningAndReplyDiscard() async throws {
    let first = try model()
    defer { DraftStore.removeAccount(first.client.baseURL.absoluteString + "test") }
    await first.load()
    first.followup = "Check the proposed delivery date"
    first.persistDraft()
    let reopened = InboxDetailModel(client: first.client, user: "test", item: first.item)
    await reopened.load()
    XCTAssertEqual(reopened.followup, "Check the proposed delivery date")
    XCTAssertFalse(reopened.dirty)
    reopened.text = "Unsent reply"
    await reopened.discardDraft()
    XCTAssertEqual(reopened.drafts.read().text, "Check the proposed delivery date")
    reopened.followup = ""
    reopened.persistDraft()
    XCTAssertEqual(reopened.drafts.read().text, "")
  }
  func testSignOutPreventsLateInboxAndConversationDraftWrites() async throws {
    let inbox = try model()
    let account = inbox.client.baseURL.absoluteString + "test"
    defer { DraftStore.removeAccount(account) }
    let chat = DraftStore(account: account, thread: "chat")
    await inbox.load()
    inbox.text = "Private reply"
    inbox.persistDraft()
    DraftStore.removeAccount(account)
    inbox.persistDraft()
    XCTAssertThrowsError(try chat.write(.init(text: "Late private chat")))
    XCTAssertNil(inbox.drafts.read().inbox)
    let signedInAgain = DraftStore(account: account, thread: "chat")
    try signedInAgain.write(.init(text: "New session"))
    XCTAssertEqual(signedInAgain.read().text, "New session")
  }
  func testInboundDraftRequestUsesFollowupEndpoint() async throws {
    InboxFixtureProtocol.paths.withLock { $0 = [] }
    let inbox = try model()
    defer { DraftStore.removeAccount(inbox.client.baseURL.absoluteString + "test") }
    await inbox.load()
    let success = await inbox.requestDraft()
    XCTAssertTrue(success)
    XCTAssertEqual(
      InboxFixtureProtocol.paths.withLock { $0.last }, "/api/loops/l1/items/i1/followup")
  }
  func testSentChatUsesMetadataHeadersOnlyWhenProposalDoesNotSpecifyThem() async throws {
    let inbox = try model()
    defer { DraftStore.removeAccount(inbox.client.baseURL.absoluteString + "test") }
    let data = Data(
      #"{"id":"sent","loopId":"l1","state":"processed","source":"gmail","sourcePayload":{"sentChat":true,"gmail":{"to":["recipient@example.com"],"cc":["copy@example.com"],"subject":"Original subject"}},"proposal":{"data":{"body":""},"by":"human","at":99},"thread":[],"updatedAt":99}"#
        .utf8)
    let item = try JSONDecoder().decode(NativeInboxItem.self, from: data)
    let detail = NativeInboxDetail(item: item, outputs: nil)
    inbox.accept(detail)
    XCTAssertEqual(inbox.to, "recipient@example.com")
    XCTAssertEqual(inbox.cc, "copy@example.com")
    XCTAssertEqual(inbox.subject, "Original subject")
    let cleared = String(data: data, encoding: .utf8)!.replacingOccurrences(
      of: #""data":{"body":""}"#, with: #""data":{"body":"","to":[],"cc":[],"subject":""}"#)
    inbox.accept(
      .init(
        item: try JSONDecoder().decode(NativeInboxItem.self, from: Data(cleared.utf8)), outputs: nil
      ))
    XCTAssertEqual(inbox.to, "")
    XCTAssertEqual(inbox.cc, "")
    XCTAssertEqual(inbox.subject, "")
  }
  func testSentMailTextDoesNotRenderExecutableOrRemoteHTML() {
    XCTAssertEqual(
      NativeSentEmail.plain(
        "<style>hide</style><p>Hello<br>world &amp; &#x1F44B;</p><script>secret()</script><img src='https://tracker.example'>"
      ), "Hello\nworld & 👋")
    XCTAssertEqual(
      NativeSentEmail.plain(
        "<!-- <p>hidden</p> --><a title=\"a>b\">1 &lt; 2</a> &bogus; <SCRIPT>if (a<b) {}</SCRIPT>&#39;ok&#39;"
      ), "1 < 2 &bogus; 'ok'")
  }
}
