import SwiftUI

struct WorkspaceDestination: Identifiable {
  let id: String
  let title: String
  let icon: String
  var section: String {
    switch id {
    case "inbox", "calendar", "voice.html", "contexts", "files": "Your work"
    case "crons", "webhooks", "loops": "Automations"
    default: "Tools and settings"
    }
  }

  static func available(to identity: Identity) -> [Self] {
    var destinations: [Self] = [
      .init(id: "voice.html", title: "Talk to QM", icon: "waveform"),
      .init(id: "contexts", title: "Projects", icon: "folder"),
      .init(id: "files", title: "Files", icon: "doc.on.doc"),
      .init(id: "crons", title: "Crons", icon: "clock"),
      .init(id: "webhooks", title: "Webhooks", icon: "bolt.horizontal"),
      .init(id: "keychain", title: "Keychain", icon: "key"),
      .init(id: "apps", title: "Apps", icon: "square.stack.3d.up"),
      .init(id: "memory", title: "Memory", icon: "brain"),
      .init(id: "skills", title: "Skills", icon: "shippingbox"),
      .init(id: "settings", title: "Settings", icon: "gearshape"),
    ]
    if identity.permissions?.contains("inbox") == true {
      destinations.insert(
        contentsOf: [
          .init(id: "inbox", title: "Inbox", icon: "tray"),
          .init(id: "calendar", title: "Calendar", icon: "calendar"),
        ], at: 0)
    }
    if identity.permissions?.contains("loops") == true {
      destinations.append(.init(id: "loops", title: "Loops", icon: "repeat"))
    }
    return destinations
  }
}

struct BrowseView: View {
  let identity: Identity
  let client: APIClient

  var body: some View {
    QMList {
      QMPageHeading(
        title: "Your workspace", subtitle: "Conversations, context, and the tools behind your work."
      )
      ForEach(["Your work", "Automations", "Tools and settings"], id: \.self) { section in
        Section(section) {
          ForEach(WorkspaceDestination.available(to: identity).filter { $0.section == section }) {
            destination in
            NavigationLink {
              if destination.id == "contexts" {
                ProjectsView(client: client, identity: identity)
              } else if destination.id == "files" {
                NativeFileLibrary(client: client)
              } else if destination.id == "crons" {
                NativeCronsView(client: client, user: identity.user)
              } else if destination.id == "webhooks" {
                NativeWebhooksView(client: client, user: identity.user)
              } else if destination.id == "skills" {
                NativeSkillsView(client: client, user: identity.user)
              } else if destination.id == "apps" {
                NativeAppsView(client: client, user: identity.user)
              } else if destination.id == "calendar" {
                ContentUnavailableView(
                  "Calendar is coming soon", systemImage: "calendar",
                  description: Text("Your calendar will appear here when it is available in QM."))
              } else if destination.id == "keychain" {
                NativeKeychainView(client: client)
              } else if destination.id == "settings" {
                NativeSettingsView(client: client, identity: identity)
              } else if destination.id == "loops" {
                NativeLoopsView(client: client)
              } else if destination.id == "inbox" {
                NativeInboxView(client: client, user: identity.user)
              } else if destination.id == "memory" {
                NativeMemoryView(client: client)
              } else if destination.id == "voice.html" {
                VoiceView(client: client)
              }
            } label: {
              Label(destination.title, systemImage: destination.icon).padding(.vertical, 10)
            }
            .listRowBackground(QMTheme.paper)
          }
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Browse").navigationBarTitleDisplayMode(.inline)
  }
}
