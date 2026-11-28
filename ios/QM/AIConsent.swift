import SwiftUI

/// App Review 5.1.1(i)/5.1.2(i): say what goes to AI providers, and who they are, and get
/// the person's agreement in the app before chat, dictation or voice sends anything.
enum AIConsent {
  /// The workspace address the person agreed for; another workspace may use other providers.
  static let key = "aiDataSharingWorkspace"
  static let policyURL = URL(
    string:
      "https://github.com/yc-software/qm/blob/877149ad8d63482f4b3bbed528d24ec233d5b73e/ios/PRIVACY.md#ai-providers"
  )!
}

struct AIConsentDetails: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(
        "QM answers you with AI models run by other companies. Before you use it, here is what they receive."
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

/// Shown in place of the signed-in app until the person agrees, so nothing they write, attach
/// or say reaches an AI provider first. Withdrawing in Settings brings it back.
struct AIConsentScreen: View {
  @AppStorage(AIConsent.key) private var consented = ""
  @State private var declined = false
  let workspace: URL
  let signOut: () -> Void
  var body: some View {
    NavigationStack {
      ScrollView {
        Group {
          if declined {
            Text(
              "QM needs your agreement to share data with AI providers before you can use it in this workspace."
            )
          } else {
            AIConsentDetails()
          }
        }
        .padding(24).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 8) {
          Button {
            if declined { declined = false } else { consented = workspace.absoluteString }
          } label: {
            Text(declined ? "Review" : "Agree").frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent).controlSize(.large)
          if declined {
            Button("Sign out", role: .destructive, action: signOut).frame(minHeight: 44)
          } else {
            Button("Not now") { declined = true }.frame(minHeight: 44)
          }
        }
        .frame(maxWidth: 560).padding(.horizontal, 24).padding(.vertical, 12)
        .frame(maxWidth: .infinity)
      }
      .background(QMTheme.paper)
      .navigationTitle("Sharing data with AI")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

/// Settings entry to review the disclosure and withdraw consent.
struct AIConsentSettings: View {
  @AppStorage(AIConsent.key) private var consented = ""
  let workspace: URL
  var body: some View {
    QMForm {
      Section { AIConsentDetails() }
      Section {
        Toggle(
          "Share with AI providers",
          isOn: Binding(
            get: { consented == workspace.absoluteString },
            set: { consented = $0 ? workspace.absoluteString : "" }))
      } footer: {
        Text("Turning this off closes QM in this workspace until you agree again.")
      }
    }
    .navigationTitle("AI data sharing").scrollContentBackground(.hidden).background(QMTheme.paper)
  }
}
