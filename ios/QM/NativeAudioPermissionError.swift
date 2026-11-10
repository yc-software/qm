import Foundation

enum NativeAudioPermissionError: LocalizedError, Equatable {
  case microphoneDenied, speechDenied, speechRestricted

  var canOpenSettings: Bool { self != .speechRestricted }

  var errorDescription: String? {
    switch self {
    case .microphoneDenied:
      "Microphone access is off for QM. Open Settings and enable Microphone to use dictation or voice."
    case .speechDenied:
      "Speech Recognition is off for QM. Open Settings and enable Speech Recognition to dictate."
    case .speechRestricted:
      "Speech Recognition is restricted on this device. Check Screen Time or device management restrictions, or type your message."
    }
  }
}
