import SwiftUI

struct NativeConversationTools: View {
  @Bindable var model: ChatModel
  @State private var sharing = false
  @State private var fork: Conversation?
  @State private var cut = "all"
  var body: some View {
    QMList {
      Section("Conversation") {
        Button("Share a snapshot", systemImage: "square.and.arrow.up") { sharing = true }
        Picker("Fork from", selection: $cut) {
          Text("Latest message").tag("all")
          ForEach(
            NativeForkPoint.points(
              model.transcriptItems, inheritedBoundary: model.conversation.forkBoundarySeq)
          ) { point in
            Text(String(point.title.prefix(70))).tag(point.id)
          }
        }
        if model.earlierItems > 0 {
          Button("Load earlier fork points") { Task { await model.loadEarlier() } }
        }
        NavigationLink("Linked conversations") { NativeLinkedConversations(model: model) }
        Button("Fork conversation", systemImage: "arrow.triangle.branch") {
          Task { fork = await model.fork(from: cut == "all" ? nil : cut) }
        }.disabled(model.forking)
        Text("A fork creates a separate conversation from the selected point.").font(.caption)
          .foregroundStyle(.secondary)
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }
      Section("Workspace resources") {
        NavigationLink("Files") {
          NativeFilesView(client: model.client, scope: model.conversation.scopeId)
        }
        NavigationLink("Skills") {
          NativeSkillsView(
            client: model.client, user: model.user, scope: model.conversation.scopeId)
        }
        NavigationLink("Apps") {
          NativeAppsView(client: model.client, user: model.user, scope: model.conversation.scopeId)
        }
        NavigationLink("Model and effort") {
          RuntimeControlsView(
            client: model.client, scopeID: model.conversation.scopeId,
            selected: model.runtimeSelection, onSelect: model.selectRuntime)
        }
      }
      Section("Activity") {
        NavigationLink("Background work") {
          NativeBackgroundView(client: model.client, conversation: model.conversation)
        }
        NavigationLink("Activity log") { NativeActivityView(model: model) }
      }
    }
    .navigationTitle("Conversation tools").navigationBarTitleDisplayMode(.inline)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .sheet(isPresented: $sharing) {
      NativeConversationShare(client: model.client, conversation: model.conversation)
    }
    .navigationDestination(item: $fork) { conversation in
      ChatView(
        model: ChatModel(
          conversation: conversation, client: model.client, user: model.user, knownSession: true))
    }
  }

}

struct NativeConversationShare: View {
  struct Result: Decodable {
    struct Share: Decodable {
      let token: String
      let audience: String
    }
    let share: Share?
  }
  let client: APIClient
  let conversation: Conversation
  @Environment(\.dismiss) private var dismiss
  @State private var audience = "internal"
  @State private var result: Result.Share?
  @State private var busy = false
  @State private var confirming = false
  @State private var error: String?
  private var url: URL? {
    result.map { client.url("share/\($0.audience.apiComponent)/\($0.token.apiComponent)") }
  }
  var body: some View {
    NavigationStack {
      QMForm {
        Picker("Who can view", selection: $audience) {
          Text("People in this workspace").tag("internal")
          Text("Anyone with the link").tag("external")
        }
        .onChange(of: audience) { result = nil }
        Text(
          "This shares a snapshot. Subsequent messages will not be visible unless you share again.")
        if audience == "external" {
          Text(
            "Anyone with the link can read this conversation. Review its contents before creating the link."
          ).foregroundStyle(.orange)
        }
        Button(result == nil ? "Create link" : "Create new snapshot") { confirming = true }
        if let url {
          ShareLink("Share conversation", item: url)
          Text(url.absoluteString).font(.footnote).textSelection(.enabled)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .disabled(busy).navigationTitle("Share conversation")
      .toolbar { Button("Done") { dismiss() }.disabled(busy) }
      .interactiveDismissDisabled(busy)
      .confirmationDialog("Create a conversation snapshot?", isPresented: $confirming) {
        Button("Create \(audience == "external" ? "external" : "workspace") link") {
          Task { await create() }
        }
      } message: {
        Text(
          audience == "external"
            ? "Anyone with the link will be able to read the shared messages."
            : "Signed-in members of this workspace with the link will be able to read the shared messages."
        )
      }
    }
  }
  private func create() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let value: Result = try await client.fetch(
        "api/sessions/\(conversation.id.apiComponent)/share", body: ["audience": audience])
      guard let share = value.share, ["internal", "external"].contains(share.audience),
        !share.token.isEmpty
      else { throw QMError.message("QM did not return a share link.") }
      result = share
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeActivityView: View {
  @Bindable var model: ChatModel
  var body: some View {
    QMList {
      if model.earlierItems > 0 {
        Button("Load earlier activity") { Task { await model.loadEarlier() } }.disabled(
          model.loadingEarlier)
      }
      ForEach(model.items) { entry in NativeActivityRow(entry: entry, client: model.client) }
      if let error = model.error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Activity").refreshable { _ = await model.refresh() }
  }
}

struct NativeBackground: Decodable {
  struct Job: Decodable, Identifiable {
    let processId: String
    let command: String
    let startedAt: Double
    let expiresAt: Double
    var id: String { processId }
  }
  struct Watch: Decodable, Identifiable {
    let id: String
    let processId: String
    let command: String
    let pattern: String?
    let instructions: String?
    let expiresAt: Double
  }
  struct Cron: Decodable, Identifiable {
    let id: String
    let title: String?
    let nextFireAt: Double?
  }
  let jobs: [Job]
  let watches: [Watch]
  let crons: [Cron]
}
struct NativeBackgroundOutput: Decodable {
  let chunk: String
  let cursor: Int
  let state: String
  let exitCode: Int?
}
struct NativeBackgroundView: View {
  let client: APIClient
  let conversation: Conversation
  @State private var work: NativeBackground?
  @State private var error: String?
  var body: some View {
    QMList {
      if let error { Text(error).foregroundStyle(.red) }
      Section("Processes") {
        ForEach(work?.jobs ?? []) { job in
          NavigationLink {
            NativeProcessOutput(
              client: client, sessionID: conversation.id, processID: job.processId,
              command: job.command)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(job.command).font(.body.monospaced())
              Text(Date(timeIntervalSince1970: job.startedAt / 1000), style: .time).font(.caption)
            }
          }
        }
        if work?.jobs.isEmpty == true { Text("No running processes").foregroundStyle(.secondary) }
      }
      Section("Watches") {
        ForEach(work?.watches ?? []) { watch in
          VStack(alignment: .leading, spacing: 6) {
            Text(watch.command).font(.headline)
            if let pattern = watch.pattern { Text(pattern).font(.caption.monospaced()) }
            if let instructions = watch.instructions { Text(instructions) }
          }
        }
      }
      Section("Scheduled tasks") {
        ForEach(work?.crons ?? []) { cron in
          VStack(alignment: .leading, spacing: 6) {
            Text(cron.title ?? cron.id)
            if let next = cron.nextFireAt {
              Text(Date(timeIntervalSince1970: next / 1000), style: .date).font(.caption)
            }
          }
        }
      }
    }
    .navigationTitle("Background work").task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      let result: NativeBackground = try await client.fetch(
        "api/sessions/\(conversation.id.apiComponent)/background")
      try Task.checkCancellation()
      work = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
struct NativeProcessOutput: View {
  let client: APIClient
  let sessionID: String
  let processID: String
  let command: String
  @State private var output = ""
  @State private var cursor = 0
  @State private var state = ""
  @State private var exitCode: Int?
  @State private var error: String?
  @State private var busy = false
  @Environment(\.scenePhase) private var phase
  private var status: String {
    switch state {
    case "exited": "Exited\(exitCode.map { " (\($0))" } ?? "")"
    case "": ""
    default: "Running"
    }
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text(command).font(.headline.monospaced())
        Text(status).font(.caption).foregroundStyle(.secondary)
        Text(output).font(.footnote.monospaced()).textSelection(.enabled).frame(
          maxWidth: .infinity, alignment: .leading)
        if let error { Text(error).foregroundStyle(.red) }
        Button("Refresh output") { Task { await load() } }.disabled(busy)
      }.padding()
    }
    .navigationTitle("Process output")
    .task(id: phase) {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await load()
        if state == "exited" { return }
        do { try await Task.sleep(for: .seconds(3)) } catch { return }
      }
    }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: NativeBackgroundOutput = try await client.fetch(
        "api/sessions/\(sessionID.apiComponent)/background/\(processID.apiComponent)/output",
        query: [.init(name: "sinceCursor", value: String(cursor))])
      try Task.checkCancellation()
      output = String((output + result.chunk).suffix(200_000))
      cursor = result.cursor
      state = result.state
      exitCode = result.exitCode
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeLinkedConversations: View {
  @Bindable var model: ChatModel
  @State private var sessions: [Conversation] = []
  @State private var busy = false
  @State private var error: String?
  @State private var confirming = false
  @State private var loader = LoadGuard()
  private var current: Conversation {
    sessions.first { $0.id == model.conversation.id } ?? model.conversation
  }
  var body: some View {
    QMList {
      if let parent = current.parentSessionId {
        Section("Linked under") {
          NavigationLink(sessions.first { $0.id == parent }?.label ?? "Parent conversation") {
            NativeConversationDestination(client: model.client, user: model.user, sessionID: parent)
          }
          Button("Make standalone") { confirming = true }
        }
      }
      Section("Related conversations") {
        ForEach(sessions.filter { $0.parentSessionId == current.id }) { child in
          NavigationLink(child.label) {
            ChatView(
              model: ChatModel(
                conversation: child, client: model.client, user: model.user, knownSession: true))
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Linked conversations")
      .task { await load() }.refreshable { if !busy { await load() } }
      .confirmationDialog("Make this conversation standalone?", isPresented: $confirming) {
        Button("Make standalone") { Task { await detach() } }
      } message: {
        Text("It will appear independently in the conversation list.")
      }
  }
  private func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      try await model.client.fetch("api/sessions") as ConversationList
    } apply: { result in
      sessions = result.sessions
      if let updated = sessions.first(where: { $0.id == model.conversation.id }) {
        model.conversation = updated
      }
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  private func detach() async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await model.client.fetch(
        "api/sessions/\(current.id.apiComponent)/detach", body: [:])
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeForkPoint: Identifiable {
  let id: String
  let title: String
  let cut: String
  static func points(_ items: [Item], inheritedBoundary: Int? = nil) -> [Self] {
    let itemsByID = Dictionary(
      items.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    var userSeqs: [Int] = []
    for item in items {
      guard item.isUserMessage, !item.isHidden, let sequence = item.seq else { continue }
      let hasText = item.text.map { !$0.isEmpty } ?? false
      let hasAttachments = item.body?.attachments.map { !$0.isEmpty } ?? false
      if hasText || hasAttachments { userSeqs.append(sequence) }
    }

    return chatMessages(items).compactMap { message in
      guard ["user", "assistant"].contains(message.role), let entry = itemsByID[message.id],
        let seq = entry.seq
      else { return nil }
      var cut =
        message.role == "user"
        ? String(seq) : userSeqs.first(where: { $0 > seq }).map { String($0 - 1) } ?? "all"
      if message.role == "assistant", let inheritedBoundary, seq <= inheritedBoundary {
        cut = String(min(Int(cut) ?? inheritedBoundary, inheritedBoundary))
      }
      let label =
        message.text.isEmpty
        ? message.files.first?.name ?? message.playgrounds.first?.title ?? "Attachment"
        : message.text
      return .init(
        id: message.id, title: "\(message.role == "user" ? "You" : "QM"): \(label)", cut: cut)
    }
  }
}
