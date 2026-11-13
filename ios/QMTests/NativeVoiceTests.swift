import AVFAudio
import Speech
import XCTest
import os

@testable import QM

final class NativeVoiceTests: XCTestCase {
  @MainActor
  func testDictationAppendsWithoutReplacingOrDuplicatingTheDraft() {
    XCTAssertEqual(
      NativeDictationModel.appending(" new words ", to: "Existing draft"),
      "Existing draft new words")
    XCTAssertEqual(NativeDictationModel.appending("new words", to: "List:\n"), "List:\nnew words")
    XCTAssertEqual(NativeDictationModel.appending(" ", to: "Keep this"), "Keep this")
  }

  @MainActor
  func testDictationAudioTapProcessesBuffersOffMainActor() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "qm-dictation-tap-\(UUID().uuidString).caf")
    defer { try? FileManager.default.removeItem(at: url) }
    let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    nonisolated(unsafe) let buffer = try XCTUnwrap(
      AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128))
    buffer.frameLength = 128
    let samples = try XCTUnwrap(buffer.floatChannelData?.pointee)
    for index in 0..<Int(buffer.frameLength) { samples[index] = 0.25 }
    let recording = try AVAudioFile(forWriting: url, settings: format.settings)
    let request = SFSpeechAudioBufferRecognitionRequest()
    let meter = DictationLevel()
    let errors = OSAllocatedUnfairLock(initialState: [String]())
    nonisolated(unsafe) let tap = dictationAudioTap(
      request: request, recording: recording, meter: meter
    ) { message in errors.withLock { $0.append(message) } }
    let calledOnMainThread = await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        tap(buffer, AVAudioTime(sampleTime: 0, atRate: 48_000))
        continuation.resume(returning: Thread.isMainThread)
      }
    }
    request.endAudio()
    XCTAssertFalse(calledOnMainThread)
    XCTAssertTrue(errors.withLock { $0.isEmpty })
    XCTAssertEqual(recording.length, 128)
    XCTAssertEqual(meter.read(), (20 * log10(0.25) + 50) / 50, accuracy: 0.0001)
  }

  @MainActor
  func testCanceledPreparationCannotStartTheMicrophoneOrChangeTheDraft() async {
    let provider = DelayedDictationProvider()
    let model = NativeDictationModel(provider: provider)
    model.start()
    for _ in 0..<100 {
      if provider.continuation != nil { break }
      await Task.yield()
    }
    XCTAssertEqual(model.state, .preparing)
    model.cancel()
    provider.continuation?.resume()
    for _ in 0..<10 { await Task.yield() }
    XCTAssertEqual(model.state, .idle)
    XCTAssertNil(model.completedText)
    XCTAssertNil(model.error)
  }

  func testCaptionsDeduplicateAndStayBounded() {
    var transcript = NativeVoiceTranscript()
    for index in 0..<250 {
      let event: [String: Any] = [
        "type": "session.input_transcript.delta", "event_id": "\(index)", "delta": "Hello",
        "start_ms": Double(index * 3000), "end_ms": Double(index * 3000 + 200),
      ]
      XCTAssertTrue(transcript.append(event))
      XCTAssertFalse(transcript.append(event))
    }
    XCTAssertEqual(transcript.fragments.count, 200)
    XCTAssertEqual(transcript.fragments.first?.role, "You")
  }
  func testTranscriptGroupsWordsAndKeepsOverlappingSpeakersIndependent() {
    var transcript = NativeVoiceTranscript()
    let deltas: [(String, String, Double, Double)] = [
      ("input", "Check", 0, 200), ("output", "Sure", 100, 300),
      ("input", " for", 200, 400), ("input", " Slack", 400, 600),
      ("output", ".", 300, 500), ("input", " open loops", 600, 1000),
      ("input", "Another request", 5000, 5500),
    ]
    for (role, text, start, end) in deltas {
      XCTAssertTrue(
        transcript.append([
          "type": "session.\(role)_transcript.delta", "delta": text,
          "start_ms": start, "end_ms": end,
        ]))
    }
    XCTAssertEqual(
      transcript.fragments.map(\.text),
      ["Check", "Sure", " for Slack", ".", " open loops", "Another request"])
    XCTAssertEqual(transcript.fragments.map(\.role), ["You", "QM", "You", "QM", "You", "You"])
  }

  func testVoiceInterleavesActivityAndSpeechWithoutReplayingPolledTools() throws {
    var transcript = NativeVoiceTranscript()
    func speech(_ text: String, _ start: Double) -> [String: Any] {
      [
        "type": "session.output_transcript.delta", "delta": text,
        "start_ms": start, "end_ms": start + 100,
      ]
    }
    let tool = try JSONDecoder().decode(
      Item.self,
      from: Data(
        #"{"createdAt":1,"seq":2,"kind":"ToolCall","callId":"c1","tool":"search","body":{}}"#
          .utf8))
    _ = transcript.append(speech("Checking.", 0))
    transcript.appendActivity([tool], runID: "run")
    _ = transcript.append(speech(" Found it.", 200))
    transcript.appendActivity([tool], runID: "run")
    transcript.appendResult("One result")
    XCTAssertEqual(transcript.items.count, 4)
    guard case .speech(let first) = transcript.items[0].content,
      case .activity(let activity) = transcript.items[1].content,
      case .speech(let second) = transcript.items[2].content,
      case .result(let result) = transcript.items[3].content
    else { return XCTFail("Events must retain arrival order") }
    XCTAssertEqual(first.text, "Checking.")
    XCTAssertEqual(activity.tool, "search")
    XCTAssertEqual(second.text, " Found it.")
    XCTAssertEqual(result, "One result")
  }

  @MainActor
  func testVoiceMicrophoneDenialStopsConnectingAndOffersSettings() async {
    let model = NativeVoiceModel(
      client: APIClient(baseURL: URL(string: "https://voice-permission.example")!),
      conversation: nil, microphonePermission: { false })
    model.available = true
    await model.start()
    XCTAssertFalse(model.connecting)
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.stopping)
    XCTAssertEqual(model.permissionError, .microphoneDenied)
    XCTAssertEqual(model.permissionError?.canOpenSettings, true)
    XCTAssertEqual(model.status, NativeAudioPermissionError.microphoneDenied.localizedDescription)
  }

  @MainActor
  func testEndingVoiceDuringPermissionPromptIgnoresALateGrant() async throws {
    let requested = expectation(description: "Microphone permission requested")
    var permission: CheckedContinuation<Bool, Never>?
    let model = NativeVoiceModel(
      client: APIClient(baseURL: URL(string: "https://voice-permission.example")!),
      conversation: nil
    ) {
      await withCheckedContinuation {
        permission = $0
        requested.fulfill()
      }
    }
    model.available = true
    let starting = Task { await model.start() }
    defer {
      permission?.resume(returning: false)
      starting.cancel()
      model.finish()
    }
    await fulfillment(of: [requested], timeout: 2)
    let prompt = try XCTUnwrap(permission)
    permission = nil
    XCTAssertTrue(model.connecting)
    model.finish()
    let stoppedRevision = model.revision
    let stoppedStatus = model.status
    prompt.resume(returning: true)
    await starting.value
    XCTAssertFalse(model.connecting)
    XCTAssertFalse(model.connected)
    XCTAssertFalse(model.stopping)
    XCTAssertNil(model.permissionError)
    XCTAssertEqual(model.revision, stoppedRevision)
    XCTAssertEqual(model.status, stoppedStatus)
  }

  @MainActor
  func testEndingVoiceCancelsQueuedTaskBeforeSubmission() async {
    NativeResourcesProtocol.state.withLock { $0 = .init() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeResourcesProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://voice-lifecycle.example")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    model.connected = true
    let revision = model.revision
    let queued = Task {
      await model.submit("Do work", delegation: "late", revision: revision)
    }
    model.finish()
    await queued.value
    XCTAssertTrue(NativeResourcesProtocol.state.withLock { $0.requests.isEmpty })
    XCTAssertFalse(model.connected)
  }

  @MainActor
  func testVoiceDisplaysCompletedReplyWhileRunStillHasBackgroundWork() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [VoiceTaskProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://voice-task.example")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    model.connected = true
    let task = Task {
      await model.submit("Read my tasks", delegation: "call", revision: model.revision)
    }
    defer {
      task.cancel()
      model.finish()
    }
    for _ in 0..<100 {
      if model.taskStatus == "Verified result" { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(model.taskStatus, "Verified result")
    XCTAssertTrue(
      model.transcript.items.contains {
        if case .activity(let entry) = $0.content { return entry.tool == "search" }
        return false
      })
  }

  @MainActor
  func testVoiceWaitsForApprovalMetadataAfterReplyTextCompletes() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [VoiceTaskProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://metadata-\(UUID()).example")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    model.connected = true
    await model.submit("Read my tasks", delegation: "call", revision: model.revision)
    XCTAssertEqual(model.taskStatus, NativeVoiceBridge.approval)
    model.finish()
  }

  @MainActor
  func testVoiceMakesSubmissionFailureVisible() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [VoiceTaskProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://voice-failure.example")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    model.connected = true
    await model.submit("Read my tasks", delegation: "call", revision: model.revision)
    XCTAssertTrue(model.taskStatus?.contains("Could not confirm") == true)
    XCTAssertTrue(model.taskStatus?.contains("Unavailable") == true)
    model.finish()
  }

  @MainActor
  func testRetriedHandOffReusesItsIdempotencyKey() async throws {
    VoiceTaskProtocol.turnKeys.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [VoiceTaskProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://voice-failure-retry.example")!, configuration: configuration)
    let model = NativeVoiceModel(client: client, conversation: nil)
    model.connected = true
    await model.submit("Read my tasks", delegation: "call", revision: model.revision)
    await model.submit("Read my tasks", delegation: "call", revision: model.revision)
    await model.submit("Read my mail", delegation: "other", revision: model.revision)
    let keys = VoiceTaskProtocol.turnKeys.withLock { $0 }
    XCTAssertEqual(keys.count, 3)
    XCTAssertEqual(keys[0], keys[1])
    XCTAssertNotEqual(keys[0], keys[2])
    for key in keys {
      XCTAssertNotNil(key.wholeMatch(of: /[A-Za-z0-9._-]{1,128}/))
    }
    XCTAssertNotEqual(
      NativeVoiceModel.submissionKey(revision: UUID(), delegation: "call"), keys[0])
    XCTAssertNotEqual(
      NativeVoiceModel.submissionKey(revision: model.revision, delegation: nil),
      NativeVoiceModel.submissionKey(revision: model.revision, delegation: nil))
    model.finish()
  }

  @MainActor
  func testAudioInterruptionsAndHeadphoneRemovalDoNotEndVoice() {
    let model = NativeVoiceModel(
      client: APIClient(baseURL: URL(string: "https://voice.example")!), conversation: nil)
    model.connected = true
    let revision = model.revision
    model.interruptAudio(AVAudioSession.InterruptionType.began.rawValue)
    XCTAssertTrue(model.connected)
    XCTAssertTrue(model.status.contains("interrupted"))
    model.interruptAudio(AVAudioSession.InterruptionType.ended.rawValue)
    XCTAssertTrue(model.connected)
    XCTAssertTrue(model.muted)
    model.headphonesDisconnected()
    XCTAssertTrue(model.connected)
    XCTAssertTrue(model.muted)
    XCTAssertEqual(model.revision, revision)
    model.finish()
  }

  @MainActor
  func testSpokenUpdatesWaitThroughInterruptionUntilExplicitUnmute() {
    let model = NativeVoiceModel(
      client: APIClient(baseURL: URL(string: "https://voice.example")!), conversation: nil)
    model.connected = true
    defer { model.finish() }
    var bridge = NativeVoiceBridge()
    model.interruptAudio(AVAudioSession.InterruptionType.began.rawValue)
    bridge.say("Verified result", delegation: "d1")
    XCTAssertFalse(model.canSpeak)
    XCTAssertTrue(bridge.takeOutgoing(canSend: model.canSpeak).isEmpty)
    model.interruptAudio(AVAudioSession.InterruptionType.ended.rawValue)
    XCTAssertTrue(bridge.takeOutgoing(canSend: model.canSpeak).isEmpty)
    model.toggleMute()
    XCTAssertTrue(model.canSpeak)
    XCTAssertEqual(bridge.takeOutgoing(canSend: model.canSpeak).count, 1)
    XCTAssertTrue(bridge.takeOutgoing(canSend: model.canSpeak).isEmpty)
  }
}

@MainActor
private final class DelayedDictationProvider: SpeechToTextProvider {
  var continuation: CheckedContinuation<Void, any Error>?
  func availability() async throws {
    try await withCheckedThrowingContinuation { continuation = $0 }
  }
  func transcribe(file: URL) async throws -> String { "Unused" }
  func recognizeLive(
    request: SFSpeechAudioBufferRecognitionRequest,
    onResult: @escaping @Sendable (String?, Bool, String?) -> Void
  ) throws -> SFSpeechRecognitionTask? { nil }
}

final class VoiceTaskProtocol: URLProtocol, @unchecked Sendable {
  static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
  static let turnKeys = OSAllocatedUnfairLock(initialState: [String]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let failed = request.url?.host?.hasPrefix("voice-failure") == true
    if request.url?.path == "/api/turn",
      let object = try? JSONSerialization.jsonObject(with: request.bodyData) as? [String: Any],
      let key = object["idempotencyKey"] as? String
    {
      Self.turnKeys.withLock { $0.append(key) }
    }
    var body =
      failed
      ? #"{"message":"Unavailable"}"#
      : request.url?.path == "/api/turn"
        ? #"{"runId":"run","status":"queued"}"#
        : #"{"status":"running","replyComplete":true,"activity":[{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"search-1","tool":"search","body":{}}],"result":{"status":"ok","reply":"Verified result"}}"#
    if request.url?.host?.hasPrefix("metadata-") == true, request.url?.path != "/api/turn" {
      let count = Self.counts.withLock { values in
        values[request.url!.absoluteString, default: 0] += 1
        return values[request.url!.absoluteString]!
      }
      body =
        count == 1
        ? #"{"status":"running","replyComplete":true,"partial":"Review the action","result":null}"#
        : #"{"status":"done","result":{"status":"pending_approval"}}"#
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: failed ? 503 : 200,
        httpVersion: nil, headerFields: ["content-type": "application/json"])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
