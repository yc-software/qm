import SwiftUI

// Apple 5.1.1(i)/5.1.2(i): nothing reaches an AI provider until the person agrees here.
struct AIConsentView: View {
  @AppStorage("aiConsent") private var consent = ""
  let signOut: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if consent == "declined" {
          Text(
            "You chose not to allow this, so nothing you write, attach or say is sent. QM needs it to work."
          ).foregroundStyle(.secondary)
        }
        Text("Allow QM to send your data to AI providers?").font(.title2.bold())
        Text("QM answers you with AI models run by other companies.")
        Label(
          "Messages you send, and files, photos and pasted images you attach, go to your QM workspace, which sends them to the provider of the AI model in use: Anthropic, OpenAI, OpenRouter (which passes them on to the model's maker), or another provider your workspace has set up.",
          systemImage: "text.bubble")
        Label(
          "In a voice call, your microphone audio goes from this device to OpenAI, which returns a transcript of what you said and receives QM's replies to read aloud.",
          systemImage: "waveform")
        Text("Dictation in the message box stays on this device. You can change this in Settings.")
          .foregroundStyle(.secondary)
        Link("Privacy policy", destination: aiPrivacyPolicy)
      }
      .padding(24).frame(maxWidth: QMTheme.conversationWidth, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    // Centred when it fits; scrolls from the top when it doesn't.
    .defaultScrollAnchor(.center, for: .alignment)
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 12) {
        choice("Allow", fill: QMTheme.ink, text: QMTheme.paper) { consent = "agreed" }
        choice("Don’t allow", fill: QMTheme.ink.opacity(0.08), text: QMTheme.ink) {
          consent = "declined"
        }
        Button("Sign out", action: signOut).buttonStyle(.borderless)
      }
      .padding(.horizontal, 24).padding(.vertical, 12)
      .frame(maxWidth: QMTheme.conversationWidth).frame(maxWidth: .infinity)
      .background(QMTheme.paper)
    }
    .background(QMTheme.paper.ignoresSafeArea())
    .accessibilityAddTraits(.isModal)
  }

  // Explicit fill and label colours: the themed tint can match the label and hide it.
  private func choice(
    _ title: LocalizedStringKey, fill: Color, text: Color, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Text(title).font(.headline).foregroundStyle(text)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(fill, in: .capsule)
        .contentShape(.capsule)
    }
    .buttonStyle(.plain)
  }
}

let aiPrivacyPolicy = URL(string: "https://github.com/yc-software/qm/blob/main/ios/PRIVACY.md")!
