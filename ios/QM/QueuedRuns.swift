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
  var edit: QueuedInputEdit?
  var expanded = false
  private var refreshError: String?
  private var actionError: String?
  var error: String? { actionError ?? refreshError }
  var mutating = false
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
      activeRunID = result.runId
      inputs = result.queued ?? []
      refreshError = nil
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
      await refresh()
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
    }
  }

  func stop() {
    revision += 1
    retry?.cancel()
    retry = nil
    mutation?.cancel()
    mutation = nil
    mutating = false
  }

  func retryRefresh() {
    retry?.cancel()
    refreshError = nil
    actionError = nil
    retry = Task { await refresh() }
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
    mutating = true
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
          break
        }
      } catch is CancellationError {
      } catch {
        guard !Task.isCancelled, expectedRevision == revision else { return }
        self.actionError =
          "\(action.failure) The message may have changed or started. \(error.localizedDescription)"
      }
      guard expectedRevision == revision else { return }
      mutating = false
      mutation = nil
      if !Task.isCancelled { await refresh() }
    }
  }
}

struct QueuedRunsView: View {
  let client: APIClient
  let threadRef: String
  let scopeID: String
  let onSnapshot: (QueuedInputsResponse) async -> Void

  var body: some View {
    QueuedRunsContent(
      client: client, threadRef: threadRef, scopeID: scopeID, onSnapshot: onSnapshot
    ).id(threadRef)
  }
}

@MainActor
private struct QueuedRunsContent: View {
  @State private var model: QueuedInputsModel
  @Environment(\.scenePhase) private var phase

  init(
    client: APIClient, threadRef: String, scopeID: String,
    onSnapshot: @escaping (QueuedInputsResponse) async -> Void
  ) {
    _model = State(
      initialValue: QueuedInputsModel(
        client: client, threadRef: threadRef, scopeID: scopeID, onSnapshot: onSnapshot))
  }

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 10) {
      if !model.inputs.isEmpty || model.edit != nil {
        DisclosureGroup(isExpanded: $model.expanded) {
          ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(model.inputs) { input in
                VStack(alignment: .leading, spacing: 8) {
                  Text(input.text.isEmpty ? "Attachments" : input.text).lineLimit(3)
                  if input.hasAttachments == true {
                    Label("Includes attachments", systemImage: "paperclip").foregroundStyle(
                      .secondary)
                  }
                  HStack {
                    Button("Edit") { model.edit = QueuedInputEdit(input) }
                    Button("Steer now") { model.steer(input) }
                      .disabled(model.activeRunID == nil)
                      .accessibilityHint("Use this queued message to direct the running task")
                    Spacer()
                    Button("Withdraw", role: .destructive) { model.withdraw(input) }
                  }
                }.padding(.vertical, 6)
              }
              if let edit = model.edit {
                VStack(alignment: .leading, spacing: 8) {
                  Text("Edit queued message").font(.subheadline.weight(.semibold))
                  TextField(
                    "Message",
                    text: Binding(get: { model.edit?.text ?? "" }, set: { model.edit?.text = $0 }),
                    axis: .vertical
                  )
                  .lineLimit(2...6).textFieldStyle(.roundedBorder)
                  if let current = model.inputs.first(where: { $0.id == edit.runID }),
                    current.text != edit.original
                  {
                    Text(
                      "This message changed elsewhere. Your draft is kept; cancel and reopen to edit the latest version."
                    )
                    .foregroundStyle(.orange)
                  } else if !model.inputs.contains(where: { $0.id == edit.runID }) {
                    Text("This message is no longer queued. Copy your draft before closing.")
                      .foregroundStyle(.secondary)
                  }
                  HStack {
                    Button("Cancel") { model.edit = nil }
                    Spacer()
                    Button("Save edit") { model.save() }.disabled(
                      !edit.canSave
                        || !model.inputs.contains(where: {
                          $0.id == edit.runID && $0.text == edit.original
                        }))
                  }
                }
              }
            }
          }
          .frame(maxHeight: 240)
        } label: {
          Label(
            "Queued messages (\(model.inputs.count))",
            systemImage: "text.line.first.and.arrowtriangle.forward"
          )
          .font(.subheadline)
        }
        .disabled(model.mutating)
      }
      if model.mutating { NativeWave().accessibilityLabel("Updating queue") }
      if let error = model.error {
        HStack(alignment: .top) {
          Text(error).font(.caption).foregroundStyle(.red)
          Button("Refresh") {
            model.retryRefresh()
          }.font(.caption).disabled(model.mutating)
        }
      }
    }
    .task(id: phase) {
      if phase == .active { await model.poll() } else { model.stop() }
    }
    .onDisappear { model.stop() }
  }
}
