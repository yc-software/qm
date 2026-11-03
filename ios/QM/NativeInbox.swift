import SwiftUI

struct NativeInboxDraft: Codable, Equatable {
  let text: String
  let to: String
  let cc: String
  let subject: String
  let proposalAt: Double?
}

struct NativeInboxItem: Decodable, Identifiable {
  struct ThreadMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let text: String
    let at: Double
  }
  struct Draft: Decodable {
    let to: [String]?
    let cc: [String]?
    let subject: String?
    let body: String?
  }
  struct Proposal: Decodable {
    let data: Draft
    let by: String
    let at: Double
    let sessionId: String?
  }
  struct Payload: Decodable {
    struct Gmail: Decodable {
      let to: [String]?
      let cc: [String]?
      let subject: String?
    }
    let gmail: Gmail?
    struct Context: Decodable {
      let author: String
      let at: Double?
      let text: String
      let images: [String]?
    }
    let title: String?
    let from: String?
    let fromDetail: String?
    let snippet: String?
    let source: String?
    let externalUrl: String?
    let context: [Context]?
    let sentChat: Bool?
    let images: [String]?
  }
  let id: String
  let loopId: String
  let state: String
  let summary: String?
  let parkedReason: String?
  let source: String?
  let sourcePayload: Payload
  let sourceAt: Double?
  let proposal: Proposal?
  let thread: [ThreadMessage]
  let actionKind: String?
  let actionResult: String?
  let updatedAt: Double
  var title: String { sourcePayload.title ?? summary ?? "Review item" }
  var kind: String { source ?? sourcePayload.source ?? "generic" }
  var canReply: Bool { ["gmail", "slack"].contains(kind) }
  var handled: Bool { state == "actioned" || state == "dismissed" }
}
struct NativeInboxLoop: Decodable, Identifiable {
  struct Sync: Decodable {
    let id: String
    let enabled: Bool
    let lastFiredAt: Double?
  }
  let id: String
  let name: String
  let source: String?
  let selected: Bool?
  let count: Int?
  let syncCron: Sync?
  let ingestionActive: Bool?
}
struct NativeInboxFeed: Decodable {
  let selected: [NativeInboxLoop]
  let available: [NativeInboxLoop]
  let items: [NativeInboxItem]
  let total: Int
  let nextCursor: String?
}
struct NativeInboxDetail: Decodable {
  let item: NativeInboxItem
  let outputs: [NativeLoopOutput]?
}

@MainActor @Observable
final class InboxModel {
  let client: APIClient
  var items: [NativeInboxItem] = []
  var selected: [NativeInboxLoop] = []
  var available: [NativeInboxLoop] = []
  var nextCursor: String?
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  private var cursors: Set<String> = []
  init(client: APIClient) { self.client = client }
  func load(view: String, loop: String, reset: Bool = true, afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    if !reset && (loading || nextCursor == nil) { return }
    if reset { cursors = [] }
    let cursor = reset ? nil : nextCursor
    var query: [URLQueryItem] = []
    if view != "open" { query.append(.init(name: "view", value: view)) }
    if loop != "all" { query.append(.init(name: "loopId", value: loop)) }
    if let cursor { query.append(.init(name: "cursor", value: cursor)) }
    await loader.run(restart: reset) {
      try await client.fetch("api/inbox", query: query) as NativeInboxFeed
    } apply: { result in
      selected = result.selected
      available = result.available
      if reset { items = [] }
      var ids = Set(items.map(\.id))
      items.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
      if let cursor { cursors.insert(cursor) }
      if let next = result.nextCursor, cursors.contains(next) {
        nextCursor = nil
        throw QMError.message("The inbox did not advance. Refresh to try again.")
      }
      nextCursor = result.nextCursor
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func select(_ loop: NativeInboxLoop) async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      var ids = selected.map(\.id)
      if ids.contains(loop.id) { ids.removeAll { $0 == loop.id } } else { ids.append(loop.id) }
      let _: MutationReceipt = try await client.fetch("api/inbox/selection", body: ["loopIds": ids])
      await load(view: "open", loop: "all", afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeInboxView: View {
  let user: String
  @State private var model: InboxModel
  @State private var view = "open"
  @State private var loop = "all"
  @State private var managing = false
  @Environment(\.scenePhase) private var phase
  init(client: APIClient, user: String) {
    self.user = user
    _model = State(initialValue: InboxModel(client: client))
  }
  var body: some View {
    QMList {
      Picker("Status", selection: $view) {
        Text("Open").tag("open")
        Text("Handled").tag("handled")
        Text("Sent actions").tag("sent")
      }.pickerStyle(.segmented)
      NavigationLink("Sent mail") { NativeSentMailView(client: model.client, user: user) }
      Picker("Source", selection: $loop) {
        Text("All").tag("all")
        ForEach(model.selected) { Text($0.name).tag($0.id) }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      ForEach(model.items) { item in
        NavigationLink {
          NativeInboxItemView(client: model.client, user: user, original: item)
        } label: {
          VStack(alignment: .leading, spacing: 7) {
            Text(item.title).font(.headline).lineLimit(2)
            if let from = item.sourcePayload.from { Text(from).font(.subheadline) }
            Text(item.sourcePayload.snippet ?? item.parkedReason ?? item.summary ?? "").font(
              .subheadline
            ).foregroundStyle(.secondary).lineLimit(3)
            Text("\(item.kind.capitalized) · \(item.state)").font(.caption)
          }.padding(.vertical, 6)
        }
      }
      if model.nextCursor != nil {
        Button("Load more") { Task { await model.load(view: view, loop: loop, reset: false) } }
          .disabled(model.loading)
      }
      if model.items.isEmpty && !model.loading && model.error == nil {
        ContentUnavailableView(
          "You're caught up", systemImage: "tray",
          description: Text("Items from your selected loops will appear here."))
      }
    }
    .navigationTitle("Inbox").scrollContentBackground(.hidden).background(QMTheme.paper)
    .toolbar {
      Button("Manage sources", systemImage: "line.3.horizontal.decrease") { managing = true }
    }
    .task(id: "\(view)|\(loop)|\(phase == .active)") {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await model.load(view: view, loop: loop)
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
      }
    }
    .refreshable { await model.load(view: view, loop: loop) }
    .sheet(
      isPresented: $managing, onDismiss: { Task { await model.load(view: view, loop: loop) } },
      content: { NativeInboxSources(model: model) })
  }
}

struct NativeInboxSources: View {
  @Bindable var model: InboxModel
  @Environment(\.dismiss) private var dismiss
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMList {
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
        ForEach(model.available) { loop in
          Button {
            Task { await model.select(loop) }
          } label: {
            Label(
              loop.name,
              systemImage: model.selected.contains { $0.id == loop.id }
                ? "checkmark.circle.fill" : "circle")
          }
        }
        Section("Sync") {
          ForEach(model.selected) { loop in
            VStack(alignment: .leading, spacing: 6) {
              Text(loop.name).font(.headline)
              if let cron = loop.syncCron {
                Text(cron.enabled ? "Scheduled sync on" : "Scheduled sync paused").font(.caption)
                Button("Sync now") { Task { await sync(loop, run: true) } }
              } else {
                Button("Enable scheduled sync") { Task { await sync(loop, run: false) } }
              }
            }
          }
        }
      }
      .disabled(model.busy).navigationTitle("Inbox sources").toolbar {
        Button("Done") { dismiss() }.disabled(model.busy)
      }
    }
  }
  private func sync(_ loop: NativeInboxLoop, run: Bool) async {
    guard !model.busy else { return }
    model.busy = true
    defer { model.busy = false }
    do {
      if run, let cron = loop.syncCron {
        let _: MutationReceipt = try await model.client.fetch(
          "api/crons/\(cron.id.apiComponent)/run", body: [:])
      } else {
        let _: MutationReceipt = try await model.client.fetch(
          "api/inbox/sync-cron", body: ["enabled": true, "loopId": loop.id])
      }
      await model.load(view: "open", loop: "all", afterMutation: true)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

@MainActor @Observable
final class InboxDetailModel {
  let client: APIClient
  var item: NativeInboxItem
  var outputs: [NativeLoopOutput] = []
  var busy = false
  var loaded = false
  var error: String?
  var text = ""
  var to = ""
  var cc = ""
  var subject = ""
  var followup = ""
  var proposalAt: Double?
  private let loader = LoadGuard()
  let drafts: DraftStore
  private var restored = false
  var draft: NativeInboxDraft {
    .init(text: text, to: to, cc: cc, subject: subject, proposalAt: proposalAt)
  }
  private var savedText = ""
  private var savedTo = ""
  private var savedCC = ""
  private var savedSubject = ""
  var dirty: Bool { text != savedText || to != savedTo || cc != savedCC || subject != savedSubject }
  var path: String { "api/loops/\(item.loopId.apiComponent)/items/\(item.id.apiComponent)" }
  init(client: APIClient, user: String, item: NativeInboxItem) {
    self.client = client
    self.item = item
    drafts = DraftStore(
      account: client.baseURL.absoluteString + user,
      thread: "native-inbox:\(item.loopId):\(item.id)")
  }
  func persistDraft() {
    guard loaded, restored else { return }
    do { try drafts.write(.init(text: followup, inbox: dirty ? draft : nil)) } catch {
      self.error = "Couldn’t preserve your draft: \(error.localizedDescription)"
    }
  }
  func discardDraft() async {
    do { try drafts.write(.init(text: followup)) } catch {
      self.error = error.localizedDescription
      return
    }
    text = savedText
    to = savedTo
    cc = savedCC
    subject = savedSubject
    await load()
  }
  func load() async {
    guard !busy, !dirty else { return }
    await loader.run {
      try await client.fetch(path) as NativeInboxDetail
    } apply: { result in
      guard !dirty else { return }
      accept(result)
      if !restored {
        let record = drafts.read()
        followup = record.text
        if let saved = record.inbox {
          text = saved.text
          to = saved.to
          cc = saved.cc
          subject = saved.subject
          proposalAt = saved.proposalAt
        }
        restored = true
      }
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func accept(_ result: NativeInboxDetail) {
    item = result.item
    outputs = result.outputs ?? outputs
    loaded = true
    text = item.proposal?.data.body ?? ""
    to = (item.proposal?.data.to ?? item.sourcePayload.gmail?.to ?? []).joined(separator: ", ")
    cc = (item.proposal?.data.cc ?? item.sourcePayload.gmail?.cc ?? []).joined(separator: ", ")
    subject = item.proposal?.data.subject ?? item.sourcePayload.gmail?.subject ?? ""
    savedText = text
    savedTo = to
    savedCC = cc
    savedSubject = subject
    proposalAt = item.proposal?.at
  }
  func requestDraft() async -> Bool {
    await action(
      "followup", message: "Please draft a reply to this item for my review. Do not send it.")
  }
  func action(_ kind: String, message: String? = nil) async -> Bool {
    guard loaded, !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      var body: [String: Any] = ["kind": kind]
      if kind == "send" || kind == "edit" {
        var args: [String: Any] = [
          "proposal": [
            "body": text,
            "to": to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              ? [] : [to.trimmingCharacters(in: .whitespacesAndNewlines)],
            "cc": cc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              ? [] : [cc.trimmingCharacters(in: .whitespacesAndNewlines)], "subject": subject,
          ]
        ]
        if let proposalAt { args["expectedProposalAt"] = proposalAt }
        body["args"] = args
      }
      if let message { body = ["message": message] }
      let result: NativeInboxDetail = try await client.fetch(
        path + (message == nil ? "/action" : "/followup"), body: body)
      accept(result)
      error = nil
      persistDraft()
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
  func decide(_ output: NativeLoopOutput, decision: String, note: String) async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/loops/\(item.loopId.apiComponent)/outputs/\(output.id.apiComponent)/decide",
        body: ["decision": decision, "note": note])
      let result: NativeInboxDetail = try await client.fetch(path)
      accept(result)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeInboxItemView: View {
  let user: String
  @State private var model: InboxDetailModel
  @Environment(\.scenePhase) private var phase
  @State private var sending = false
  @State private var discarding = false
  @State private var output: NativeLoopOutput?
  @State private var note = ""
  @State private var decision = "ship"
  init(client: APIClient, user: String, original: NativeInboxItem) {
    self.user = user
    _model = State(initialValue: InboxDetailModel(client: client, user: user, item: original))
  }
  var body: some View {
    QMForm {
      summarySection
      contextSection
      draftSection
      proposedActionsSection
      threadSection
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Text("Your unsaved draft is still here.").font(.caption)
      }
      Button("Refresh item") { Task { await model.load() } }.disabled(model.dirty)
      if model.dirty {
        Button("Discard local edits and load latest", role: .destructive) { discarding = true }
      }
    }
    .disabled(model.busy).navigationTitle("Inbox item").navigationBarTitleDisplayMode(.inline)
    .task(id: phase == .active) {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await model.load()
        do { try await Task.sleep(for: .seconds(10)) } catch { return }
      }
    }.refreshable { await model.load() }
    .onChange(of: model.followup) { model.persistDraft() }
    .onChange(of: phase) { if phase != .active { model.persistDraft() } }
    .onChange(of: model.draft) { model.persistDraft() }
    .onDisappear { model.persistDraft() }
    .confirmationDialog("Discard your local edits?", isPresented: $discarding) {
      Button("Discard and reload", role: .destructive) { Task { await model.discardDraft() } }
    }
    .confirmationDialog("Send this reply?", isPresented: $sending) {
      Button("Send reply") { Task { _ = await model.action("send") } }
    } message: {
      Text(
        model.item.kind == "gmail"
          ? "Send to \(model.to)\(model.cc.isEmpty ? "" : ", cc: \(model.cc)")."
          : "Post this reply to the original Slack conversation.")
    }
    .sheet(item: $output) { candidate in
      reviewSheet(candidate)
    }
  }

  private var summarySection: some View {
    Section {
      Text(model.item.title).font(.headline)
      if let from = model.item.sourcePayload.from { Text(from) }
      if let detail = model.item.sourcePayload.fromDetail { Text(detail).font(.caption) }
      if let summary = model.item.summary { Text(summary) }
      if let reason = model.item.parkedReason { Text(reason).foregroundStyle(.orange) }
      if let raw = model.item.sourcePayload.externalUrl,
        let url = NativeModelConnection.httpsURL(raw)
      {
        Link("Open original", destination: url)
      }
      if model.item.sourcePayload.sentChat == true && model.item.handled {
        Button("Draft a follow-up reply") { Task { _ = await model.action("reply") } }.disabled(
          !model.loaded || model.dirty)
      }
      Button(model.item.handled ? "Reopen" : "Archive") {
        Task { _ = await model.action(model.item.handled ? "reopen" : "dismiss") }
      }.disabled(!model.loaded || model.dirty)
    }
  }

  private var contextSection: some View {
    Section("Context") {
      ForEach(Array((model.item.sourcePayload.context ?? []).enumerated()), id: \.offset) {
        index, message in
        VStack(alignment: .leading, spacing: 6) {
          Text(message.author).font(.caption.bold())
          Text(message.text).textSelection(.enabled)
          ForEach(Array((message.images ?? []).indices), id: \.self) { image in
            NativeInboxImage(client: model.client, path: model.path, context: index, index: image)
          }
        }
      }
      ForEach(Array((model.item.sourcePayload.images ?? []).indices), id: \.self) { image in
        NativeInboxImage(client: model.client, path: model.path, context: -1, index: image)
      }
      if let snippet = model.item.sourcePayload.snippet,
        model.item.sourcePayload.context?.isEmpty != false
      {
        Text(snippet).textSelection(.enabled)
      }
    }
  }

  @ViewBuilder
  private var draftSection: some View {
    if model.item.canReply && !model.item.handled && model.loaded {
      Section("Draft reply") {
        if model.item.kind == "gmail" {
          TextField("To", text: $model.to).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Cc", text: $model.cc).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Subject", text: $model.subject)
        }
        TextEditor(text: $model.text).frame(minHeight: 150)
        Button("Save draft") { Task { _ = await model.action("edit") } }.disabled(!model.dirty)
        Button("Send reply", systemImage: "paperplane") { sending = true }.disabled(
          model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if model.item.proposal == nil {
          Button("Ask QM to draft a reply") { Task { _ = await model.requestDraft() } }.disabled(
            model.dirty)
        }
      }
    }
  }

  @ViewBuilder
  private var proposedActionsSection: some View {
    if !model.outputs.isEmpty {
      Section("Proposed actions") {
        ForEach(model.outputs) { candidate in
          VStack(alignment: .leading, spacing: 8) {
            Text(candidate.title).font(.headline)
            if let summary = candidate.summary { Text(summary) }
            Text(candidate.state).font(.caption)
            if candidate.state == "ready" {
              Button("Review action") {
                output = candidate
                note = ""
                decision = "ship"
              }.disabled(model.dirty)
            }
          }
        }
      }
    }
  }

  private var threadSection: some View {
    Section("Conversation with QM") {
      ForEach(model.item.thread) { message in
        VStack(alignment: .leading, spacing: 6) {
          Text(message.role == "human" ? "You" : "QM").font(.caption.bold())
          Text(message.text).textSelection(.enabled)
        }
      }
      TextField("Ask QM about this item", text: $model.followup, axis: .vertical).disabled(
        !model.loaded)
      Button("Ask QM") {
        Task {
          if await model.action(
            "followup", message: model.followup.trimmingCharacters(in: .whitespacesAndNewlines))
          {
            model.followup = ""
            model.persistDraft()
          }
        }
      }.disabled(
        model.followup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.dirty
          || !model.loaded)
      if let session = model.item.proposal?.sessionId {
        NavigationLink("Open worklog") {
          NativeConversationDestination(client: model.client, user: user, sessionID: session)
        }
      }
    }
  }

  private func reviewSheet(_ candidate: NativeLoopOutput) -> some View {
    NavigationStack {
      QMForm {
        Text(candidate.title).font(.headline)
        if let summary = candidate.summary { Text(summary) }
        LabeledContent("Action", value: candidate.shipAction)
        Picker("Decision", selection: $decision) {
          Text("Approve action").tag("ship")
          Text("Request changes").tag("return")
        }
        TextField("Review note", text: $note, axis: .vertical)
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }
      .disabled(model.busy).navigationTitle("Review action")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { output = nil }.disabled(model.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(decision == "ship" ? "Approve" : "Return") {
            Task {
              await model.decide(candidate, decision: decision, note: note)
              if model.error == nil { output = nil }
            }
          }.disabled(
            model.busy
              || (decision == "return"
                && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          )
        }
      }.interactiveDismissDisabled(model.busy)
    }
  }
}

struct NativeInboxImage: View {
  let client: APIClient
  let path: String
  let context: Int
  let index: Int
  @State private var image: CGImage?
  @State private var error: String?
  @State private var retry = UUID()
  var body: some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1).resizable().scaledToFit().frame(maxHeight: 300)
          .accessibilityLabel("Attached image")
      } else if let error {
        VStack {
          Text(error).font(.caption)
          Button("Retry image") { retry = UUID() }
        }
      } else {
        ProgressView("Loading image")
      }
    }.task(id: retry) {
      do {
        let data = try await client.imageData(
          path + "/image",
          query: [
            .init(name: "ctx", value: String(context)), .init(name: "i", value: String(index)),
          ])
        try Task.checkCancellation()
        image = try MarkdownImageResource.thumbnail(data, maximumPixels: 1600)
        error = nil
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
  }
}
