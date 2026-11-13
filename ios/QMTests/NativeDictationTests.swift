import Speech
import XCTest

@testable import QM

final class NativeDictationTests: XCTestCase {
  @MainActor
  func testSpeechPermissionFailureDoesNotStartMicrophoneAndOffersTheRightRecovery() async {
    for failure in [NativeAudioPermissionError.speechDenied, .speechRestricted] {
      let provider = DictationPermissionProvider()
      provider.failure = failure
      var microphoneRequests = 0
      let model = NativeDictationModel(provider: provider) {
        microphoneRequests += 1
        return false
      }
      model.start()
      await waitUntil { model.state == .idle }
      XCTAssertEqual(model.state, .idle)
      XCTAssertEqual(model.permissionError, failure)
      XCTAssertEqual(model.permissionError?.canOpenSettings, failure == .speechDenied)
      XCTAssertNotNil(model.error)
      XCTAssertNil(model.completedText)
      XCTAssertEqual(microphoneRequests, 0)
      XCTAssertEqual(provider.recognitionCount, 0)
    }
  }

  @MainActor
  func testMicrophoneDenialReturnsToTheDraftWithSettingsRecovery() async {
    let provider = DictationPermissionProvider()
    let model = NativeDictationModel(provider: provider, microphonePermission: { false })
    model.start()
    await waitUntil { model.state == .idle }
    XCTAssertEqual(model.state, .idle)
    XCTAssertEqual(model.permissionError, .microphoneDenied)
    XCTAssertEqual(model.permissionError?.canOpenSettings, true)
    XCTAssertNotNil(model.error)
    XCTAssertNil(model.completedText)
    XCTAssertEqual(provider.recognitionCount, 0)
  }

  @MainActor
  func testCanceledMicrophonePermissionPromptCannotStartRecording() async {
    let provider = DictationPermissionProvider()
    var permission: CheckedContinuation<Bool, Never>?
    let model = NativeDictationModel(provider: provider) {
      await withCheckedContinuation { permission = $0 }
    }
    model.start()
    await waitUntil { permission != nil }
    XCTAssertEqual(model.state, .preparing)
    model.cancel()
    permission?.resume(returning: true)
    for _ in 0..<10 { await Task.yield() }
    XCTAssertEqual(model.state, .idle)
    XCTAssertEqual(provider.recognitionCount, 0)
    XCTAssertNil(model.permissionError)
    XCTAssertNil(model.error)
    XCTAssertNil(model.completedText)
  }

  @MainActor
  func testNewAttemptClearsThePreviousPermissionFailure() async {
    let provider = DictationPermissionProvider()
    provider.failure = .speechDenied
    let model = NativeDictationModel(provider: provider, microphonePermission: { false })
    model.start()
    await waitUntil { model.state == .idle }
    XCTAssertEqual(model.permissionError, .speechDenied)
    provider.failure = nil
    model.start()
    XCTAssertNil(model.permissionError)
    XCTAssertNil(model.error)
    await waitUntil { model.state == .idle }
    XCTAssertEqual(model.permissionError, .microphoneDenied)
    model.cancel()
    XCTAssertNil(model.permissionError)
    XCTAssertNil(model.error)
  }

  @MainActor
  func testLiveFailureStopsListeningAndRetainsRecognizedWordsForRetry() {
    let model = NativeDictationModel(provider: DictationPermissionProvider())
    model.state = .recording
    model.receiveLiveResult(
      text: "Keep these words", isFinal: false, errorMessage: nil, revision: model.revision)
    model.receiveLiveResult(
      text: nil, isFinal: false, errorMessage: "Recognition service stopped",
      revision: model.revision)
    XCTAssertEqual(model.state, .retry)
    XCTAssertEqual(model.liveText, "Keep these words")
    XCTAssertEqual(model.error, "Recognition service stopped")
    XCTAssertNil(model.completedText)
    model.receiveLiveResult(
      text: "Late callback", isFinal: true, errorMessage: nil, revision: model.revision)
    XCTAssertEqual(model.state, .retry)
    XCTAssertEqual(model.liveText, "Keep these words")
    model.cancel()
  }

  @MainActor
  func testFinalResultStopsRecordingWithoutCompletingTheDraft() {
    let model = NativeDictationModel(provider: DictationPermissionProvider())
    model.state = .recording
    model.receiveLiveResult(
      text: "Final words", isFinal: true, errorMessage: nil, revision: model.revision)
    XCTAssertEqual(model.state, .ready)
    XCTAssertEqual(model.liveText, "Final words")
    XCTAssertNil(model.completedText)
    XCTAssertNil(model.error)
    model.cancel()
  }

  @MainActor
  func testCanceledLiveCallbackCannotChangeTheNextRecording() {
    let model = NativeDictationModel(provider: DictationPermissionProvider())
    model.state = .recording
    let revision = model.revision
    model.cancel()
    model.state = .recording
    model.receiveLiveResult(
      text: "Old words", isFinal: true, errorMessage: "Old failure", revision: revision)
    XCTAssertEqual(model.state, .recording)
    XCTAssertEqual(model.liveText, "")
    XCTAssertNil(model.error)
    XCTAssertNil(model.completedText)
    model.cancel()
  }

  @MainActor
  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<100 {
      if condition() { return }
      await Task.yield()
    }
  }
}

@MainActor
private final class DictationPermissionProvider: SpeechToTextProvider {
  var failure: NativeAudioPermissionError?
  var recognitionCount = 0

  func availability() async throws {
    if let failure { throw failure }
  }

  func transcribe(file: URL) async throws -> String { "Unused" }

  func recognizeLive(
    request: SFSpeechAudioBufferRecognitionRequest,
    onResult: @escaping @Sendable (String?, Bool, String?) -> Void
  ) throws -> SFSpeechRecognitionTask? {
    recognitionCount += 1
    return nil
  }
}
