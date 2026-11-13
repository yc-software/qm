import SwiftUI
import XCTest
import os

@testable import QM

private final class ChatScrollProtocol: URLProtocol, @unchecked Sendable {
  static let imageRequests = OSAllocatedUnfairLock(initialState: [URLRequest]())
  static let searchResponses = OSAllocatedUnfairLock(
    initialState: [String: @Sendable () -> Void]())

  static func imageHistory() throws -> Data {
    let items: [[String: Any]] = (1...90).map { sequence in
      [
        "kind": "AgentMessage", "seq": sequence, "createdAt": sequence,
        "text": "Images from message \(sequence).\n\n"
            + "![Workspace image](/api/files/markdown-\(sequence)/content)\n\n"
            + "![Attached image](attachment://figure-\(sequence).png)",
        "body": ["attachments": [
            ["name": "figure-\(sequence).png", "artifactId": "attachment-\(sequence)"]
          ],
        ],
      ]
    }
    return try JSONSerialization.data(withJSONObject: ["items": items, "earlierItems": 0])
  }

  static func requestedImages(at host: String) -> [URLRequest] {
    imageRequests.withLock { $0.filter { $0.url?.host == host } }
  }

  static func mixedHistory() throws -> Data {
    let items: [[String: Any]] = (1...90).map { sequence in
      let text: String
      if sequence % 3 == 0 {
        text =
          "## Answer \(sequence)\n\n"
          + String(
            repeating:
              "A detailed answer with **formatted text**, a [link](https://example.com), and several paragraphs.\n\n",
            count: sequence % 11 + 1)
          + "| File | Status |\n| --- | --- |\n| Sources/Conversation.swift | Checked |\n\n```swift\nlet message = \"A wide code line that scrolls horizontally inside the reply\"\n```"
      } else {
        text =
          "Question \(sequence). "
          + String(repeating: "Please check this detail.\n", count: sequence % 14 + 1)
      }
      return [
        "kind": sequence % 3 == 0 ? "AgentMessage" : "UserMessage", "seq": sequence,
        "createdAt": sequence, "text": text, "body": [:],
      ]
    }
    return try JSONSerialization.data(withJSONObject: ["items": items, "earlierItems": 0])
  }

  static func history(count: Int, first: Int = 1) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "items": (first..<(first + count)).map { sequence in
        [
          "kind": "UserMessage", "seq": sequence, "createdAt": sequence,
          "text": "Message \(sequence). " + String(repeating: "Conversation text. ", count: 8), "body": [:],
        ] as [String: Any]
      },
      "earlierItems": first - 1,
    ])
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let data: Data
    var contentType = "application/json"
    if request.url?.path == "/api/sessions/chat" {
      if request.url?.host?.hasPrefix("chat-scroll-search-") == true {
        data = try! Self.history(
          count: 60, first: request.url?.query?.contains("beforeSeq=") == true ? 1 : 61)
      } else if request.url?.host?.contains("images-") == true {
        data = try! Self.imageHistory()
      } else {
        data =
          try! request.url?.host?.contains("mixed-") == true
          ? Self.mixedHistory() : Self.history(count: 60)
      }
    } else if request.url?.path.hasPrefix("/api/files/") == true,
      request.url?.path.hasSuffix("/content") == true
    {
      Self.imageRequests.withLock { $0.append(request) }
      contentType = "image/png"
      data = Data(
        base64Encoded:
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAAAE0lEQVR4nGNQSGggCTGMahiaGgDu0qAB4GjpWQAAAABJRU5ErkJggg=="
      )!
    } else if request.url?.path.hasSuffix("/approvals") == true {
      data = Data(#"{"approvals":[]}"#.utf8)
    } else if request.url?.path.hasSuffix("/children") == true {
      data = Data(
        (request.url?.host?.hasPrefix("chat-scroll-agents-") == true
          ? #"{"sessions":[{"id":"child","scopeId":"personal:test","threadRef":"agent:child","parentSessionId":"chat","title":"Completed earlier task","lastActivityAt":1000}]}"#
          : #"{"sessions":[]}"#).utf8)
    } else if request.url?.path == "/api/turn" {
      data = Data(#"{"status":"ok","runId":"new","reply":"New reply"}"#.utf8)
    } else {
      data = Data("{}".utf8)
    }
    let responseContentType = contentType
    let deliver: @Sendable () -> Void = {
      self.client?.urlProtocol(
        self,
        didReceive: HTTPURLResponse(
          url: self.request.url!, statusCode: 200, httpVersion: nil,
          headerFields: ["Content-Type": responseContentType])!,
        cacheStoragePolicy: .notAllowed)
      self.client?.urlProtocol(self, didLoad: data)
      self.client?.urlProtocolDidFinishLoading(self)
    }
    if let url = request.url, let host = url.host, host.hasPrefix("chat-scroll-search-"),
      url.path == "/api/turn" || url.query?.contains("beforeSeq=") == true
    {
      Self.searchResponses.withLock { $0[host + url.path] = deliver }
    } else if request.url?.path == "/api/turn"
      || request.url?.path == "/api/sessions/chat"
        && request.url?.host?.contains("delayed-") == true
    {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.5, execute: deliver)
    } else {
      deliver()
    }
  }

  override func stopLoading() {}
}

@MainActor
final class ChatScrollTests: XCTestCase {
  func testTranscriptClipsAtComposerWithoutEmptyControlSpacing() async throws {
    try await withChat(mixedHistory: true) { model, scroll in
      model.draft = "Draft"
      let window = try XCTUnwrap(scroll.window)
      try await self.waitUntil { self.composer(in: window, text: "Draft") != nil }
      let field = try XCTUnwrap(self.composer(in: window, text: "Draft"))
      window.layoutIfNeeded()
      let fieldFrame = field.convert(field.bounds, to: window)
      let viewport = scroll.convert(scroll.bounds, to: window)
      XCTAssertLessThanOrEqual(
        fieldFrame.minY - (viewport.maxY - scroll.adjustedContentInset.bottom), 32)
      XCTAssertTrue(scroll.clipsToBounds)
      scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height / 2), animated: false)
      try await Task.sleep(for: .milliseconds(300))
      let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = "Floating composer over transcript"
      attachment.lifetime = .keepAlways
      self.add(attachment)
    }
  }

  func testOpeningLongTranscriptDoesNotRequestEveryLoadedImage() async throws {
    try await withChat(imageHistory: true) { model, scroll in
      let host = try XCTUnwrap(model.client.baseURL.host)
      func requestedPaths() -> Set<String> {
        Set(ChatScrollProtocol.requestedImages(at: host).compactMap { $0.url?.path })
      }
      let latestImages: Set<String> = [
        "/api/files/markdown-90/content", "/api/files/attachment-90/content",
      ]
      try await self.waitUntil(diagnostics: {
        "Loaded image paths: \(requestedPaths().sorted()); \(self.geometry(scroll))"
      }) {
        latestImages.isSubset(of: requestedPaths()) && abs(self.distanceFromBottom(scroll)) < 2
      }
      try await Task.sleep(for: .milliseconds(500))
      XCTAssertTrue(model.hasLoadedTranscript)
      XCTAssertEqual(model.messages.count, 90)
      let initiallyRequested = requestedPaths()
      XCTAssertLessThan(
        initiallyRequested.count, model.messages.count * 2,
        "Opening the latest message must not fetch every image in the loaded history.")
      for request in ChatScrollProtocol.requestedImages(at: host) {
        XCTAssertEqual(
          request.value(forHTTPHeaderField: "Cookie"), "portal_session=scroll-image-test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "image/*")
      }
    }
  }

  func testSendWithMixedHeightHistoryKeepsLatestContentOnScreen() async throws {
    try await withChat(mixedHistory: true) { model, scroll in
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
      model.draft = "Please check the next thing."
      let root = try XCTUnwrap(scroll.window?.rootViewController?.view)
      try await self.waitUntil { self.composer(in: root, text: model.draft) != nil }
      let editor = try XCTUnwrap(self.composer(in: root, text: model.draft))
      XCTAssertTrue(editor.becomeFirstResponder())
      try await Task.sleep(for: .milliseconds(350))
      editor.resignFirstResponder()
      let sending = Task { await model.send() }
      for _ in 0..<75 {
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertGreaterThan(self.distanceFromBottom(scroll), -80, self.geometry(scroll))
        XCTAssertLessThan(
          self.distanceFromBottom(scroll), self.visibleHeight(scroll), self.geometry(scroll))
      }
      await sending.value
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
      XCTAssertEqual(model.messages.last?.text, "New reply")
    }
  }

  func testOpeningConversationAtLatestAfterHistoryLoads() async throws {
    try await withChat(delayedHistory: true) { model, scroll in
      XCTAssertTrue(model.hasLoadedTranscript)
      XCTAssertEqual(model.messages.last?.sequence, 60)
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
    }
  }

  func testLatestPositionFollowsToolCallsAfterDelayedHistory() async throws {
    try await withChat(delayedHistory: true) { model, scroll in
      try await self.waitUntil { abs(self.distanceFromBottom(scroll)) < 2 }
      model.activeRunID = "current"
      let oldHeight = scroll.contentSize.height
      model.items.append(
        try JSONDecoder().decode(
          Item.self,
          from: JSONSerialization.data(withJSONObject: [
            "kind": "ToolCall", "seq": 61, "createdAt": 61,
            "turnId": "current", "callId": "tool", "tool": "execute", "body": [
              "description": String(repeating: "Inspecting the requested file. ", count: 12),
            ],
          ])))
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        scroll.contentSize.height > oldHeight && abs(self.distanceFromBottom(scroll)) < 2
      }
    }
  }

  func testKeyboardAndDraftChangesKeepTranscriptWithinHorizontalBounds() async throws {
    try await withChat { model, scroll in
      model.partial =
        "A final answer stays aligned with the transcript.\n\n"
        + String(repeating: "Long conversation prose. ", count: 40)
      model.draft = "Draft used to identify the composer"
      try await self.waitUntil { abs(self.distanceFromBottom(scroll)) < 2 }
      let root = try XCTUnwrap(scroll.window?.rootViewController?.view)
      try await self.waitUntil { self.composer(in: root, text: model.draft) != nil }
      let editor = try XCTUnwrap(self.composer(in: root, text: model.draft))
      XCTAssertTrue(editor.becomeFirstResponder())
      var capturedDrift = false
      for draft in ["Short draft", String(repeating: "A longer draft to send.\n", count: 8), ""] {
        model.draft = draft
        for _ in 0..<25 {
          try await Task.sleep(for: .milliseconds(20))
          if !capturedDrift, abs(scroll.contentOffset.x + scroll.adjustedContentInset.left) > 1 {
            capturedDrift = true
            let image = UIGraphicsImageRenderer(bounds: root.bounds).image { _ in
              root.drawHierarchy(in: root.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "Transcript horizontal drift"
            attachment.lifetime = .keepAlways
            self.add(attachment)
          }
          XCTAssertEqual(
            scroll.contentOffset.x + scroll.adjustedContentInset.left, 0, accuracy: 1,
            self.geometry(scroll))
          XCTAssertEqual(
            scroll.contentSize.width + scroll.adjustedContentInset.left
              + scroll.adjustedContentInset.right,
            scroll.bounds.width, accuracy: 1, self.geometry(scroll))
        }
      }
      editor.resignFirstResponder()
    }
  }

  func testSendKeepsTranscriptVisibleWhileComposerShrinks() async throws {
    try await withChat { model, scroll in
      model.draft = String(repeating: "A long submitted message.\n", count: 8)
      try await self.waitUntil { abs(self.distanceFromBottom(scroll)) < 2 }
      let root = try XCTUnwrap(scroll.window?.rootViewController?.view)
      try await self.waitUntil { self.composer(in: root, text: model.draft) != nil }
      let editor = try XCTUnwrap(self.composer(in: root, text: model.draft))
      XCTAssertTrue(editor.becomeFirstResponder())
      try await Task.sleep(for: .milliseconds(350))
      let sending = Task { await model.send() }
      var sendingFrames = 0
      for _ in 0..<50 {
        try await Task.sleep(for: .milliseconds(10))
        if model.sending {
          sendingFrames += 1
        }
        XCTAssertEqual(
          scroll.contentOffset.x + scroll.adjustedContentInset.left, 0, accuracy: 1,
          self.geometry(scroll))
        XCTAssertGreaterThan(self.visibleHeight(scroll), 100, self.geometry(scroll))
        XCTAssertGreaterThan(self.distanceFromBottom(scroll), -80, self.geometry(scroll))
        XCTAssertLessThan(
          self.distanceFromBottom(scroll), self.visibleHeight(scroll), self.geometry(scroll))
      }
      await sending.value
      XCTAssertGreaterThan(sendingFrames, 3)
      XCTAssertTrue(model.draft.isEmpty)
      XCTAssertEqual(model.messages.last?.text, "New reply")
      editor.resignFirstResponder()
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
    }
  }

  func testSearchSelectionKeepsReadingPositionWhenHistoryArrives() async throws {
    try await withChat(initialSequence: 24) { model, scroll in
      try await self.waitUntil {
        scroll.contentOffset.y > 500 && self.distanceFromBottom(scroll) > 1_000
      }
      let readingOffset = scroll.contentOffset.y
      let readingHeight = scroll.contentSize.height
      model.items = try JSONDecoder().decode(
        Transcript.self, from: ChatScrollProtocol.history(count: 64)
      ).items
      try await self.waitUntil { scroll.contentSize.height > readingHeight }
      XCTAssertEqual(scroll.contentOffset.y, readingOffset, accuracy: 1)
    }
  }

  func testLoadingEarlierMessagesKeepsTheReadingPosition() async throws {
    try await withChat(initialSequence: 61, firstSequence: 61) { model, scroll in
      try await self.waitUntil { self.distanceFromBottom(scroll) > 1_000 }
      try await Task.sleep(for: .milliseconds(200))
      let loadedHeight = scroll.contentSize.height
      await model.loadEarlier()
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        model.transcriptEntries.first?.seq == 1
          && abs(scroll.contentOffset.y - (scroll.contentSize.height - loadedHeight)) < 150
      }
    }
  }

  func testSendingWhileSearchHistoryLoadsKeepsLatestVisible() async throws {
    if let handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
      let symbol = dlsym(handle, "_AXSSetAutomationEnabled")
    {
      typealias Enable = @convention(c) (Int32) -> Void
      unsafeBitCast(symbol, to: Enable.self)(1)
    }
    func sendButton(in root: NSObject) -> NSObject? {
      if root.accessibilityLabel == "Send message" { return root }
      let children =
        root.accessibilityElements as? [NSObject] ?? (root as? UIView)?.subviews ?? []
      return children.lazy.compactMap { sendButton(in: $0) }.first
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatScrollProtocol.self]
    let host = "chat-scroll-search-\(UUID().uuidString).example.test"
    let client = APIClient(
      baseURL: URL(string: "https://\(host)")!, configuration: configuration)
    let transcript = try JSONDecoder().decode(
      Transcript.self, from: ChatScrollProtocol.history(count: 60, first: 61))
    let model = ChatModel(
      conversation: Conversation(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true, transcript: transcript)
    defer {
      model.pause()
      DraftStore.removeAccount(client.baseURL.absoluteString + "test")
      for path in ["/api/sessions/chat", "/api/turn"] {
        ChatScrollProtocol.searchResponses.withLock { $0.removeValue(forKey: host + path) }?()
      }
    }
    try await withScrollView(ChatView(model: model, initialSequence: 24)) { scroll in
      try await self.waitUntil {
        model.loadingEarlier
          && ChatScrollProtocol.searchResponses.withLock { $0[host + "/api/sessions/chat"] != nil }
      }
      XCTAssertEqual(model.transcriptEntries.first?.seq, 61)
      model.draft = "Please check the latest message."
      let root = try XCTUnwrap(scroll.window?.rootViewController?.view)
      try await self.waitUntil { self.composer(in: root, text: model.draft) != nil }
      XCTAssertTrue(
        try XCTUnwrap(self.composer(in: root, text: model.draft)).becomeFirstResponder())
      try await Task.sleep(for: .milliseconds(350))
      XCTAssertTrue(try XCTUnwrap(sendButton(in: root)).accessibilityActivate())
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        model.sending && abs(self.distanceFromBottom(scroll)) < 2
          && ChatScrollProtocol.searchResponses.withLock { $0[host + "/api/turn"] != nil }
      }
      let deliverHistory = try XCTUnwrap(
        ChatScrollProtocol.searchResponses.withLock {
          $0.removeValue(forKey: host + "/api/sessions/chat")
        })
      deliverHistory()
      try await self.waitUntil {
        !model.loadingEarlier && model.transcriptEntries.first?.seq == 1
      }
      try await Task.sleep(for: .milliseconds(300))
      XCTAssertEqual(
        self.distanceFromBottom(scroll), 0, accuracy: 2,
        "Loading the searched history must not override Send: \(self.geometry(scroll))")
      let finishSend = try XCTUnwrap(
        ChatScrollProtocol.searchResponses.withLock { $0.removeValue(forKey: host + "/api/turn") })
      finishSend()
      try await self.waitUntil { !model.sending && model.messages.last?.text == "New reply" }
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
    }
  }

  func testCompletedAgentShelfRetiresOnNextPromptWithoutMovingReadingPosition() async throws {
    try await withChat(initialSequence: 24, agents: true) { model, scroll in
      try await self.waitUntil {
        scroll.contentOffset.y > 500 && self.distanceFromBottom(scroll) > 1_000
      }
      try await Task.sleep(for: .milliseconds(200))
      let readingOffset = scroll.contentOffset.y
      let oldHeight = self.visibleHeight(scroll)
      let newMessage = try JSONDecoder().decode(
        Item.self,
        from: Data(
          #"{"seq":61,"createdAt":2000,"kind":"UserMessage","turnId":"next","text":"A later question","body":{}}"#
            .utf8))
      model.items.append(newMessage)
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        self.visibleHeight(scroll) > oldHeight + 60
      }
      XCTAssertEqual(scroll.contentOffset.y, readingOffset, accuracy: 1, self.geometry(scroll))
    }
  }

  func testAcceptedSendRetiresCompletedAgentShelf() async throws {
    try await withChat(agents: true) { model, scroll in
      try await self.waitUntil { abs(self.distanceFromBottom(scroll)) < 2 }
      try await Task.sleep(for: .milliseconds(200))
      let oldHeight = self.visibleHeight(scroll)
      XCTAssertEqual(model.latestPromptAt, 60)
      model.draft = "Please check the next thing."
      await model.send()
      XCTAssertTrue(model.draft.isEmpty)
      XCTAssertGreaterThan(try XCTUnwrap(model.latestPromptAt), 1000)
      try await self.waitUntil(diagnostics: { self.geometry(scroll) }) {
        self.visibleHeight(scroll) > oldHeight + 60
      }
      XCTAssertEqual(self.distanceFromBottom(scroll), 0, accuracy: 2, self.geometry(scroll))
    }
  }

  func testLatestPositionFollowsAppendedAndGrowingContent() async throws {
    try await withChat { model, scroll in
      try await self.waitUntil(diagnostics: { "Initial bottom: \(self.geometry(scroll))" }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
      let oldHeight = scroll.contentSize.height
      model.items = try JSONDecoder().decode(
        Transcript.self, from: ChatScrollProtocol.history(count: 64)
      ).items
      try await self.waitUntil(diagnostics: { "Appended history: \(self.geometry(scroll))" }) {
        scroll.contentSize.height > oldHeight && abs(self.distanceFromBottom(scroll)) < 2
      }
      let appendedHeight = scroll.contentSize.height
      model.activeRunID = "streaming"
      model.partial = String(
        repeating: "Streaming reply grows without a new message identity.\n", count: 40)
      try await self.waitUntil(diagnostics: {
        "New partial: baseline=\(appendedHeight), text=\(model.displayedPartial.count), \(self.geometry(scroll))"
      }) {
        scroll.contentSize.height != appendedHeight && abs(self.distanceFromBottom(scroll)) < 2
      }
      let streamingHeight = scroll.contentSize.height
      model.partial += String(repeating: "More streaming content.\n", count: 40)
      try await self.waitUntil(diagnostics: { "Growing partial: \(self.geometry(scroll))" }) {
        scroll.contentSize.height > streamingHeight && abs(self.distanceFromBottom(scroll)) < 2
      }
    }
  }

  func testAttachmentTrayKeepsTranscriptVisible() async throws {
    try await withChat { model, scroll in
      let originalHeight = self.visibleHeight(scroll)
      model.attachments = [
        UploadAttachment(
          name: "report.pdf", mimetype: "application/pdf", sizeBytes: 123, blobId: "blob-1")
      ]
      try await self.waitUntil { self.visibleHeight(scroll) < originalHeight }
      XCTAssertGreaterThan(self.visibleHeight(scroll), originalHeight - 100, self.geometry(scroll))
    }
  }

  func testVoiceTranscriptStaysAlignedWhileNewAndExistingContentGrows() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatScrollProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://voice-scroll.example.test")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    for sequence in 1...60 {
      model.transcript.appendResult(
        "Reply \(sequence). " + String(repeating: "Spoken reply. ", count: 20))
    }
    try await withScrollView(VoiceView(model: model)) { scroll in
      try await self.waitUntil(diagnostics: { "Voice initial bottom: \(self.geometry(scroll))" }) {
        abs(self.distanceFromBottom(scroll)) < 2
      }
      for (index, text) in [
        "New spoken reply.", String(repeating: "Growing spoken reply.\n", count: 40),
      ].enumerated() {
        let oldHeight = scroll.contentSize.height
        if index == 0 {
          model.transcript.appendResult(text)
        } else {
          model.transcript.items[model.transcript.items.count - 1].content = .result(text)
        }
        try await self.waitUntil(diagnostics: {
          "Voice growth \(index), previous height=\(oldHeight): \(self.geometry(scroll))"
        }) {
          scroll.contentSize.height > oldHeight && abs(self.distanceFromBottom(scroll)) < 2
        }
        XCTAssertEqual(scroll.contentOffset.x, 0, accuracy: 1, self.geometry(scroll))
        XCTAssertEqual(
          scroll.contentSize.width, scroll.bounds.width, accuracy: 1, self.geometry(scroll))
      }
    }
  }

  private func withChat(
    initialSequence: Int? = nil, firstSequence: Int = 1, agents: Bool = false,
    delayedHistory: Bool = false, mixedHistory: Bool = false, imageHistory: Bool = false,
    _ action: @MainActor (ChatModel, UIScrollView) async throws -> Void
  ) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatScrollProtocol.self]
    let client = APIClient(
      baseURL: URL(
        string:
          "https://chat-scroll-\(agents ? "agents-" : "")\(delayedHistory ? "delayed-" : "")\(mixedHistory ? "mixed-" : "")\(imageHistory ? "images-" : "")\(UUID().uuidString).example.test"
      )!,
      configuration: configuration)
    if imageHistory { try client.saveSession("scroll-image-test") }
    let history =
      try imageHistory
      ? ChatScrollProtocol.imageHistory()
      : mixedHistory
        ? ChatScrollProtocol.mixedHistory()
        : ChatScrollProtocol.history(count: 60, first: firstSequence)
    let transcript = try JSONDecoder().decode(
      Transcript.self, from: history)
    let model = ChatModel(
      conversation: Conversation(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true,
      transcript: delayedHistory ? nil : transcript)
    let host = client.baseURL.host
    defer {
      model.pause()
      DraftStore.removeAccount(client.baseURL.absoluteString + "test")
      if imageHistory {
        client.signOut()
        ChatScrollProtocol.imageRequests.withLock {
          $0.removeAll { $0.url?.host == host }
        }
      }
    }
    try await withScrollView(ChatView(model: model, initialSequence: initialSequence)) { scroll in
      model.pause()
      try await action(model, scroll)
    }
  }

  private func withScrollView<Content: View>(
    _ content: Content, _ action: @MainActor (UIScrollView) async throws -> Void
  ) async throws {
    let controller = UIHostingController(
      rootView: NavigationStack { content.environment(\.scenePhase, .active) })
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
    controller.view.layoutIfNeeded()
    try await waitUntil {
      self.scrollViews(in: controller.view).contains { $0.contentSize.height > 4_000 }
    }
    let scroll = try XCTUnwrap(
      scrollViews(in: controller.view).max { $0.contentSize.height < $1.contentSize.height })
    try await action(scroll)
  }

  private func visibleHeight(_ scroll: UIScrollView) -> CGFloat {
    scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
  }

  private func distanceFromBottom(_ scroll: UIScrollView) -> CGFloat {
    scroll.contentSize.height + scroll.adjustedContentInset.bottom
      - scroll.contentOffset.y - scroll.bounds.height
  }

  private func geometry(_ scroll: UIScrollView) -> String {
    "offset=\(scroll.contentOffset), content=\(scroll.contentSize), "
      + "viewport=\(scroll.bounds.height), inset=\(scroll.adjustedContentInset.bottom), "
      + "distance=\(distanceFromBottom(scroll)), contentInset=\(scroll.contentInset), "
      + "frame=\(scroll.frame), safeArea=\(scroll.safeAreaInsets)"
  }

  private func scrollViews(in view: UIView) -> [UIScrollView] {
    ((view as? UIScrollView).map { [$0] } ?? [])
      + view.subviews.flatMap { scrollViews(in: $0) }
  }

  private func descendants(in view: UIView) -> [UIView] {
    view.subviews.flatMap { [$0] + descendants(in: $0) }
  }

  private func composer(in root: UIView, text: String) -> UIView? {
    descendants(in: root).first {
      ($0 as? UITextField)?.text == text || ($0 as? UITextView)?.text == text
    }
  }

  private func waitUntil(
    diagnostics: () -> String = { "" },
    file: StaticString = #filePath, line: UInt = #line,
    _ condition: @MainActor () -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !condition(), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertTrue(condition(), diagnostics(), file: file, line: line)
  }
}
