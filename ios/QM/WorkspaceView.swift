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
    List {
      ForEach(["Your work", "Automations", "Tools and settings"], id: \.self) { section in
        Section {
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
              HStack(spacing: 12) {
                Image(systemName: destination.icon).frame(width: 24)
                Text(destination.title)
              }
              .font(.body)
            }
            .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
            .listRowBackground(QMTheme.paper)
            .listRowSeparatorTint(QMTheme.border)
          }
        } header: {
          Text(section).font(.subheadline).foregroundStyle(.secondary).textCase(nil)
        }
      }
    }
    .listStyle(.insetGrouped)
    .listSectionSpacing(24)
    .scrollContentBackground(.hidden)
    .background(background)
    .foregroundStyle(QMTheme.ink)
    .toolbarBackground(background, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .navigationTitle("Your Workspace").navigationBarTitleDisplayMode(.inline)
  }

  private var background: Color {
    NativeThemeStore.shared.active?.surface.color ?? Color(uiColor: .systemGroupedBackground)
  }
}
