import SwiftUI

struct NativeSetupView: View {
  let client: APIClient
  let identity: Identity
  var body: some View {
    QMList {
      Section {
        VStack(alignment: .leading, spacing: 14) {
          Text("Make QM your own.")
            .font(.custom("IowanOldStyle-Roman", size: 34, relativeTo: .largeTitle))
          Text(
            "Connect the tools you work with, choose your AI account, and give QM the context it needs."
          )
          .foregroundStyle(.secondary)
        }.padding(.vertical, 12)
      }.listRowBackground(QMTheme.paper)
      Section("Connect your work") {
        NavigationLink {
          NativeConnectedApps(client: client)
        } label: {
          setupLabel("Connect apps", "Bring your tools into QM.", "square.stack.3d.up")
        }
        NavigationLink {
          NativeSlackAccountView(client: client)
        } label: {
          setupLabel(
            "Connect your Slack account", "Let QM work with your Slack context.",
            "bubble.left.and.bubble.right")
        }
        NavigationLink {
          NativeKeychainView(client: client)
        } label: {
          setupLabel(
            "Manage credentials", "Review access and share credentials with a purpose.", "key")
        }
      }
      Section("Choose how QM works") {
        NavigationLink {
          NativeModelAccountsView(client: client)
        } label: {
          setupLabel(
            "AI accounts", "Use workspace access or connect your own account.", "person.crop.circle"
          )
        }
        NavigationLink {
          RuntimeControlsView(client: client, scopeID: "personal:\(identity.user)")
        } label: {
          setupLabel(
            "Model and effort", "Choose the defaults for your conversations.", "slider.horizontal.3"
          )
        }
        NavigationLink {
          NativeMemoryView(client: client)
        } label: {
          setupLabel("Memory", "Review what QM remembers and add useful context.", "brain")
        }
      }
      Section {
        Text("You can start a conversation at any time and return here from Settings.")
          .font(.footnote).foregroundStyle(.secondary)
      }.listRowBackground(QMTheme.paper)
    }.navigationTitle("Set up QM").scrollContentBackground(.hidden).background(QMTheme.paper)
  }
  private func setupLabel(_ title: String, _ detail: String, _ icon: String) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.headline)
        Text(detail).font(.subheadline).foregroundStyle(.secondary)
      }.padding(.vertical, 8)
    } icon: {
      Image(systemName: icon).foregroundStyle(QMTheme.ink)
    }
  }
}
