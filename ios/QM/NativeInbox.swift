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

    func readable(_ text: String) -> String {
      source == "slack" ? SlackText.plain(text) : text
    }
  }
  struct Triage: Decodable {
    let priority: String?
    let groupId: String?
  }
  static let priorities = ["urgent", "high", "normal", "low"]
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
  let triage: Triage?
  var title: String { sourcePayload.title ?? summary ?? "Review item" }
  var kind: String { source ?? sourcePayload.source ?? "generic" }
  var canReply: Bool { ["gmail", "slack"].contains(kind) }
  var handled: Bool { state == "actioned" || state == "dismissed" }
  var priority: String { triage?.priority ?? "normal" }
  var canReopen: Bool { state == "dismissed" }
  var leadsGroup: Bool { !handled && triage?.groupId == id }
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
  let sources: [String]?
  let selected: Bool?
  var count: Int?
  let syncCron: Sync?
  let ingestionActive: Bool?
  let prioritize: Bool?
}
struct NativeInboxFeed: Decodable {
  let selected: [NativeInboxLoop]
  let available: [NativeInboxLoop]
  let items: [NativeInboxItem]
  let total: Int
  let nextCursor: String?
  let filter: String
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
  private(set) var total = 0
  var loaded = false
  private(set) var filter = "human"
  var nextCursor: String?
  var busy = false
  var error: String?
  var notice: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  private var cursors: Set<String> = []
  private var completedQuery = ""
  private var requested = (view: "open", loop: "all")
  static let filters = [
    (id: "all", label: "All emails"), (id: "human", label: "Light filtering"),
    (id: "triaged", label: "Heavy filtering"),
  ]
  init(client: APIClient) { self.client = client }
  func completed(view: String, loop: String) -> Bool { completedQuery == "\(view)|\(loop)" }
  func showsEmptyState(view: String, loop: String) -> Bool {
    items.isEmpty && loaded && error == nil && completed(view: view, loop: loop)
  }
  func filtersEmail(_ loop: String) -> Bool {
    loop == "all" || selected.contains { $0.id == loop && $0.sources?.contains("gmail") == true }
  }
  func selectFilter(_ value: String) async {
    struct Receipt: Decodable { let ok: Bool }
    guard !busy, value != filter else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let receipt: Receipt = try await client.fetch(
        "api/ui-state",
        body: [
          "key": "inbox-filter", "value": value,
          "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
        ], method: "PUT")
      await reload()
      notice = receipt.ok ? nil : "Filter not saved. A newer filter was saved elsewhere."
    } catch { notice = "Filter not saved. \(error.localizedDescription)" }
  }
  func load(view: String, loop: String, reset: Bool = true, afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    if !reset && (loading || nextCursor == nil) { return }
    requested = (view, loop)
    let cursor = reset ? nil : nextCursor
    let completing = "\(view)|\(loop)"
    let refreshing = reset && !afterMutation && completing == completedQuery && !cursors.isEmpty
    if reset && !refreshing { cursors = [] }
    var query: [URLQueryItem] = []
    if view != "open" { query.append(.init(name: "view", value: view)) }
    if loop != "all" { query.append(.init(name: "loopId", value: loop)) }
    if let cursor { query.append(.init(name: "cursor", value: cursor)) }
    await loader.run(restart: reset) {
      try await client.fetch("api/inbox", query: query) as NativeInboxFeed
    } apply: { result in
      selected = result.selected
      available = result.available
      total = result.total
      let fresh = Set(result.items.map(\.id))
      let keeping = refreshing && result.nextCursor != nil && result.filter == filter
      filter = result.filter
      let later =
        keeping ? items.suffix(from: (items.lastIndex { fresh.contains($0.id) } ?? -1) + 1) : []
      if reset { items = [] }
      if reset && !keeping { cursors = [] }
      var ids = Set(items.map(\.id))
      items.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
      items.append(contentsOf: later)
      if let cursor { cursors.insert(cursor) }
      if !keeping {
        if let next = result.nextCursor, cursors.contains(next) {
          nextCursor = nil
          throw QMError.message("The inbox did not advance. Refresh to try again.")
        }
        nextCursor = result.nextCursor
      }
      loaded = true
      completedQuery = completing
      error = nil
    } failed: {
      completedQuery = completing
      error = $0.localizedDescription
    }
  }
  func prioritizes(_ item: NativeInboxItem) -> Bool {
    item.triage?.priority != nil
      || selected.contains { $0.id == item.loopId && $0.prioritize == true }
  }
  func reload() async {
    await load(view: requested.view, loop: requested.loop, afterMutation: true)
  }
  func groupSize(_ item: NativeInboxItem) -> Int {
    guard item.leadsGroup, nextCursor == nil || items.last?.triage?.groupId != item.id else {
      return 1
    }
    return max(1, items.count { !$0.handled && $0.triage?.groupId == item.id })
  }
  func openCount(_ loop: String) -> Int {
    loop == "all" ? total : selected.first { $0.id == loop }?.count ?? 0
  }
  func reconcile(_ item: NativeInboxItem, wasHandled: Bool) {
    guard item.handled != wasHandled else {
      if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item }
      return
    }
    items.removeAll { $0.id == item.id }
    let change = item.handled ? -1 : 1
    total = max(0, total + change)
    if let index = selected.firstIndex(where: { $0.id == item.loopId }) {
      selected[index].count = max(0, (selected[index].count ?? 0) + change)
    }
  }
  func enableSync(_ loop: NativeInboxLoop, view: String, active: String) async throws {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    let _: MutationReceipt = try await client.fetch(
      "api/inbox/sync-cron", body: ["enabled": true, "loopId": loop.id])
    await load(view: view, loop: active, afterMutation: true)
  }
  func select(_ loop: NativeInboxLoop, view: String, active: String) async throws -> String {
    guard !busy else { return active }
    busy = true
    loader.cancel()
    defer { busy = false }
    var ids = selected.map(\.id)
    if ids.contains(loop.id) { ids.removeAll { $0 == loop.id } } else { ids.append(loop.id) }
    let _: MutationReceipt = try await client.fetch("api/inbox/selection", body: ["loopIds": ids])
    let next = active == "all" || ids.contains(active) ? active : "all"
    await load(view: view, loop: next, afterMutation: true)
    return next
  }
}

struct NativeInboxView: View {
  let user: String
  @State private var model: InboxModel
  @State private var view = "open"
  @State private var loop = "all"
  @State private var managing = false
  @State private var opened: NativeInboxItem?
  @State private var opening = false
  @State private var refreshing = false
  @State private var loadingMore = false
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
        Text(model.loaded ? "All (\(model.openCount("all")))" : "All").tag("all")
        ForEach(model.selected) { Text("\($0.name) (\(model.openCount($0.id)))").tag($0.id) }
      }
      if view == "open" && model.filtersEmail(loop) {
        Picker(
          "Email filter",
          selection: Binding(
            get: { model.filter },
            set: { value in Task { await model.selectFilter(value) } })
        ) {
          ForEach(InboxModel.filters, id: \.id) { Text($0.label).tag($0.id) }
        }
      }
      if let notice = model.notice { Text(notice).foregroundStyle(QMTheme.warning) }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.loading && !model.loaded && model.error == nil {
        NativeCollectionLoading(label: "Loading inbox", symbol: "tray")
      }
      ForEach(model.items) { item in
        NativeLinkRow {
          opened = item
          opening = true
        } label: {
          VStack(alignment: .leading, spacing: 7) {
            Text(item.title).font(.headline).lineLimit(2)
            if let from = item.sourcePayload.from { Text(from).font(.subheadline) }
            Text(
              item.sourcePayload.snippet.map(item.sourcePayload.readable) ?? item.parkedReason
                ?? item.summary ?? ""
            ).font(
              .subheadline
            ).foregroundStyle(.secondary).lineLimit(3)
            Text(caption(item)).font(.caption)
          }
        }
      }
      if model.nextCursor != nil {
        if loadingMore && model.loading {
          NativeCollectionRefreshHeader(label: "Loading more inbox items")
        }
        Button("Load more") {
          Task {
            loadingMore = true
            defer { loadingMore = false }
            await model.load(view: view, loop: loop, reset: false)
          }
        }.disabled(model.loading)
      }
      if model.showsEmptyState(view: view, loop: loop) {
        ContentUnavailableView(
          view == "handled"
            ? "No handled items"
            : view == "sent"
              ? "No sent actions" : loop == "all" ? "You're caught up" : "No open items",
          systemImage: "tray",
          description: Text(
            view == "open" && model.filter == "triaged" && model.filtersEmail(loop)
              ? "Choose Light filtering or All emails to see more."
              : loop == "all"
                ? "Items from your selected loops will appear here."
                : "No items in this source match the selected status."))
      }
    }
    .navigationTitle("Inbox").scrollContentBackground(.hidden).background(QMTheme.paper)
    .modifier(
      NativeCollectionRefresh(
        active: (refreshing || !model.completed(view: view, loop: loop)) && model.loading
          && (model.loaded || (refreshing && model.error != nil)),
        label: "Refreshing inbox")
    )
    .toolbar { Button("Manage sources", systemImage: "tray.2") { managing = true } }
    .task(id: "\(view)|\(loop)|\(phase == .active)") {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await model.load(view: view, loop: loop)
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
      }
    }
    .onChange(of: model.selected.map(\.id)) { _, sources in
      if loop != "all" && !sources.contains(loop) { loop = "all" }
    }
    .refreshable { await refresh() }
    .navigationDestination(isPresented: $opening) {
      if let opened {
        NativeInboxItemView(client: model.client, user: user, original: opened, inbox: model)
          .id(opened.id)
      }
    }
    .sheet(
      isPresented: $managing, onDismiss: { Task { await refresh() } },
      content: { NativeInboxSources(model: model, view: view, loop: $loop) })
  }

  private func refresh() async {
    refreshing = true
    defer { refreshing = false }
    await model.load(view: view, loop: loop)
  }

  private func caption(_ item: NativeInboxItem) -> String {
    var parts = [item.kind.capitalized, item.state]
    if !item.handled && item.priority != "normal" { parts.append(item.priority.capitalized) }
    let size = model.groupSize(item)
    if size > 1 {
      parts.append("Group of \(size)")
    } else if !item.handled && item.triage?.groupId != nil {
      parts.append("Grouped")
    }
    return parts.joined(separator: " · ")
  }
}

struct NativeInboxSources: View {
  @Bindable var model: InboxModel
  let view: String
  @Binding var loop: String
  @Environment(\.dismiss) private var dismiss
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMList {
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
        ForEach(model.available) { source in
          Button {
            Task { await toggle(source) }
          } label: {
            Label(
              source.name,
              systemImage: model.selected.contains { $0.id == source.id }
                ? "checkmark.circle.fill" : "circle")
          }
        }
        if model.available.isEmpty {
          if model.loading && !model.loaded && error == nil && model.error == nil {
            NativeCollectionLoading(label: "Loading sources", symbol: "tray", rows: 3)
          } else if model.loaded && error == nil && model.error == nil {
            ContentUnavailableView("No sources available", systemImage: "tray")
          }
        }
        ForEach(model.selected) { source in
          Section(source.name) {
            if source.source != nil && source.syncCron?.enabled != true {
              Button("Turn on scheduled sync") {
                Task {
                  await attempt { try await model.enableSync(source, view: view, active: loop) }
                }
              }
            }
            if let cron = source.syncCron {
              Button("Sync now") { Task { await sync(cron) } }
            }
            Button("Remove from Inbox", role: .destructive) { Task { await toggle(source) } }
          }
        }
      }
      .disabled(model.busy).navigationTitle("Inbox sources").toolbar {
        Button("Done") { dismiss() }.disabled(model.busy)
      }
    }
  }
  private func attempt(_ change: () async throws -> Void) async {
    do {
      try await change()
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func toggle(_ source: NativeInboxLoop) async {
    await attempt { loop = try await model.select(source, view: view, active: loop) }
  }
  private func sync(_ cron: NativeInboxLoop.Sync) async {
    guard !model.busy else { return }
    model.busy = true
    defer { model.busy = false }
    await attempt {
      let _: MutationReceipt = try await model.client.fetch(
        "api/crons/\(cron.id.apiComponent)/run", body: [:])
      await model.load(view: view, loop: loop, afterMutation: true)
    }
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
  var loading: Bool { loader.loading }
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
  var canPrioritize: Bool {
    !item.handled && (inbox?.prioritizes(item) ?? (item.triage?.priority != nil))
  }
  var canUngroup: Bool { !item.handled && item.triage?.groupId != nil }
  private let inbox: InboxModel?
  init(client: APIClient, user: String, item: NativeInboxItem, inbox: InboxModel? = nil) {
    self.client = client
    self.item = item
    self.inbox = inbox
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
  func load(refreshSource: Bool = false) async {
    guard !busy, !dirty else { return }
    await loader.run {
      try await client.fetch(
        path, query: refreshSource ? [.init(name: "refreshSource", value: "1")] : [])
        as NativeInboxDetail
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
    inbox?.reconcile(result.item, wasHandled: item.handled)
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
  func archive() async -> Bool {
    await action("dismiss", args: item.leadsGroup ? ["group": true] : [:])
  }
  func ungroup() async -> Bool {
    guard canUngroup else { return false }
    return await action("ungroup")
  }
  func reopen() async -> Bool {
    guard item.canReopen else { return false }
    return await action("reopen")
  }
  func action(_ kind: String, args: [String: Any] = [:], message: String? = nil) async -> Bool {
    guard loaded, !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      var body: [String: Any] = ["kind": kind]
      var args = args
      if kind == "send" || kind == "edit" {
        args["proposal"] = [
          "body": text,
          "to": to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? [] : [to.trimmingCharacters(in: .whitespacesAndNewlines)],
          "cc": cc.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? [] : [cc.trimmingCharacters(in: .whitespacesAndNewlines)], "subject": subject,
        ]
        if let proposalAt { args["expectedProposalAt"] = proposalAt }
      }
      if !args.isEmpty { body["args"] = args }
      if let message { body = ["message": message] }
      accept(try await client.fetch(path + (message == nil ? "/action" : "/followup"), body: body))
      if args["group"] != nil { await inbox?.reload() }
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
  @Environment(\.dismiss) private var dismiss
  @State private var sending = false
  @State private var discarding = false
  @State private var output: NativeLoopOutput?
  @State private var note = ""
  @State private var decision = "ship"
  @State private var refreshing = false
  init(client: APIClient, user: String, original: NativeInboxItem, inbox: InboxModel? = nil) {
    self.user = user
    _model = State(
      initialValue: InboxDetailModel(client: client, user: user, item: original, inbox: inbox))
  }
  var body: some View {
    QMForm {
      summarySection
      if !model.loaded && model.loading && model.error == nil {
        NativeParagraphLoading(label: "Loading item")
      }
      contextSection
      draftSection
      proposedActionsSection
      threadSection
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Text("Your unsaved draft is still here.").font(.caption)
      }
      Button("Refresh item") { Task { await refresh() } }.disabled(model.dirty)
      if model.dirty {
        Button("Discard local edits and load latest", role: .destructive) { discarding = true }
      }
    }
    .disabled(model.busy).navigationTitle("Inbox item").navigationBarTitleDisplayMode(.inline)
    .modifier(
      NativeCollectionRefresh(
        active: refreshing && model.loading && (model.loaded || model.error != nil),
        label: "Refreshing item")
    )
    .task(id: phase == .active) {
      guard phase == .active else { return }
      while !Task.isCancelled {
        await model.load()
        do { try await Task.sleep(for: .seconds(10)) } catch { return }
      }
    }.refreshable { await refresh() }
    .onChange(of: model.followup) { model.persistDraft() }
    .onChange(of: phase) { if phase != .active { model.persistDraft() } }
    .onChange(of: model.draft) { model.persistDraft() }
    .onDisappear { model.persistDraft() }
    .confirmationDialog("Discard your local edits?", isPresented: $discarding) {
      Button("Discard and reload", role: .destructive) {
        Task {
          refreshing = true
          defer { refreshing = false }
          await model.discardDraft()
        }
      }
    }
    .confirmationDialog("Send this reply?", isPresented: $sending) {
      Button("Send reply") {
        Task {
          if model.dirty, !(await model.action("edit")) { return }
          _ = await model.action("send")
        }
      }
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

  private func refresh() async {
    refreshing = true
    defer { refreshing = false }
    await model.load(refreshSource: true)
  }

  private var summarySection: some View {
    Section {
      Text(model.item.title).font(.headline)
      if let from = model.item.sourcePayload.from { Text(from) }
      if let detail = model.item.sourcePayload.fromDetail { Text(detail).font(.caption) }
      if let summary = model.item.summary { Text(summary) }
      if let reason = model.item.parkedReason { Text(reason).foregroundStyle(QMTheme.warning) }
      if let raw = model.item.sourcePayload.externalUrl,
        let url = NativeModelConnection.httpsURL(raw)
      {
        Link("Open original", destination: url)
      }
      if model.item.sourcePayload.sentChat == true && model.item.handled {
        Button("Draft a follow-up reply") { Task { _ = await model.action("reply") } }.disabled(
          !model.loaded || model.dirty)
      }
      if model.canPrioritize {
        Picker(
          "Priority",
          selection: Binding(
            get: { model.item.priority },
            set: { value in
              Task { _ = await model.action("prioritize", args: ["priority": value]) }
            })
        ) {
          ForEach(NativeInboxItem.priorities, id: \.self) { Text($0.capitalized).tag($0) }
        }.disabled(!model.loaded || model.dirty)
      }
      if model.item.canReopen {
        Button("Reopen") { Task { _ = await model.reopen() } }.disabled(
          !model.loaded || model.dirty)
      } else if !model.item.handled {
        Button(model.item.leadsGroup ? "Archive group" : "Archive") {
          Task { if await model.archive() { dismiss() } }
        }.disabled(!model.loaded || model.dirty)
      }
      if model.canUngroup {
        Button("Remove from group") { Task { _ = await model.ungroup() } }.disabled(
          !model.loaded || model.dirty)
      }
    }
  }

  private var contextSection: some View {
    Section("Context") {
      ForEach(Array((model.item.sourcePayload.context ?? []).enumerated()), id: \.offset) {
        index, message in
        VStack(alignment: .leading, spacing: 6) {
          Text(message.author).font(.caption.bold())
          Text(model.item.sourcePayload.readable(message.text)).textSelection(.enabled)
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
        Text(model.item.sourcePayload.readable(snippet)).textSelection(.enabled)
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
            if candidate.reviewable {
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
          Text(candidate.approveLabel).tag("ship")
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
          Button {
            Task {
              await model.decide(candidate, decision: decision, note: note)
              if model.error == nil { output = nil }
            }
          } label: {
            NativeActionLabel(
              title: decision == "ship" ? "Approve" : "Return",
              busyTitle: decision == "ship" ? "Approving…" : "Returning…", busy: model.busy,
              compact: true)
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
