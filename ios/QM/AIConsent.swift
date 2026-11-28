import SwiftUI

/// The app says what it sends to an AI service, and to whom, and asks before sending it. Live
/// voice goes to OpenAI; everything else goes to the workspace, which runs it through the AI
/// providers its operator chose.
enum AIConsent {
  /// Set when the person allows Talk to QM to connect to OpenAI. Settings can withdraw it.
  static let voiceKey = "voiceConsent"
  /// The workspace origins whose AI processing notice the person has accepted.
  static let processingKey = "aiProcessingAccepted"
  static let policy = URL(string: "https://github.com/yc-software/qm/blob/main/ios/PRIVACY.md")!
}

struct AIConsentView: View {
  let title: String
  let summary: String
  let sent: [String]
  let detail: String
  let confirm: String
  let cancel: String
  let onConfirm: () -> Void
  let onCancel: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text(summary)
          VStack(alignment: .leading, spacing: 8) {
            ForEach(sent, id: \.self) { Label($0, systemImage: "arrow.up.circle") }
          }
          Text(detail).foregroundStyle(.secondary)
          Link("Privacy policy", destination: AIConsent.policy)
        }
        .padding(24).frame(maxWidth: QMTheme.conversationWidth, alignment: .leading)
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 8) {
          Button(confirm, action: onConfirm).buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
          Button(cancel, role: .cancel, action: onCancel)
        }
        .controlSize(.large).padding(.horizontal, 24).padding(.bottom)
      }
      .background(QMTheme.paper)
      .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
    .interactiveDismissDisabled()
  }
}

extension AIConsentView {
  static func voice(onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void) -> Self {
    AIConsentView(
      title: "Talk to QM uses OpenAI",
      summary:
        "A Talk to QM call connects this device directly to OpenAI, which provides the voice.",
      sent: [
        "Your microphone audio, while the call is active",
        "The text of QM’s progress and results, so they can be read aloud",
      ],
      detail:
        "OpenAI returns a transcript of what you say, which the app sends to your QM workspace as a task. Dictation in the composer stays on this device and does not use OpenAI.",
      confirm: "Allow", cancel: "Not now", onConfirm: onConfirm, onCancel: onCancel)
  }

  static func processing(
    workspace: String, onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void
  ) -> Self {
    AIConsentView(
      title: "Your workspace uses AI",
      summary: "QM sends what you give it to your QM workspace at \(workspace):",
      sent: [
        "The messages you send", "Files, photos and videos you attach",
        "Transcripts of what you say to QM",
      ],
      detail:
        "The workspace processes them with AI models from providers such as Anthropic and OpenAI, chosen by whoever runs it. Nothing is sent until you continue.",
      confirm: "Continue", cancel: "Cancel", onConfirm: onConfirm, onCancel: onCancel)
  }
}
