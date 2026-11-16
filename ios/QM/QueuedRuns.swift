import SwiftUI

struct QueuedInput: Decodable, Identifiable, Equatable {
  let runId: String
  let text: String
  let hasAttachments: Bool?
  var id: String { runId }
}

struct QueuedInputsResponse: Decodable {
  let runId: String?
  let queued: [QueuedInput]?
}

struct QueuedInputEdit {
  let runID: String
  let original: String
  let hasAttachments: Bool
  var text: String

  init(_ input: QueuedInput) {
    runID = input.runId
    original = input.text
    hasAttachments = input.hasAttachments == true
    text = input.text
  }

  var canSave: Bool {
    text != original
      && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasAttachments)
  }
  var body: [String: Any] { ["text": text, "expectedText": original] }
}

private struct QueueMutationResponse: Decodable {
  let edited: Bool?
  let withdrawn: Bool?
  let accepted: Bool?
  let replayed: Bool?
}

@MainActor
@Observable
final class QueuedInputsModel {
  let client: APIClient
  let threadRef: String
  let scopeID: String
  let onSnapshot: (QueuedInputsResponse) async -> Void
  var inputs: [QueuedInput] = []
  private(set) var steering: [QueuedInput] = []
  var edit: QueuedInputEdit?
  private var refreshError: String?
  private var actionError: String?
  var error: String? { actionError ?? (inputs.isEmpty && edit == nil ? nil : refreshError) }
  private(set) var mutatingRunID: String?
  var mutating: Bool { mutatingRunID != nil }
  private(set) var retrying = false
  var activeRunID: String?
  private var mutation: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var refreshRevision = 0
  private var revision = 0

  init(
    client: APIClient, threadRef: String, scopeID: String,
    onSnapshot: @escaping (QueuedInputsResponse) async -> Void
  ) {
    self.client = client
    self.threadRef = threadRef
    self.scopeID = scopeID
    self.onSnapshot = onSnapshot
  }

  func apply(_ snapshot: QueuedInputsResponse) {
    refreshRevision += 1
    if snapshot.runId != activeRunID { steering = [] }
    activeRunID = snapshot.runId
    inputs = snapshot.queued ?? []
    refreshError = nil
  }

  func settleSteering(recorded timestamps: Set<String>) {
    guard !steering.isEmpty else { return }
    steering.removeAll { timestamps.contains("queued-steer:\(threadRef):\($0.runId)") }
  }

  func refresh() async {
    guard !mutating else { return }
    let expectedRevision = revision
    refreshRevision += 1
    let expectedRefresh = refreshRevision
    do {
      let result: QueuedInputsResponse = try await client.fetch(
        "api/runs/active", query: [.init(name: "threadRef", value: threadRef)])
      try Task.checkCancellation()
      guard expectedRevision == revision, expectedRefresh == refreshRevision else { return }
      apply(result)
      await onSnapshot(result)
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled, expectedRevision == revision, expectedRefresh == refreshRevision
      else { return }
      self.refreshError = "Could not refresh queued messages. \(error.localizedDescription)"
    }
  }

  func poll() async {
    while !Task.isCancelled {
      if !retrying { await refresh() }
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
    }
  }

  func stop() {
    revision += 1
    retry?.cancel()
    retry = nil
    retrying = false
    mutation?.cancel()
    mutation = nil
    mutatingRunID = nil
  }

  func retryRefresh() {
    guard !mutating, !retrying else { return }
    let expectedRevision = revision
    retrying = true
    refreshError = nil
    actionError = nil
    retry = Task {
      defer { if revision == expectedRevision { retrying = false } }
      await refresh()
    }
  }

  func save() {
    guard let edit, edit.canSave else { return }
    perform(runID: edit.runID, body: edit.body, action: .edit)
  }

  func withdraw(_ input: QueuedInput) {
    perform(runID: input.runId, body: [:], action: .withdraw)
  }

  func steer(_ input: QueuedInput) {
    guard let activeRunID, inputs.contains(input) else { return }
    perform(
      runID: input.runId,
      body: [
        "kind": "steer", "text": input.text, "queuedRunId": input.runId,
        "threadRef": threadRef, "scopeId": scopeID,
      ],
      action: .steer(activeRunID))
  }

  private enum Action {
    case edit, withdraw
    case steer(String)

    var failure: String {
      switch self {
      case .edit: "Edit was not confirmed."
      case .withdraw: "Removal was not confirmed."
      case .steer: "Steering was not confirmed. Check the queue and transcript before trying again."
      }
    }
  }

  private func perform(runID: String, body: [String: Any], action: Action) {
    guard !mutating else { return }
    mutatingRunID = runID
    revision += 1
    let expectedRevision = revision
    actionError = nil
    mutation = Task {
      do {
        let path: String
        let method: String
        let statusCodes: Set<Int>
        switch action {
        case .edit:
          path = "api/runs/\(runID)/input"
          method = "PATCH"
          statusCodes = []
        case .withdraw:
          path = "api/runs/\(runID)/withdraw"
          method = "POST"
          statusCodes = []
        case .steer(let active):
          path = "api/runs/\(active)/signal"
          method = "POST"
          statusCodes = [409]
        }
        let response: QueueMutationResponse = try await client.fetch(
          path, body: body, method: method, accepting: statusCodes)
        try Task.checkCancellation()
        guard expectedRevision == revision else { return }
        let confirmed: Bool
        switch action {
        case .edit: confirmed = response.edited == true
        case .withdraw: confirmed = response.withdrawn == true
        case .steer: confirmed = response.accepted == true || response.replayed == true
        }
        guard confirmed else {
          throw QMError.message(
            "The message changed or already started. Refresh the queue and try again.")
        }
        switch action {
        case .edit, .withdraw:
          if edit?.runID == runID { edit = nil }
        case .steer:
          if response.accepted == true, let input = inputs.first(where: { $0.runId == runID }) {
            steering.append(input)
          }
        }
      } catch is CancellationError {
      } catch {
        guard !Task.isCancelled, expectedRevision == revision else { return }
        self.actionError =
          "\(action.failure) The message may have changed or started. \(error.localizedDescription)"
      }
      guard expectedRevision == revision else { return }
      mutatingRunID = nil
      mutation = nil
      if !Task.isCancelled { await refresh() }
    }
  }
}

@MainActor
struct QueuedRunsView: View {
  let model: QueuedInputsModel

  private var waiting: [QueuedInput] {
    model.inputs.filter { input in !model.steering.contains { $0.runId == input.runId } }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !model.steering.isEmpty || !waiting.isEmpty || model.edit != nil {
        Group {
          if model.steering.count + waiting.count > 3 {
            ScrollView(.vertical) { rows }.frame(height: 200)
          } else {
            rows
          }
        }
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(QMTheme.border, lineWidth: 1) }
        .padding(.bottom, 10)
      }
      if model.retrying {
        NativeLoadingRail()
          .accessibilityHidden(false)
          .accessibilityLabel("Refreshing queued messages")
          .padding(.bottom, 10)
      }
      if let error = model.error {
        HStack(alignment: .top) {
          Text(error).font(.caption).foregroundStyle(.red)
          Button("Refresh") {
            model.retryRefresh()
          }.font(.caption).disabled(model.mutating || model.retrying)
        }
        .padding(.bottom, 10)
      }
    }
  }

  private var rows: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Queued").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 2)
      ForEach(model.steering) { input in
        row(input) {
          Text("Steering…").font(.footnote).foregroundStyle(.secondary).padding(.trailing, 8)
        }
      }
      ForEach(waiting) { input in
        if model.edit?.runID == input.runId {
          editor
        } else {
          row(input) { actions(input) }
        }
      }
      if let edit = model.edit, !waiting.contains(where: { $0.runId == edit.runID }) {
        editor
      }
    }
    .padding(.bottom, 4)
  }

  private func row(_ input: QueuedInput, @ViewBuilder trailing: () -> some View) -> some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(input.text.isEmpty ? "Attachments" : input.text).font(.subheadline).lineLimit(2)
        if input.hasAttachments == true, !input.text.isEmpty {
          Label("Attachments", systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      trailing()
    }
    .padding(.leading, 14).padding(.trailing, 6).frame(minHeight: 44)
  }

  @ViewBuilder
  private func actions(_ input: QueuedInput) -> some View {
    if model.mutatingRunID == input.runId {
      NativeWave().accessibilityLabel("Updating queue").padding(.trailing, 8)
    } else {
      Button {
        model.steer(input)
      } label: {
        Label("Steer", systemImage: "arrow.turn.down.right")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(QMTheme.paper)
          .padding(.horizontal, 12).frame(minHeight: 32)
          .background(QMTheme.ink.opacity(model.activeRunID == nil ? 0.25 : 1), in: Capsule())
          .frame(minHeight: 44)
      }
      .disabled(model.activeRunID == nil || model.mutating || model.retrying)
      .accessibilityHint("Send this queued message to the running task now")
      Menu {
        Button("Edit", systemImage: "pencil") { model.edit = QueuedInputEdit(input) }
        Button("Remove", systemImage: "trash", role: .destructive) { model.withdraw(input) }
      } label: {
        Image(systemName: "ellipsis").frame(width: 36, height: 44)
      }
      .disabled(model.mutating || model.retrying)
      .accessibilityLabel("More actions for queued message")
    }
  }

  @ViewBuilder
  private var editor: some View {
    if let edit = model.edit {
      let current = model.inputs.first { $0.runId == edit.runID }
      VStack(alignment: .leading, spacing: 8) {
        TextField(
          "Message",
          text: Binding(get: { model.edit?.text ?? "" }, set: { model.edit?.text = $0 }),
          axis: .vertical
        )
        .lineLimit(1...6).font(.subheadline)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(QMTheme.paper, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel("Edit queued message")
        if let current, current.text != edit.original {
          Text(
            "This message changed elsewhere. Your draft is kept; cancel and reopen to edit the latest version."
          )
          .font(.caption).foregroundStyle(QMTheme.warning)
        } else if current == nil {
          Text("This message is no longer queued. Copy your draft before closing.")
            .font(.caption).foregroundStyle(.secondary)
        }
        HStack {
          Button("Cancel") { model.edit = nil }
          Spacer()
          if model.mutatingRunID == edit.runID {
            NativeWave().accessibilityLabel("Updating queue")
          } else {
            Button("Save") { model.save() }
              .fontWeight(.semibold)
              .disabled(
                !edit.canSave || current?.text != edit.original || model.mutating
                  || model.retrying)
          }
        }
        .font(.footnote).frame(minHeight: 32)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)
    }
  }
}
