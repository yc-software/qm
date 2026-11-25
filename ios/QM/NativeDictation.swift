import AVFAudio
import Accelerate
import Speech
import SwiftUI

@MainActor
protocol SpeechToTextProvider {
  func availability() async throws
  func transcribe(file: URL) async throws -> String
  func recognizeLive(
    request: SFSpeechAudioBufferRecognitionRequest,
    onResult: @escaping @Sendable (String?, Bool, String?) -> Void
  ) throws -> SFSpeechRecognitionTask?
}

struct OnDeviceSpeechToTextProvider: SpeechToTextProvider {
  func availability() async throws {
    let status = await speechAuthorizationStatus()
    switch status {
    case .authorized: break
    case .denied: throw NativeAudioPermissionError.speechDenied
    case .restricted: throw NativeAudioPermissionError.speechRestricted
    case .notDetermined:
      throw QMError.message(
        "Speech Recognition permission was not granted. Tap the microphone to try again.")
    @unknown default:
      throw QMError.message("Speech Recognition permission could not be checked. Please try again.")
    }
    try Task.checkCancellation()
    _ = try onDeviceRecognizer()
  }

  func transcribe(file: URL) async throws -> String {
    let recognizer = try onDeviceRecognizer()
    return try await OnDeviceSpeechSession(recognizer: recognizer).transcribe(file: file)
  }

  func recognizeLive(
    request: SFSpeechAudioBufferRecognitionRequest,
    onResult: @escaping @Sendable (String?, Bool, String?) -> Void
  ) throws -> SFSpeechRecognitionTask? {
    let recognizer = try onDeviceRecognizer()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    return startSpeechRecognition(recognizer: recognizer, request: request, onResult: onResult)
  }
}

private func onDeviceRecognizer() throws -> SFSpeechRecognizer {
  guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else {
    throw QMError.message(
      "On-device dictation is unavailable for your current language. You can use the keyboard microphone instead."
    )
  }
  guard recognizer.isAvailable else {
    throw QMError.message("On-device dictation is temporarily unavailable. Please try again.")
  }
  return recognizer
}

@MainActor
private final class OnDeviceSpeechSession {
  private let recognizer: SFSpeechRecognizer
  private var task: SFSpeechRecognitionTask?
  private var continuation: CheckedContinuation<String, any Error>?

  init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func transcribe(file: URL) async throws -> String {
    let request = SFSpeechURLRecognitionRequest(url: file)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard !Task.isCancelled else {
          continuation.resume(throwing: CancellationError())
          return
        }
        self.continuation = continuation
        task = startSpeechRecognition(recognizer: recognizer, request: request) {
          [weak self] text, isFinal, errorMessage in
          Task { @MainActor [weak self] in
            self?.receive(text: text, isFinal: isFinal, errorMessage: errorMessage)
          }
        }
      }
    } onCancel: {
      Task { @MainActor in self.cancel() }
    }
  }

  private func receive(text: String?, isFinal: Bool, errorMessage: String?) {
    guard let continuation else { return }
    if let errorMessage {
      self.continuation = nil
      task = nil
      continuation.resume(throwing: QMError.message(errorMessage))
    } else if isFinal {
      self.continuation = nil
      task = nil
      continuation.resume(returning: text ?? "")
    }
  }

  private func cancel() {
    task?.cancel()
    task = nil
    guard let continuation else { return }
    self.continuation = nil
    continuation.resume(throwing: CancellationError())
  }
}

private func speechAuthorizationStatus() async -> SFSpeechRecognizerAuthorizationStatus {
  await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { status in
      continuation.resume(returning: status)
    }
  }
}

private func startSpeechRecognition(
  recognizer: SFSpeechRecognizer, request: SFSpeechRecognitionRequest,
  onResult: @escaping @Sendable (String?, Bool, String?) -> Void
) -> SFSpeechRecognitionTask {
  recognizer.recognitionTask(with: request) { result, error in
    onResult(
      result?.bestTranscription.formattedString,
      result?.isFinal == true,
      error?.localizedDescription)
  }
}

final class DictationLevel: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0.0

  func update(_ buffer: AVAudioPCMBuffer) {
    guard let samples = buffer.floatChannelData?.pointee else { return }
    let count = Int(buffer.frameLength)
    guard count > 0 else { return }
    var rms: Float = 0
    vDSP_rmsqv(samples, vDSP_Stride(buffer.stride), &rms, vDSP_Length(count))
    let decibels = 20 * log10(max(Double(rms), 0.0001))
    let level = max(0, min(1, (decibels + 50) / 50))
    lock.withLock { value = level }
  }

  func read() -> Double { lock.withLock { value } }
}

/// Carries the recognition request to the audio start-up off the main thread; the main
/// actor only ends it after the engine, which feeds it, has stopped.
struct DictationAudioRequest: @unchecked Sendable {
  let request: SFSpeechAudioBufferRecognitionRequest
}

/// The running microphone, built off the main thread and handed to the main actor once.
struct DictationAudio: @unchecked Sendable {
  let engine: AVAudioEngine
  let recording: AVAudioFile

  /// Tears down audio that started after dictation was already cancelled.
  func stop() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// Activates the audio session and starts recording into `url` and the recognition request.
/// Blocking; run it off the main thread.
nonisolated func startDictationAudio(
  url: URL, request: DictationAudioRequest, meter: DictationLevel,
  onError: @escaping @Sendable (String) -> Void
) throws -> DictationAudio {
  let session = AVAudioSession.sharedInstance()
  try session.setCategory(
    .playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
  try session.setActive(true)
  do {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw QMError.message("Could not prepare the microphone.")
    }
    let recording = try AVAudioFile(forWriting: url, settings: format.settings)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    let tap = dictationAudioTap(
      request: request.request, recording: recording, meter: meter, onError: onError)
    input.installTap(onBus: 0, bufferSize: 4096, format: format, block: tap)
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    return DictationAudio(engine: engine, recording: recording)
  } catch {
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    throw error
  }
}

func dictationAudioTap(
  request: SFSpeechAudioBufferRecognitionRequest, recording: AVAudioFile,
  meter: DictationLevel, onError: @escaping @Sendable (String) -> Void
) -> AVAudioNodeTapBlock {
  { buffer, _ in
    request.append(buffer)
    do {
      try recording.write(from: buffer)
    } catch {
      onError(error.localizedDescription)
    }
    meter.update(buffer)
  }
}

@MainActor @Observable
final class NativeDictationModel {
  enum State { case idle, preparing, recording, ready, transcribing, retry }
  var state = State.idle
  private(set) var elapsed = 0.0
  private(set) var level = 0.0
  private(set) var liveText = ""
  private(set) var completedText: String?
  /// Whether the finished text should be sent straight away rather than left in the draft.
  private(set) var sendsWhenDone = false
  private var silentRecording = false

  /// Whether retrying should listen again. When nothing was heard, reading the same audio
  /// again can only fail the same way.
  var retryRecordsAgain: Bool { liveText.isEmpty || silentRecording }
  private(set) var permissionError: NativeAudioPermissionError?
  var error: String?
  var busy: Bool { state != .idle }
  var canFinish: Bool { state == .recording || state == .ready }
  private let provider: any SpeechToTextProvider
  private let microphonePermission: @MainActor () async -> Bool
  /// How long to wait after the panel starts opening before any microphone setup. Parts of
  /// it still run on the main thread and stalled the opening animation.
  private let openingDelay: Duration
  private var audioEngine: AVAudioEngine?
  private var audioFile: AVAudioFile?
  private var liveRequest: SFSpeechAudioBufferRecognitionRequest?
  private var liveTask: SFSpeechRecognitionTask?
  private var ownsAudioSession = false
  private var file: URL?
  private var operation: Task<Void, Never>?
  private var timer: Task<Void, Never>?
  private(set) var revision = UUID()

  init(
    provider: any SpeechToTextProvider,
    openingDelay: Duration = .zero,
    microphonePermission: @escaping @MainActor () async -> Bool = {
      await AVAudioApplication.requestRecordPermission()
    }
  ) {
    self.provider = provider
    self.openingDelay = openingDelay
    self.microphonePermission = microphonePermission
  }

  func start() {
    guard state == .idle else { return }
    completedText = nil
    sendsWhenDone = false
    silentRecording = false
    error = nil
    permissionError = nil
    elapsed = 0
    level = 0
    liveText = ""
    state = .preparing
    let current = UUID()
    revision = current
    operation = Task { [self] in
      do {
        if openingDelay > .zero { try await Task.sleep(for: openingDelay) }
        guard current == revision, !Task.isCancelled else { return }
        try await provider.availability()
        guard current == revision, !Task.isCancelled else { return }
        guard await microphonePermission() else {
          throw NativeAudioPermissionError.microphoneDenied
        }
        guard current == revision, !Task.isCancelled else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
          "qm-dictation-\(UUID().uuidString).caf")
        file = url
        let request = SFSpeechAudioBufferRecognitionRequest()
        let liveTask = try provider.recognizeLive(request: request) {
          [weak self] text, isFinal, errorMessage in
          Task { @MainActor [weak self] in
            self?.receiveLiveResult(
              text: text, isFinal: isFinal, errorMessage: errorMessage, revision: current)
          }
        }
        liveRequest = request
        self.liveTask = liveTask
        let meter = DictationLevel()
        let onError: @Sendable (String) -> Void = { [weak self] message in
          Task { @MainActor [weak self] in
            guard let self, current == self.revision else { return }
            self.cancel()
            self.error = message
          }
        }
        // Activating the audio session and starting the engine can block for a second or
        // more; on the main thread that froze the panel's opening animation mid-flight.
        let shared = DictationAudioRequest(request: request)
        let audio = try await Task.detached(priority: .userInitiated) {
          try startDictationAudio(url: url, request: shared, meter: meter, onError: onError)
        }.value
        guard current == revision, !Task.isCancelled else {
          audio.stop()
          return
        }
        ownsAudioSession = true
        audioEngine = audio.engine
        audioFile = audio.recording
        state = .recording
        let startedAt = ProcessInfo.processInfo.systemUptime
        timer = Task {
          while current == revision, state == .recording, !Task.isCancelled {
            elapsed = ProcessInfo.processInfo.systemUptime - startedAt
            level = meter.read()
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
          }
        }
        operation = nil
      } catch {
        guard current == revision, !Task.isCancelled else { return }
        cancel()
        self.error = error.localizedDescription
        permissionError = error as? NativeAudioPermissionError
      }
    }
  }

  func receiveLiveResult(
    text: String?, isFinal: Bool, errorMessage: String?, revision current: UUID
  ) {
    guard current == revision, state == .recording else { return }
    if let text { liveText = text }
    if let errorMessage {
      state = .retry
      stopRecording()
      error = errorMessage
    } else if isFinal {
      stop()
    }
  }

  func finish(sending: Bool = false) {
    guard state == .recording || state == .ready else { return }
    sendsWhenDone = sending
    state = .transcribing
    stopRecording()
    transcribe()
  }

  func stop() {
    guard state == .recording else { return }
    state = .ready
    stopRecording()
  }

  func retry() {
    guard state == .retry else { return }
    if retryRecordsAgain || file == nil {
      cancel()
      start()
      return
    }
    state = .transcribing
    error = nil
    permissionError = nil
    transcribe()
  }

  private func transcribe() {
    guard let file else {
      cancel()
      return
    }
    let current = revision
    operation = Task {
      do {
        try await provider.availability()
        guard current == revision, !Task.isCancelled else { return }
        let text = try await provider.transcribe(file: file).trimmingCharacters(
          in: .whitespacesAndNewlines)
        guard current == revision, !Task.isCancelled else { return }
        guard !text.isEmpty else {
          silentRecording = true
          throw QMError.message("No speech was detected. Try recording again.")
        }
        cancel()
        completedText = text
      } catch {
        guard current == revision, !Task.isCancelled else { return }
        state = .retry
        self.error = error.localizedDescription
        permissionError = error as? NativeAudioPermissionError
      }
    }
  }

  func cancel() {
    revision = UUID()
    operation?.cancel()
    operation = nil
    stopRecording()
    if let file { try? FileManager.default.removeItem(at: file) }
    file = nil
    state = .idle
    level = 0
    liveText = ""
    error = nil
    permissionError = nil
  }

  private func stopRecording() {
    timer?.cancel()
    timer = nil
    audioEngine?.stop()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine = nil
    audioFile = nil
    liveRequest?.endAudio()
    liveRequest = nil
    liveTask?.cancel()
    liveTask = nil
    if ownsAudioSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      ownsAudioSession = false
    }
  }

  static func appending(_ transcript: String, to draft: String) -> String {
    let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return draft }
    guard !draft.isEmpty else { return text }
    return draft + (draft.last?.isWhitespace == true ? "" : " ") + text
  }
}
