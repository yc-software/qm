import SwiftUI

struct WorkspaceDestination: Identifiable {
  let id: String
  let title: String
  let icon: String
  var section: String {
    switch id {
    case "inbox", "calendar", "voice.html", "contexts", "bots", "files": "Your work"
    case "crons", "webhooks", "loops": "Automations"
    default: "Tools and settings"
    }
  }

  static func available(to identity: Identity, bots: Bool = false) -> [Self] {
    var destinations: [Self] = [
      .init(id: "voice.html", title: "Talk to QM", icon: "waveform"),
      .init(id: "contexts", title: "Projects", icon: "folder"),
    ]
    if bots { destinations.append(.init(id: "bots", title: "Bots", icon: "")) }
    destinations += [
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

  /// The destinations someone can open, grouped under their section titles in display order.
  static func sections(for identity: Identity, bots: Bool = false) -> [WorkspaceSection] {
    let destinations = available(to: identity, bots: bots)
    return ["Your work", "Automations", "Tools and settings"].map { title in
      WorkspaceSection(title: title, destinations: destinations.filter { $0.section == title })
    }
  }
}

struct WorkspaceSection: Identifiable {
  let title: String
  let destinations: [WorkspaceDestination]
  var id: String { title }
}

struct WorkspaceDestinationView: View {
  let id: String
  let identity: Identity
  let client: APIClient

  var body: some View {
    switch id {
    case "contexts": ProjectsView(client: client, identity: identity)
    case "bots": NativeBotsView(client: client, identity: identity)
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

/// Two-column tiles for every workspace destination, like ChatGPT's More screen, grouped by
/// section.
struct MoreGrid: View {
  let identity: Identity
  let client: APIClient
  @State private var botsEnabled = false

  var body: some View {
    ScrollView {
      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
        alignment: .leading, spacing: 12
      ) {
        ForEach(WorkspaceDestination.sections(for: identity, bots: botsEnabled)) { section in
          Section {
            ForEach(section.destinations) { tile($0) }
          } header: {
            Text(section.title).font(.subheadline).foregroundStyle(.secondary)
              .padding(.top, 12).padding(.leading, 4)
          }
        }
      }
      .padding(16)
    }
    .background(QMTheme.paper)
    .navigationTitle("Your Workspace")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      let bots = BotsModel(client: client, user: identity.user)
      await bots.load()
      botsEnabled = bots.enabled
    }
  }

  private func tile(_ destination: WorkspaceDestination) -> some View {
    NavigationLink {
      WorkspaceDestinationView(id: destination.id, identity: identity, client: client)
    } label: {
      VStack(alignment: .leading, spacing: 0) {
        Text(destination.title).font(.title3)
        Spacer(minLength: 20)
        if destination.id == "bots" {
          BotGlyph(size: 17)
        } else {
          Image(systemName: destination.icon).font(.system(size: 17, weight: .medium))
        }
      }
      .foregroundStyle(QMTheme.ink)
      .padding(18)
      .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
      .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}
