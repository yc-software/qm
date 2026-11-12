import SwiftUI
import XCTest
import os

@testable import QM

final class ChatTurnLabProtocol: URLProtocol, @unchecked Sendable {
  static let phases = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let reply: String = {
    var text = "## Result\n\n"
    for index in 0..<14 {
      text +=
        "Paragraph \(index) explains one part of the answer with **bold text** and a [link](https://example.com) so that the layout wraps over several lines on a phone.\n\n"
      if index % 5 == 2 { text += "- first point\n- second point\n- third point\n\n" }
    }
    return text + "```swift\nlet finished = true\n```"
  }()

  static func reply(host: String) -> String { host.contains("shortReply") ? "OK" : reply }

  static func history(host: String) -> [[String: Any]] {
    let phase = phases.withLock { $0[host] ?? 0 }
    var entries: [[String: Any]] = []
    var seq = 0
    func add(_ type: String, _ payload: [String: Any]) {
      seq += 1
      entries.append(["type": type, "seq": seq, "createdAt": seq, "payload": payload])
    }
    let turnCount =
      host.contains("empty-") ? 0 : host.contains("short-") || host.contains("single-") ? 1 : 25
    for turn in 0..<turnCount {
      let run = "run-\(turn)"
      add(
        "user",
        [
          "runId": run,
          "text": "Question \(turn). "
            + String(repeating: "Please check this detail.\n", count: turn % 6 + 1),
        ])
      for tool in 0..<40 {
        add(
          "tool_call",
          [
            "runId": run, "callId": "c\(turn)-\(tool)", "tool": "execute",
            "purpose": "Step \(tool)",
          ])
        add(
          "tool_result",
          ["runId": run, "callId": "c\(turn)-\(tool)", "ok": true, "stdout": "ok"])
      }
      add(
        "assistant",
        [
          "runId": run,
          "text": "## Answer \(turn)\n\n"
            + String(
              repeating:
                "A detailed answer with **formatted text**, a [link](https://example.com), and several paragraphs.\n\n",
              count: host.contains("single-") ? 30 : turn % 11 + 1)
            + "| File | Status |\n| --- | --- |\n| Sources/Conversation.swift | Checked |\n\n```swift\nlet message = \"A wide code line that scrolls horizontally inside the reply\"\n```",
        ])
    }
    if phase >= 1 {
      entries.append([
        "type": "user", "seq": 9001, "createdAt": 9001,
        "payload": ["text": "Please check the next thing.", "runId": "new"],
      ])
    }
    if phase >= 2 {
      entries.append(toolCall)
      entries.append(toolResult)
      entries.append([
        "type": "assistant", "seq": 9004, "createdAt": 9004,
        "payload": ["text": reply(host: host), "runId": "new"],
      ])
    }
    return entries
  }

  static var toolCall: [String: Any] {
    [
      "type": "tool_call", "seq": 9002, "createdAt": 9002,
      "payload": [
        "runId": "new", "callId": "c1", "tool": "execute", "purpose": "Inspect the workspace",
      ],
    ]
  }
  static var toolResult: [String: Any] {
    [
      "type": "tool_result", "seq": 9003, "createdAt": 9003,
      "payload": ["runId": "new", "callId": "c1", "ok": true, "stdout": "ok"],
    ]
  }

  private static func json(_ value: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: value)
  }

  private static func event(_ name: String, _ value: [String: Any]) -> Data {
    Data("data: ".utf8) + json(["type": "CUSTOM", "name": name, "value": value]) + Data("\n\n".utf8)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  private func respond(_ data: Data, type: String = "application/json", after delay: Double = 0) {
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
      self.client?.urlProtocol(
        self,
        didReceive: HTTPURLResponse(
          url: self.request.url!, statusCode: 200, httpVersion: nil,
          headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
      self.client?.urlProtocol(self, didLoad: data)
      self.client?.urlProtocolDidFinishLoading(self)
    }
  }

  override func startLoading() {
    let url = request.url!
    let host = url.host!
    let phase = Self.phases.withLock { $0[host] ?? 0 }
    switch url.path {
    case "/api/sessions/chat":
      respond(
        Self.json(["entries": Self.history(host: host), "earlierEntries": 0]),
        after: host.contains("overlap-") && phase == 0 ? 2.5 : 0.08)
    case "/api/sessions/chat/approvals": respond(Data(#"{"approvals":[]}"#.utf8), after: 0.03)
    case "/api/sessions/chat/children": respond(Data(#"{"sessions":[]}"#.utf8), after: 0.03)
    case "/api/runs/active":
      respond(Data((phase == 1 ? #"{"runId":"new"}"# : #"{"runId":null}"#).utf8), after: 0.04)
    case "/api/turn":
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.18) {
        Self.phases.withLock { $0[host] = 1 }
        self.respond(Data(#"{"runId":"new","status":"queued"}"#.utf8))
      }
    case "/api/runs/new":
      respond(
        Self.json(
          phase == 2
            ? [
              "status": "done", "attempt": 1, "partial": Self.reply(host: host),
              "activity": [Self.toolCall, Self.toolResult],
              "result": ["status": "ok", "reply": Self.reply(host: host)],
            ] : ["status": "running", "attempt": 1]), after: 0.04)
    case "/api/runs/new/events": stream(host: host)
    default: respond(Data("{}".utf8))
    }
  }

  private func stream(host: String) {
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
    var steps: [(Double, Data, Bool)] = []
    steps.append(
      (
        0.05,
        Self.event(
          "run",
          [
            "status": "running", "attempt": 1, "activity": [Any](),
            "input": [
              "runId": "new", "seq": 9001, "text": "Please check the next thing.",
              "createdAt": 9001,
            ],
          ]), false
      ))
    steps.append(
      (
        0.25,
        Self.event(
          "reasoning",
          ["step": "s1", "index": 0, "offset": 0, "delta": "Looking at the request first."]), false
      ))
    steps.append(
      (
        0.45,
        Self.event("run", ["status": "running", "attempt": 1, "activity": [Self.toolCall]]), false
      ))
    steps.append(
      (
        0.95,
        Self.event(
          "run", ["status": "running", "attempt": 1, "activity": [Self.toolCall, Self.toolResult]]),
        false
      ))
    let reply = Self.reply(host: host)
    let units = Array(reply.utf16)
    var offset = 0
    var time = 1.05
    while offset < units.count {
      let end = min(units.count, offset + 48)
      steps.append(
        (
          time,
          Self.event(
            "delta",
            ["offset": offset, "delta": String(decoding: units[offset..<end], as: UTF16.self)]),
          false
        ))
      offset = end
      time += 0.04
    }
    steps.append(
      (
        time + 0.1,
        Self.event(
          "run",
          [
            "status": "done", "attempt": 1, "partial": reply,
            "activity": [Self.toolCall, Self.toolResult],
            "result": ["status": "ok", "reply": reply],
          ]), true
      ))
    for (delay, data, last) in steps {
      DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
        if last { Self.phases.withLock { $0[host] = 2 } }
        self.client?.urlProtocol(self, didLoad: data)
        if last { self.client?.urlProtocolDidFinishLoading(self) }
      }
    }
  }
}

@MainActor
final class ScrollLabTests: XCTestCase {
  func testSendPinned() async throws { try await sendFlow("pinned", scrollUp: 0, delayed: false) }
  func testSendScrolledUp() async throws {
    try await sendFlow("scrolledUp", scrollUp: 3000, delayed: false)
  }
  func testSendFromTop() async throws {
    try await sendFlow("fromTop", scrollUp: -1, delayed: false)
  }
  func testSendAfterDelayedHistory() async throws {
    try await sendFlow("delayed", scrollUp: 0, delayed: true)
  }
  func testReadingHistoryDuringReplyDoesNotResumeFollowing() async throws {
    try await sendFlow("reading", scrollUp: 0, delayed: false, readDuringReply: true)
  }
  func testSendWithAccessibilityText() async throws {
    try await sendFlow("largeText", scrollUp: 0, delayed: false, dynamicTypeSize: .accessibility3)
  }
  func testSendInEmptyConversation() async throws {
    try await sendFlow("empty", scrollUp: 0, delayed: false)
  }
  func testSendInShortConversation() async throws {
    try await sendFlow("short", scrollUp: 0, delayed: false)
  }
  func testShortFirstReplyStaysInsideViewport() async throws {
    try await sendFlow("empty-shortReply", scrollUp: 0, delayed: false)
  }
  func testSendAfterExpandingOldActivity() async throws {
    try await sendFlow("expanded", scrollUp: 3_000, delayed: false, expandActivity: true)
  }
  func testSendWhileInitialHistoryIsLoading() async throws {
    try await sendFlow("overlap", scrollUp: 0, delayed: true, sendBeforeHistory: true)
  }
  func testOpenAndSendAfterSingleLongReplyLoads() async throws {
    try await sendFlow("single", scrollUp: 0, delayed: true)
  }

  private func enableAutomation() {
    if let handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
      let symbol = dlsym(handle, "_AXSSetAutomationEnabled")
    {
      typealias Enable = @convention(c) (Int32) -> Void
      unsafeBitCast(symbol, to: Enable.self)(1)
    }
  }

  private func nodes(_ root: NSObject, depth: Int = 0) -> [NSObject] {
    guard depth < 60 else { return [] }
    var result: [NSObject] = [root]
    if let elements = root.accessibilityElements as? [NSObject], !elements.isEmpty {
      for element in elements { result += nodes(element, depth: depth + 1) }
    } else if let view = root as? UIView {
      for subview in view.subviews { result += nodes(subview, depth: depth + 1) }
    }
    return result
  }

  private func drag(_ scroll: UIScrollView, to y: CGFloat) async throws {
    scroll.delegate?.scrollViewWillBeginDragging?(scroll)
    try await Task.sleep(for: .milliseconds(60))
    scroll.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    try await Task.sleep(for: .milliseconds(60))
    scroll.delegate?.scrollViewDidEndDragging?(scroll, willDecelerate: false)
    try await Task.sleep(for: .milliseconds(250))
  }

  private func sendFlow(
    _ name: String, scrollUp: CGFloat, delayed: Bool, readDuringReply: Bool = false,
    dynamicTypeSize: DynamicTypeSize = .large, expandActivity: Bool = false,
    sendBeforeHistory: Bool = false
  ) async throws {
    let tag = "SENDLAB[\(name)]"
    enableAutomation()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatTurnLabProtocol.self]
    let host = "turn-lab-\(name)-\(UUID().uuidString).example.test"
    let client = APIClient(baseURL: URL(string: "https://\(host)")!, configuration: configuration)
    let transcript = try JSONDecoder().decode(
      Transcript.self,
      from: JSONSerialization.data(withJSONObject: [
        "entries": ChatTurnLabProtocol.history(host: host), "earlierEntries": 0,
      ]))
    let model = ChatModel(
      conversation: Conversation(
        id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web",
        canContinue: true),
      client: client, user: "test", knownSession: true, transcript: delayed ? nil : transcript)
    defer {
      model.pause()
      DraftStore.removeAccount(client.baseURL.absoluteString + "test")
      _ = ChatTurnLabProtocol.phases.withLock { $0.removeValue(forKey: host) }
    }
    let controller = UIHostingController(
      rootView: NavigationStack {
        NavigationLink("Open chat") {
          ChatView(model: model)
            .environment(\.scenePhase, .active)
            .environment(\.dynamicTypeSize, dynamicTypeSize)
        }
      })
    for _ in 0..<100 where UIApplication.shared.connectedScenes.isEmpty {
      try await Task.sleep(for: .milliseconds(50))
    }
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
    let layoutStart = CACurrentMediaTime()
    controller.view.layoutIfNeeded()
    let open = try XCTUnwrap(nodes(controller.view).first { $0.accessibilityLabel == "Open chat" })
    XCTAssertTrue(open.accessibilityActivate())
    let chatReady = {
      self.scrollViews(in: controller.view).contains {
        !($0 is UITextView) && $0.bounds.height > 0
      }
        && self.descendants(in: controller.view).contains {
          $0 is UITextField || $0 is UITextView
        }
    }
    let readinessDeadline = ContinuousClock.now + .seconds(3)
    while !chatReady(), ContinuousClock.now < readinessDeadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertTrue(chatReady(), "The chat scroll view and composer must appear after navigation.")
    let firstLayout = CACurrentMediaTime() - layoutStart
    var settledAt = 0.0
    var lastHeight: CGFloat = -1
    for _ in 0..<(sendBeforeHistory ? 0 : 60) {
      try await Task.sleep(for: .milliseconds(20))
      let height = scrollViews(in: controller.view).map(\.contentSize.height).max() ?? 0
      if height != lastHeight {
        lastHeight = height
        settledAt = CACurrentMediaTime() - layoutStart
      }
    }
    print(
      "\(tag) TIMING firstLayout=\(Int(firstLayout * 1000))ms contentSettled=\(Int(settledAt * 1000))ms height=\(Int(lastHeight))"
    )
    try await Task.sleep(for: .milliseconds(delayed ? 0 : 200))
    let scroll = try XCTUnwrap(
      scrollViews(in: controller.view).max { $0.contentSize.height < $1.contentSize.height })
    print("\(tag) opened \(geometry(scroll)) ink=\(ink(scroll)) messages=\(model.messages.count)")
    if !sendBeforeHistory, scroll.contentSize.height > scroll.bounds.height {
      XCTAssertEqual(distanceFromBottom(scroll), 0, accuracy: 2, geometry(scroll))
    }

    if scrollUp > 0 {
      try await drag(scroll, to: max(0, scroll.contentOffset.y - scrollUp))
    } else if scrollUp < 0 {
      var y = scroll.contentOffset.y
      while y > 0 {
        y = max(0, y - 2500)
        try await drag(scroll, to: y)
      }
    }
    print("\(tag) positioned \(geometry(scroll)) ink=\(ink(scroll))")
    if expandActivity {
      let disclosure = try XCTUnwrap(
        nodes(controller.view).first {
          $0.accessibilityLabel?.hasPrefix("Ran commands") == true
        })
      XCTAssertTrue(disclosure.accessibilityActivate())
      try await Task.sleep(for: .milliseconds(300))
    }

    model.draft = "Please check the next thing."
    try await Task.sleep(for: .milliseconds(300))
    let editor = descendants(in: controller.view).first {
      ($0 as? UITextField)?.text == model.draft || ($0 as? UITextView)?.text == model.draft
    }
    XCTAssertTrue(try XCTUnwrap(editor).becomeFirstResponder())
    try await Task.sleep(for: .milliseconds(700))
    print("\(tag) focused \(geometry(scroll)) ink=\(ink(scroll))")
    let buttons = nodes(controller.view).filter { $0.accessibilityLabel == "Send message" }
    print("\(tag) sendButtons=\(buttons.count)")
    if sendBeforeHistory { XCTAssertFalse(model.hasLoadedTranscript) }
    let start = ContinuousClock.now
    let activated = buttons.first?.accessibilityActivate() ?? false
    print("\(tag) activated=\(activated)")
    XCTAssertTrue(activated, "The test must exercise the Send button.")
    var last = ""
    var minimumInk = 1.0
    var worstDistance: CGFloat = 0
    var reversals = 0
    var previousOffset = scroll.contentOffset.y
    var previousDirection: CGFloat = 0
    var blankSamples = 0
    var readingOffset: CGFloat?
    for sample in 0..<280 {
      try await Task.sleep(for: .milliseconds(20))
      if readDuringReply, readingOffset == nil, model.partial.count > 100 {
        try await drag(scroll, to: max(0, scroll.contentOffset.y - 1_000))
        readingOffset = scroll.contentOffset.y
      }
      if let readingOffset {
        XCTAssertEqual(scroll.contentOffset.y, readingOffset, accuracy: 2, geometry(scroll))
      }
      let distance = distanceFromBottom(scroll)
      let amount = sample.isMultiple(of: 2) ? ink(scroll) : -1
      if sample.isMultiple(of: 2) {
        XCTAssertGreaterThanOrEqual(amount, 0, "The transcript capture must succeed.")
      }
      if amount >= 0 {
        minimumInk = min(minimumInk, amount)
        if amount < 0.004 { blankSamples += 1 }
      }
      if abs(distance) > abs(worstDistance) { worstDistance = distance }
      let direction = scroll.contentOffset.y - previousOffset
      if direction != 0 {
        if previousDirection != 0, (direction > 0) != (previousDirection > 0) { reversals += 1 }
        previousDirection = direction
      }
      previousOffset = scroll.contentOffset.y
      let line =
        "distance=\(Int(distance)) offset=\(Int(scroll.contentOffset.y)) content=\(Int(scroll.contentSize.height)) viewport=\(Int(scroll.bounds.height)) run=\(model.activeRunID ?? "-") messages=\(model.messages.count) partial=\(model.partial.count)"
      if line != last {
        let elapsed = (ContinuousClock.now - start).components
        let ms = elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000
        print("\(tag) t=\(ms) \(line) ink=\(amount)")
        last = line
      }
    }
    print(
      "\(tag) SUMMARY final=\(geometry(scroll)) ink=\(ink(scroll)) minInk=\(minimumInk) blankSamples=\(blankSamples) worstDistance=\(Int(worstDistance)) reversals=\(reversals) lastMessage=\(model.messages.last?.text.count ?? -1)"
    )
    XCTAssertEqual(blankSamples, 0, "The transcript must remain visible after Send.")
    XCTAssertNil(model.activeRunID)
    XCTAssertTrue(model.draft.isEmpty)
    XCTAssertEqual(model.messages.last?.text, ChatTurnLabProtocol.reply(host: host))
    if readDuringReply {
      XCTAssertNotNil(readingOffset)
      XCTAssertGreaterThan(distanceFromBottom(scroll), scroll.bounds.height)
    } else if scroll.contentSize.height > scroll.bounds.height {
      XCTAssertEqual(distanceFromBottom(scroll), 0, accuracy: 2, geometry(scroll))
      XCTAssertLessThan(abs(worstDistance), scroll.bounds.height, "\(tag): lost the latest message")
    } else {
      XCTAssertEqual(
        scroll.contentOffset.y, -scroll.adjustedContentInset.top, accuracy: 2, geometry(scroll))
    }
  }

  private func distanceFromBottom(_ scroll: UIScrollView) -> CGFloat {
    scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.contentOffset.y
      - scroll.bounds.height
  }

  private func geometry(_ scroll: UIScrollView) -> String {
    "distance=\(Int(distanceFromBottom(scroll))) offset=\(Int(scroll.contentOffset.y)) content=\(Int(scroll.contentSize.height)) viewport=\(Int(scroll.bounds.height))"
  }

  private func ink(_ scroll: UIScrollView) -> Double {
    guard let window = scroll.window else { return -1 }
    let frame = scroll.convert(scroll.bounds, to: window)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 0.25
    let image = UIGraphicsImageRenderer(bounds: frame, format: format).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
    }
    guard let cg = image.cgImage, let data = cg.dataProvider?.data,
      let bytes = CFDataGetBytePtr(data)
    else { return -1 }
    let bytesPerPixel = cg.bitsPerPixel / 8
    var counts: [Int: Int] = [:]
    var total = 0
    for y in stride(from: 0, to: cg.height, by: 2) {
      for x in stride(from: 0, to: cg.width, by: 2) {
        let pixel = bytes + y * cg.bytesPerRow + x * bytesPerPixel
        total += 1
        counts[
          (Int(pixel[0]) >> 4) << 8 | (Int(pixel[1]) >> 4) << 4 | Int(pixel[2]) >> 4, default: 0] +=
          1
      }
    }
    return total == 0 ? -1 : 1 - Double(counts.values.max() ?? 0) / Double(total)
  }

  private func scrollViews(in view: UIView) -> [UIScrollView] {
    ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
  }

  private func descendants(in view: UIView) -> [UIView] {
    view.subviews.flatMap { [$0] + descendants(in: $0) }
  }
}
