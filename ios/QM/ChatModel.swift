import SwiftUI
import os

@MainActor @Observable
final class ChatModel {
  let user: String
  var conversation: Conversation {
    didSet { if conversation != oldValue { presentationRevision += 1 } }
  }
  var entries: [Entry] = [] { didSet { presentationRevision += 1 } }
  private var inheritedEntries: [Entry]? { didSet { presentationRevision += 1 } }
  var loadingInherited = false
  private(set) var hasLoadedTranscript: Bool

  private var earlierPromptAt: Double? {
    didSet { if earlierPromptAt != oldValue { presentationRevision += 1 } }
  }
  private var earlierPromptBoundary: Int?
  private static func latestPrompt(in messages: [ChatMessage]) -> Double? {
    messages.lazy.filter { $0.role == "user" && SubagentMail(text: $0.text) == nil }
      .compactMap(\.createdAt).max()
  }

  private struct StreamShape: Equatable {
    let responding: Bool
    let reasoning: [String]
    let reasoningAfterText: Set<String>
  }

  private struct Presentation {
    let revision: Int
    let transcriptEntries: [Entry]
    let messages: [ChatMessage]
    let forkableMessageIDs: Set<String>
    let partialIsRecorded: Bool
    let liveTimeline: NativeRunTimeline?
    let timeline: NativeChatTimeline
    let visiblePromptAt: Double?
    let latestPromptAt: Double?
    let agentActivity: [NativeWorkItem]
    let stream: StreamShape
  }

  private var presentationRevision = 0
  @ObservationIgnored private var cachedPresentation: Presentation?

  private var presentation: Presentation {
    let revision = presentationRevision
    if let cachedPresentation, cachedPresentation.revision == revision {
      return cachedPresentation
    }
    let currentIDs = Set(entries.map(\.id))
    let transcriptEntries =
      ((inheritedEntries ?? []).filter { !currentIDs.contains($0.id) }
      + entries).sorted { ($0.seq ?? Int.max) < ($1.seq ?? Int.max) }
    let messages = presentedChatMessages(
      transcriptEntries, runs: runPresentations, activeRunID: activeRunID,
      queuedRunIDs: queuedRunIDs, liveActivity: liveActivity, surface: conversation.surface)
    let live = activeRunID.map {
      NativeRunTimeline(
        activity: liveActivity, partial: partial, startOffset: streamStartOffset,
        runID: $0, recorded: messages, finalReply: streamIsFinalReply)
    }
    let timeline = NativeChatTimeline(
      messages: messages + (live?.messages ?? []),
      entries: transcriptEntries + runPresentations.flatMap(\.activity) + liveActivity,
      activeRunID: activeRunID, reasoning: live == nil ? [] : liveReasoning,
      reasoningAfterText: reasoningAfterText,
      streamingMessageID: live?.messages.last?.id)
    let visiblePromptAt = Self.latestPrompt(in: messages)
    let latestPromptAt = [visiblePromptAt, earlierPromptAt].compactMap { $0 }.max()
    let built = Presentation(
      revision: revision, transcriptEntries: transcriptEntries, messages: messages,
      forkableMessageIDs: conversation.isSubagent
        ? []
        : Set(
          NativeForkPoint.points(
            transcriptEntries, inheritedBoundary: conversation.forkBoundarySeq
          ).map(\.id)),
      partialIsRecorded: partialRunID.map { hasRecordedRunReply(entries, runID: $0) } ?? false,
      liveTimeline: live, timeline: timeline, visiblePromptAt: visiblePromptAt,
      latestPromptAt: latestPromptAt,
      agentActivity: timeline.items.compactMap { item in
        guard case .work(let work) = item.content, work.opensAgents else { return nil }
        if item.active { return work }
        guard work.state(active: false) == .complete, let latestPromptAt,
          work.entry.createdAt >= latestPromptAt
        else { return nil }
        return work
      },
      stream: streamShape(live))
    cachedPresentation = built
    return built
  }

  private func streamShape(_ live: NativeRunTimeline?) -> StreamShape {
    guard let live else {
      return StreamShape(responding: false, reasoning: [], reasoningAfterText: [])
    }
    return StreamShape(
      responding: !live.liveText(
        partial, startOffset: streamStartOffset, finalReply: streamIsFinalReply
      ).isEmpty,
      reasoning: liveReasoning.map(\.id), reasoningAfterText: reasoningAfterText)
  }

  private func streamChanged() {
    guard let cached = cachedPresentation, cached.revision == presentationRevision,
      streamShape(cached.liveTimeline) != cached.stream
    else { return }
    presentationRevision += 1
  }

  var transcriptEntries: [Entry] { presentation.transcriptEntries }
  var messages: [ChatMessage] { presentation.messages }
  var forkableMessageIDs: Set<String> { presentation.forkableMessageIDs }
  var latestPromptAt: Double? { presentation.latestPromptAt }
  var liveTimeline: NativeRunTimeline? { presentation.liveTimeline }
  var timeline: NativeChatTimeline { presentation.timeline }
  var agentActivity: [NativeWorkItem] { presentation.agentActivity }

  var pins: [NativeConversationPin] = []
  var draft = ""
  var attachments: [UploadAttachment] = []
  var uploading = false
  var uploadingName: String?
  @ObservationIgnored var attachmentUploadTask: Task<Void, Never>?
  var partial = "" { didSet { streamChanged() } }
  private(set) var liveActivity: [Entry] = [] {
    didSet {
      presentationRevision += 1
      guard !queue.steering.isEmpty else { return }
      queue.settleSteering(
        recorded: Set(
          liveActivity.lazy.filter { $0.payload?.steered == true }.compactMap { $0.payload?.ts }))
    }
  }
  @ObservationIgnored private(set) lazy var queue = QueuedInputsModel(
    client: client, threadRef: conversation.threadRef, scopeID: conversation.scopeId
  ) { [weak self] in await self?.reconcileActivity($0) }
  private(set) var liveReasoning: [RunReasoning] = [] { didSet { streamChanged() } }
  private var reasoningAfterText = Set<String>() { didSet { streamChanged() } }
  private var streamStartOffset = 0 { didSet { streamChanged() } }
  private var streamIsFinalReply = false { didSet { streamChanged() } }
  @ObservationIgnored private var streamState = StreamText()
  private(set) var partialRunID: String? {
    didSet { if partialRunID != oldValue { presentationRevision += 1 } }
  }
  private(set) var runPresentations: [ChatRunPresentation] = [] {
    didSet { presentationRevision += 1 }
  }
  private var queuedRunIDs = Set<String>() {
    didSet { if queuedRunIDs != oldValue { presentationRevision += 1 } }
  }

  var displayedPartial: String {
    let presentation = presentation
    if let live = presentation.liveTimeline {
      return live.liveText(partial, startOffset: streamStartOffset, finalReply: streamIsFinalReply)
    }
    return presentation.partialIsRecorded ? "" : partial
  }

  func reasoningText(_ block: RunReasoning) -> String {
    liveReasoning.first { $0.id == block.id }?.text ?? block.text
  }

  private func publish(_ text: StreamText) {
    partial = text.text
    streamStartOffset = text.startOffset
    streamIsFinalReply = text.isFinalReply
    liveReasoning = text.reasoning
    reasoningAfterText = text.reasoningAfterText
  }
  var workStatus: NativeReadOnlyWorkStatus? {
    if reconnecting { return .reconnecting }
    if approvals.contains(where: \.blocksComposer) { return .awaitingInput }
    if activeRunID != nil { return activeRunStatus == "pending" ? .pending : .working }
    return NativeReadOnlyWorkStatus(conversation: conversation)
  }
  var showsWorkingStatus: Bool { workStatus == .working }
  private(set) var activeRunStatus: String?
  var approvals: [Approval] = []
  private var actionError: String?
  private var syncError: String?
  var error: String? {
    get { actionError ?? syncError }
    set { actionError = newValue }
  }
  var hasActionError: Bool { actionError != nil }
  private var reconnectingStream = false
  private var needsRefresh = false
  var reconnecting: Bool { reconnectingStream || needsRefresh }
  var activeRunID: String? {
    didSet {
      guard activeRunID != oldValue else { return }
      activeRunStatus = nil
      presentationRevision += 1
    }
  }
  var pending: PendingSend?
  var readingSequence: Int?
  var sending = false
  var runtimeSelection: RuntimeSelection?
  var runtimeConfiguration: RuntimeConfiguration?
  var earlierEntries = 0
  var loadingEarlier = false
  var forking = false
  private(set) var goal: Conversation.Goal?
  var cancellingGoal = false
  var detaching = false
  private var visible = false
  let client: APIClient
  private let drafts: DraftStore
  var attachmentAccount: String { drafts.account }
  private var seededTranscript = false
  private var knownSession: Bool
  private var monitor: Task<Void, Never>?
  private var monitoredRunID: String?
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
    goal = conversation.goal
    if let transcript {
      goal = transcript.goal
      entries = transcript.entries
      pins = transcript.pins ?? []
      earlierEntries = transcript.earlierEntries ?? 0
      seededTranscript = true
    }
    drafts = DraftStore(
      account: client.baseURL.absoluteString + user, thread: conversation.threadRef)
    if !conversation.isSubagent {
      let saved = drafts.read()
      draft = saved.text
      runtimeSelection = saved.runtime
      pending = saved.pending
      attachments = saved.pending?.attachments ?? saved.attachments ?? []
    }
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
        var session = transcript.session ?? conversation
        if session.isSubagent {
          let response: ConversationUpdate = try await client.fetch(
            "api/sessions/row", query: [.init(name: "id", value: session.id)])
          guard current == generation, revision == transcriptRevision else { return false }
          session = response.session
        }
        let retained =
          transcript.entries.first?.seq.map { first in
            entries.filter { ($0.seq ?? Int.max) < first }
          } ?? []
        pins = transcript.pins ?? []
        goal = transcript.goal
        conversation = session
        entries = retained + transcript.entries
        hasLoadedTranscript = true
        if let id = activeRunID, completedRunIDs.contains(id),
          hasRecordedRunReply(entries, runID: id)
        {
          recordCompletion(id: id, reply: nil)
          activeRunID = nil
          if partialRunID == id { partial = "" }
        }
        if let partialRunID, completedRunIDs.contains(partialRunID),
          hasRecordedRunReply(entries, runID: partialRunID)
        {
          partial = ""
        }
        let recordedEntryIDs = Set(entries.map(\.id))
        let recordedFailures =
          runPresentations.contains { $0.failure != nil }
          ? Set(chatMessages(entries).lazy.filter { $0.role == "error" }.compactMap(\.runID)) : []
        runPresentations.removeAll { run in
          let failureRecorded =
            run.failure == nil || run.runID.map(recordedFailures.contains) == true
          return failureRecorded
            && (unassociatedReplies.contains(run.id)
              || (run.input?.isRecorded(in: entries) ?? true)
                && (run.reply == nil
                  || run.runID.map {
                    hasRecordedRunReply(entries, runID: $0, includingPosts: false)
                  }
                    == true)
                && run.activity.filter(NativeWorkItem.supports).allSatisfy {
                  recordedEntryIDs.contains($0.id)
                })
        }
        earlierEntries = max(0, (transcript.earlierEntries ?? 0) - retained.count)
        await recoverEarlierPrompt()
        guard current == generation, revision == transcriptRevision else { return false }
        if conversation.canReply {
          let response: ApprovalList = try await client.fetch(
            "api/sessions/\(conversation.id)/approvals")
          guard current == generation, revision == transcriptRevision else { return false }
          approvals = response.approvals
        }
      }
      syncError = nil
      needsRefresh = false
      return knownSession
    } catch {
      if !Task.isCancelled, current == generation, revision == transcriptRevision {
        needsRefresh = recordSyncFailure(error)
      }
      return false
    }
  }

  func resume(refreshInterval: Duration = .seconds(5)) async {
    pause()
    visible = true
    syncError = nil
    let current = generation
    async let activeResponse: QueuedInputsResponse? = fetchActiveRun()
    var restored: Bool
    if seededTranscript {
      seededTranscript = false
      restored = true
      if conversation.canReply {
        do {
          let response: ApprovalList = try await client.fetch(
            "api/sessions/\(conversation.id)/approvals")
          guard current == generation, !Task.isCancelled else { return }
          approvals = response.approvals
        } catch {
          if current == generation, !Task.isCancelled {
            restored = false
            needsRefresh = recordSyncFailure(error)
          }
        }
      }
    } else {
      restored = await refresh()
    }
    guard !Task.isCancelled, current == generation else { return }
    await recoverEarlierPrompt()
    guard !Task.isCancelled, current == generation else { return }
    if !conversation.canReply && !conversation.isSubagent {
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
        follow(id)
      } else if let active, active.runId == nil, activeRunID != nil {
        await reconcileActivity(active)
      } else if restored {
        activeRunID = nil
        partial = ""
      } else if reconnecting {
        retryResume(after: refreshInterval)
      }
    } catch {
      guard current == generation, !Task.isCancelled else { return }
      if recordSyncFailure(error) {
        if let activeRunID {
          follow(activeRunID)
        } else {
          retryResume(after: refreshInterval)
        }
        reconnectingStream = true
      }
    }
  }

  private func retryResume(after interval: Duration) {
    let current = generation
    monitor = Task {
      do { try await Task.sleep(for: interval) } catch { return }
      guard current == generation, visible, client.hasSession, !Task.isCancelled else { return }
      monitor = nil
      await resume(refreshInterval: interval)
    }
  }

  private func fetchActiveRun() async throws -> QueuedInputsResponse? {
    guard conversation.canReply || conversation.isSubagent else { return nil }
    return try await client.fetch(
      "api/runs/active", query: [.init(name: "threadRef", value: conversation.threadRef)])
  }

  func pause() {
    visible = false
    generation = UUID()
    monitor?.cancel()
    monitor = nil
    monitoredRunID = nil
    reconnectingStream = false
  }

  func send() async {
    guard !sending, !uploading, conversation.canReply else { return }
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || !attachments.isEmpty else { return }
    sending = true
    let accountGeneration = client.generation
    var acceptedSubmission: Submission?
    let saved = pending.flatMap { saved in
      saved.text == text && (saved.attachments ?? []) == attachments ? saved : nil
    }
    var submission =
      saved
      ?? PendingSend(
        text: text, idempotencyKey: UUID().uuidString.lowercased(), attachments: attachments,
        runtime: runtimeSelection)
    do {
      try drafts.write(
        .init(
          text: draft, pending: saved, conversation: conversation, attachments: attachments,
          runtime: runtimeSelection))
      var staged: [UploadAttachment] = []
      for attachment in submission.attachments ?? [] {
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
      submission.attachments = staged
      attachments = staged
      try drafts.write(
        .init(
          text: draft, pending: submission, conversation: conversation, attachments: attachments,
          runtime: runtimeSelection))
      var body: [String: Any] = [
        "text": submission.text, "idempotencyKey": submission.idempotencyKey,
        "threadRef": conversation.threadRef, "scopeId": conversation.scopeId,
        "timezone": TimeZone.current.identifier, "midTurn": "queue",
        "attachments": staged.map { attachment -> [String: Any] in
          [
            "name": attachment.name, "mimetype": attachment.mimetype,
            "sizeBytes": attachment.sizeBytes, "blobId": attachment.blobId,
          ]
        },
      ]
      if let runtime = submission.runtime {
        body.merge(runtime.turnOptions) { _, selected in selected }
      }
      pending = submission
      let result: Submission = try await client.fetch("api/turn", body: body)
      if result.runId == nil, result.status == "pending_approval" {
        approvals = result.pendingApprovals ?? approvals
        throw QMError.rejected(
          result.reason ?? "This conversation is waiting on a pending approval.")
      }
      guard result.runId != nil || result.isTerminalResult else {
        throw QMError.message(
          "QM did not confirm this submission. Retry with the saved message key.")
      }
      if let id = result.runId, let accepted = pending {
        if activeRunID == nil || activeRunID == id || result.isTerminalResult {
          updatePresentation(id: id) { presentation in
            presentation.input = RunInput(
              runId: id, seq: nil, text: accepted.text,
              createdAt: Date().timeIntervalSince1970 * 1000,
              attachments: accepted.attachments?.map { .init(name: $0.name) })
          }
        } else if !queue.inputs.contains(where: { $0.runId == id }) {
          let queued = QueuedInput(
            runId: id, text: accepted.text,
            hasAttachments: accepted.attachments?.isEmpty == false ? true : nil)
          queue.apply(.init(runId: activeRunID, queued: queue.inputs + [queued]))
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
    guard !conversation.isSubagent, !sending,
      scope == "once" || (scope == "session" && approval.grantModes?.session == true)
        || (scope == "always" && approval.grantModes?.always == true)
    else { return }
    sending = true
    defer { sending = false }
    do {
      if let askID = approval.credentialAskID {
        let status = try await client.decideCredentialAsk(
          askID, decision: approved ? (scope == "once" ? "once" : "standing") : "deny")
        guard ["approved", "declined", "expired"].contains(status) else {
          throw QMError.message("The credential request is still pending. Try again.")
        }
        approvals.removeAll { $0.id == approval.id }
        error = nil
        return
      }
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
      error = nil
      await reconcileSubmission(response)
    } catch { self.error = error.localizedDescription }
  }

  private func reconcileSubmission(_ result: Submission) async {
    let current = generation
    if result.isTerminalResult {
      recordCompletion(id: result.runId, reply: result.finalReply, failure: result.failure)
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
    if let active {
      queue.apply(active)
      reconcileQueuedPresentations(active)
    }
    let next = active?.runId ?? activeRunID ?? (active == nil ? result.runId : nil)
    if let next { follow(next) }
    let established = generation
    let restored = await refresh()
    guard established == generation, !Task.isCancelled else { return }
    if !restored, let pending = result.pendingApprovals, !pending.isEmpty { approvals = pending }
  }

  private func reconcileQueuedPresentations(_ active: QueuedInputsResponse) {
    queuedRunIDs = Set((active.queued ?? []).map(\.runId))
    runPresentations.removeAll { queuedRunIDs.contains($0.id) && !$0.finished }
  }

  func reconcileActivity(_ active: QueuedInputsResponse) async {
    guard visible, client.hasSession, !Task.isCancelled else { return }
    reconcileQueuedPresentations(active)
    if let id = active.runId, !completedRunIDs.contains(id) {
      guard monitoredRunID != id || monitor != nil else { return }
      let changed = activeRunID != id
      follow(id)
      if changed || needsRefresh { await refresh() }
    } else if active.runId == nil {
      if let id = activeRunID {
        let current = generation
        do {
          let run: Run = try await client.fetch("api/runs/\(id)")
          guard current == generation, !Task.isCancelled else { return }
          if run.isFinished {
            await finish(run, id: id, generation: current)
          } else {
            follow(id)
          }
        } catch {
          handleRunFailure(error, id: id, generation: current)
        }
      } else if monitoredRunID == nil {
        await refresh()
      }
    }
  }

  func stop() async {
    guard !conversation.isSubagent, let id = activeRunID else { return }
    do {
      struct Signal: Decodable { let reason: String? }
      let signal: Signal = try await client.fetch(
        "api/runs/\(id)/signal", body: ["kind": "abort", "threadRef": conversation.threadRef],
        accepting: [409])
      if let reason = signal.reason, reason != "terminal" {
        throw QMError.message("QM could not stop this response (\(reason)).")
      }
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  func cancelGoal() async {
    guard goal != nil, !cancellingGoal else { return }
    cancellingGoal = true
    defer { cancellingGoal = false }
    do {
      struct Outcome: Decodable {
        let cancelled: Bool?
        let error: String?
        let message: String?
      }
      let outcome: Outcome = try await client.fetch(
        "api/sessions/\(conversation.id)/goal/cancel", body: [:], accepting: [409])
      guard outcome.cancelled == true || outcome.error == "no_open_goal" else {
        throw QMError.message(outcome.message ?? "Could not cancel the goal.")
      }
      goal = nil
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  func detach() async {
    guard conversation.isSubagent, !detaching else { return }
    detaching = true
    defer { detaching = false }
    do {
      struct Outcome: Decodable { let detached: Bool? }
      let outcome: Outcome = try await client.fetch(
        "api/sessions/\(conversation.id)/detach", body: [:])
      guard outcome.detached == true else {
        throw QMError.message("QM did not confirm the conversation was detached.")
      }
      let response: ConversationUpdate = try await client.fetch(
        "api/sessions/row", query: [.init(name: "id", value: conversation.id)])
      conversation = response.session
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  func fork(from messageID: String? = nil) async -> Conversation? {
    guard !conversation.isSubagent, !forking else { return nil }
    forking = true
    defer { forking = false }
    do {
      struct Result: Decodable { let session: Conversation }
      let point = messageID.flatMap { id in
        NativeForkPoint.points(transcriptEntries, inheritedBoundary: conversation.forkBoundarySeq)
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
    guard earlierEntries > 0, let first = entries.first?.seq, first > sequence else { return false }
    if let boundary = conversation.forkBoundarySeq, sequence <= boundary,
      transcriptEntries.contains(where: { ($0.seq ?? Int.max) <= sequence })
    {
      return false
    }
    return true
  }

  func loadInheritedHistory() async {
    guard !loadingInherited, inheritedEntries == nil, conversation.forkedFrom != nil,
      let boundary = conversation.forkBoundarySeq, boundary < Int.max
    else { return }
    loadingInherited = true
    defer { loadingInherited = false }
    var before = boundary + 1
    var loaded: [Entry] = []
    do {
      while !Task.isCancelled {
        let page: Transcript = try await client.fetch(
          "api/sessions/\(conversation.id.apiComponent)",
          query: [
            .init(name: "beforeSeq", value: String(before)), .init(name: "tailTurns", value: "25"),
          ])
        guard !Task.isCancelled else { return }
        let inherited = page.entries.filter { ($0.seq ?? Int.max) <= boundary }
        loaded.insert(contentsOf: inherited, at: 0)
        guard (page.earlierEntries ?? 0) > 0, let first = inherited.first?.seq,
          first > 0, first < before
        else { break }
        before = first
      }
      guard !Task.isCancelled else { return }
      inheritedEntries = loaded
      syncError = nil
    } catch {
      if !Task.isCancelled { syncError = error.localizedDescription }
    }
  }

  func loadEarlier() async {
    guard !loadingEarlier, let first = entries.first?.seq else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    let reading = messages.first?.sequence
    do {
      let page: Transcript = try await client.fetch(
        "api/sessions/\(conversation.id)",
        query: [
          .init(name: "beforeSeq", value: String(first)), .init(name: "tailTurns", value: "25"),
        ])
      guard !Task.isCancelled else { return }
      let existing = Set(entries.map(\.id))
      entries.insert(contentsOf: page.entries.filter { !existing.contains($0.id) }, at: 0)
      earlierEntries = page.earlierEntries ?? 0
      readingSequence = reading
      syncError = nil
    } catch {
      if !Task.isCancelled { syncError = error.localizedDescription }
    }
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

  private func recoverEarlierPrompt() async {
    guard presentation.visiblePromptAt == nil, earlierEntries > 0, let first = entries.first?.seq,
      earlierPromptBoundary != first
    else { return }
    let current = generation
    let revision = transcriptRevision
    var before = first
    do {
      while !Task.isCancelled {
        let page: Transcript = try await client.fetch(
          "api/sessions/\(conversation.id.apiComponent)",
          query: [
            .init(name: "beforeSeq", value: String(before)), .init(name: "tailTurns", value: "25"),
          ])
        guard current == generation, revision == transcriptRevision, !Task.isCancelled else {
          return
        }
        if let prompt = Self.latestPrompt(in: chatMessages(page.entries)) {
          earlierPromptAt = prompt
          earlierPromptBoundary = first
          return
        }
        guard (page.earlierEntries ?? 0) > 0, let next = page.entries.first?.seq,
          next > 0, next < before
        else {
          earlierPromptBoundary = first
          return
        }
        before = next
      }
    } catch {
      if !Task.isCancelled { Log.background.failure("Earlier prompt lookup", error) }
    }
  }

  private func recordCompletion(id: String?, reply: String?, failure: String? = nil) {
    if let id {
      completedRunIDs.insert(id)
      updatePresentation(id: id) {
        $0.finished = true
        $0.reply = reply
        $0.failure = failure ?? $0.failure
        if partialRunID == id { $0.activity = liveActivity }
      }
    } else if reply?.isEmpty == false || failure != nil {
      runPresentations.append(
        ChatRunPresentation(
          id: UUID().uuidString, reply: reply, failure: failure, finished: true))
    }
  }

  private func finish(_ run: Run, id: String, generation current: UUID) async {
    guard current == generation, !Task.isCancelled else { return }
    reconnectingStream = false
    completedRunIDs.insert(id)
    if let activity = run.activity { liveActivity = activity }
    if let input = run.input { updatePresentation(id: id) { $0.input = input } }
    let reply = run.finalReply ?? run.partial ?? partial
    recordCompletion(id: id, reply: reply, failure: run.failure)
    if activeRunID == id { activeRunID = nil }
    if partialRunID == id { partial = "" }
    let refreshed = await refresh()
    guard current == generation, !Task.isCancelled else { return }
    if refreshed { syncError = nil }
    if monitoredRunID == id {
      monitor?.cancel()
      monitor = nil
      monitoredRunID = nil
    }
  }

  private func handleRunFailure(_ failure: Error, id: String, generation current: UUID) {
    guard current == generation, !Task.isCancelled, activeRunID == id,
      !completedRunIDs.contains(id)
    else { return }
    Log.background.failure("Run status refresh", failure)
    if recordSyncFailure(failure) {
      reconnectingStream = true
      return
    }
    reconnectingStream = false
    activeRunID = nil
    monitor?.cancel()
    monitor = nil
    monitoredRunID = id
  }

  @discardableResult
  private func recordSyncFailure(_ failure: Error) -> Bool {
    switch failure {
    case QMError.signedOut, QMError.rejected:
      syncError = failure.localizedDescription
    case is DecodingError:
      syncError = "QM returned a response this app couldn’t read. Retry or update the app."
    case is CancellationError:
      return false
    default:
      return true
    }
    return false
  }

  private func follow(_ id: String) {
    guard visible, !completedRunIDs.contains(id) else { return }
    guard monitoredRunID != id || monitor == nil else { return }
    pause()
    visible = true
    let current = generation
    activeRunID = id
    if partialRunID != id {
      partial = ""
      liveActivity = []
      liveReasoning = []
      reasoningAfterText = []
      streamStartOffset = 0
      streamIsFinalReply = false
      streamState = StreamText()
    }
    partialRunID = id
    monitoredRunID = id
    monitor = Task {
      defer {
        if current == generation {
          monitor = nil
        }
      }
      var text = streamState
      while !Task.isCancelled && current == generation {
        do {
          var textChanged = false
          let publisher = Task { @MainActor in
            while !Task.isCancelled {
              do { try await publishTick() } catch { return }
              guard current == generation, !Task.isCancelled else { return }
              if textChanged {
                publish(text)
                textChanged = false
              }
            }
          }
          defer { publisher.cancel() }
          var terminal: Run?
          try await client.stream(id) { event in
            guard current == generation, !Task.isCancelled else { throw CancellationError() }
            try text.apply(event)
            streamState = text
            if event.name == "delta" || event.name == "run" || event.name == "reasoning" {
              textChanged = true
            }
            if let run = event.run { activeRunStatus = run.status }
            if let activity = event.run?.activity { liveActivity = activity }
            if let input = event.run?.input, input.runId == id {
              updatePresentation(id: id) { $0.input = input }
            }
            reconnectingStream = false
            if let run = event.run, run.isFinished {
              terminal = run
              completedRunIDs.insert(id)
              publish(text)
              publisher.cancel()
            }
          }
          publisher.cancel()
          try Task.checkCancellation()
          if let terminal {
            await finish(terminal, id: id, generation: current)
            return
          }
          if textChanged { publish(text) }
        } catch {
          if Task.isCancelled || current != generation { return }
          if case QMError.signedOut = error {
            handleRunFailure(error, id: id, generation: current)
            return
          }
          Log.background.failure("Run stream", error)
          reconnectingStream = true
        }
        do {
          let run: Run = try await client.fetch("api/runs/\(id)")
          guard current == generation, !Task.isCancelled else { return }
          text.apply(run)
          activeRunStatus = run.status
          streamState = text
          if let activity = run.activity { liveActivity = activity }
          if let input = run.input, input.runId == id {
            updatePresentation(id: id) { $0.input = input }
          }
          publish(text)
          reconnectingStream = false
          if run.isFinished {
            await finish(run, id: id, generation: current)
            return
          }
          try await Task.sleep(for: .seconds(2))
        } catch {
          handleRunFailure(error, id: id, generation: current)
          guard current == generation, !Task.isCancelled, activeRunID == id else { return }
          try? await Task.sleep(for: .seconds(3))
        }
      }
    }
  }
}
