import AVFAudio
import SwiftUI

struct ChatView: View {
  @State private var model: ChatModel
  var initialSequence: Int? = nil
  var showsConversations = false
  var onShowConversations: (() -> Void)?
  @State private var targetSequence: Int?
  @State private var pinsExpanded = false
  @State private var dictation: NativeDictationModel
  @State private var suggestions: NativeSuggestedActivitiesModel
  @State private var inheritedExpanded = false
  @Environment(\.scenePhase) private var phase
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.qmIdentity) private var identity
  @Environment(AppModel.self) private var app: AppModel?
  @State private var approvalToConfirm: Approval?
  @State private var showingRuntime = false
  @State private var showingAgents = false
  @State private var openedConversation: Conversation?
  @State private var startingSideChat = false
  @State private var followsLatest = true
  @State private var previewingAttachment: UploadAttachment?
  @State private var stopping = false
  @State private var retryingHistory = false
  @State private var forkingMessageID: String?
  @State private var approvalSubmission: (id: String, approved: Bool)?
  @State private var showingWorkers = false
  @State private var swarm: SwarmModel?
  @FocusState private var composerFocused: Bool

  init(
    model: ChatModel, initialSequence: Int? = nil, showsConversations: Bool = false,
    onShowConversations: (() -> Void)? = nil
  ) {
    self.showsConversations = showsConversations
    self.onShowConversations = onShowConversations
    _model = State(initialValue: model)
    _dictation = State(
      initialValue: NativeDictationModel(provider: OnDeviceSpeechToTextProvider()))
    _suggestions = State(initialValue: NativeSuggestedActivitiesModel(client: model.client))
    self.initialSequence = initialSequence
    _targetSequence = State(initialValue: initialSequence)
    _followsLatest = State(initialValue: initialSequence == nil)
    _inheritedExpanded = State(initialValue: initialSequence != nil)
  }

  private var canSend: Bool {
    (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !model.attachments.isEmpty)
      && !dictation.busy && !model.sending && !model.uploading
      && !model.approvals.contains(where: \.blocksComposer)
  }

  private func transcriptScroll(width: CGFloat, proxy: ScrollViewProxy) -> some View {
    ScrollView {
      transcript
        .frame(width: min(width, QMTheme.conversationWidth), alignment: .leading)
        .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: TranscriptGeometry.self) { geometry in
      TranscriptGeometry(
        contentHeight: geometry.contentSize.height, viewportHeight: geometry.containerSize.height,
        nearLatest: geometry.contentSize.height + geometry.contentInsets.bottom
          - geometry.visibleRect.maxY <= 44)
    } action: { previous, current in
      if followsLatest, !current.nearLatest, current.sizeChanged(since: previous) {
        proxy.scrollTo("transcript", anchor: .bottom)
      } else {
        followsLatest = current.nearLatest
      }
    }
    .defaultScrollAnchor(initialSequence == nil ? .bottom : .top, for: .initialOffset)
    .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
    .defaultScrollAnchor(.top, for: .alignment)
    .overlay(alignment: .bottomTrailing) { jumpToLatest(proxy) }
    .onChange(of: inheritedExpanded) { _, expanded in
      if expanded { proxy.scrollTo("fork-origin", anchor: .top) }
    }
    .onChange(of: composerFocused) { _, focused in
      if focused {
        showingAgents = false
      }
    }
    .task(id: model.transcriptEntries.count) { await position(proxy) }
    .onChange(of: targetSequence) { _, target in
      if target != nil { Task { await position(proxy) } }
    }
    .onChange(of: model.readingSequence) { _, reading in
      guard let reading else { return }
      model.readingSequence = nil
      if targetSequence == nil, !followsLatest { targetSequence = reading }
    }
  }

  private func position(_ proxy: ScrollViewProxy) async {
    guard let targetSequence, !model.transcriptEntries.isEmpty else { return }
    if model.needsEarlierHistory(for: targetSequence) {
      await model.loadEarlier()
      return
    }
    let messages = model.messages
    let target =
      messages.last {
        ($0.sequence ?? Int.max) <= targetSequence
      } ?? messages.first
    if let target {
      proxy.scrollTo(target.id, anchor: .top)
      self.targetSequence = nil
    }
  }

  var body: some View {
    ScrollViewReader { proxy in
      GeometryReader { geometry in
        transcriptScroll(width: geometry.size.width, proxy: proxy)
          .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar(proxy)
          }
      }
    }
    .background(QMTheme.paper)
    .toolbarBackground(QMTheme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .environment(\.qmSessionID, model.conversation.id)
    .navigationTitle(model.conversation.label)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { conversationToolbar }
    .navigationDestination(item: $openedConversation) { conversation in
      ChatView(
        model: ChatModel(
          conversation: conversation, client: model.client, user: model.user, knownSession: true))
    }
    .sheet(item: $previewingAttachment) { attachment in
      FilePreviewSheet(
        attachment: attachment, account: model.attachmentAccount, client: model.client)
    }
    .onChange(of: model.client.generation) { model.cancelAttachmentUpload() }
    .sheet(isPresented: $showingWorkers) {
      if let swarm { NavigationStack { NativeSwarmWorkers(model: swarm) } }
    }
    .task(id: model.activeRunID) {
      if swarm == nil, model.conversation.localOnly != true {
        swarm = SwarmModel(client: model.client, sessionID: model.conversation.id)
      }
      await swarm?.load()
    }
    .confirmationDialog(
      approvalToConfirm?.isCredential == true ? "Share this credential?" : "Allow this action?",
      isPresented: Binding(
        get: { approvalToConfirm != nil }, set: { if !$0 { approvalToConfirm = nil } }),
      presenting: approvalToConfirm
    ) { approval in
      approvalChoices(approval)
    } message: { approval in
      Text(approval.command)
    }
    .task {
      if model.conversation.canReply { await model.loadRuntime() }
    }
    .onChange(of: showingAgents) { _, expanded in
      if expanded, dictation.busy {
        showingAgents = false
        return
      }
      if expanded { composerFocused = false }
    }
    .onChange(of: dictation.completedText) { _, text in
      if let text {
        model.draft = NativeDictationModel.appending(text, to: model.draft)
        model.saveDraft()
        composerFocused = true
      }
    }
    .onChange(of: showsConversations) { _, showing in
      if showing {
        composerFocused = false
        showingAgents = false
        dictation.stop()
      }
    }
    .onChange(of: phase) { _, phase in
      if phase == .background {
        showingAgents = false
        dictation.cancel()
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) {
      notification in
      if notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        == AVAudioSession.InterruptionType.began.rawValue
      {
        dictation.stop()
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) {
      notification in
      if notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
        dictation.state == .recording
      {
        dictation.stop()
      }
    }
    .onChange(of: model.draft) { _, _ in model.saveDraft() }
    .onChange(of: model.attachments) { _, _ in model.saveDraft() }
    .task(id: phase == .background) {
      if phase != .background { await model.resume() } else { model.pause() }
    }
    .task(id: phase == .background) {
      if phase != .background, model.conversation.canReply || model.conversation.isSubagent {
        await model.queue.poll()
      } else {
        model.queue.stop()
      }
    }
    .onDisappear {
      showingAgents = false
      dictation.cancel()
      model.pause()
      model.cancelAttachmentUpload()
      model.queue.stop()
      app?.left(model.conversation.threadRef)
    }
  }

  @ToolbarContentBuilder
  private var conversationToolbar: some ToolbarContent {
    if let onShowConversations {
      ToolbarItem(placement: .topBarLeading) {
        Button(action: onShowConversations) {
          Image(systemName: "chevron.left")
        }
        .accessibilityLabel("Conversations")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if model.conversation.localOnly != true {
          Button("Agents", systemImage: "point.3.connected.trianglepath.dotted") {
            composerFocused = false
            showingAgents = true
          }
        }
        if model.conversation.surface == "web", model.conversation.canReply {
          NavigationLink {
            VoiceView(client: model.client, conversation: model.conversation)
          } label: {
            Label("Talk to QM", systemImage: "waveform")
          }
        }
        if model.conversation.canReply {
          Button("Model and effort", systemImage: "slider.horizontal.3") { showingRuntime = true }
        }
        if swarm?.view != nil {
          Button("Workers", systemImage: "person.3") {
            composerFocused = false
            showingWorkers = true
          }
        }
        if model.conversation.isSubagent {
          Button("Make top-level conversation", systemImage: "arrow.up.forward.square") {
            Task { await model.detach() }
          }
          .disabled(model.detaching)
        }
        if !model.conversation.isSubagent {
          NavigationLink {
            NativeConversationTools(model: model)
          } label: {
            Label("All conversation tools", systemImage: "rectangle.3.group")
          }
          .disabled(model.conversation.localOnly == true)
        } else {
          NavigationLink("Activity log") { NativeActivityView(model: model) }
        }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .accessibilityLabel("Conversation controls")
    }
    if composerFocused {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          composerFocused = false
        } label: {
          Image(systemName: "keyboard.chevron.compact.down")
        }
        .accessibilityLabel("Dismiss keyboard")
      }
    }
    if model.conversation.canReply, model.activeRunID != nil,
      !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !model.attachments.isEmpty
    {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await stop() }
        } label: {
          Image(systemName: "stop.circle")
            .modifier(NativeLoadingPulse(active: stopping))
        }
        .accessibilityLabel(stopping ? "Stopping response" : "Stop response")
        .disabled(stopping)
      }
    }
  }

  @ViewBuilder
  private func jumpToLatest(_ proxy: ScrollViewProxy) -> some View {
    if !followsLatest {
      Button {
        targetSequence = nil
        proxy.scrollTo("transcript", anchor: .bottom)
      } label: {
        Image(systemName: "arrow.down")
          .font(.system(size: 18, weight: .semibold)).frame(width: 44, height: 44)
          .background(QMTheme.paper, in: Circle())
          .overlay(Circle().strokeBorder(QMTheme.border))
          .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
      }
      .accessibilityLabel("Jump to latest message")
      .padding(16)
    }
  }

  @ViewBuilder
  private func approvalChoices(_ approval: Approval) -> some View {
    Button("Approve once") { Task { await decide(approval, approved: true) } }
    if approval.grantModes?.session == true {
      Button("Allow for this session") {
        Task { await decide(approval, approved: true, scope: "session") }
      }
    }
    if approval.grantModes?.always == true {
      Button(
        approval.isCredential ? "Always allow this credential" : "Always allow matching actions"
      ) {
        Task { await decide(approval, approved: true, scope: "always") }
      }
    }
  }

  @ViewBuilder
  private var pinsSection: some View {
    if !model.pins.isEmpty {
      NativeDisclosureRow(expanded: pinsExpanded) {
        pinsExpanded.toggle()
      } label: {
        Label("Pinned (\(model.pins.count))", systemImage: "pin")
          .font(.subheadline).foregroundStyle(.secondary)
      }
      if pinsExpanded {
        ForEach(model.pins) { pin in
          VStack(alignment: .leading, spacing: 6) {
            Text(pin.text ?? pin.preview ?? "Pinned message").textSelection(.enabled)
            if pin.text != nil, let preview = pin.preview {
              Text(preview).font(.caption).foregroundStyle(.secondary)
            }
            if let sequence = pin.entrySeq {
              Button("Go to message") {
                followsLatest = false
                targetSequence = sequence
              }
            }
          }.padding(.vertical, 6)
        }
      }
    }
  }

  @ViewBuilder
  private var forkOrigin: some View {
    if let origin = model.conversation.forkedFrom, model.conversation.forkBoundarySeq != nil {
      VStack(alignment: .leading, spacing: 12) {
        NavigationLink {
          NativeConversationDestination(
            client: model.client, user: model.user, sessionID: origin.sessionId)
        } label: {
          Label("Forked from \(origin.label)", systemImage: "arrow.triangle.branch")
            .font(.subheadline).multilineTextAlignment(.leading)
        }
        Button {
          inheritedExpanded.toggle()
          if inheritedExpanded {
            Task { await model.loadInheritedHistory() }
          }
        } label: {
          HStack {
            NativeActionLabel(
              title: inheritedExpanded ? "Hide earlier history" : "Show earlier history",
              busyTitle: "Loading earlier history…", busy: model.loadingInherited)
            Spacer()
            if !model.loadingInherited {
              Image(systemName: inheritedExpanded ? "chevron.up" : "chevron.down")
            }
          }.font(.footnote)
        }.disabled(model.loadingInherited)
      }
      .padding(14)
      .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 14))
      .id("fork-origin")
    }
  }

  private func approvalCard(_ approval: Approval) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(
        approval.isCredential ? "Credential request" : "Approval needed",
        systemImage: approval.isCredential ? "key.fill" : "hand.raised.fill"
      ).font(.headline)
      if let summary = approval.summary ?? approval.purpose ?? approval.reason {
        Text(summary)
      }
      Text(approval.command).font(.system(.footnote, design: .monospaced)).textSelection(
        .enabled)
      HStack {
        Button(role: .destructive) {
          Task { await decide(approval, approved: false) }
        } label: {
          NativeActionLabel(
            title: "Deny", busyTitle: "Denying…",
            busy: approvalSubmission?.id == approval.id && approvalSubmission?.approved == false)
        }
        Spacer()
        Button {
          approvalToConfirm = approval
        } label: {
          NativeActionLabel(
            title: "Approve once", busyTitle: "Approving…",
            busy: approvalSubmission?.id == approval.id && approvalSubmission?.approved == true)
        }.buttonStyle(.borderedProminent)
      }.disabled(model.sending)
    }.padding().background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
  }

  @State private var workDisclosure = NativeWorkDisclosureState()

  private func stop() async {
    guard !stopping else { return }
    stopping = true
    defer { stopping = false }
    await model.stop()
  }

  private func decide(_ approval: Approval, approved: Bool, scope: String = "once") async {
    guard !model.sending else { return }
    approvalSubmission = (approval.id, approved)
    defer { approvalSubmission = nil }
    await model.decide(approval, approved: approved, scope: scope)
  }

  private func fork(from messageID: String) async {
    guard !model.forking else { return }
    forkingMessageID = messageID
    defer { forkingMessageID = nil }
    openedConversation = await model.fork(from: messageID)
  }

  private func askAbout(_ message: ChatMessage) async {
    guard !startingSideChat else { return }
    startingSideChat = true
    defer { startingSideChat = false }
    do {
      openedConversation = try await NativeSideChat.start(
        client: model.client, sessionID: model.conversation.id, about: message)
    } catch { model.error = error.localizedDescription }
  }

  private func retryHistory() async {
    guard !retryingHistory else { return }
    retryingHistory = true
    defer { retryingHistory = false }
    await model.resume()
  }

  var showsInitialHistoryPlaceholder: Bool {
    !model.hasLoadedTranscript && (model.error == nil || retryingHistory)
      && model.activeRunID == nil
      && model.transcriptEntries.isEmpty && model.messages.isEmpty
      && model.displayedPartial.isEmpty && model.pending == nil && !model.sending
  }

  private var transcript: some View {
    let messages = model.messages
    let liveTimeline = model.liveTimeline
    let forkable = model.forkableMessageIDs
    let timeline = model.timeline.items
    let inherited = timeline.filter { $0.isInherited(in: model.conversation) }
    let current = timeline.filter { !$0.isInherited(in: model.conversation) }
    let visible = inheritedExpanded ? inherited + current : current
    let sections = NativeChatTranscriptSection.grouped(
      visible, activeRunID: model.activeRunID, status: model.workStatus)
    let showSpeakers =
      model.conversation.isShared
      || Set(messages.filter { $0.role == "user" }.compactMap(\.speaker)).count > 1
    return VStack(alignment: .leading, spacing: 16) {
      Group {
        pinsSection
        forkOrigin
        if model.earlierItems > 0,
          inheritedExpanded || model.conversation.forkBoundarySeq == nil
            || model.earlierItems > (model.conversation.forkBoundarySeq ?? -1) + 1
        {
          Button {
            Task { await model.loadEarlier() }
          } label: {
            NativeActionLabel(
              title: "Load earlier messages",
              busyTitle: targetSequence != nil
                ? "Loading selected message…" : "Loading earlier messages…",
              busy: model.loadingEarlier)
          }.disabled(model.loadingEarlier)
        }
        if showsInitialHistoryPlaceholder {
          NativeChatHistoryPlaceholder()
        } else if model.hasLoadedTranscript && model.transcriptEntries.isEmpty
          && model.earlierItems == 0 && visible.isEmpty && model.displayedPartial.isEmpty
          && model.activeRunID == nil && model.pending == nil && model.workStatus == nil
        {
          ContentUnavailableView {
            Text("What shall we work on?")
          } description: {
            Text("Ask a question or hand off a task.")
          }
          .padding(.top, 60)
          if model.draft.isEmpty, model.attachments.isEmpty, model.conversation.canReply,
            let identity, !model.conversation.isShared
          {
            NativeSuggestedActivities(model: suggestions, identity: identity) { activity in
              guard model.draft.isEmpty else { return }
              model.draft = activity.prompt
              model.saveDraft()
              composerFocused = true
            }
          }
        }
        ForEach(sections) { section in
          VStack(alignment: .leading, spacing: 16) {
            if inheritedExpanded, !inherited.isEmpty, section.items.first?.id == current.first?.id {
              HStack {
                Rectangle().frame(height: 1)
                Text("This conversation").font(.caption).fixedSize()
                Rectangle().frame(height: 1)
              }.foregroundStyle(.secondary)
            }
            if section.isActivity {
              NativeTimelineActivityGroup(
                section: section, client: model.client, user: model.user,
                disclosure: workDisclosure,
                reasoningText: model.reasoningText,
                onShowAgents: {
                  composerFocused = false
                  showingAgents = true
                },
                onInspect: { followsLatest = false })
            } else if let item = section.items.first {
              timelineRow(item, showSpeakers: showSpeakers, forkable: forkable)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .id(section.id)
        }
        if liveTimeline == nil, !model.displayedPartial.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            MessageMarkdown(text: model.displayedPartial, client: model.client)
          }.accessibilityIdentifier("streamingResponse")
        }
        if model.conversation.canReply {
          ForEach(model.approvals) { approval in approvalCard(approval) }
        }
      }
      .padding(.horizontal, 16)
    }
    .padding(.vertical, 20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .id("transcript")
  }

  private func displayed(_ message: ChatMessage, streaming: Bool) -> ChatMessage {
    guard streaming else { return message }
    var message = message
    message.text = model.displayedPartial
    return message
  }

  @ViewBuilder private func timelineRow(
    _ item: NativeChatTimelineItem, showSpeakers: Bool, forkable: Set<String>
  ) -> some View {
    switch item.content {
    case .message(let message):
      NativeChatMessageView(
        message: displayed(message, streaming: item.streaming), client: model.client,
        showSpeaker: showSpeakers, user: model.user,
        conversationID: model.conversation.id,
        onFork: !model.conversation.isSubagent && forkable.contains(message.id) && !model.forking
          ? { Task { await fork(from: message.id) } } : nil,
        onAskAbout: !model.conversation.isSubagent && model.conversation.localOnly != true
          ? { message in Task { await askAbout(message) } } : nil,
        forking: forkingMessageID == message.id, streaming: item.streaming
      )
      .accessibilityIdentifier(item.streaming ? "streamingResponse" : "message-\(item.id)")
    case .work, .reasoning:
      EmptyView()
    }
  }

  private func bottomBar(_ proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 0) {
      if model.conversation.localOnly != true {
        NativeAgentTrail(
          client: model.client, user: model.user, conversationID: model.conversation.id,
          promptStartedAt: model.latestPromptAt,
          agentActivity: model.agentActivity,
          isExpanded: $showingAgents,
          onOpen: { conversation in
            showingAgents = false
            composerFocused = false
            openedConversation = conversation
          }
        )
        .disabled(dictation.busy)
      }
      bottomControls(proxy)
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .frame(maxWidth: QMTheme.conversationWidth)
    .frame(maxWidth: .infinity)
    // As on web, the transcript runs 16pt behind the composer's top edge before the bar
    // turns opaque.
    .background(QMTheme.paper.padding(.top, 28).ignoresSafeArea(.container, edges: .bottom))
  }

  private func bottomControls(_ proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 0) {
      if let parent = model.conversation.parentSessionId, !parent.isEmpty {
        NavigationLink {
          NativeConversationDestination(client: model.client, user: model.user, sessionID: parent)
        } label: {
          HStack(spacing: 10) {
            NativeAgentAvatar(
              sessionID: model.conversation.id,
              returned: model.conversation.working != true
                && model.conversation.awaitingInput != true
                && model.conversation.lastTurnFailed != true
            )
            .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 3) {
              Text("Read-only agent").font(.subheadline.weight(.medium))
              Text("Open parent conversation").font(.caption).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.left").font(.subheadline)
          }
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .accessibilityHint(
          "This agent updates automatically. View the conversation that delegated this work."
        )
        .accessibilityIdentifier("agentReadOnlyNotice")
        .padding(.bottom, 10)
      }
      if model.conversation.canReply, !dictation.busy {
        NativeSkillSuggestions(client: model.client, draft: $model.draft).disabled(model.sending)
      }
      if model.conversation.canReply, !composerFocused, !dictation.busy {
        QueuedRunsView(model: model.queue)
      }
      if let error = model.error {
        HStack {
          Text(error).font(.footnote).foregroundStyle(.red)
          if model.hasActionError {
            Button("Dismiss") { model.error = nil }
          } else {
            Button {
              Task { await retryHistory() }
            } label: {
              NativeActionLabel(title: "Retry", busyTitle: "Retrying…", busy: retryingHistory)
            }.disabled(retryingHistory)
          }
        }
        .padding(.bottom, 10)
      }
      if let goal = model.goal {
        HStack(spacing: 10) {
          Image(systemName: goal.paused ? "pause.circle" : "target").font(.footnote)
          VStack(alignment: .leading, spacing: 2) {
            Text(goal.paused ? "Goal paused" : "Pursuing goal")
              .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(goal.objective).font(.footnote).lineLimit(1)
          }
          Spacer(minLength: 0)
          Button {
            Task { await model.cancelGoal() }
          } label: {
            NativeActionLabel(
              title: "Cancel goal", busyTitle: "Cancelling…", busy: model.cancellingGoal
            ).font(.footnote)
          }
          .disabled(model.cancellingGoal)
        }
        .padding(.horizontal, 12).frame(minHeight: 44)
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
        .padding(.bottom, 10)
        .accessibilityIdentifier("goalStrip")
      }
      if model.conversation.canReply, !model.attachments.isEmpty, !dictation.busy {
        ScrollView(.horizontal) {
          HStack {
            ForEach(model.attachments) { attachment in
              HStack(spacing: 8) {
                Button {
                  composerFocused = false
                  previewingAttachment = attachment
                } label: {
                  Label(
                    attachment.name,
                    systemImage: attachment.mimetype.hasPrefix("image/") ? "photo" : "doc"
                  )
                  .lineLimit(1).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Preview \(attachment.name)")
                Button {
                  model.attachments.removeAll { $0.id == attachment.id }
                } label: {
                  Image(systemName: "xmark.circle.fill")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }.accessibilityLabel("Remove \(attachment.name)")
                  .disabled(model.sending)
              }
              .font(.footnote).padding(.leading, 12).padding(.trailing, 4)
              .frame(minHeight: 44).background(QMTheme.surface, in: Capsule())
            }
          }
        }
        .padding(.bottom, 10)
      }
      if model.conversation.canReply {
        composer(proxy)
      } else if !model.conversation.isSubagent {
        NativeSlackReplyBar(client: model.client, conversation: model.conversation) {
          if let url = model.conversation.slackURL(workspaceURL: identity?.slackWorkspaceUrl) {
            Link(destination: url) {
              NativeServiceLabel(title: "Open in Slack", service: "slack")
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
          } else if model.conversation.isSlackThread {
            NativeServiceLabel(title: "Continue this conversation in Slack.", service: "slack")
              .font(.footnote).foregroundStyle(.secondary)
          } else {
            Text("This conversation is read-only here.").font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .id(model.conversation.id)
      }
    }
  }

  private func send(_ proxy: ScrollViewProxy) {
    showingAgents = false
    composerFocused = false
    targetSequence = nil
    proxy.scrollTo("transcript", anchor: .bottom)
    Task { await model.send() }
  }

  private func composer(_ proxy: ScrollViewProxy) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if dictation.busy {
        NativeDictationComposer(model: dictation)
      } else {
        composerTextField
        if let error = dictation.error {
          NativeAudioPermissionNotice(message: error, permission: dictation.permissionError)
            .padding(.horizontal, 8)
        }
        if model.uploading, let uploadingName = model.uploadingName {
          NativeChatUploadStatus(filename: uploadingName)
            .padding(.horizontal, 8)
        }
        HStack(spacing: 6) {
          AttachmentPicker(
            uploading: model.uploading, error: $model.error, onSelect: model.addAttachments
          ).disabled(model.sending)
          if !dynamicTypeSize.isAccessibilitySize || verticalSizeClass == .compact { modelSelector }
          Spacer(minLength: 0)
          Button {
            composerFocused = false
            dictation.start()
          } label: {
            Image(systemName: "mic")
              .font(.system(size: 21)).frame(width: 44, height: 44)
              .foregroundStyle(QMTheme.ink)
          }
          .accessibilityLabel("Dictate message")
          .disabled(model.sending)
          if model.activeRunID != nil,
            model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            model.attachments.isEmpty
          {
            Button {
              Task { await stop() }
            } label: {
              Image(systemName: "stop.fill")
                .font(.system(size: 15, weight: .semibold))
                .modifier(NativeLoadingPulse(active: stopping))
                .foregroundStyle(QMTheme.paper)
                .frame(width: 44, height: 44)
                .background(QMTheme.ink, in: Circle())
            }.accessibilityLabel(stopping ? "Stopping response" : "Stop response")
              .disabled(stopping)
          } else {
            Button {
              send(proxy)
            } label: {
              ComposerSendLabel(enabled: canSend, sending: model.sending)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.sending)
            }
            .accessibilityLabel(model.activeRunID == nil ? "Send message" : "Queue message")
            .disabled(!canSend)
          }
        }
        if dynamicTypeSize.isAccessibilitySize && verticalSizeClass != .compact { modelSelector }
      }
    }
    .padding(8)
    .composerChrome()
  }

  private var composerTextField: some View {
    TextField(
      model.activeRunID == nil ? "Message QM" : "Queue a message", text: $model.draft,
      axis: .vertical
    )
    .lineLimit(
      1...(verticalSizeClass == .compact ? 1 : dynamicTypeSize.isAccessibilitySize ? 3 : 8)
    )
    .padding(.horizontal, 8).padding(.top, 8)
    .focused($composerFocused)
    .disabled(model.sending)
    .accessibilityIdentifier("composer")
  }

  private var modelSelector: some View {
    Button {
      showingRuntime = true
    } label: {
      HStack(spacing: 5) {
        Text(model.runtimeLabel).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
      }
      .font(.footnote.weight(.medium))
      .padding(.horizontal, 8).frame(minHeight: 44)
    }
    .popover(isPresented: $showingRuntime, arrowEdge: .bottom) {
      NavigationStack {
        RuntimeControlsView(
          client: model.client, scopeID: model.conversation.scopeId, showsCancel: true,
          selected: model.runtimeSelection, onSelect: model.selectRuntime)
      }
      .frame(width: 340, height: 390)
      .presentationCompactAdaptation(.popover)
    }
    .accessibilityLabel("Model and effort: \(model.runtimeLabel)")
    .accessibilityValue(model.runtimeDetail ?? "Workspace default")
    .disabled(model.sending)
  }

}

extension View {
  func composerChrome() -> some View {
    background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 24))
      .shadow(color: .black.opacity(0.08), radius: 12, y: 3)
      .overlay {
        RoundedRectangle(cornerRadius: 24).strokeBorder(QMTheme.border, lineWidth: 1)
      }
  }
}

struct ComposerSendLabel: View {
  let enabled: Bool
  var sending = false

  var body: some View {
    Group {
      if sending {
        NativeWave().foregroundStyle(QMTheme.paper)
          .transition(.opacity.combined(with: .scale(scale: 0.8)))
      } else {
        Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold))
          .transition(.opacity.combined(with: .scale(scale: 0.8)))
      }
    }
    .foregroundStyle(QMTheme.paper)
    .frame(width: 44, height: 44)
    .background(QMTheme.ink.opacity(enabled ? 1 : 0.25), in: Circle())
  }
}

private struct TranscriptGeometry: Equatable {
  let contentHeight: CGFloat
  let viewportHeight: CGFloat
  let nearLatest: Bool

  func sizeChanged(since previous: Self) -> Bool {
    contentHeight != previous.contentHeight || viewportHeight != previous.viewportHeight
  }
}
