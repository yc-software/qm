import SwiftUI

struct NativeCron: Decodable, Identifiable {
  struct Schedule: Decodable, Equatable {
    let everyMs: Double?
    let firstFireAt: Double?
    let cron: String?
    let timezone: String?
    var label: String {
      if let cron { return "\(cron) · \(timezone ?? "UTC")" }
      if let everyMs { return "Every \(String(format: "%.0f", everyMs / 60000)) minutes" }
      if let firstFireAt { return Date(timeIntervalSince1970: firstFireAt / 1000).formatted() }
      return "Unscheduled"
    }
  }
  struct Destination: Decodable {
    let type: String
    let target: String
  }
  let id: String
  let ownerScopeId: String
  let owner: String
  let title: String?
  let action: String?
  let loopId: String?
  let message: String?
  let schedule: Schedule
  let destination: Destination?
  let enabled: Bool
  let archived: Bool?
  let lastFiredAt: Double?
  let nextFireAt: Double?
  let scopeName: String?
  let permission: String?
  var label: String { title ?? action ?? message ?? "Scheduled task" }
  var task: String { message ?? action ?? "" }
  var canEditTask: Bool { message == nil && loopId == nil && action != nil }

  func editPatch(title: String, task: String, schedule: Schedule) -> [String: Any] {
    var patch: [String: Any] = [:]
    if title != (self.title ?? "") { patch["title"] = title }
    if canEditTask && task != self.task { patch["task"] = task }
    if schedule != self.schedule {
      var value: [String: Any] = [:]
      if let cron = schedule.cron {
        value["cron"] = cron
        value["timezone"] = schedule.timezone
      } else if let everyMs = schedule.everyMs {
        value["everyMs"] = everyMs
      } else if let firstFireAt = schedule.firstFireAt {
        value["firstFireAt"] = firstFireAt
      }
      patch["schedule"] = value
    }
    return patch
  }
}

struct NativeCronList: Decodable {
  let crons: [NativeCron]
  let visible: [NativeCron]?
}
struct NativeCronRun: Decodable, Identifiable {
  let fireKey: String
  let firedAt: Double
  let status: String?
  let note: String?
  let reply: String?
  let sessionId: String?
  var id: String { fireKey }
}
struct NativeCronRuns: Decodable { let runs: [NativeCronRun] }
struct MutationReceipt: Decodable {}

@MainActor @Observable
final class CronsModel {
  let client: APIClient
  var owned: [NativeCron] = []
  var shared: [NativeCron] = []
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  init(client: APIClient) { self.client = client }

  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      try await client.fetch("api/crons") as NativeCronList
    } apply: { result in
      owned = result.crons
      shared = result.visible ?? []
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }

  func mutate(
    _ cron: NativeCron, action: String? = nil, patch: [String: Any]? = nil, deleting: Bool = false
  ) async -> Bool {
    guard !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/crons/\(cron.id.apiComponent)" + (action.map { "/\($0)" } ?? ""),
        body: patch ?? [:], method: deleting ? "DELETE" : patch != nil ? "PATCH" : "POST")
      await load(afterMutation: true)
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

struct NativeCronsView: View {
  let user: String
  @State private var model: CronsModel
  @State private var tab = "Yours"
  @State private var query = ""
  @State private var creating = false
  init(client: APIClient, user: String) {
    self.user = user
    _model = State(initialValue: CronsModel(client: client))
  }
  private var crons: [NativeCron] {
    (tab == "Shared" ? model.shared : model.owned).filter {
      ($0.archived == true) == (tab == "Archived")
        && (query.isEmpty || $0.label.localizedCaseInsensitiveContains(query))
    }
  }
  var body: some View {
    QMList {
      Picker("Show", selection: $tab) {
        ForEach(["Yours", "Shared", "Archived"], id: \.self) { Text($0) }
      }.pickerStyle(.segmented)
      if let error = model.error { Text(error).foregroundStyle(.red) }
      ForEach(crons) { cron in
        NavigationLink {
          NativeCronDetail(model: model, original: cron, user: user)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(cron.label).font(.headline).lineLimit(2)
            Text(cron.schedule.label).font(.caption).foregroundStyle(.secondary)
            Label(
              cron.enabled ? "Active" : "Paused",
              systemImage: cron.enabled ? "clock" : "pause.circle"
            ).font(.caption)
          }.padding(.vertical, 6)
        }
      }
      if crons.isEmpty && !model.loading {
        ContentUnavailableView(
          "No scheduled tasks", systemImage: "clock",
          description: Text("Ask QM to schedule a task and it will appear here."))
      }
    }
    .navigationTitle("Crons").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .toolbar { Button("New cron", systemImage: "plus") { creating = true } }
    .task { await model.load() }.refreshable { await model.load() }
    .overlay { if model.loading && model.owned.isEmpty { ProgressView() } }
    .sheet(
      isPresented: $creating, onDismiss: { Task { await model.load() } },
      content: {
        NativeCronCreation(client: model.client, user: user)
      })
  }
}

struct NativeCronDetail: View {
  @Bindable var model: CronsModel
  let original: NativeCron
  let user: String
  @Environment(\.dismiss) private var dismiss
  @State private var runs: [NativeCronRun] = []
  @State private var historyError: String?
  @State private var editing = false
  @State private var deleting = false
  @State private var running = false
  private var cron: NativeCron {
    (model.owned + model.shared).first { $0.id == original.id } ?? original
  }
  private var canManage: Bool {
    cron.permission == "manage"
      || (cron.permission == nil && model.owned.contains { $0.id == cron.id })
  }
  var body: some View {
    QMList {
      if let error = model.error { Text(error).foregroundStyle(.red) }
      Section("Task") { Text(cron.task).textSelection(.enabled) }
      Section("Schedule") {
        LabeledContent("Timing", value: cron.schedule.label)
        LabeledContent(
          "Status", value: cron.archived == true ? "Archived" : cron.enabled ? "Active" : "Paused")
        if let next = cron.nextFireAt {
          LabeledContent("Next run", value: Date(timeIntervalSince1970: next / 1000).formatted())
        }
        if let last = cron.lastFiredAt {
          LabeledContent("Last run", value: Date(timeIntervalSince1970: last / 1000).formatted())
        }
        if let destination = cron.destination {
          LabeledContent("Deliver to", value: destination.target)
        }
        if let scope = cron.scopeName { LabeledContent("Workspace", value: scope) }
      }
      if canManage {
        Section {
          Button("Edit task and schedule", systemImage: "pencil") { editing = true }
          if cron.archived != true {
            Button("Run now", systemImage: "play") { running = true }
            Button(
              cron.enabled ? "Pause" : "Enable", systemImage: cron.enabled ? "pause" : "play.circle"
            ) {
              Task { _ = await model.mutate(cron, action: cron.enabled ? "disable" : "enable") }
            }
          }
          Button(
            cron.archived == true ? "Restore from archive" : "Archive", systemImage: "archivebox"
          ) {
            Task { _ = await model.mutate(cron, patch: ["archived": cron.archived != true]) }
          }
          Button("Delete cron", role: .destructive) { deleting = true }
        }.disabled(model.busy)
      }
      Section("Recent runs") {
        if let historyError { Text(historyError).foregroundStyle(.red) }
        if runs.isEmpty && historyError == nil { Text("No runs yet").foregroundStyle(.secondary) }
        ForEach(runs.sorted { $0.firedAt > $1.firedAt }) { run in
          VStack(alignment: .leading, spacing: 8) {
            Text(Date(timeIntervalSince1970: run.firedAt / 1000), style: .date)
            Text(run.status ?? "Completed").font(.caption).foregroundStyle(.secondary)
            if let detail = run.note ?? run.reply { Text(detail).textSelection(.enabled) }
            if let id = run.sessionId {
              NavigationLink("Open conversation") {
                NativeConversationDestination(client: model.client, user: user, sessionID: id)
              }
            }
          }.padding(.vertical, 6)
        }
        Button("Refresh runs") { Task { await loadRuns() } }
      }
    }
    .navigationTitle(cron.label).navigationBarTitleDisplayMode(.inline)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await loadRuns() }.refreshable {
      await model.load()
      await loadRuns()
    }
    .sheet(isPresented: $editing) { NativeCronEditor(model: model, cron: cron) }
    .confirmationDialog("Run this task now?", isPresented: $running) {
      Button("Run now") { Task { if await model.mutate(cron, action: "run") { await loadRuns() } } }
    } message: {
      Text("QM will execute the task and deliver its result to the configured destination.")
    }
    .confirmationDialog("Permanently delete this cron?", isPresented: $deleting) {
      Button("Delete cron", role: .destructive) {
        Task { if await model.mutate(cron, deleting: true) { dismiss() } }
      }
    } message: {
      Text("This cannot be undone. Archive it to keep its history instead.")
    }
  }
  private func loadRuns() async {
    do {
      let result: NativeCronRuns = try await model.client.fetch(
        "api/crons/\(cron.id.apiComponent)/runs")
      try Task.checkCancellation()
      runs = result.runs
      historyError = nil
    } catch { if !Task.isCancelled { historyError = error.localizedDescription } }
  }
}

struct NativeCronEditor: View {
  @Bindable var model: CronsModel
  let cron: NativeCron
  @Environment(\.dismiss) private var dismiss
  @State private var title: String
  @State private var task: String
  @State private var timing: String
  @State private var expression: String
  @State private var minutes: String
  @State private var timezone: String
  @State private var firstFire: Date
  @State private var error: String?
  init(model: CronsModel, cron: NativeCron) {
    self.model = model
    self.cron = cron
    _title = State(initialValue: cron.title ?? "")
    _task = State(initialValue: cron.task)
    _timing = State(
      initialValue: cron.schedule.cron != nil
        ? "Calendar" : cron.schedule.everyMs != nil ? "Interval" : "Once")
    _expression = State(initialValue: cron.schedule.cron ?? "0 9 * * 1-5")
    _minutes = State(initialValue: String((cron.schedule.everyMs ?? 3_600_000) / 60000))
    _timezone = State(initialValue: cron.schedule.timezone ?? "UTC")
    _firstFire = State(
      initialValue: Date(
        timeIntervalSince1970: (cron.schedule.firstFireAt ?? Date().timeIntervalSince1970 * 1000)
          / 1000))
  }
  var body: some View {
    NavigationStack {
      QMForm {
        Section("Task") {
          TextField("Title", text: $title)
          if cron.canEditTask {
            TextEditor(text: $task).frame(minHeight: 140)
          } else {
            Text(cron.task)
            Text("Use QM to change this task’s behavior.").font(.caption)
          }
        }
        Section("Schedule") {
          Picker("Timing", selection: $timing) {
            ForEach(["Calendar", "Interval", "Once"], id: \.self) { Text($0) }
          }
          if timing == "Calendar" {
            TextField("Cron expression", text: $expression).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            Text(
              "Minute, hour, day of month, month, day of week. Example: 0 9 * * 1-5 runs at 9am on weekdays."
            ).font(.caption)
            TextField("Timezone", text: $timezone).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
          } else if timing == "Interval" {
            TextField("Minutes between runs", text: $minutes).keyboardType(.decimalPad)
          } else {
            DatePicker("Run at", selection: $firstFire)
          }
        }
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
      }
      .disabled(model.busy).navigationTitle("Edit cron")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(model.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { Task { await save() } }.disabled(
            model.busy
              || (cron.canEditTask && task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        }
      }.interactiveDismissDisabled(model.busy)
    }
  }
  private func save() async {
    let schedule: NativeCron.Schedule
    if timing == "Calendar" {
      guard expression.split(whereSeparator: \.isWhitespace).count == 5,
        TimeZone(identifier: timezone) != nil
      else {
        error = "Enter a five-field cron expression and a valid timezone."
        return
      }
      schedule = .init(everyMs: nil, firstFireAt: nil, cron: expression, timezone: timezone)
    } else if timing == "Interval" {
      guard let value = Double(minutes), value.isFinite, value > 0 else {
        error = "Enter a positive interval in minutes."
        return
      }
      schedule = .init(
        everyMs: value * 60000, firstFireAt: cron.schedule.firstFireAt, cron: nil,
        timezone: cron.schedule.timezone)
    } else {
      schedule = .init(
        everyMs: nil, firstFireAt: firstFire.timeIntervalSince1970 * 1000, cron: nil,
        timezone: cron.schedule.timezone)
    }
    let unchangedCalendar =
      timing == "Calendar" && cron.schedule.cron == expression
      && timezone == (cron.schedule.timezone ?? "UTC")
    let patch = cron.editPatch(
      title: title, task: task, schedule: unchangedCalendar ? cron.schedule : schedule)
    if patch.isEmpty {
      dismiss()
      return
    }
    if await model.mutate(cron, patch: patch) {
      dismiss()
    }
  }
}

struct NativeCronCreation: View {
  let client: APIClient
  let user: String
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var chat: ChatModel?
  var body: some View {
    NavigationStack {
      QMForm {
        Section {
          Text(
            "Describe what to do, how often, and where the result should go. QM will create the schedule and confirm it in chat."
          )
          TextEditor(text: $text).frame(minHeight: 160)
        }
        Button("Ask QM to set it up") {
          let id = UUID().uuidString.lowercased()
          let conversation = Conversation(
            id: id, scopeId: "personal:\(user)", threadRef: "web:\(user):\(id)", surface: "web",
            localOnly: true)
          let model = ChatModel(
            conversation: conversation, client: client, user: user, knownSession: false)
          model.draft =
            "Set up a cron for me: \(text.trimmingCharacters(in: .whitespacesAndNewlines))\n\nUse your scheduling API, a calendar schedule with timezone for daily, weekly or monthly timing, and a short distinctive title. Confirm what you created."
          model.saveDraft()
          chat = model
        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .navigationTitle("New cron")
      .toolbar { Button("Done") { dismiss() } }
      .navigationDestination(
        isPresented: Binding(get: { chat != nil }, set: { if !$0 { chat = nil } })
      ) {
        if let chat { ChatView(model: chat) }
      }
    }
  }
}
