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
              model.transcriptEntries, inheritedBoundary: model.conversation.forkBoundarySeq,
              surface: model.conversation.surface)
          ) { point in
            Text(String(point.title.prefix(70))).tag(point.id)
          }
        }
        if model.earlierEntries > 0 {
          Button {
            Task { await model.loadEarlier() }
          } label: {
            NativeActionLabel(
              title: "Load earlier fork points", busyTitle: "Loading earlier fork points…",
              busy: model.loadingEarlier)
          }.disabled(model.loadingEarlier)
        }
        Button {
          Task { fork = await model.fork(from: cut == "all" ? nil : cut) }
        } label: {
          if model.forking {
            NativeActionLabel(
              title: "Fork conversation", busyTitle: "Forking conversation…", busy: true)
          } else {
            Label("Fork conversation", systemImage: "arrow.triangle.branch")
          }
        }.disabled(model.forking)
        Text("A fork creates a separate conversation from the selected point.").font(.caption)
          .foregroundStyle(.secondary)
        if let error = model.error { Text(error).foregroundStyle(.red) }
        NavigationLink("Side chats") {
          NativeSideChatsView(
            client: model.client, user: model.user, sessionID: model.conversation.id)
        }
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
        .disabled(busy)
        Text(
          "This shares a snapshot. Subsequent messages will not be visible unless you share again.")
        if audience == "external" {
          Text(
            "Anyone with the link can read this conversation. Review its contents before creating the link."
          ).foregroundStyle(QMTheme.warning)
        }
        Button {
          confirming = true
        } label: {
          HStack(spacing: 10) {
            if busy {
              Image(systemName: "link")
                .frame(width: 22, height: 22)
                .modifier(NativeLoadingPulse())
                .accessibilityHidden(true)
            }
            Text(busy ? "Creating link…" : result == nil ? "Create link" : "Create new snapshot")
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .frame(minHeight: 44)
        }.disabled(busy)
        if let url {
          ShareLink("Share conversation", item: url).disabled(busy)
          Text(url.absoluteString).font(.footnote).textSelection(.enabled)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle("Share conversation")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }.disabled(busy)
        }
      }
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
    }.interactiveDismissDisabled(busy)
  }
  private func create() async {
    guard !busy else { return }
    busy = true
    error = nil
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
      if model.earlierEntries > 0 {
        Button {
          Task { await model.loadEarlier() }
        } label: {
          NativeActionLabel(
            title: "Load earlier activity", busyTitle: "Loading earlier activity…",
            busy: model.loadingEarlier)
        }.disabled(model.loadingEarlier)
      }
      ForEach(model.entries) { entry in NativeActivityRow(entry: entry, client: model.client) }
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
  @State private var loading = false
  var body: some View {
    QMList {
      if loading, work == nil {
        NativeActionLabel(
          title: "Background work", busyTitle: "Loading background work…", busy: true
        )
        .listRowSeparator(.hidden)
      }
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
    guard !loading else { return }
    loading = true
    defer { loading = false }
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
        Button {
          Task { await load() }
        } label: {
          NativeActionLabel(
            title: "Refresh output",
            busyTitle: state.isEmpty ? "Loading output…" : "Refreshing output…", busy: busy)
        }.disabled(busy)
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

struct NativeForkPoint: Identifiable {
  let id: String
  let title: String
  let cut: String
  static func points(_ entries: [Entry], inheritedBoundary: Int? = nil, surface: String? = nil)
    -> [Self]
  {
    let entriesByID = Dictionary(
      entries.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    var userSeqs: [Int] = []
    for entry in entries {
      guard entry.type == "user", let payload = entry.payload, payload.hidden != true,
        let sequence = entry.seq
      else { continue }
      let hasText = payload.text.map { !$0.isEmpty } ?? false
      let hasAttachments = payload.attachments.map { !$0.isEmpty } ?? false
      if hasText || hasAttachments { userSeqs.append(sequence) }
    }

    return chatMessages(entries, surface: surface).compactMap { message in
      guard ["user", "assistant"].contains(message.role), let entry = entriesByID[message.id],
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

@MainActor @Observable
final class NativeSlackReplyModel {
  struct Status: Decodable {
    var connected: Bool?
    var sent: Bool?
    var user: String?
    var error: String?
    var message: String?
  }
  static let maximumLength = 4000
  let client: APIClient
  let sessionID: String
  private(set) var connected = false
  private(set) var linkAvailable = false
  private(set) var user: String?
  private(set) var sending = false
  var text = ""
  private(set) var error: String?
  private var checking = false
  init(client: APIClient, sessionID: String) {
    self.client = client
    self.sessionID = sessionID
  }
  var tooLong: Bool { text.utf16.count > Self.maximumLength }
  var canSend: Bool {
    connected && !sending && !tooLong
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  var notice: String? { tooLong ? "Slack replies can be up to 4,000 characters." : error }
  func refresh() async {
    guard !checking else { return }
    checking = true
    defer { checking = false }
    do {
      let status: Status = try await client.fetch(
        "api/composio/slack/reply-status", body: ["sessionId": sessionID], accepting: [400])
      try Task.checkCancellation()
      connected = status.connected == true
      linkAvailable = connected || status.error == "slack_link_required"
      user = status.user
      error =
        connected || linkAvailable || status.error == "not_slack"
        ? nil : status.message ?? status.error
    } catch {
      guard !Task.isCancelled else { return }
      connected = false
      linkAvailable = false
      self.error = error.localizedDescription
    }
  }
  func send() async -> Bool {
    guard canSend else { return false }
    sending = true
    error = nil
    defer { sending = false }
    do {
      let result: Status = try await client.fetch(
        "api/composio/slack/reply",
        body: [
          "sessionId": sessionID, "text": text,
          "clientMessageId": UUID().uuidString.lowercased(),
        ],
        accepting: [400, 403, 409, 502, 503])
      try Task.checkCancellation()
      guard result.sent == true else {
        if result.connected == false { connected = false }
        error = result.message ?? result.error ?? "Could not send your Slack message."
        return false
      }
      text = ""
      return true
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
      return false
    }
  }
}

struct NativeSlackReplyBar<Fallback: View>: View {
  @State private var model: NativeSlackReplyModel
  @State private var linking = false
  private let isSlackThread: Bool
  @ViewBuilder let fallback: () -> Fallback
  init(
    client: APIClient, conversation: Conversation,
    @ViewBuilder fallback: @escaping () -> Fallback
  ) {
    _model = State(
      initialValue: NativeSlackReplyModel(client: client, sessionID: conversation.id))
    isSlackThread = conversation.isSlackThread
    self.fallback = fallback
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        if model.connected {
          TextField("Reply in Slack as \(model.user ?? "yourself")", text: $model.text)
            .padding(.horizontal, 16).frame(minHeight: 44)
            .composerChrome()
            .disabled(model.sending)
            .onSubmit { Task { _ = await model.send() } }
          Button {
            Task { _ = await model.send() }
          } label: {
            ComposerSendLabel(enabled: model.canSend)
          }
          .accessibilityLabel(model.sending ? "Sending Slack reply" : "Send Slack reply")
          .disabled(!model.canSend)
        } else {
          if model.linkAvailable {
            Button {
              linking = true
            } label: {
              NativeServiceLabel(title: "Link Slack", service: "slack")
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14).frame(minHeight: 44)
            .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
          }
          fallback()
        }
      }
      .frame(minHeight: 44)
      if let notice = model.notice { Text(notice).font(.footnote).foregroundStyle(.red) }
    }
    .task { if isSlackThread { await model.refresh() } }
    .sheet(
      isPresented: $linking, onDismiss: { Task { await model.refresh() } },
      content: {
        NavigationStack {
          NativeSlackAccountView(client: model.client)
            .toolbar {
              ToolbarItem(placement: .confirmationAction) { Button("Done") { linking = false } }
            }
        }
      })
  }
}

struct NativeSideChat: Decodable, Identifiable {
  struct Anchor: Decodable {
    let entrySeq: Int
    let quote: String
    let occurrence: Int
    let expanded: Bool?
  }
  let id: String
  let title: String?
  let createdAt: Double
  let sideChat: Anchor
  var excerpt: String { sideChat.quote.split(whereSeparator: \.isNewline).joined(separator: " ") }
  static func start(client: APIClient, sessionID: String, about message: ChatMessage) async throws
    -> Conversation
  {
    struct Result: Decodable { let session: Conversation }
    guard let sequence = message.sequence,
      let quote = message.text.components(separatedBy: "\n\n")
        .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).first(where: { !$0.isEmpty })
    else { throw QMError.message("This message hasn’t synced yet. Try again in a moment.") }
    let result: Result = try await client.fetch(
      "api/sessions/\(sessionID.apiComponent)/fork",
      body: ["sideChat": ["entrySeq": sequence, "quote": quote, "occurrence": 0]])
    return result.session
  }
}

@MainActor @Observable
final class NativeSideChatsModel {
  let client: APIClient
  let sessionID: String
  private(set) var chats: [NativeSideChat]?
  private(set) var loading = false
  private(set) var expanding: String?
  var error: String?
  init(client: APIClient, sessionID: String) {
    self.client = client
    self.sessionID = sessionID
  }
  func load() async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    do {
      struct Result: Decodable { let sessions: [NativeSideChat] }
      let result: Result = try await client.fetch(
        "api/sessions/\(sessionID.apiComponent)/side-chats")
      try Task.checkCancellation()
      chats = result.sessions
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  func expand(_ chat: NativeSideChat) async -> Bool {
    guard expanding == nil else { return false }
    expanding = chat.id
    defer { expanding = nil }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/sessions/\(chat.id.apiComponent)/expand", method: "POST")
      try Task.checkCancellation()
      error = nil
      await load()
      return true
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
      return false
    }
  }
}

struct NativeSideChatsView: View {
  @State private var model: NativeSideChatsModel
  @State private var expanded: String?
  let user: String
  init(client: APIClient, user: String, sessionID: String) {
    _model = State(initialValue: NativeSideChatsModel(client: client, sessionID: sessionID))
    self.user = user
  }
  var body: some View {
    QMList {
      if model.loading, model.chats == nil {
        NativeActionLabel(title: "Side chats", busyTitle: "Loading side chats…", busy: true)
          .listRowSeparator(.hidden)
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.chats?.isEmpty == true {
        Text("No side chats yet. Ask about a reply from its message menu to start one.")
          .foregroundStyle(.secondary)
      }
      ForEach(model.chats ?? []) { chat in
        NavigationLink {
          NativeConversationDestination(client: model.client, user: user, sessionID: chat.id)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(chat.excerpt).lineLimit(3)
            HStack(spacing: 6) {
              Text(Date(timeIntervalSince1970: chat.createdAt / 1000), style: .date)
              if chat.sideChat.expanded == true { Text("Opened as conversation") }
            }
            .font(.caption).foregroundStyle(.secondary)
          }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if chat.sideChat.expanded != true {
            Button("Open as conversation", systemImage: "arrow.up.right.square") {
              Task { if await model.expand(chat) { expanded = chat.id } }
            }
            .disabled(model.expanding != nil)
          }
        }
      }
    }
    .navigationTitle("Side chats").navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }.refreshable { await model.load() }
    .navigationDestination(item: $expanded) { sessionID in
      NativeConversationDestination(client: model.client, user: user, sessionID: sessionID)
    }
  }
}
