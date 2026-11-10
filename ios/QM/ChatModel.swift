import SwiftUI
import os

@MainActor @Observable
final class ChatModel {
  let user: String
  var conversation: Conversation { didSet { rebuildForkPoints() } }
  var items: [Item] = [] { didSet { rebuildTranscript() } }
  private var inheritedItems: [Item]? { didSet { rebuildTranscript() } }
  var loadingInherited = false
  private(set) var hasLoadedTranscript: Bool

  private(set) var transcriptItems: [Item] = []
  private(set) var messages: [ChatMessage] = []
  private(set) var forkableMessageIDs = Set<String>()
  private var partialIsRecorded = false

  private func rebuildForkPoints() {
    forkableMessageIDs = Set(
      NativeForkPoint.points(
        transcriptItems, inheritedBoundary: conversation.forkBoundarySeq
      ).map(\.id))
  }

  private func rebuildPartialVisibility() {
    partialIsRecorded = partialRunID.map { hasRecordedRunReply(items, runID: $0) } ?? false
  }

  private func rebuildTranscript() {
    let currentIDs = Set(items.map(\.id))
    transcriptItems = ((inheritedItems ?? []).filter { !currentIDs.contains($0.id) } + items)
      .sorted { ($0.seq ?? Int.max) < ($1.seq ?? Int.max) }
    rebuildMessages()
    rebuildForkPoints()
    rebuildPartialVisibility()
  }

  private func rebuildMessages() {
    messages = presentedChatMessages(
      transcriptItems, runs: runPresentations, activeRunID: activeRunID,
      queuedRunIDs: queuedRunIDs)
  }
  var pins: [NativeConversationPin] = []
  var draft = ""
  var attachments: [UploadAttachment] = []
  var uploading = false
  var partial = ""
  private(set) var liveActivity: [Item] = []
  private(set) var partialRunID: String? { didSet { rebuildPartialVisibility() } }
  private(set) var runPresentations: [ChatRunPresentation] = [] { didSet { rebuildMessages() } }
  private var queuedRunIDs = Set<String>() { didSet { rebuildMessages() } }

  var displayedPartial: String {
    if partialIsRecorded { return "" }
    return partial
  }
  var approvals: [Approval] = []
  var error: String?
  var activeRunID: String? { didSet { rebuildMessages() } }
  var pending: PendingSend?
  var sending = false
  var runtimeSelection: RuntimeSelection?
  var runtimeConfiguration: RuntimeConfiguration?
  var earlierItems = 0
  var loadingEarlier = false
  var forking = false
  private var visible = false
  let client: APIClient
  private let drafts: DraftStore
  var attachmentAccount: String { drafts.account }
  private var seededTranscript = false
  private var knownSession: Bool
  private var monitor: Task<Void, Never>?
  private var generation = UUID()
  private var transcriptRevision = 0
  private var completedRunIDs = Set<String>()
  private let publishTick: @MainActor () async throws -> Void

  init(
    conversation: Conversation, client: APIClient, user: String, knownSession: Bool,
    transcript: Transcript? = nil,
    publishTick: @escaping @MainActor () async throws -> Void = {
      try await Task.sleep(for: .milliseconds(50))
    }
  ) {
    self.user = user
    self.publishTick = publishTick
    self.conversation = conversation
    self.client = client
    self.knownSession = knownSession
    hasLoadedTranscript = transcript != nil || !knownSession
    if let transcript {
      items = transcript.items
      pins = transcript.pins ?? []
      earlierItems = transcript.earlierItems ?? 0
      seededTranscript = true
    }
    drafts = DraftStore(
      account: client.baseURL.absoluteString + user, thread: conversation.threadRef)
    let saved = drafts.read()
    draft = saved.text
    runtimeSelection = saved.runtime
    pending = saved.pending
    attachments = saved.pending?.attachments ?? saved.attachments ?? []
    rebuildTranscript()
  }

  var runtimeLabel: String {
    guard let selection = runtimeSelection ?? runtimeConfiguration?.effective else {
      return "Model"
    }
    return runtimeConfiguration?.modelCatalog[selection.modelId]?.label ?? selection.modelId
  }

  var runtimeDetail: String? {
    guard let selection = runtimeSelection ?? runtimeConfiguration?.effective else { return nil }
    var parts: [String] = []
    if let effort = selection.effortLevel, effort != "auto" {
      parts.append(effort == "xhigh" ? "Extra high" : effort.capitalized)
    }
    if selection.fastMode == true { parts.append("Fast") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  func loadRuntime() async {
    do {
      let configuration: RuntimeConfiguration = try await client.fetch(
        "api/runtime-config", query: [.init(name: "scopeId", value: conversation.scopeId)])
      guard !Task.isCancelled else { return }
      runtimeConfiguration = configuration
    } catch {
      Log.background.failure("Loading runtime settings", error)
    }
  }

  func selectRuntime(_ selection: RuntimeSelection?) {
    runtimeSelection = selection
    saveDraft()
  }

  func saveDraft() {
    do {
      try drafts.write(
        .init(
          text: draft, pending: pending, conversation: conversation, attachments: attachments,
          runtime: runtimeSelection))
    } catch {
      self.error = "Could not save your draft on this device."
    }
  }

  @discardableResult
  func refresh() async -> Bool {
    let current = generation
    transcriptRevision += 1
    let revision = transcriptRevision
    let unassociatedReplies = Set(runPresentations.filter { $0.runID == nil }.map(\.id))
    do {
      if !knownSession {
        let list: ConversationList = try await client.fetch("api/sessions")
        guard current == generation, revision == transcriptRevision else { return false }
        if let existing = list.sessions.first(where: { $0.threadRef == conversation.threadRef }) {
          conversation = existing
          knownSession = true
        }
      }
      if knownSession {
        let transcript: Transcript = try await client.fetch(
          "api/sessions/\(conversation.id)", query: [.init(name: "tailTurns", value: "25")])
        guard current == generation, revision == transcriptRevision else { return false }
        let retained =
          transcript.items.first?.seq.map { first in
            items.filter { ($0.seq ?? Int.max) < first }
          } ?? []
        pins = transcript.pins ?? []
        if let session = transcript.session { conversation = session }
        items = retained + transcript.items
        hasLoadedTranscript = true
        if let partialRunID, hasRecordedRunReply(items, runID: partialRunID) {
          partial = ""
        }
        let recordedItemIDs = Set(items.map(\.id))
        runPresentations.removeAll { run in
          unassociatedReplies.contains(run.id)
            || (run.input?.isRecorded(in: items) ?? true)
              && (run.reply == nil
                || run.runID.map { hasRecordedRunReply(items, runID: $0, includingPosts: false) }
                  == true)
              && run.activity.filter(NativeWorkItem.supports).allSatisfy {
                recordedItemIDs.contains($0.id)
              }
        }
        earlierItems = max(0, (transcript.earlierItems ?? 0) - retained.count)
        if conversation.canReply {
          let response: ApprovalList = try await client.fetch(
            "api/sessions/\(conversation.id)/approvals")
          guard current == generation, revision == transcriptRevision else { return false }
          approvals = response.approvals
        }
      }
      error = nil
      return knownSession
    } catch {
      if !Task.isCancelled, current == generation, revision == transcriptRevision {
        self.error = error.localizedDescription
      }
      return false
    }
  }

  func resume(refreshInterval: Duration = .seconds(5)) async {
    pause()
    visible = true
    let current = generation
    async let activeResponse: ActiveRun? = fetchActiveRun()
    let restored: Bool
    if seededTranscript {
      seededTranscript = false
      restored = true
      if conversation.canReply {
        do {
          let response: ApprovalList = try await client.fetch(
            "api/sessions/\(conversation.id)/approvals")
          guard current == generation, !Task.isCancelled else { return }
          approvals = response.approvals
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
      }
    } else {
      restored = await refresh()
    }
    guard !Task.isCancelled, current == generation else { return }
    if !conversation.canReply {
      monitor = Task {
        while !Task.isCancelled, current == generation, visible, client.hasSession {
          do { try await Task.sleep(for: refreshInterval) } catch { return }
          guard !Task.isCancelled, current == generation, visible else { return }
          await refresh()
        }
      }
      return
    }
    do {
      let active = try await activeResponse
      guard current == generation, !Task.isCancelled else { return }
      if let id = active?.runId, !completedRunIDs.contains(id) {
        activeRunID = id
        follow(id)
      } else if restored {
        activeRunID = nil
        partial = ""
      }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }

  private func fetchActiveRun() async throws -> ActiveRun? {
    guard conversation.canReply else { return nil }
    return try await client.fetch(
      "api/runs/active", query: [.init(name: "threadRef", value: conversation.threadRef)])
  }

  func pause() {
    visible = false
    generation = UUID()
    monitor?.cancel()
    monitor = nil
  }

  func send() async {
    guard !sending, !uploading, conversation.canReply else { return }
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard pending != nil || !text.isEmpty || !attachments.isEmpty else { return }
    sending = true
    let accountGeneration = client.generation
    var acceptedSubmission: Submission?
    do {
      if pending == nil {
        pending = PendingSend(
          text: text, idempotencyKey: UUID().uuidString.lowercased(), attachments: attachments,
          runtime: runtimeSelection)
      }
      try drafts.write(
        .init(
          text: draft, pending: pending, conversation: conversation, attachments: attachments,
          runtime: runtimeSelection))
      var staged: [UploadAttachment] = []
      for attachment in pending!.attachments ?? [] {
        let age = Date().timeIntervalSince1970 - (attachment.uploadedAt ?? 0)
        if attachment.uploadedAt != nil && age >= 0 && age < 5 * 60 * 60 {
          staged.append(attachment)
          continue
        }
        guard let sha = attachment.localSHA else {
          throw QMError.message(
            "This saved attachment needs to be attached again before it can be sent.")
        }
        let account = attachmentAccount
        let prepared = try await Task.detached {
          try AttachmentCache.read(account: account, sha: sha)
        }
        .value
        guard client.generation == accountGeneration else { throw CancellationError() }
        let blob = try await client.upload(prepared)
        guard client.generation == accountGeneration else { throw CancellationError() }
        guard blob.sizeBytes == attachment.sizeBytes else {
          throw QMError.message("Could not verify the attachment upload.")
        }
        staged.append(
          UploadAttachment(
            name: attachment.name, mimetype: attachment.mimetype, sizeBytes: blob.sizeBytes,
            blobId: blob.blobId, localSHA: sha, uploadedAt: Date().timeIntervalSince1970))
      }
      guard client.generation == accountGeneration else { throw CancellationError() }
      pending!.attachments = staged
      attachments = staged
      try drafts.write(
        .init(
          text: draft, pending: pending, conversation: conversation, attachments: attachments,
          runtime: runtimeSelection))
      var body: [String: Any] = [
        "text": pending!.text, "idempotencyKey": pending!.idempotencyKey,
        "threadRef": conversation.threadRef, "scopeId": conversation.scopeId,
        "timezone": TimeZone.current.identifier,
        "attachments": staged.map { attachment -> [String: Any] in
          [
            "name": attachment.name, "mimetype": attachment.mimetype,
            "sizeBytes": attachment.sizeBytes, "blobId": attachment.blobId,
          ]
        },
      ]
      if let runtime = pending!.runtime {
        body.merge(runtime.turnOptions) { _, selected in selected }
      }
      let result: Submission = try await client.fetch("api/turn", body: body)
      guard result.runId != nil || result.isTerminalResult else {
        throw QMError.message(
          "QM did not confirm this submission. Retry with the saved message key.")
      }
      if let id = result.runId, let accepted = pending,
        activeRunID == nil || activeRunID == id || result.isTerminalResult
      {
        updatePresentation(id: id) { presentation in
          presentation.input = RunInput(
            runId: id, seq: nil, text: accepted.text,
            createdAt: Date().timeIntervalSince1970 * 1000,
            attachments: accepted.attachments?.map { .init(name: $0.name) })
        }
      }
      draft = ""
      attachments = []
      pending = nil
      try drafts.write(.init(runtime: runtimeSelection))
      error = nil
      acceptedSubmission = result
    } catch {
      if case QMError.rejected = error {
        pending = nil
        saveDraft()
      }
      self.error = error.localizedDescription
    }
    sending = false
    if let acceptedSubmission { await reconcileSubmission(acceptedSubmission) }
  }

  func decide(_ approval: Approval, approved: Bool, scope: String = "once") async {
    guard !sending,
      scope == "once" || (scope == "session" && approval.grantModes?.session == true)
        || (scope == "always" && approval.grantModes?.always == true)
    else { return }
    sending = true
    defer { sending = false }
    do {
      let response: Submission = try await client.fetch(
        "api/approvals/\(approval.requestId)",
        body: [
          "approved": approved, "scope": scope,
          "idempotencyKey": "ios-approval-\(approval.requestId)-\(approved)-\(scope)",
        ])
      guard response.runId != nil || response.isTerminalResult else {
        throw QMError.message(response.reason ?? "Could not confirm approval. Retry this decision.")
      }
      approvals.removeAll { $0.id == approval.id }
      await reconcileSubmission(response)
    } catch { self.error = error.localizedDescription }
  }

  private func reconcileSubmission(_ result: Submission) async {
    let current = generation
    if result.isTerminalResult {
      recordCompletion(id: result.runId, reply: result.reply)
    }
    let active: QueuedInputsResponse?
    do {
      active = try await client.fetch(
        "api/runs/active", query: [.init(name: "threadRef", value: conversation.threadRef)])
    } catch {
      Log.background.failure("Active run check after submission", error)
      active = nil
    }
    guard current == generation, !Task.isCancelled else { return }
    if let active { reconcileQueuedPresentations(active) }
    let next = active?.runId ?? activeRunID ?? (active == nil ? result.runId : nil)
    if let next, !completedRunIDs.contains(next),
      activeRunID != next
    {
      partial = ""
      activeRunID = next
      follow(next)
    }
    let established = generation
    let restored = await refresh()
    guard established == generation, !Task.isCancelled else { return }
    if result.status == "failed" || result.status == "refused" {
      error = result.reason ?? "The task could not be completed."
    }
    if !restored, let pending = result.pendingApprovals, !pending.isEmpty { approvals = pending }
  }

  private func reconcileQueuedPresentations(_ active: QueuedInputsResponse) {
    queuedRunIDs = Set((active.queued ?? []).map(\.runId))
    runPresentations.removeAll { queuedRunIDs.contains($0.id) && !$0.finished }
  }

  func reconcileActivity(_ active: QueuedInputsResponse) async {
    guard visible, client.hasSession else { return }
    reconcileQueuedPresentations(active)
    if let id = active.runId, activeRunID != id, !completedRunIDs.contains(id) {
      let current = generation
      activeRunID = id
      partial = ""
      await refresh()
      guard current == generation, activeRunID == id, !Task.isCancelled else { return }
      follow(id)
    } else if active.runId == nil && activeRunID == nil {
      await refresh()
    }
  }

  func stop() async {
    guard let id = activeRunID else { return }
    do {
      struct Signal: Decodable {}
      let _: Signal = try await client.fetch(
        "api/runs/\(id)/signal", body: ["kind": "abort", "threadRef": conversation.threadRef])
    } catch { self.error = error.localizedDescription }
  }

  func fork(from messageID: String? = nil) async -> Conversation? {
    guard !forking else { return nil }
    forking = true
    defer { forking = false }
    do {
      struct Result: Decodable { let session: Conversation }
      let point = messageID.flatMap { id in
        NativeForkPoint.points(transcriptItems, inheritedBoundary: conversation.forkBoundarySeq)
          .first { $0.id == id }
      }
      guard messageID == nil || point != nil else {
        throw QMError.message("This message hasn’t synced yet. Try again in a moment.")
      }
      let result: Result = try await client.fetch(
        "api/sessions/\(conversation.id.apiComponent)/fork",
        body: Int(point?.cut ?? "all").map { ["upToSeq": $0] } ?? [:])
      error = nil
      return result.session
    } catch {
      self.error = error.localizedDescription
      return nil
    }
  }

  func needsEarlierHistory(for sequence: Int) -> Bool {
    guard earlierItems > 0, let first = items.first?.seq, first > sequence else { return false }
    if let boundary = conversation.forkBoundarySeq, sequence <= boundary,
      transcriptItems.contains(where: { ($0.seq ?? Int.max) <= sequence })
    {
      return false
    }
    return true
  }

  func loadInheritedHistory() async {
    guard !loadingInherited, inheritedItems == nil, conversation.forkedFrom != nil,
      let boundary = conversation.forkBoundarySeq, boundary < Int.max
    else { return }
    loadingInherited = true
    defer { loadingInherited = false }
    let current = generation
    var before = boundary + 1
    var loaded: [Item] = []
    do {
      while !Task.isCancelled {
        let page: Transcript = try await client.fetch(
          "api/sessions/\(conversation.id.apiComponent)",
          query: [
            .init(name: "beforeSeq", value: String(before)), .init(name: "tailTurns", value: "25"),
          ])
        guard current == generation, !Task.isCancelled else { return }
        let inherited = page.items.filter { ($0.seq ?? Int.max) <= boundary }
        loaded.insert(contentsOf: inherited, at: 0)
        guard (page.earlierItems ?? 0) > 0, let first = inherited.first?.seq,
          first > 0, first < before
        else { break }
        before = first
      }
      guard current == generation, !Task.isCancelled else { return }
      inheritedItems = loaded
      error = nil
    } catch {
      if current == generation, !Task.isCancelled { self.error = error.localizedDescription }
    }
  }

  func loadEarlier() async {
    guard !loadingEarlier, let first = items.first?.seq else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    let revision = transcriptRevision
    let current = generation
    do {
      let page: Transcript = try await client.fetch(
        "api/sessions/\(conversation.id)",
        query: [
          .init(name: "beforeSeq", value: String(first)), .init(name: "tailTurns", value: "25"),
        ])
      guard current == generation, revision == transcriptRevision else { return }
      let existing = Set(items.map(\.id))
      items.insert(contentsOf: page.items.filter { !existing.contains($0.id) }, at: 0)
      earlierItems = page.earlierItems ?? 0
    } catch { self.error = error.localizedDescription }
  }

  private func updatePresentation(id: String, update: (inout ChatRunPresentation) -> Void) {
    if let index = runPresentations.firstIndex(where: { $0.id == id }) {
      update(&runPresentations[index])
    } else {
      var presentation = ChatRunPresentation(id: id, runID: id)
      update(&presentation)
      runPresentations.append(presentation)
    }
  }

  private func recordCompletion(id: String?, reply: String?) {
    if let id {
      completedRunIDs.insert(id)
      updatePresentation(id: id) {
        $0.finished = true
        $0.reply = reply
        if partialRunID == id { $0.activity = liveActivity }
      }
    } else if let reply, !reply.isEmpty {
      runPresentations.append(
        ChatRunPresentation(id: UUID().uuidString, reply: reply, finished: true))
    }
  }

  private func finish(_ run: Run, id: String, generation current: UUID) async {
    guard current == generation, !Task.isCancelled else { return }
    if let input = run.input { updatePresentation(id: id) { $0.input = input } }
    recordCompletion(id: id, reply: run.result?.reply ?? run.partial ?? partial)
    if activeRunID == id { activeRunID = nil }
    if partialRunID == id { partial = "" }
    if await refresh(), current == generation, !Task.isCancelled {
      error = run.failure
    }
  }

  private func follow(_ id: String) {
    guard visible, !completedRunIDs.contains(id) else { return }
    pause()
    visible = true
    let current = generation
    partialRunID = id
    liveActivity = []
    monitor = Task {
      var text = StreamText()
      while !Task.isCancelled && current == generation {
        do {
          var textChanged = false
          let publisher = Task { @MainActor in
            while !Task.isCancelled {
              do { try await publishTick() } catch { return }
              guard current == generation, !Task.isCancelled else { return }
              if textChanged {
                partial = text.text
                textChanged = false
              }
            }
          }
          defer { publisher.cancel() }
          var terminal: Run?
          try await client.stream(id) { event in
            guard current == generation, !Task.isCancelled else { throw CancellationError() }
            try text.apply(event)
            if event.name == "delta" || event.name == "run" { textChanged = true }
            if let activity = event.run?.activityItems { liveActivity = activity }
            if let input = event.run?.input, input.runId == id {
              updatePresentation(id: id) { $0.input = input }
            }
            error = nil
            if let run = event.run, run.isFinished {
              terminal = run
              recordCompletion(id: id, reply: run.result?.reply ?? run.partial ?? text.text)
              if activeRunID == id { activeRunID = nil }
              publisher.cancel()
              partial = ""
            }
          }
          publisher.cancel()
          try Task.checkCancellation()
          if let terminal {
            await finish(terminal, id: id, generation: current)
            return
          }
          if textChanged { partial = text.text }
          let run: Run = try await client.fetch("api/runs/\(id)")
          if let activity = run.activityItems { liveActivity = activity }
          if let input = run.input, input.runId == id {
            updatePresentation(id: id) { $0.input = input }
          }
          if run.isFinished {
            await finish(run, id: id, generation: current)
            return
          }
        } catch {
          if Task.isCancelled || current != generation { return }
          Log.background.failure("Following run events", error)
          if case QMError.signedOut = error {
            self.error = error.localizedDescription
            return
          }
          self.error = "Connection interrupted. Reconnecting…"
        }
        do {
          let run: Run = try await client.fetch("api/runs/\(id)")
          if let activity = run.activityItems { liveActivity = activity }
          if let input = run.input, input.runId == id {
            updatePresentation(id: id) { $0.input = input }
          }
          partial = run.result?.reply ?? run.partial ?? partial
          if run.isFinished {
            await finish(run, id: id, generation: current)
            return
          }
          try await Task.sleep(for: .seconds(2))
        } catch {
          if Task.isCancelled { return }
          Log.background.failure("Reading run status", error)
          if case QMError.signedOut = error {
            self.error = error.localizedDescription
            return
          }
          try? await Task.sleep(for: .seconds(3))
        }
      }
    }
  }
}
