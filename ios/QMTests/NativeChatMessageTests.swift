import SwiftUI
import XCTest
import os

@testable import QM

@MainActor
final class NativeChatMessageTests: XCTestCase {
  func testLongPromptRemainsFullyVisible() throws {
    let renderer = ImageRenderer(
      content: NativeChatMessageView(
        message: ChatMessage(
          id: "prompt", role: "user",
          text: String(repeating: "A longer prompt paragraph.\n\n", count: 20)),
        client: APIClient(baseURL: URL(string: "https://example.test")!),
        showSpeaker: false, user: "test"
      )
      .frame(width: 320))
    renderer.scale = 1
    let image = try XCTUnwrap(renderer.uiImage)
    XCTAssertGreaterThan(image.size.height, 600)
  }

  func testLongAssistantReplyRemainsFullyVisible() throws {
    let renderer = ImageRenderer(
      content: NativeChatMessageView(
        message: ChatMessage(
          id: "reply", role: "assistant",
          text: String(repeating: "A complete answer paragraph.\n\n", count: 20)),
        client: APIClient(baseURL: URL(string: "https://example.test")!),
        showSpeaker: false, user: "test"
      )
      .frame(width: 320))
    renderer.scale = 1
    let image = try XCTUnwrap(renderer.uiImage)
    XCTAssertGreaterThan(image.size.height, 600)
    XCTAssertEqual(image.size.width, 320)
  }
}

@MainActor
final class NativeConversationToolsTests: XCTestCase {
  private var server = NativeRouteProtocol.Server()
  private let replyStatus = "POST /api/composio/slack/reply-status"
  private let reply = "POST /api/composio/slack/reply"
  private let sideChats = "GET /api/sessions/s1/side-chats"
  private let expand = "POST /api/sessions/side1/expand"
  private func client() -> APIClient {
    server = NativeRouteProtocol.Server(
      fallback: .init(status: 404, body: #"{"error":"not_found"}"#))
    return server.client([
      replyStatus: [.init()], reply: [.init()], expand: [.init()],
      "POST /api/sessions/s1/fork": [.init()],
      sideChats: [.init(body: #"{"sessions":[]}"#)],
      "GET /api/sessions/side1/approvals": [.init(body: #"{"approvals":[]}"#)],
      "GET /api/runs/active": [.init(body: #"{"runId":null}"#)],
    ])
  }
  private var requests: [(path: String, body: [String: Any])] {
    server.calls.map { ($0.url.path, $0.json) }
  }
  private func message(role: String, sequence: Int?, text: String = "The answer is 42.")
    -> ChatMessage
  {
    ChatMessage(id: "m1", role: role, text: text, sequence: sequence)
  }

  func testAskAboutIsOfferedOnlyForSavedAssistantMessages() {
    var asked: [String] = []
    func view(_ message: ChatMessage, callback: Bool = true) -> NativeChatMessageView {
      NativeChatMessageView(
        message: message, client: client(), showSpeaker: false, user: "alice",
        onAskAbout: callback ? { asked.append($0.id) } : nil)
    }
    XCTAssertNil(view(message(role: "assistant", sequence: nil)).askAbout)
    XCTAssertNil(view(message(role: "user", sequence: 4)).askAbout)
    XCTAssertNil(view(message(role: "assistant", sequence: 4, text: " \n")).askAbout)
    XCTAssertNil(view(message(role: "assistant", sequence: 4), callback: false).askAbout)
    let offered = view(message(role: "assistant", sequence: 4)).askAbout
    XCTAssertNotNil(offered)
    offered?()
    XCTAssertEqual(asked, ["m1"])
  }

  func testStartingASideChatForksWithTheFirstParagraphAsTheQuote() async throws {
    let client = client()
    server.reply(
      "POST /api/sessions/s1/fork",
      #"{"session":{"id":"side1","scopeId":"user:alice","threadRef":"web:alice:x"}}"#)
    let conversation = try await NativeSideChat.start(
      client: client, sessionID: "s1",
      about: message(
        role: "assistant", sequence: 7,
        text: "\n\nThe answer is 42.\nIt always was.\n\nHere is how I worked it out.\n\nDone."))
    XCTAssertEqual(conversation.id, "side1")
    XCTAssertEqual(requests.map(\.path), ["/api/sessions/s1/fork"])
    let anchor = try XCTUnwrap(requests[0].body["sideChat"] as? [String: Any])
    XCTAssertEqual(anchor["entrySeq"] as? Int, 7)
    XCTAssertEqual(anchor["quote"] as? String, "The answer is 42.\nIt always was.")
    XCTAssertEqual(anchor["occurrence"] as? Int, 0)
    XCTAssertNil(requests[0].body["upToSeq"])

    do {
      _ = try await NativeSideChat.start(
        client: client, sessionID: "s1", about: message(role: "assistant", sequence: nil))
      XCTFail("A message without a saved sequence cannot anchor a side chat")
    } catch {}
    XCTAssertEqual(requests.count, 1)
  }

  func testSlackReplySendsOnlyLinkedNonEmptyTextAndClearsOnSuccess() async {
    let model = NativeSlackReplyModel(client: client(), sessionID: "s1")
    server.reply(replyStatus, #"{"connected":true,"user":"alice","workspace":"Acme"}"#)
    server.reply(reply, #"{"sent":true,"ts":"1700000000.000100"}"#)
    await model.refresh()
    XCTAssertTrue(model.connected)
    XCTAssertTrue(model.linkAvailable)
    XCTAssertEqual(model.user, "alice")
    XCTAssertNil(model.notice)
    XCTAssertEqual(requests[0].body["sessionId"] as? String, "s1")

    model.text = "  \n"
    let blank = await model.send()
    XCTAssertFalse(blank)
    XCTAssertFalse(model.canSend)
    XCTAssertEqual(requests.map(\.path), ["/api/composio/slack/reply-status"])

    model.text = "On it"
    let sent = await model.send()
    XCTAssertTrue(sent)
    XCTAssertEqual(model.text, "")
    XCTAssertNil(model.notice)
    let body = requests[1].body
    XCTAssertEqual(requests[1].path, "/api/composio/slack/reply")
    XCTAssertEqual(body["sessionId"] as? String, "s1")
    XCTAssertEqual(body["text"] as? String, "On it")
    XCTAssertNotNil(UUID(uuidString: body["clientMessageId"] as? String ?? ""))
  }

  func testSlackReplyFailureKeepsTextAndAnExpiredLinkOffersLinkingAgain() async {
    let model = NativeSlackReplyModel(client: client(), sessionID: "s1")
    server.reply(replyStatus, #"{"connected":true,"user":"alice"}"#)
    server.state.withLock { [reply] in
      $0.replies[reply] = [
        .init(status: 403, body: #"{"error":"slack_send_failed","message":"Slack refused it."}"#),
        .init(status: 400, body: #"{"error":"invalid_message"}"#),
        .init(
          status: 409,
          body: #"{"connected":false,"error":"slack_link_required","message":"Link Slack."}"#),
      ]
    }
    await model.refresh()
    model.text = "Still here"
    let failed = await model.send()
    XCTAssertFalse(failed)
    XCTAssertEqual(model.notice, "Slack refused it.")
    XCTAssertEqual(model.text, "Still here")
    XCTAssertTrue(model.connected)

    let invalid = await model.send()
    XCTAssertFalse(invalid)
    XCTAssertEqual(model.notice, "invalid_message")
    XCTAssertEqual(model.text, "Still here")
    XCTAssertTrue(model.connected)

    let expired = await model.send()
    XCTAssertFalse(expired)
    XCTAssertFalse(model.connected)
    XCTAssertTrue(model.linkAvailable)
    XCTAssertEqual(model.notice, "Link Slack.")
    XCTAssertEqual(model.text, "Still here")
    XCTAssertFalse(model.canSend)

    server.reply(replyStatus, #"{"connected":true,"user":"alice"}"#)
    await model.refresh()
    XCTAssertTrue(model.connected)
    XCTAssertNil(model.notice)
  }

  func testSlackReplyStatusShowsWhyReplyingIsUnavailableUnlessLinkingFixesIt() async {
    let model = NativeSlackReplyModel(client: client(), sessionID: "s1")
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.linkAvailable)
    server.reply(
      replyStatus,
      #"{"connected":false,"error":"slack_link_required","message":"Link your account."}"#)
    await model.refresh()
    XCTAssertFalse(model.connected)
    XCTAssertTrue(model.linkAvailable)
    XCTAssertNil(model.notice)

    server.reply(replyStatus, status: 403, #"{"error":"browser_identity_required"}"#)
    await model.refresh()
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.linkAvailable)
    XCTAssertEqual(model.notice, "browser_identity_required")

    server.reply(
      replyStatus, status: 502,
      #"{"error":"slack_unavailable","message":"Could not verify Slack."}"#)
    await model.refresh()
    XCTAssertFalse(model.linkAvailable)
    XCTAssertEqual(model.notice, "Could not verify Slack.")

    server.reply(
      replyStatus, status: 500, #"{"error":"internal","message":"Slack check crashed."}"#)
    await model.refresh()
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.linkAvailable)
    XCTAssertEqual(model.notice, "Slack check crashed.")

    server.reply(replyStatus, status: 400, #"{"error":"not_slack"}"#)
    await model.refresh()
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.linkAvailable)
    XCTAssertNil(model.notice)

    server.reply(replyStatus, #"{"connected":true,"user":"alice"}"#)
    await model.refresh()
    XCTAssertTrue(model.connected)
    XCTAssertNil(model.notice)
  }

  func testSlackReplyBarKeepsOneRowHeightAndChecksStatusOnlyForSlackThreads() async throws {
    let linked = #"{"connected":true,"user":"alice"}"#
    for (reference, status) in [
      ("ch:C1:1.2", linked),
      (
        "ch:C1:1.2",
        #"{"connected":false,"error":"slack_link_required","message":"Link your account."}"#
      ),
      ("web:alice:s1", linked),
    ] {
      let client = client()
      server.reply(replyStatus, status)
      let controller = UIHostingController(
        rootView: NativeSlackReplyBar(
          client: client,
          conversation: Conversation(
            id: "s1", scopeId: "personal:alice", threadRef: reference, surface: "slack")
        ) {
          Text("Open in Slack").frame(maxWidth: .infinity, minHeight: 44)
        })
      controller.safeAreaRegions = []
      let scene = try XCTUnwrap(
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let previousWindow = scene.keyWindow
      let window = UIWindow(windowScene: scene)
      window.rootViewController = controller
      window.makeKeyAndVisible()
      defer {
        window.isHidden = true
        window.rootViewController = nil
        previousWindow?.makeKey()
      }
      func height() -> CGFloat {
        controller.sizeThatFits(in: CGSize(width: 390, height: 10_000)).height
      }
      XCTAssertEqual(height(), 44, accuracy: 0.5, status)
      let expected = reference.hasPrefix("ch:") ? ["/api/composio/slack/reply-status"] : []
      let deadline = ContinuousClock.now + .seconds(5)
      while requests.count < expected.count, ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(20))
      }
      for _ in 0..<25 {
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(height(), 44, accuracy: 0.5, status)
      }
      XCTAssertEqual(requests.map(\.path), expected, "\(reference) \(status)")
    }
  }

  func testSlackReplyOverTheServerLimitCannotBeSent() async {
    let model = NativeSlackReplyModel(client: client(), sessionID: "s1")
    server.reply(replyStatus, #"{"connected":true,"user":"alice"}"#)
    server.reply(reply, #"{"sent":true,"ts":"1700000000.000100"}"#)
    await model.refresh()

    model.text = String(repeating: "a", count: 4001)
    XCTAssertFalse(model.canSend)
    XCTAssertEqual(model.notice, "Slack replies can be up to 4,000 characters.")
    let refused = await model.send()
    XCTAssertFalse(refused)
    XCTAssertEqual(requests.map(\.path), ["/api/composio/slack/reply-status"])

    model.text = String(repeating: "😀", count: 2001)
    XCTAssertFalse(model.canSend)

    model.text = String(repeating: "😀", count: 2000)
    XCTAssertTrue(model.canSend)
    XCTAssertNil(model.notice)
    let sent = await model.send()
    XCTAssertTrue(sent)
    XCTAssertEqual((requests.last?.body["text"] as? String)?.utf16.count, 4000)
  }

  func testSideChatsListEmptyStateAndExpandOutcomes() async throws {
    let client = client()
    let model = NativeSideChatsModel(client: client, sessionID: "s1")
    await model.load()
    XCTAssertEqual(model.chats?.isEmpty, true)
    XCTAssertNil(model.error)
    XCTAssertEqual(requests.map(\.path), ["/api/sessions/s1/side-chats"])

    let row = """
      {"id":"side1","scopeId":"user:alice","threadRef":"web:alice:x","createdAt":1700000000000,
      "sideChat":{"entrySeq":7,"quote":"First line\\nSecond line","occurrence":0,"expanded":false}}
      """
    server.reply(sideChats, "{\"sessions\":[\(row)]}")
    server.reply(expand, status: 404, #"{"error":"not_found"}"#)
    await model.load()
    let chat = try XCTUnwrap(model.chats?.first)
    XCTAssertEqual(chat.id, "side1")
    XCTAssertEqual(chat.excerpt, "First line Second line")
    let long = String(repeating: "A long passage. ", count: 20)
    let quoted = try JSONDecoder().decode(
      NativeSideChat.self,
      from: Data(
        #"{"id":"side2","createdAt":1,"sideChat":{"entrySeq":1,"quote":"\#(long)","occurrence":0}}"#
          .utf8))
    XCTAssertEqual(quoted.excerpt, long)
    XCTAssertEqual(chat.sideChat.entrySeq, 7)

    let refused = await model.expand(chat)
    XCTAssertFalse(refused)
    XCTAssertNotNil(model.error)
    XCTAssertEqual(requests.last?.path, "/api/sessions/side1/expand")
    XCTAssertNil(model.expanding)

    let session =
      #"{"id":"side1","scopeId":"user:alice","threadRef":"web:alice:x","surface":"web","sideChat":{"entrySeq":7,"quote":"q","occurrence":0,"expanded":true}"#
    server.reply(expand, #"{"session":"# + session + "}}")
    server.reply(
      "GET /api/sessions/side1", #"{"session":"# + session + #","canContinue":true},"items":[]}"#)
    let opened = await model.expand(chat)
    XCTAssertTrue(opened)
    XCTAssertNil(model.error)
    XCTAssertEqual(
      requests.suffix(2).map(\.path), ["/api/sessions/side1/expand", "/api/sessions/s1/side-chats"])

    let controller = UIHostingController(
      rootView: NavigationStack {
        NativeConversationDestination(client: client, user: "alice", sessionID: chat.id)
          .environment(\.scenePhase, .active)
      })
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousWindow = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previousWindow?.makeKey()
    }
    let deadline = ContinuousClock.now + .seconds(5)
    while !requests.contains(where: { $0.path == "/api/runtime-config" }),
      ContinuousClock.now < deadline
    {
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertTrue(requests.contains { $0.path == "/api/runtime-config" })
    XCTAssertFalse(requests.contains { $0.path == "/api/composio/slack/reply-status" })
  }
}
