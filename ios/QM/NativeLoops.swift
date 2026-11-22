import SwiftUI

struct NativeLoop: Decodable, Identifiable {
  struct ShipAction: Decodable {
    let action: String
    let gate: String
  }
  struct Triage: Decodable {
    struct Setting: Decodable {
      let enabled: Bool
      let instructions: String?
    }
    let prioritize: Setting?
    let consolidate: Setting?
  }
  let id: String
  let name: String
  let icon: String?
  let purpose: String?
  let playbook: String
  let playbookVersion: Int
  let successCondition: String
  let shipActions: [ShipAction]
  let state: String
  let health: String
  let healthReason: String?
  let owner: String
  let cronId: String?
  let lastFiredAt: Double?
  let triage: Triage?
  var archived: Bool { state == "archived" }
  var enablingTitle: String {
    state == "quarantined" ? "Clear quarantine" : "Enable loop"
  }
  func triage(_ kind: NativeLoopTriage) -> Triage.Setting? {
    kind == .prioritize ? triage?.prioritize : triage?.consolidate
  }
}
enum NativeLoopTriage: String, CaseIterable, Identifiable {
  case prioritize, consolidate
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}
struct NativeLoopItem: Decodable, Identifiable {
  let id: String
  let sourceKey: String
  let sourceSummary: String?
  let source: String?
  let status: String
  let attempts: Int
  let parkedReason: String?
  var title: String { sourceSummary ?? sourceKey }
  var caption: String {
    let status = status.replacingOccurrences(of: "_", with: " ")
    return attempts > 0 ? "\(status) · \(attempts) attempt\(attempts == 1 ? "" : "s")" : status
  }
}
struct NativeLoopOutput: Decodable, Identifiable {
  let id: String
  let title: String
  let summary: String?
  let shipAction: String
  let externalRef: String?
  let state: String
  let decisionNote: String?
  let decidedBy: String?
  var decided: Bool { ["shipped", "returned", "superseded", "expired"].contains(state) }
  var reviewable: Bool { ["ready", "unconfirmed"].contains(state) }
  var approveLabel: String { state == "unconfirmed" ? "Confirm shipped" : "Approve action" }
  var caption: String {
    [state, decidedBy, decisionNote].compactMap { $0 }.joined(separator: " · ")
  }
}
struct NativeLoopDetail: Decodable {
  struct Vitals: Decodable {
    struct Queue: Decodable {
      let queued: Int
      let inProgress: Int
    }
    let queue: Queue
    let openOutputs: Int
  }
  var loop: NativeLoop
  let items: [NativeLoopItem]
  let outputs: [NativeLoopOutput]
  let vitals: Vitals
  let triageAvailable: Bool?
  var triageKinds: [NativeLoopTriage] {
    NativeLoopTriage.allCases.filter {
      triageAvailable == true || loop.triage($0)?.enabled == true
    }
  }
}
struct NativeLoopList: Decodable { let loops: [NativeLoop] }
struct NativeLoopReceipt: Decodable { let loop: NativeLoop? }
struct NativeTriagePreview: Decodable {
  struct Item: Decodable, Identifiable {
    let id: String
    let priority: String?
    let reason: String?
    let groupId: String?
    var note: String {
      [priority?.capitalized, reason].compactMap { $0 }.joined(separator: " · ")
    }
  }
  let items: [Item]
}
struct NativeIngestion: Decodable {
  struct Source: Decodable, Identifiable {
    struct Gmail: Decodable {
      let email: String
      let expiresAt: Double
    }
    let id: String
    let kind: String
    let enabled: Bool
    let url: String
    let channels: [String]?
    let gmail: Gmail?
    let lastReceivedAt: Double?
    let lastError: String?
  }
  let sources: [Source]
  let gmailAvailable: Bool
}

@MainActor @Observable
final class LoopsModel {
  let client: APIClient
  var loops: [NativeLoop] = []
  var loaded = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  init(client: APIClient) { self.client = client }
  func loops(matching query: String) -> [NativeLoop] {
    loops.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
  }
  func load() async {
    await loader.run {
      try await client.fetch("api/loops") as NativeLoopList
    } apply: { result in
      loops = result.loops
      loaded = true
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func accept(_ loop: NativeLoop) {
    loader.cancel()
    guard let index = loops.firstIndex(where: { $0.id == loop.id }) else { return }
    loops[index] = loop
  }
}

@MainActor @Observable
final class LoopDetailModel {
  let client: APIClient
  let id: String
  let list: LoopsModel?
  var detail: NativeLoopDetail?
  var ingestion: NativeIngestion?
  var preview: [NativeTriagePreview.Item]?
  var previewError: String?
  var opened: NativeInboxItem?
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  private let previewer = LoadGuard()
  var loading: Bool { loader.loading }
  var previewing: Bool { previewer.loading }
  init(client: APIClient, id: String, list: LoopsModel? = nil) {
    self.client = client
    self.id = id
    self.list = list
  }
  var path: String { "api/loops/\(id.apiComponent)" }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      async let result: NativeLoopDetail = try await client.fetch(path)
      async let sources: NativeIngestion = try await client.fetch(path + "/ingestion")
      return try await (result, sources)
    } apply: { result, sources in
      detail = result
      ingestion = sources
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func open(_ item: NativeLoopItem) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: NativeInboxDetail = try await client.fetch(
        path + "/items/\(item.id.apiComponent)")
      opened = result.item
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  func setState(_ state: String) async -> Bool {
    await mutate(method: "PATCH", body: ["state": state])
  }
  func saveTriage(_ kind: NativeLoopTriage, enabled: Bool, instructions: String) async -> Bool {
    await mutate(
      method: "PATCH",
      body: ["triage": [kind.rawValue: ["enabled": enabled, "instructions": instructions]]])
  }
  func previewTriage(_ kind: NativeLoopTriage, instructions: String) async -> Bool {
    let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    return await previewer.run {
      try await client.fetch(
        path + "/triage/preview",
        body: ["triage": [kind.rawValue: ["enabled": true, "instructions": text]]],
        timeout: .infinity)
        as NativeTriagePreview
    } apply: { result in
      preview = result.items
      previewError = nil
    } failed: {
      previewError = $0.localizedDescription
    }
  }
  func clearPreview() {
    previewer.cancel()
    preview = nil
    previewError = nil
  }
  func title(of item: String) -> String {
    detail?.items.first { $0.id == item }?.title ?? item
  }
  func mutate(_ suffix: String = "", method: String = "POST", body: [String: Any] = [:]) async
    -> Bool
  {
    await submit {
      let receipt: NativeLoopReceipt = try await client.fetch(
        path + suffix, body: body, method: method)
      if let loop = receipt.loop {
        detail?.loop = loop
        list?.accept(loop)
      }
      await load(afterMutation: true)
    }
  }
  private func submit(_ work: () async throws -> Void) async -> Bool {
    guard !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      try await work()
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

struct NativeLoopsView: View {
  @State private var model: LoopsModel
  @State private var query = ""
  @State private var opened: String?
  init(client: APIClient) { _model = State(initialValue: LoopsModel(client: client)) }
  var body: some View {
    let shown = model.loops(matching: query)
    QMList {
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.load() } }.disabled(model.loading)
      }
      ForEach(shown) { loop in
        NativeLinkRow {
          opened = loop.id
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              NativeLoopIcon(value: loop.icon)
              Text(loop.name).font(.headline)
            }
            Text(loop.purpose ?? loop.successCondition).font(.subheadline).lineLimit(2)
            Text("\(loop.state) · \(loop.health)").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      if model.loading && !model.loaded && model.error == nil {
        NativeLoopCollectionLoading()
      } else if model.loaded && shown.isEmpty && model.error == nil {
        if !query.isEmpty {
          ContentUnavailableView.search(text: query)
        } else {
          ContentUnavailableView(
            "No loops yet", systemImage: "repeat",
            description: Text("Loops keep track of recurring work for QM."))
        }
      }
    }
    .navigationTitle("Loops").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.loaded || model.error != nil), label: "Refreshing loops")
    )
    .task { await model.load() }.refreshable { await model.load() }
    .navigationDestination(item: $opened) { NativeLoopDetailView(list: model, id: $0) }
  }
}

struct NativeLoopDetailView: View {
  @State private var model: LoopDetailModel
  @State private var editing = false
  @State private var adding = false
  @State private var confirm: String?
  @State private var editingIcon = false
  @State private var readingPlaybook = false
  @State private var triage: NativeLoopTriage?
  @Environment(\.qmIdentity) private var identity
  init(list: LoopsModel, id: String) {
    _model = State(initialValue: LoopDetailModel(client: list.client, id: id, list: list))
  }
  var body: some View {
    QMList {
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.load() } }
      }
      if let detail = model.detail {
        Section("Overview") {
          Text(detail.loop.purpose ?? detail.loop.successCondition)
          LabeledContent("State", value: detail.loop.state)
          LabeledContent("Health", value: detail.loop.health)
          if let reason = detail.loop.healthReason { Text(reason).foregroundStyle(QMTheme.warning) }
          LabeledContent("Queued", value: String(detail.vitals.queue.queued))
          LabeledContent("In progress", value: String(detail.vitals.queue.inProgress))
          LabeledContent("Awaiting review", value: String(detail.vitals.openOutputs))
          Button(detail.loop.state == "enabled" ? "Pause loop" : detail.loop.enablingTitle) {
            confirm = detail.loop.state == "enabled" ? "paused" : "enabled"
          }
          if !detail.loop.archived {
            Button("Run now", systemImage: "play") { confirm = "fire" }
            Button("Archive loop", role: .destructive) { confirm = "archived" }
            if !detail.loop.shipActions.isEmpty {
              Button(
                detail.loop.shipActions.allSatisfy { $0.gate == "auto" }
                  ? "Turn off autopilot" : "Turn on autopilot"
              ) {
                confirm =
                  detail.loop.shipActions.allSatisfy { $0.gate == "auto" } ? "manual" : "autopilot"
              }
            }
          }
        }
        Section("Playbook") {
          NativeDisclosureRow(expanded: readingPlaybook) {
            readingPlaybook.toggle()
          } label: {
            Text("Instructions")
          }
          if readingPlaybook { Text(detail.loop.playbook).textSelection(.enabled) }
          Button("Edit playbook") { editing = true }
          Button("Change icon") {
            editingIcon = true
          }
          LabeledContent("Version", value: String(detail.loop.playbookVersion))
        }
        if !detail.triageKinds.isEmpty {
          Section("Triage") {
            ForEach(detail.triageKinds) { kind in
              Button {
                triage = kind
              } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text(kind.title)
                  Text(
                    detail.loop.triage(kind)?.enabled == true
                      ? detail.loop.triage(kind)?.instructions ?? "Default instructions" : "Off"
                  ).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
              }
            }
          }
        }
        Section("Outputs") { outputs(detail.outputs.filter { !$0.decided }) }
        if detail.outputs.contains(where: \.decided) {
          Section("Decided") { outputs(detail.outputs.filter(\.decided)) }
        }
        Section("Work items") {
          ForEach(detail.items) { item in
            if item.source != nil && identity != nil {
              NativeLinkRow {
                Task { await model.open(item) }
              } label: {
                workItem(item)
              }
            } else {
              workItem(item)
            }
          }
          if detail.items.isEmpty { Text("No work items").foregroundStyle(.secondary) }
        }
        let sources = model.ingestion?.sources ?? []
        if !detail.loop.archived || !sources.isEmpty {
          Section("Event sources") {
            ForEach(sources) { source in
              VStack(alignment: .leading, spacing: 6) {
                Text(source.kind.capitalized).font(.headline)
                Text(source.url).font(.footnote.monospaced()).textSelection(.enabled)
                if let gmail = source.gmail { Text(gmail.email) }
                if let error = source.lastError { Text(error).foregroundStyle(.red) }
                if !detail.loop.archived {
                  Button(source.enabled ? "Disable source" : "Enable source") {
                    Task {
                      _ = await model.mutate(
                        "/ingestion/\(source.id.apiComponent)", method: "PATCH",
                        body: ["enabled": !source.enabled])
                    }
                  }
                }
              }
            }
            if !detail.loop.archived { Button("Add event source") { adding = true } }
          }
        }
      } else if model.loading && model.error == nil {
        NativeParagraphLoading(label: "Loading loop")
      }
    }
    .disabled(model.busy).navigationTitle(model.detail?.loop.name ?? "Loop")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.detail != nil || model.error != nil) && !model.busy,
        label: "Refreshing loop")
    )
    .task { await model.load() }.refreshable { await model.load() }
    .sheet(isPresented: $editing) { NativeLoopPlaybook(model: model) }
    .sheet(isPresented: $adding, onDismiss: { Task { await model.load() } }) {
      NativeLoopSourceCreation(model: model)
    }
    .sheet(isPresented: $editingIcon) { NativeLoopIconPicker(model: model) }
    .sheet(item: $triage) { NativeLoopTriageEditor(model: model, kind: $0) }
    .navigationDestination(
      isPresented: Binding(
        get: { model.opened != nil }, set: { if !$0 { model.opened = nil } })
    ) {
      if let opened = model.opened, let user = identity?.user {
        NativeInboxItemView(client: model.client, user: user, original: opened).id(opened.id)
      }
    }
    .confirmationDialog(
      "Update this loop?",
      isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })
    ) {
      if let confirm {
        Button(title(confirm)) { Task { await perform(confirm) } }
      }
    } message: {
      Text(
        confirm == "autopilot"
          ? "QM will perform this loop’s configured actions automatically, without waiting for review."
          : confirm == "fire"
            ? "QM will process the loop’s work now."
            : "This changes how the loop processes and delivers work.")
    }
  }
  private func title(_ action: String) -> String {
    switch action {
    case "fire": "Run now"
    case "autopilot": "Enable autopilot"
    case "enabled": model.detail?.loop.enablingTitle ?? "Confirm"
    default: "Confirm"
    }
  }
  private func outputs(_ shown: [NativeLoopOutput]) -> some View {
    ForEach(shown) { output in
      NavigationLink {
        NativeLoopOutputReview(model: model, original: output)
      } label: {
        VStack(alignment: .leading, spacing: 6) {
          Text(output.title).font(.headline)
          Text(output.caption).font(.caption)
        }
      }
    }
  }
  private func workItem(_ item: NativeLoopItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(item.title)
      Text(item.caption).font(.caption)
      if let reason = item.parkedReason { Text(reason).foregroundStyle(QMTheme.warning) }
    }
  }
  private func perform(_ action: String) async {
    if action == "fire" {
      _ = await model.mutate("/fire")
    } else if ["autopilot", "manual"].contains(action) {
      _ = await model.mutate("/autopilot", body: ["enabled": action == "autopilot"])
    } else {
      _ = await model.setState(action)
    }
  }
}

struct NativeLoopPlaybook: View {
  @Bindable var model: LoopDetailModel
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ""
  @State private var discarding = false
  var body: some View {
    NavigationStack {
      QMForm {
        TextEditor(text: $draft).frame(minHeight: 300)
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }.disabled(model.busy).navigationTitle("Playbook")
        .task { draft = model.detail?.loop.playbook ?? "" }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
              if draft == (model.detail?.loop.playbook ?? "") {
                dismiss()
              } else {
                discarding = true
              }
            }.disabled(model.busy)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task {
                if await model.mutate(method: "PATCH", body: ["playbook": draft]) { dismiss() }
              }
            } label: {
              NativeActionLabel(
                title: "Save", busyTitle: "Saving…", busy: model.busy, compact: true)
            }.disabled(model.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }.interactiveDismissDisabled(model.busy || draft != model.detail?.loop.playbook)
    }
    .confirmationDialog("Discard playbook changes?", isPresented: $discarding) {
      Button("Discard", role: .destructive) { dismiss() }
    }
  }
}
struct NativeLoopTriageEditor: View {
  @Bindable var model: LoopDetailModel
  let kind: NativeLoopTriage
  @Environment(\.dismiss) private var dismiss
  @State private var enabled = false
  @State private var draft = ""
  private var saved: NativeLoop.Triage.Setting? { model.detail?.loop.triage(kind) }
  private var available: Bool { model.detail?.triageAvailable == true }
  private var changed: Bool {
    enabled != (saved?.enabled == true) || draft != (saved?.instructions ?? "")
  }
  var body: some View {
    NavigationStack {
      QMForm {
        Toggle("On", isOn: $enabled)
        TextField("Instructions", text: $draft, axis: .vertical).lineLimit(4...12)
          .disabled(!available)
        if available {
          Button {
            Task { _ = await model.previewTriage(kind, instructions: draft) }
          } label: {
            NativeActionLabel(title: "Preview", busyTitle: "Previewing…", busy: model.previewing)
          }.disabled(
            model.previewing || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        if let error = model.previewError { Text(error).foregroundStyle(.red) }
        if let preview = model.preview {
          Section("Preview") {
            if preview.isEmpty { Text("No open items").foregroundStyle(.secondary) }
            ForEach(preview) { item in
              VStack(alignment: .leading, spacing: 6) {
                Text(model.title(of: item.id))
                if !item.note.isEmpty { Text(item.note).font(.caption).foregroundStyle(.secondary) }
                if let group = item.groupId, group != item.id {
                  Text("With \(model.title(of: group))").font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }.disabled(model.busy).navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
          enabled = saved?.enabled == true
          draft = saved?.instructions ?? ""
          model.clearPreview()
        }
        .onDisappear { model.clearPreview() }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }.disabled(model.busy)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task {
                if await model.saveTriage(kind, enabled: enabled, instructions: draft) { dismiss() }
              }
            } label: {
              NativeActionLabel(
                title: "Save", busyTitle: "Saving…", busy: model.busy, compact: true)
            }.disabled(model.busy || !changed)
          }
        }.interactiveDismissDisabled(model.busy)
    }
  }
}
struct NativeLoopOutputReview: View {
  @Bindable var model: LoopDetailModel
  let original: NativeLoopOutput
  @State private var note = ""
  @State private var decision: String?
  private var output: NativeLoopOutput {
    model.detail?.outputs.first { $0.id == original.id } ?? original
  }
  var body: some View {
    QMForm {
      Text(output.title).font(.headline)
      if let summary = output.summary { Text(summary).textSelection(.enabled) }
      LabeledContent("Action", value: output.shipAction)
      LabeledContent("State", value: output.state)
      if let reference = output.externalRef { Text(reference).textSelection(.enabled) }
      if let note = output.decisionNote { Text(note) }
      if output.reviewable {
        TextField("Review note", text: $note, axis: .vertical)
        Button(output.approveLabel) { decision = "ship" }
        Button("Request changes") { decision = "return" }.disabled(
          note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
    }
    .disabled(model.busy).navigationTitle("Review output")
    .confirmationDialog(
      decision == "ship" ? "Perform this action?" : "Return for changes?",
      isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })
    ) {
      if let decision {
        Button(decision == "ship" ? output.approveLabel : "Request changes") {
          Task {
            if await model.mutate(
              "/outputs/\(output.id.apiComponent)/decide",
              body: ["decision": decision, "note": note])
            {
              note = ""
            }
          }
        }
      }
    } message: {
      Text(output.shipAction.replacingOccurrences(of: "_", with: " "))
    }
  }
}
struct NativeLoopSourceCreation: View {
  @Bindable var model: LoopDetailModel
  @Environment(\.dismiss) private var dismiss
  @State private var kind = "webhook"
  @State private var secret = ""
  @State private var team = ""
  @State private var channels = ""
  @State private var createdSecret: String?
  @State private var busy = false
  @State private var created = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMForm {
        if created {
          Text("Source created. Copy the signing secret now; it will not be shown again.")
          if let createdSecret {
            Text(createdSecret).font(.footnote.monospaced()).textSelection(.enabled)
          }
        } else {
          Picker("Source", selection: $kind) {
            Text("Signed webhook").tag("webhook")
            NativeServiceLabel(title: "Slack events", service: "slack").tag("slack")
            if model.ingestion?.gmailAvailable == true {
              NativeServiceLabel(title: "Gmail Pub/Sub", service: "gmail").tag("gmail")
            }
          }
          if kind == "slack" {
            SecureField("Slack signing secret", text: $secret)
            TextField("Team ID", text: $team).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            TextField("Channel IDs, separated by commas", text: $channels)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
          }
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .disabled(busy).navigationTitle("Event source")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(created ? "Done" : "Cancel") { dismiss() }.disabled(busy)
        }
        if !created {
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task { await create() }
            } label: {
              NativeActionLabel(title: "Create", busyTitle: "Creating…", busy: busy, compact: true)
            }.disabled(
              busy || (kind == "slack" && (secret.isEmpty || team.isEmpty)))
          }
        }
      }.interactiveDismissDisabled(busy || created)
    }
  }
  private func create() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      struct Result: Decodable { let secret: String? }
      var body: [String: Any] = ["kind": kind]
      if kind == "slack" {
        body["secret"] = secret
        body["teamId"] = team.trimmingCharacters(in: .whitespacesAndNewlines)
        body["channels"] = channels.split { $0 == "," || $0.isWhitespace }.map(String.init)
      }
      let result: Result = try await model.client.fetch(model.path + "/ingestion", body: body)
      secret = ""
      createdSecret = result.secret
      created = true
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
