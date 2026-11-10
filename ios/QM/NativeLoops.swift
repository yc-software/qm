import SwiftUI

struct NativeLoop: Decodable, Identifiable {
  struct ShipAction: Decodable {
    let action: String
    let gate: String
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
}
struct NativeLoopItem: Decodable, Identifiable {
  let id: String
  let sourceKey: String
  let sourceSummary: String?
  let status: String
  let attempts: Int
  let parkedReason: String?
}
struct NativeLoopOutput: Decodable, Identifiable {
  let id: String
  let title: String
  let summary: String?
  let shipAction: String
  let externalRef: String?
  let state: String
  let decisionNote: String?
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
  let loop: NativeLoop
  let items: [NativeLoopItem]
  let outputs: [NativeLoopOutput]
  let vitals: Vitals
}
struct NativeLoopList: Decodable { let loops: [NativeLoop] }
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
final class LoopDetailModel {
  let client: APIClient
  let id: String
  var detail: NativeLoopDetail?
  var ingestion: NativeIngestion?
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  init(client: APIClient, id: String) {
    self.client = client
    self.id = id
  }
  var path: String { "api/loops/\(id.apiComponent)" }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      let result: NativeLoopDetail = try await client.fetch(path)
      let sources: NativeIngestion = try await client.fetch(path + "/ingestion")
      return (result, sources)
    } apply: { result, sources in
      detail = result
      ingestion = sources
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func mutate(_ suffix: String = "", method: String = "POST", body: [String: Any] = [:]) async
    -> Bool
  {
    guard !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(path + suffix, body: body, method: method)
      await load(afterMutation: true)
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

struct NativeLoopsView: View {
  let client: APIClient
  @State private var loops: [NativeLoop] = []
  @State private var error: String?
  @State private var query = ""
  var body: some View {
    QMList {
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(loops.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) {
        loop in
        NavigationLink {
          NativeLoopDetailView(client: client, id: loop.id)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              NativeLoopIcon(value: loop.icon)
              Text(loop.name).font(.headline)
            }
            Text(loop.purpose ?? loop.successCondition).font(.subheadline).lineLimit(2)
            Text("\(loop.state) · \(loop.health)").font(.caption).foregroundStyle(.secondary)
          }.padding(.vertical, 6)
        }
      }
      if loops.isEmpty && error == nil {
        ContentUnavailableView(
          "No loops yet", systemImage: "repeat",
          description: Text("Loops keep track of recurring work for QM."))
      }
    }
    .navigationTitle("Loops").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      let result: NativeLoopList = try await client.fetch("api/loops")
      try Task.checkCancellation()
      loops = result.loops
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeLoopDetailView: View {
  @State private var model: LoopDetailModel
  @State private var editing = false
  @State private var adding = false
  @State private var confirm: String?
  @State private var editingIcon = false
  init(client: APIClient, id: String) {
    _model = State(initialValue: LoopDetailModel(client: client, id: id))
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
          if let reason = detail.loop.healthReason { Text(reason).foregroundStyle(.orange) }
          LabeledContent("Queued", value: String(detail.vitals.queue.queued))
          LabeledContent("In progress", value: String(detail.vitals.queue.inProgress))
          LabeledContent("Awaiting review", value: String(detail.vitals.openOutputs))
          Button("Run now", systemImage: "play") { confirm = "fire" }
          Button(detail.loop.state == "enabled" ? "Pause loop" : "Enable loop") {
            confirm = detail.loop.state == "enabled" ? "paused" : "enabled"
          }
          Button("Archive loop", role: .destructive) { confirm = "archived" }
          Button(
            detail.loop.shipActions.allSatisfy { $0.gate == "auto" }
              ? "Turn off autopilot" : "Turn on autopilot"
          ) {
            confirm =
              detail.loop.shipActions.allSatisfy { $0.gate == "auto" } ? "manual" : "autopilot"
          }
        }
        Section("Playbook") {
          DisclosureGroup("Read instructions") {
            Text(detail.loop.playbook).textSelection(.enabled)
          }
          Button("Edit playbook") { editing = true }
          Button("Change icon") {
            editingIcon = true
          }
          LabeledContent("Version", value: String(detail.loop.playbookVersion))
        }
        Section("Outputs") {
          ForEach(detail.outputs) { output in
            NavigationLink {
              NativeLoopOutputReview(model: model, original: output)
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Text(output.title).font(.headline)
                Text(output.state).font(.caption)
              }
            }
          }
        }
        Section("Work items") {
          ForEach(detail.items) { item in
            VStack(alignment: .leading, spacing: 6) {
              Text(item.sourceSummary ?? item.sourceKey)
              Text("\(item.status) · \(item.attempts) attempts").font(.caption)
              if let reason = item.parkedReason { Text(reason).foregroundStyle(.orange) }
            }
          }
        }
        Section("Event sources") {
          ForEach(model.ingestion?.sources ?? []) { source in
            VStack(alignment: .leading, spacing: 6) {
              Text(source.kind.capitalized).font(.headline)
              Text(source.url).font(.footnote.monospaced()).textSelection(.enabled)
              if let gmail = source.gmail { Text(gmail.email) }
              if let error = source.lastError { Text(error).foregroundStyle(.red) }
              Button(source.enabled ? "Disable source" : "Enable source") {
                Task {
                  _ = await model.mutate(
                    "/ingestion/\(source.id.apiComponent)", method: "PATCH",
                    body: ["enabled": !source.enabled])
                }
              }
            }
          }
          Button("Add event source") { adding = true }
        }
      } else if model.loading {
        ProgressView()
      }
    }
    .disabled(model.busy).navigationTitle(model.detail?.loop.name ?? "Loop")
    .navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }.refreshable { await model.load() }
    .sheet(isPresented: $editing) { NativeLoopPlaybook(model: model) }
    .sheet(isPresented: $adding, onDismiss: { Task { await model.load() } }) {
      NativeLoopSourceCreation(model: model)
    }
    .sheet(isPresented: $editingIcon) { NativeLoopIconPicker(model: model) }
    .confirmationDialog(
      "Update this loop?",
      isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })
    ) {
      if let confirm {
        Button(
          confirm == "fire" ? "Run now" : confirm == "autopilot" ? "Enable autopilot" : "Confirm"
        ) { Task { await perform(confirm) } }
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
  private func perform(_ action: String) async {
    if action == "fire" {
      _ = await model.mutate("/fire")
    } else if ["autopilot", "manual"].contains(action) {
      _ = await model.mutate("/autopilot", body: ["enabled": action == "autopilot"])
    } else {
      _ = await model.mutate(method: "PATCH", body: ["state": action])
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
            Button("Save") {
              Task {
                if await model.mutate(method: "PATCH", body: ["playbook": draft]) { dismiss() }
              }
            }.disabled(model.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }.interactiveDismissDisabled(model.busy || draft != model.detail?.loop.playbook)
    }
    .confirmationDialog("Discard playbook changes?", isPresented: $discarding) {
      Button("Discard", role: .destructive) { dismiss() }
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
      if output.state == "ready" {
        TextField("Review note", text: $note, axis: .vertical)
        Button("Approve action") { decision = "ship" }
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
        Button(decision == "ship" ? "Approve action" : "Request changes") {
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
            Text("Slack events").tag("slack")
            if model.ingestion?.gmailAvailable == true { Text("Gmail Pub/Sub").tag("gmail") }
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
            Button("Create") { Task { await create() } }.disabled(
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
