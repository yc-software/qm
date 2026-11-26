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
              WorkspaceDestinationView(id: destination.id, identity: identity, client: client)
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

struct WorkspaceDestinationView: View {
  let id: String
  let identity: Identity
  let client: APIClient

  var body: some View {
    switch id {
    case "contexts": ProjectsView(client: client, identity: identity)
    case "files": NativeFileLibrary(client: client)
    case "crons": NativeCronsView(client: client, user: identity.user)
    case "webhooks": NativeWebhooksView(client: client, user: identity.user)
    case "skills": NativeSkillsView(client: client, user: identity.user)
    case "apps": NativeAppsView(client: client, user: identity.user)
    case "calendar":
      ContentUnavailableView(
        "Calendar is coming soon", systemImage: "calendar",
        description: Text("Your calendar will appear here when it is available in QM."))
    case "keychain": NativeKeychainView(client: client)
    case "settings": NativeSettingsView(client: client, identity: identity)
    case "loops": NativeLoopsView(client: client)
    case "inbox": NativeInboxView(client: client, user: identity.user)
    case "memory": NativeMemoryView(client: client)
    case "voice.html": VoiceView(client: client)
    default: EmptyView()
    }
  }
}

/// Two-column tiles for every workspace destination, like ChatGPT's More screen.
struct MoreGrid: View {
  let identity: Identity
  let client: APIClient

  private static let tints: [String: Color] = [
    "inbox": .blue, "calendar": .red, "voice.html": .pink, "contexts": .cyan, "files": .orange,
    "crons": .purple, "webhooks": .yellow, "loops": .green, "keychain": .gray, "apps": .indigo,
    "memory": .mint, "skills": .brown, "settings": .gray,
  ]

  var body: some View {
    ScrollView {
      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
        spacing: 12
      ) {
        ForEach(WorkspaceDestination.available(to: identity)) { destination in
          NavigationLink {
            WorkspaceDestinationView(id: destination.id, identity: identity, client: client)
          } label: {
            VStack(alignment: .leading, spacing: 0) {
              Text(destination.title).font(.title3).foregroundStyle(QMTheme.ink)
              Spacer(minLength: 20)
              Image(systemName: destination.icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Self.tints[destination.id] ?? QMTheme.ink)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
            .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
          }
          .buttonStyle(.plain)
        }
      }
      .padding(16)
    }
    .background(QMTheme.paper)
    .navigationBarTitleDisplayMode(.inline)
  }
}
