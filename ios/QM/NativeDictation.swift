import AVFAudio
import SwiftUI

@MainActor
protocol SpeechToTextProvider {
  func availability() async throws -> String
  func transcribe(file: URL) async throws -> String
}

struct QMSpeechToTextProvider: SpeechToTextProvider {
  let client: APIClient
  func availability() async throws -> String {
    struct Capability: Decodable {
      let enabled: Bool
      let provider: String?
    }
    let capability: Capability = try await client.fetch("api/dictation")
    guard capability.enabled, let provider = capability.provider else {
      throw QMError.message("Dictation is not enabled for this account yet.")
    }
    return provider
  }
  func transcribe(file: URL) async throws -> String { try await client.transcribe(file: file) }
}

@MainActor @Observable
final class NativeDictationModel: NSObject, AVAudioRecorderDelegate {
  enum State { case idle, preparing, recording, ready, transcribing, retry }
  private(set) var state = State.idle
  private(set) var elapsed = 0.0
  private(set) var level = 0.0
  private(set) var providerName = ""
  private(set) var completedText: String?
  var error: String?
  var busy: Bool { state != .idle }
  private let provider: any SpeechToTextProvider
  private var recorder: AVAudioRecorder?
  private var ownsAudioSession = false
  private var file: URL?
  private var operation: Task<Void, Never>?
  private var timer: Task<Void, Never>?
  private var revision = UUID()

  init(provider: any SpeechToTextProvider) { self.provider = provider }

  func start() {
    guard state == .idle else { return }
    completedText = nil
    error = nil
    elapsed = 0
    level = 0
    state = .preparing
    let current = UUID()
    revision = current
    operation = Task {
      do {
        let name = try await provider.availability()
        guard current == revision, !Task.isCancelled else { return }
        providerName = name
        guard await AVAudioApplication.requestRecordPermission() else {
          throw QMError.message("Enable microphone access for QM in Settings to dictate.")
        }
        guard current == revision, !Task.isCancelled else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
          .playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        ownsAudioSession = true
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
          "qm-dictation-\(UUID().uuidString).m4a")
        file = url
        let recorder = try AVAudioRecorder(
          url: url,
          settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
          ])
        self.recorder = recorder
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord() else {
          throw QMError.message("Could not prepare the microphone.")
        }
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        guard recorder.record() else {
          throw QMError.message("Could not start recording.")
        }
        state = .recording
        timer = Task {
          while current == revision, state == .recording, !Task.isCancelled {
            recorder.updateMeters()
            elapsed = recorder.currentTime
            level = max(0, min(1, (Double(recorder.averagePower(forChannel: 0)) + 50) / 50))
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
          }
        }
      } catch {
        guard current == revision, !Task.isCancelled else { return }
        cancel()
        self.error = error.localizedDescription
      }
    }
  }

  func finish() {
    guard state == .recording || state == .ready else { return }
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
    guard state == .retry, file != nil else { return }
    state = .transcribing
    error = nil
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
        let text = try await provider.transcribe(file: file).trimmingCharacters(
          in: .whitespacesAndNewlines)
        guard current == revision, !Task.isCancelled else { return }
        guard !text.isEmpty else {
          throw QMError.message("No speech was detected. Try recording again.")
        }
        cancel()
        completedText = text
      } catch {
        guard current == revision, !Task.isCancelled else { return }
        state = .retry
        self.error = error.localizedDescription
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
    error = nil
  }

  private func stopRecording() {
    timer?.cancel()
    timer = nil
    recorder?.delegate = nil
    recorder?.stop()
    recorder = nil
    if ownsAudioSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      ownsAudioSession = false
    }
  }

  nonisolated func audioRecorderDidFinishRecording(
    _ recorder: AVAudioRecorder, successfully flag: Bool
  ) {
    Task { @MainActor [weak self] in
      guard let self, self.recorder === recorder else { return }
      if flag {
        stop()
      } else {
        cancel()
        error = "Recording was interrupted. Please try again."
      }
    }
  }

  nonisolated func audioRecorderEncodeErrorDidOccur(
    _ recorder: AVAudioRecorder, error: (any Error)?
  ) {
    Task { @MainActor [weak self] in
      guard let self, self.recorder === recorder else { return }
      cancel()
      self.error = "Could not record audio. Please try again."
    }
  }

  static func appending(_ transcript: String, to draft: String) -> String {
    let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return draft }
    guard !draft.isEmpty else { return text }
    return draft + (draft.last?.isWhitespace == true ? "" : " ") + text
  }
}
