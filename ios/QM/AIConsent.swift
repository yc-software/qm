import SwiftUI

/// App Review 5.1.1(i)/5.1.2(i): say what goes to AI providers, and who they are, and get
/// the person's agreement in the app before chat, dictation or voice sends anything.
enum AIConsent {
  static let key = "aiDataSharingConsent"
  static let policyURL = URL(
    string: "https://github.com/yc-software/qm/blob/main/ios/PRIVACY.md#ai-providers")!
}

struct AIConsentDetails: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(
        "QM answers you with AI models run by other companies. Before you use chat, dictation or Talk to QM, here is what they receive."
      )
      Label {
        Text(
          "**What is sent:** the messages you send, files and photos you attach, and content QM reads from apps you connect, such as Slack, Gmail or GitHub, while it works on your request."
        )
      } icon: {
        Image(systemName: "doc.text")
      }
      Label {
        Text(
          "**Who receives it:** your QM workspace sends it to the provider of the model you choose: Anthropic (Claude) or OpenAI (GPT), or another provider your workspace's operator has set up. The model picker shows which."
        )
      } icon: {
        Image(systemName: "building.2")
      }
      Label {
        Text(
          "**Your voice:** in Talk to QM, your audio goes from this device to OpenAI, which transcribes it and speaks replies. Dictation is transcribed on this device, and only the text you send is shared."
        )
      } icon: {
        Image(systemName: "waveform")
      }
      Label {
        Text(
          "**What for:** only to answer your requests and do the work you ask for. QM has no ads or tracking."
        )
      } icon: {
        Image(systemName: "checkmark.shield")
      }
      Link("Read the privacy policy", destination: AIConsent.policyURL)
    }
    .labelStyle(.titleAndIcon)
  }
}

/// Asked before the first message, dictation or voice call; AI features stay off until agreed.
struct AIConsentSheet: View {
  @AppStorage(AIConsent.key) private var consented = false
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        AIConsentDetails().padding(24).frame(maxWidth: 560, alignment: .leading)
          .frame(maxWidth: .infinity)
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 8) {
          Button {
            consented = true
            dismiss()
          } label: {
            Text("Agree").frame(maxWidth: .infinity, minHeight: 32)
          }.buttonStyle(.borderedProminent)
          Button("Not now") { dismiss() }.frame(minHeight: 44)
          Text("You can change this in Settings.").font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: 560).padding(.horizontal, 24).padding(.vertical, 12)
        .frame(maxWidth: .infinity).background(.bar)
      }
      .navigationTitle("Sharing data with AI")
      .navigationBarTitleDisplayMode(.inline)
    }
    .interactiveDismissDisabled()
  }
}

/// Settings entry to review the disclosure and give or withdraw consent.
struct AIConsentSettings: View {
  @AppStorage(AIConsent.key) private var consented = false
  var body: some View {
    QMForm {
      Section { AIConsentDetails() }
      Section {
        Toggle("Share with AI providers", isOn: $consented)
      } footer: {
        Text("While this is off, QM asks again before chat, dictation or Talk to QM can be used.")
      }
    }
    .navigationTitle("AI data sharing").scrollContentBackground(.hidden).background(QMTheme.paper)
  }
}

/// Runs an action now if the person has agreed to share data with AI providers; otherwise
/// asks first and runs it only if they agree.
@MainActor @Observable final class AIConsentGate {
  var asking = false
  private var pending: () -> Void = {}

  func run(_ action: @escaping () -> Void) {
    if UserDefaults.standard.bool(forKey: AIConsent.key) { return action() }
    pending = action
    asking = true
  }

  fileprivate func finish() {
    if UserDefaults.standard.bool(forKey: AIConsent.key) { pending() }
    pending = {}
  }
}

extension View {
  func aiConsentSheet(_ gate: AIConsentGate) -> some View {
    @Bindable var gate = gate
    return sheet(isPresented: $gate.asking, onDismiss: gate.finish, content: { AIConsentSheet() })
  }
}
