import AVFAudio
import SwiftUI

struct ChatView: View {
  @State var model: ChatModel
  var initialSequence: Int? = nil
  @State private var positionedSearch = false
  @State private var dictation: NativeDictationModel
  @State private var inheritedExpanded = false
  @Environment(\.scenePhase) private var phase
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.qmIdentity) private var identity
  @State private var approvalToConfirm: Approval?
  @State private var showingRuntime = false
  @State private var forkedConversation: Conversation?
  @State private var followsLatest = true
  @State private var nearLatest = true
  @State private var scrollPhase = ScrollPhase.idle
  @FocusState private var composerFocused: Bool

  init(model: ChatModel, initialSequence: Int? = nil) {
    _model = State(initialValue: model)
    _dictation = State(
      initialValue: NativeDictationModel(provider: QMSpeechToTextProvider(client: model.client)))
    self.initialSequence = initialSequence
    _followsLatest = State(initialValue: initialSequence == nil)
    _inheritedExpanded = State(initialValue: initialSequence != nil)
  }

  private var canSend: Bool {
    (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !model.attachments.isEmpty)
      && !dictation.busy && !model.sending && !model.uploading
      && !model.approvals.contains(where: \.blocksComposer)
  }

  var body: some View {
    let messages = model.messages
    ScrollViewReader { proxy in
      ScrollView {
        transcript
      }
      .scrollDismissesKeyboard(.interactively)
      .scrollClipDisabled()
      .onScrollPhaseChange { previous, phase in
        scrollPhase = phase
        if phase == .interacting { followsLatest = false }
        if phase == .idle, previous == .interacting || previous == .decelerating {
          followsLatest = nearLatest
        }
      }
      .onChange(of: inheritedExpanded) { _, expanded in
        if expanded { proxy.scrollTo("fork-origin", anchor: .top) }
      }
      .onChange(of: messages.last?.id) { _, _ in
        if followsLatest { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      .onChange(of: composerFocused) { _, focused in
        if focused, followsLatest { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      .overlay(alignment: .bottomTrailing) { jumpToLatest(proxy) }
      .defaultScrollAnchor(initialSequence == nil ? .bottom : .top, for: .initialOffset)
      .defaultScrollAnchor(
        followsLatest ? .bottom : nil, for: .sizeChanges
      )
      .defaultScrollAnchor(.top, for: .alignment)
      .task(id: model.transcriptItems.count) {
        guard let initialSequence, !positionedSearch, !model.transcriptItems.isEmpty else {
          return
        }
        if model.needsEarlierHistory(for: initialSequence) {
          await model.loadEarlier()
          return
        }
        let messages = model.messages
        let target =
          messages.last {
            ($0.sequence ?? Int.max) <= initialSequence
          } ?? messages.first
        if let target {
          proxy.scrollTo(target.id, anchor: .top)
          positionedSearch = true
        }
      }
    }
    .background(QMTheme.paper)
    .toolbarBackground(QMTheme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .environment(\.qmSessionID, model.conversation.id)
    .navigationTitle(model.conversation.label)
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .toolbar { conversationToolbar }
    .navigationDestination(item: $forkedConversation) { conversation in
      ChatView(
        model: ChatModel(
          conversation: conversation, client: model.client, user: model.user, knownSession: true))
    }
    .confirmationDialog(
      "Allow this action?",
      isPresented: Binding(
        get: { approvalToConfirm != nil }, set: { if !$0 { approvalToConfirm = nil } }),
      presenting: approvalToConfirm
    ) { approval in
      approvalChoices(approval)
    } message: { approval in
      Text(approval.command)
    }
    .task { await model.loadRuntime() }
    .onChange(of: dictation.completedText) { _, text in
      if let text {
        model.draft = NativeDictationModel.appending(text, to: model.draft)
        model.saveDraft()
        composerFocused = true
      }
    }
    .onDisappear { dictation.cancel() }
    .onChange(of: phase) { _, phase in if phase == .background { dictation.cancel() } }
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
    .task(id: phase) { if phase == .active { await model.resume() } else { model.pause() } }
    .onDisappear { model.pause() }
  }

  @ToolbarContentBuilder
  private var conversationToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if model.conversation.surface == "web" {
          NavigationLink {
            VoiceView(client: model.client, conversation: model.conversation)
          } label: {
            Label("Talk to QM", systemImage: "waveform")
          }
        }
        Button("Model and effort", systemImage: "slider.horizontal.3") { showingRuntime = true }
        NavigationLink {
          NativeConversationTools(model: model)
        } label: {
          Label("All conversation tools", systemImage: "rectangle.3.group")
        }
        .disabled(model.conversation.localOnly == true)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .accessibilityLabel("Conversation controls")
    }
    if model.activeRunID != nil,
      !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !model.attachments.isEmpty
    {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Stop", systemImage: "stop.circle") { Task { await model.stop() } }
      }
    }
  }

  @ViewBuilder
  private func jumpToLatest(_ proxy: ScrollViewProxy) -> some View {
    if !nearLatest, !model.messages.isEmpty {
      Button {
        followsLatest = true
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
      } label: {
        Image(systemName: "arrow.down")
          .font(.body.weight(.semibold)).frame(width: 44, height: 44)
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
    Button("Approve once") { Task { await model.decide(approval, approved: true) } }
    if approval.grantModes?.session == true {
      Button("Allow for this session") {
        Task { await model.decide(approval, approved: true, scope: "session") }
      }
    }
    if approval.grantModes?.always == true {
      Button("Always allow matching actions") {
        Task { await model.decide(approval, approved: true, scope: "always") }
      }
    }
  }

  @ViewBuilder
  private var pinsSection: some View {
    if !model.pins.isEmpty {
      DisclosureGroup("Pinned in this conversation (\(model.pins.count))") {
        ForEach(model.pins) { pin in
          VStack(alignment: .leading, spacing: 6) {
            Text(pin.text ?? pin.preview ?? "Pinned message").textSelection(.enabled)
            if pin.text != nil, let preview = pin.preview {
              Text(preview).font(.caption).foregroundStyle(.secondary)
            }
            if let sequence = pin.entrySeq {
              NavigationLink("View pinned message") {
                NativeConversationDestination(
                  client: model.client, user: model.user, sessionID: model.conversation.id,
                  initialSequence: sequence)
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
          followsLatest = false
          inheritedExpanded.toggle()
          if inheritedExpanded {
            Task { await model.loadInheritedHistory() }
          }
        } label: {
          HStack {
            Text(inheritedExpanded ? "Hide earlier history" : "Show earlier history")
            Spacer()
            if model.loadingInherited {
              NativeWave()
            } else {
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
      Label("Approval needed", systemImage: "hand.raised.fill").font(.headline)
      if let summary = approval.summary ?? approval.purpose ?? approval.reason {
        Text(summary)
      }
      Text(approval.command).font(.system(.footnote, design: .monospaced)).textSelection(
        .enabled)
      HStack {
        Button("Deny", role: .destructive) {
          Task { await model.decide(approval, approved: false) }
        }
        Spacer()
        Button("Approve once") { approvalToConfirm = approval }.buttonStyle(
          .borderedProminent)
      }.disabled(model.sending)
    }.padding().background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
  }

  private var transcript: some View {
    let messages = model.messages
    let forkable = model.forkableMessageIDs
    let inherited = messages.filter { model.conversation.isInherited($0) }
    let current = messages.filter { !model.conversation.isInherited($0) }
    let visible = inheritedExpanded ? messages : current
    let showSpeakers =
      model.conversation.isShared
      || Set(messages.filter { $0.role == "user" }.compactMap(\.speaker)).count > 1
    return LazyVStack(alignment: .leading, spacing: 24) {
      pinsSection
      forkOrigin
      if model.earlierItems > 0,
        inheritedExpanded || model.conversation.forkBoundarySeq == nil
          || model.earlierItems > (model.conversation.forkBoundarySeq ?? -1) + 1
      {
        Button("Load earlier messages") { Task { await model.loadEarlier() } }
          .disabled(model.loadingEarlier)
      }
      if !model.hasLoadedTranscript && model.error == nil && model.activeRunID == nil {
        NativeWave().accessibilityLabel("Loading conversation")
          .frame(maxWidth: .infinity).padding(.top, 60)
      } else if model.hasLoadedTranscript && model.transcriptItems.isEmpty
        && model.earlierItems == 0 && visible.isEmpty && model.displayedPartial.isEmpty
        && model.activeRunID == nil && model.pending == nil
      {
        ContentUnavailableView(
          "What shall we work on?", systemImage: "helm",
          description: Text("Ask a question or hand off a task.")
        )
        .padding(.top, 60)
        if model.draft.isEmpty, model.attachments.isEmpty, model.conversation.canReply,
          let identity, !model.conversation.isShared
        {
          NativeSuggestedActivities(client: model.client, identity: identity) { activity in
            guard model.draft.isEmpty else { return }
            model.draft = activity.prompt
            model.saveDraft()
            composerFocused = true
          }
        }
      }
      ForEach(visible) { entry in
        if inheritedExpanded, !inherited.isEmpty, entry.id == current.first?.id {
          HStack {
            Rectangle().frame(height: 1)
            Text("This conversation").font(.caption).fixedSize()
            Rectangle().frame(height: 1)
          }.foregroundStyle(.secondary)
        }
        NativeChatMessageView(
          message: entry, client: model.client,
          showSpeaker: showSpeakers, user: model.user, conversationID: model.conversation.id,
          onFork: forkable.contains(entry.id) && !model.forking
            ? {
              Task { forkedConversation = await model.fork(from: entry.id) }
            } : nil
        )
        .id(entry.id)
      }
      if !model.displayedPartial.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          MessageMarkdown(text: model.displayedPartial, client: model.client)
        }.accessibilityIdentifier("streamingResponse")
      }
      if model.activeRunID != nil {
        NativeWorkSummary(
          activity: model.liveActivity, client: model.client, active: true,
          responding: !model.displayedPartial.isEmpty)
      }
      ForEach(model.approvals) { approval in approvalCard(approval) }
      Color.clear.frame(height: 1).id("bottom")
        .onScrollVisibilityChange { visible in
          nearLatest = visible
        }
    }
    .padding(20)
    .frame(maxWidth: QMTheme.conversationWidth)
    .frame(maxWidth: .infinity)
  }

  private var bottomBar: some View {
    VStack(spacing: 10) {
      if model.conversation.canReply, model.pending == nil {
        NativeSkillSuggestions(client: model.client, draft: $model.draft).disabled(model.sending)
      }
      if model.conversation.canReply {
        QueuedRunsView(
          client: model.client, threadRef: model.conversation.threadRef,
          scopeID: model.conversation.scopeId
        ) {
          await model.reconcileActivity($0)
        }
      }
      if let error = model.error {
        HStack {
          Text(error).font(.footnote).foregroundStyle(.red)
          Button("Retry") { Task { await model.resume() } }
        }
      }
      if !model.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(model.attachments) { attachment in
              HStack(spacing: 8) {
                Label(attachment.name, systemImage: "doc").lineLimit(1)
                if model.pending == nil {
                  Button {
                    model.attachments.removeAll { $0.id == attachment.id }
                  } label: {
                    Image(systemName: "xmark.circle.fill")
                  }.accessibilityLabel("Remove \(attachment.name)")
                    .disabled(model.sending)
                }
              }.font(.footnote).padding(10).background(QMTheme.surface, in: Capsule())
            }
          }
        }
      }
      if model.pending != nil && !model.sending {
        Button("Retry sending saved message") { Task { await model.send() } }.disabled(
          model.sending)
      } else if model.conversation.canReply {
        composer
      } else {
        if let url = model.conversation.slackURL(workspaceURL: identity?.slackWorkspaceUrl) {
          Link(destination: url) {
            Label("Open in Slack", systemImage: "arrow.up.right.square")
              .font(.subheadline.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
        } else {
          Text("Continue this conversation in Slack.").font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .frame(maxWidth: QMTheme.conversationWidth)
    .frame(maxWidth: .infinity)
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField("Message QM", text: $model.draft, axis: .vertical)
        .lineLimit(1...(dynamicTypeSize.isAccessibilitySize ? 3 : 8))
        .padding(.horizontal, 8).padding(.top, 8)
        .focused($composerFocused)
        .disabled(model.sending)
        .accessibilityIdentifier("composer")
      if dictation.busy || dictation.error != nil { dictationStatus }
      HStack(spacing: 6) {
        AttachmentPicker(
          client: model.client, account: model.attachmentAccount,
          attachments: $model.attachments, error: $model.error, uploading: $model.uploading
        ).disabled(model.sending)
        if !dynamicTypeSize.isAccessibilitySize { modelSelector }
        Spacer(minLength: 0)
        Button {
          if dictation.state == .recording {
            dictation.finish()
          } else {
            composerFocused = false
            dictation.start()
          }
        } label: {
          Image(systemName: dictation.state == .recording ? "stop.circle.fill" : "mic")
            .font(.system(size: 21)).frame(width: 44, height: 44)
            .foregroundStyle(dictation.state == .recording ? Color.red : QMTheme.ink)
        }
        .accessibilityLabel(dictation.state == .recording ? "Finish dictation" : "Dictate message")
        .disabled(model.sending || (dictation.busy && dictation.state != .recording))
        if model.activeRunID != nil,
          model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          model.attachments.isEmpty
        {
          Button {
            Task { await model.stop() }
          } label: {
            Image(systemName: "stop.fill")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(QMTheme.paper)
              .frame(width: 44, height: 44)
              .background(QMTheme.ink, in: Circle())
          }.accessibilityLabel("Stop response")
        } else {
          Button {
            followsLatest = true
            Task { await model.send() }
          } label: {
            Group {
              if model.sending {
                NativeWave().foregroundStyle(QMTheme.paper)
              } else {
                Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold))
              }
            }
            .foregroundStyle(QMTheme.paper)
            .frame(width: 44, height: 44)
            .background(QMTheme.ink.opacity(canSend ? 1 : 0.25), in: Circle())
          }
          .accessibilityLabel(model.activeRunID == nil ? "Send message" : "Queue message")
          .disabled(!canSend)
        }
      }
      if dynamicTypeSize.isAccessibilitySize { modelSelector }
    }
    .padding(8)
    .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 24))
    .shadow(color: .black.opacity(0.08), radius: 12, y: 3)
    .overlay {
      RoundedRectangle(cornerRadius: 24).strokeBorder(QMTheme.border, lineWidth: 1)
    }
  }

  private var dictationStatus: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        if dictation.state == .recording {
          Image(systemName: "waveform").foregroundStyle(.red)
            .scaleEffect(0.85 + dictation.level * 0.3)
          Text(
            "Recording · \(Int(dictation.elapsed) / 60):\(String(format: "%02d", Int(dictation.elapsed) % 60))"
          )
          Spacer()
          Button("Done") { dictation.finish() }
        } else if dictation.state == .ready {
          Text("Recording stopped")
          Spacer()
          Button("Transcribe") { dictation.finish() }
        } else if dictation.state == .retry {
          Text("Recording saved for retry")
          Spacer()
          Button("Retry") { dictation.retry() }
        } else if dictation.busy {
          NativeWave()
          Text(dictation.state == .preparing ? "Preparing microphone…" : "Transcribing…")
          Spacer()
        }
        Button(dictation.busy ? "Cancel" : "Dismiss") { dictation.cancel() }
      }
      if let error = dictation.error { Text(error).foregroundStyle(.red) }
      if dictation.state == .recording {
        Text(
          "Audio is sent to \(dictation.providerName) when you finish recording. You can edit before sending."
        )
        .foregroundStyle(.secondary)
      }
    }.font(.footnote).padding(.horizontal, 8).padding(.vertical, 6)
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
