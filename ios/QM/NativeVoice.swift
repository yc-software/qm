import AVFAudio
import CryptoKit
import SwiftUI
@preconcurrency import WebRTC
import os

struct NativeVoiceFragment: Identifiable {
  let id = UUID()
  let role: String
  var text: String
  let start: Double
  var end: Double
}
enum NativeVoiceTimelineContent {
  case speech(NativeVoiceFragment)
  case activity(Item)
  case status(String)
  case result(String)
}
struct NativeVoiceTimelineItem: Identifiable {
  let id = UUID()
  var content: NativeVoiceTimelineContent
}
struct NativeVoiceTranscript {
  var items: [NativeVoiceTimelineItem] = []
  var fragments: [NativeVoiceFragment] {
    items.compactMap { if case .speech(let fragment) = $0.content { fragment } else { nil } }
  }
  private var eventIDs: Set<String> = []
  private var activityIDs: Set<String> = []
  mutating func appendStatus(_ text: String) {
    appendItem(.status(text))
  }
  mutating func appendResult(_ text: String) {
    appendItem(.result(text))
  }
  mutating func appendActivity(_ activity: [Item], runID: String) {
    for entry in activity
    where NativeWorkItem.supports(entry) && activityIDs.insert("\(runID):\(entry.id)").inserted {
      appendItem(.activity(entry))
    }
  }
  private mutating func appendItem(_ content: NativeVoiceTimelineContent) {
    items.append(.init(content: content))
    if items.count > 200 { items.removeFirst() }
  }
  mutating func append(_ event: [String: Any]) -> Bool {
    let type = event["type"] as? String
    guard type == "session.input_transcript.delta" || type == "session.output_transcript.delta",
      let text = event["delta"] as? String, let start = event["start_ms"] as? Double,
      let end = event["end_ms"] as? Double, start.isFinite, end.isFinite, start >= 0, end >= start
    else { return false }
    if let id = event["event_id"] as? String, !eventIDs.insert(id).inserted { return false }
    let role = type == "session.input_transcript.delta" ? "You" : "QM"
    if let last = items.last, case .speech(var fragment) = last.content,
      fragment.role == role, start >= fragment.start, start - fragment.end <= 1500,
      fragment.text.count + text.count <= 8000
    {
      fragment.text += text
      fragment.end = max(fragment.end, end)
      items[items.count - 1].content = .speech(fragment)
    } else {
      appendItem(
        .speech(.init(role: role, text: String(text.prefix(8000)), start: start, end: end)))
    }
    return true
  }
}

@MainActor @Observable
final class NativeVoiceModel: NSObject {
  let client: APIClient
  var conversation: Conversation?
  var available = false
  var status = "Checking voice availability…"
  var connected = false
  var connecting = false
  var stopping = false
  var muted = false
  var taskStatus: String?
  var transcript = NativeVoiceTranscript()
  private var factory: RTCPeerConnectionFactory?
  private var peer: RTCPeerConnection?
  private var channel: RTCDataChannel?
  private var microphone: RTCAudioTrack?
  private var bridge = NativeVoiceBridge()
  private(set) var revision = UUID()
  private var monitor: Task<Void, Never>?
  private var tasks: [Task<Void, Never>] = []
  private var followed: Set<String> = []
  private var closingStatus = "Conversation ended. QM tasks remain in your history."
  private var audioInterrupted = false
  private var audioPaused = false
  private var threadRef = ""
  private var scopeID = ""
  private var user = ""
  init(client: APIClient, conversation: Conversation?) {
    self.client = client
    self.conversation = conversation
  }
  func load() async {
    do {
      struct Capability: Decodable { let enabled: Bool }
      let identity: Identity = try await client.fetch("me")
      let capability: Capability = try await client.fetch("api/voice")
      try Task.checkCancellation()
      user = identity.user
      available = capability.enabled
      status = available ? "Ready when you are." : "Voice is not enabled for this account."
    } catch { if !Task.isCancelled { status = error.localizedDescription } }
  }
  func start() async {
    guard available, !connecting, !connected, !stopping else { return }
    cleanup()
    closingStatus = "Conversation ended. QM tasks remain in your history."
    audioInterrupted = false
    audioPaused = false
    let current = UUID()
    revision = current
    connecting = true
    status = "Connecting…"
    muted = false
    taskStatus = nil
    transcript = NativeVoiceTranscript()
    bridge = NativeVoiceBridge()
    followed = []
    threadRef = conversation?.threadRef ?? "web:\(user):voice-\(UUID().uuidString.lowercased())"
    scopeID = conversation?.scopeId ?? "personal:\(user)"
    do {
      guard await AVAudioApplication.requestRecordPermission() else {
        throw QMError.message("Enable microphone access for QM in Settings to use voice.")
      }
      guard current == revision && !Task.isCancelled else { return }
      let rtcAudio = RTCAudioSessionConfiguration.webRTC()
      rtcAudio.categoryOptions.insert(.defaultToSpeaker)
      RTCAudioSessionConfiguration.setWebRTC(rtcAudio)
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(
        .playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
      try audio.setActive(true)
      RTCInitializeSSL()
      let factory = RTCPeerConnectionFactory()
      self.factory = factory
      let configuration = RTCConfiguration()
      configuration.sdpSemantics = .unifiedPlan
      guard
        let peer = factory.peerConnection(
          with: configuration,
          constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
          delegate: self)
      else { throw QMError.message("Could not create a voice connection.") }
      self.peer = peer
      let audioSource = factory.audioSource(
        with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
      let track = factory.audioTrack(with: audioSource, trackId: "qm-microphone")
      microphone = track
      peer.add(track, streamIds: ["qm-voice"])
      let dataConfiguration = RTCDataChannelConfiguration()
      guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: dataConfiguration)
      else { throw QMError.message("Could not create the voice event channel.") }
      self.channel = channel
      channel.delegate = self
      let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
        peer.offer(
          for: RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        ) { description, error in
          if let error {
            continuation.resume(throwing: error)
          } else if let description {
            continuation.resume(returning: description)
          } else {
            continuation.resume(
              throwing: QMError.message("Voice did not produce a connection offer."))
          }
        }
      }
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        peer.setLocalDescription(offer) { error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        }
      }
      let deadline = Date().addingTimeInterval(10)
      while peer.iceGatheringState != .complete && Date() < deadline {
        try await Task.sleep(for: .milliseconds(50))
        guard current == revision else { return }
      }
      guard current == revision && !Task.isCancelled else { return }
      guard peer.iceGatheringState == .complete, let sdp = peer.localDescription?.sdp else {
        throw QMError.message("Voice connection timed out. Try again.")
      }
      struct Session: Decodable {
        struct Transport: Decodable { let sdp: String }
        let transport: Transport
      }
      var body = ["sdp": sdp]
      if let briefing = await briefing() { body["briefing"] = briefing }
      guard current == revision && !Task.isCancelled else { return }
      let result: Session = try await client.fetch("api/voice/sessions", body: body)
      guard current == revision && !Task.isCancelled else { return }
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: result.transport.sdp)) {
          error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        }
      }
      updatePlaybackVolume()
      monitor = Task {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        if current == revision && !connected { fail("Voice did not connect. Try again.") }
      }
    } catch { if current == revision { fail(error.localizedDescription) } }
  }
  func updatePlaybackVolume() {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    let gain = outputs.count == 1 && outputs.first?.portType == .builtInSpeaker ? 2.0 : 1.0
    for receiver in peer?.receivers ?? [] {
      (receiver.track as? RTCAudioTrack)?.source.volume = gain
    }
  }
  func toggleMute() {
    guard !audioInterrupted else { return }
    do {
      if muted {
        try AVAudioSession.sharedInstance().setActive(true)
        audioPaused = false
        updatePlaybackVolume()
      }
      muted.toggle()
      microphone?.isEnabled = !muted
      send(bridge.event(muted ? "session.input_audio.mute" : "session.input_audio.unmute"))
      status = muted ? "Microphone muted" : "Listening · You can interrupt naturally"
      flushEvents()
    } catch { fail("Could not resume audio. QM tasks continue in your history.") }
  }
  func interruptAudio(_ type: UInt, options: UInt = 0) {
    guard connected, !stopping else { return }
    if type == AVAudioSession.InterruptionType.began.rawValue {
      audioInterrupted = true
      audioPaused = true
      microphone?.isEnabled = false
      status = "Audio interrupted. QM tasks continue."
    } else if type == AVAudioSession.InterruptionType.ended.rawValue {
      audioInterrupted = false
      guard AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) else {
        muted = true
        send(bridge.event("session.input_audio.mute"))
        status = "Audio paused. Unmute to continue."
        return
      }
      do {
        try AVAudioSession.sharedInstance().setActive(true)
        audioPaused = false
        updatePlaybackVolume()
        microphone?.isEnabled = !muted
        status = muted ? "Microphone muted" : "Listening · You can interrupt naturally"
        flushEvents()
      } catch { fail("Could not resume audio. QM tasks continue in your history.") }
    }
  }
  func headphonesDisconnected() {
    guard connected, !stopping else { return }
    muted = true
    microphone?.isEnabled = false
    send(bridge.event("session.input_audio.mute"))
    status = "Headphones disconnected. Unmute to continue."
  }
  func finish(reason: String = "Conversation ended. QM tasks remain in your history.") {
    guard connecting || connected, !stopping else { return }
    closingStatus = reason
    stopping = true
    connecting = false
    microphone?.isEnabled = false
    for receiver in peer?.receivers ?? [] { receiver.track?.isEnabled = false }
    status = "Ending voice…"
    monitor?.cancel()
    if connected && channel?.readyState == .open {
      send(["type": "session.close"])
      let current = revision
      monitor = Task {
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
        if current == revision { fail("Voice ended. Final session confirmation was unavailable.") }
      }
    } else {
      status = closingStatus
      cleanup()
    }
  }
  private func fail(_ message: String) {
    status = message
    cleanup()
  }
  private func cleanup() {
    revision = UUID()
    monitor?.cancel()
    monitor = nil
    for task in tasks { task.cancel() }
    tasks = []
    microphone?.isEnabled = false
    microphone = nil
    channel?.delegate = nil
    channel?.close()
    channel = nil
    peer?.delegate = nil
    peer?.close()
    peer = nil
    factory = nil
    connecting = false
    connected = false
    stopping = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  private func send(_ event: [String: Any]) {
    guard channel?.readyState == .open,
      let data = try? JSONSerialization.data(withJSONObject: event)
    else { return }
    if channel?.sendData(RTCDataBuffer(data: data, isBinary: false)) != true {
      fail("Voice could not send an event. Check QM before retrying a task.")
    }
  }
  private func receive(_ data: Data) {
    guard peer != nil else { return }
    do {
      guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw QMError.message("Voice received an unreadable event.")
      }
      if event["type"] as? String == "session.closed" {
        status = closingStatus
        cleanup()
        return
      }
      guard !stopping else { return }
      switch event["type"] as? String {
      case "session.started":
        updatePlaybackVolume()
        connecting = false
        connected = true
        status = "Listening · You can interrupt naturally"
        monitor?.cancel()
        let current = revision
        monitor = Task {
          do { try await Task.sleep(for: .seconds(20 * 60)) } catch { return }
          if current == revision { finish() }
        }
        tasks.append(Task { await tick(revision: current) })
        tasks.append(Task { await watchThread(revision: current) })
        bridge.say(NativeVoiceBridge.greeting, delegation: nil)
        flushEvents()
      case "error":
        guard (event["error"] as? [String: Any])?["client_event_id"] is String else {
          return fail("Voice reported an error. Check QM before retrying a task.")
        }
        transcript.appendStatus("Voice could not take an update. Results stay in QM.")
      default:
        if (event["type"] as? String)?.hasSuffix("_transcript.delta") == true,
          !transcript.append(event)
        {
          return
        }
        perform(bridge.receive(event, now: Self.clock), revision: revision)
        flushEvents()
      }
    } catch { fail(error.localizedDescription) }
  }
  nonisolated static func submissionKey(revision: UUID, delegation: String?) -> String {
    let source = "\(revision.uuidString.lowercased()):\(delegation ?? UUID().uuidString)"
    return "voice-" + SHA256.hash(data: Data(source.utf8)).hex
  }
  private static var clock: Double { ProcessInfo.processInfo.systemUptime }
  var canSpeak: Bool { connected && !stopping && !audioPaused }
  private func flushEvents() {
    for event in bridge.takeOutgoing(canSend: canSpeak) { send(event) }
  }
  private func briefing() async -> String? {
    guard let conversation else { return nil }
    let active: ActiveRun?
    do {
      active = try await client.fetch(
        "api/runs/active", query: [.init(name: "threadRef", value: threadRef)])
    } catch {
      Log.background.failure("Voice briefing active run check", error)
      active = nil
    }
    let history: Transcript?
    do {
      history = try await client.fetch(
        "api/sessions/\(conversation.id.apiComponent)",
        query: [.init(name: "tailTurns", value: "25")])
    } catch {
      Log.background.failure("Voice briefing history", error)
      history = nil
    }
    let messages = chatMessages(history?.items ?? []).filter {
      $0.role == "user" || $0.role == "assistant"
    }
    return NativeVoiceBridge.briefing(
      messages.map { (user: $0.role == "user", text: $0.text) }, working: active?.runId != nil)
  }
  private func perform(_ actions: [NativeVoiceAction], revision current: UUID) {
    for action in actions {
      tasks.append(
        Task {
          switch action {
          case .submit(let text, let delegation):
            await submit(text, delegation: delegation, revision: current)
          case .steer(let text, let delegation, let remark):
            await steer(text, delegation: delegation, remark: remark, revision: current)
          }
        })
    }
  }
  private func tick(revision current: UUID) async {
    while current == revision {
      do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
      guard current == revision else { return }
      perform(bridge.tick(now: Self.clock), revision: current)
      flushEvents()
    }
  }
  private func watchThread(revision current: UUID) async {
    while current == revision && !Task.isCancelled {
      let active: ActiveRun?
      do {
        active = try await client.fetch(
          "api/runs/active", query: [.init(name: "threadRef", value: threadRef)])
      } catch {
        Log.background.failure("Voice active run check", error)
        active = nil
      }
      if let id = active?.runId, !followed.contains(id) {
        await follow(id, delegation: nil, revision: current)
        continue
      }
      do { try await Task.sleep(for: .seconds(2)) } catch { return }
    }
  }
  func submit(_ text: String, delegation: String?, revision current: UUID) async {
    guard current == revision, connected, !stopping, !Task.isCancelled else { return }
    taskStatus = "Sending your request to QM…"
    transcript.appendStatus("Sending to QM…")
    do {
      let submission: Submission = try await client.fetch(
        "api/turn",
        body: [
          "text": text, "threadRef": threadRef, "scopeId": scopeID,
          "timezone": TimeZone.current.identifier,
          "idempotencyKey": Self.submissionKey(revision: current, delegation: delegation),
        ])
      guard current == revision, !Task.isCancelled else { return }
      if let id = submission.runId {
        taskStatus = "QM is working on your request…"
        transcript.appendStatus("Request accepted by QM")
        await follow(id, delegation: delegation, revision: current)
      } else {
        guard submission.isTerminalResult else {
          throw QMError.message("Task submission is unconfirmed.")
        }
        report(
          run: nil, delegation: delegation, status: submission.status, reply: submission.reply,
          reason: submission.reason)
      }
    } catch {
      guard current == revision, !Task.isCancelled else { return }
      report(
        run: nil, delegation: delegation, status: "unconfirmed", reply: nil,
        reason: error.localizedDescription)
    }
  }
  func steer(_ text: String, delegation: String?, remark: Bool, revision current: UUID) async {
    guard current == revision, connected, !stopping, !Task.isCancelled else { return }
    guard let run = bridge.activeRun else {
      if !remark { await submit(text, delegation: delegation, revision: current) }
      return
    }
    do {
      let signal: VoiceSignal = try await client.fetch(
        "api/runs/\(run.apiComponent)/signal",
        body: ["kind": "steer", "text": text, "threadRef": threadRef, "scopeId": scopeID],
        accepting: [409])
      guard current == revision, !Task.isCancelled else { return }
      if signal.accepted == true || signal.replayed == true {
        transcript.appendStatus(remark ? "Passed your words to QM" : "Added to QM's running task")
        bridge.steered(run: run, delegation: delegation, remark: remark)
        flushEvents()
      } else if !remark {
        await submit(text, delegation: delegation, revision: current)
      }
    } catch {
      guard current == revision, !Task.isCancelled, !remark else { return }
      bridge.unconfirmed(delegation: delegation)
      flushEvents()
    }
  }
  func follow(_ runID: String, delegation: String?, revision current: UUID) async {
    guard current == revision else { return }
    if followed.contains(runID) && !bridge.isLive(runID) { return }
    if delegation != nil {
      bridge.started(run: runID, delegation: delegation)
      flushEvents()
    } else {
      bridge.observe(run: runID)
    }
    guard followed.insert(runID).inserted else { return }
    var latest: Run?
    var reported = -Double.infinity
    do {
      try await client.stream(runID.apiComponent) { event in
        guard current == revision else { throw CancellationError() }
        guard let run = event.run else { return }
        latest = run
        transcript.appendActivity(run.activityItems ?? [], runID: runID)
        if Self.clock - reported >= 4,
          let item = NativeWorkItem.items(run.activityItems ?? []).last(where: { !$0.isThinking })
        {
          reported = Self.clock
          bridge.progress(String(item.label(active: true).prefix(160)), run: runID)
          flushEvents()
        }
      }
    } catch {
      Log.background.failure("Following voice hand-off events", error)
    }
    var failures = 0
    while current == revision && !Task.isCancelled && failures < 3
      && latest.map({ $0.result == nil && $0.status != "done" && $0.status != "failed" }) ?? true
    {
      do {
        if latest != nil || failures > 0 { try await Task.sleep(for: .seconds(1 + failures * 2)) }
        let run: Run = try await client.fetch("api/runs/\(runID.apiComponent)")
        latest = run
        failures = 0
        transcript.appendActivity(run.activityItems ?? [], runID: runID)
      } catch {
        failures += 1
      }
    }
    guard current == revision, !Task.isCancelled else { return }
    if let run = latest, run.result != nil || run.status == "done" || run.status == "failed" {
      report(
        run: runID, delegation: nil, status: run.result?.status ?? "failed",
        reply: run.result?.reply, reason: run.result?.reason)
    } else {
      report(
        run: runID, delegation: nil, status: "unconfirmed", reply: nil,
        reason: "The result could not be retrieved.")
    }
  }
  private func report(
    run: String?, delegation: String?, status: String?, reply: String?, reason: String?
  ) {
    let spoken = bridge.finish(
      run: run, delegation: delegation, status: status, reply: reply, reason: reason)
    flushEvents()
    guard let spoken else { return }
    switch status {
    case "unconfirmed":
      taskStatus =
        "Could not confirm the QM task: \(reason ?? "") Check the conversation before retrying."
    case "pending_approval", "failed", "refused": taskStatus = spoken
    default: taskStatus = reply.flatMap { $0.isEmpty ? nil : $0 } ?? spoken
    }
    transcript.appendResult(taskStatus ?? spoken)
  }
}

private struct VoiceSignal: Decodable {
  let accepted: Bool?
  let replayed: Bool?
}

extension NativeVoiceModel: RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream
  ) {}
  nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState
  ) {
    if newState == .failed {
      Task { @MainActor [weak self] in
        if self?.peer === peerConnection {
          self?.fail("Voice connection lost. QM tasks already started remain in your history.")
        }
      }
    }
  }
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel
  ) {}
  nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    if dataChannel.readyState == .closed {
      Task { @MainActor [weak self] in
        if self?.channel === dataChannel {
          self?.fail("Voice disconnected. QM tasks already started remain in your history.")
        }
      }
    }
  }
  nonisolated func dataChannel(
    _ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer
  ) {
    let data = buffer.data
    Task { @MainActor [weak self] in if self?.channel === dataChannel { self?.receive(data) } }
  }
}

struct VoiceView: View {
  @State private var model: NativeVoiceModel
  @Environment(\.scenePhase) private var phase
  init(client: APIClient, conversation: Conversation? = nil) {
    _model = State(initialValue: NativeVoiceModel(client: client, conversation: conversation))
  }
  var body: some View {
    VStack(spacing: 24) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("Talk to QM").font(.title2.weight(.semibold))
          Text(model.status).font(.headline).accessibilityAddTraits(.updatesFrequently)
          LazyVStack(alignment: .leading, spacing: 20) {
            ForEach(model.transcript.items) { item in
              switch item.content {
              case .speech(let fragment):
                NativeChatMessageView(
                  message: ChatMessage(
                    id: item.id.uuidString, role: fragment.role == "You" ? "user" : "assistant",
                    text: fragment.text), client: model.client, showSpeaker: false, user: "")
              case .activity(let entry):
                NativeActivityRow(entry: entry, client: model.client)
              case .status(let text):
                Text(text).font(.caption).foregroundStyle(.secondary)
              case .result(let text):
                NativeChatMessageView(
                  message: ChatMessage(id: item.id.uuidString, role: "assistant", text: text),
                  client: model.client, showSpeaker: false, user: "")
              }
            }
          }
        }.padding(24).frame(maxWidth: QMTheme.conversationWidth, alignment: .leading)
      }
      if model.connected || model.connecting || model.stopping {
        HStack(spacing: 24) {
          Button(model.muted ? "Unmute" : "Mute", systemImage: model.muted ? "mic.slash" : "mic") {
            model.toggleMute()
          }.disabled(!model.connected || model.stopping)
          Button("End voice", systemImage: "phone.down.fill", role: .destructive) { model.finish() }
            .disabled(model.stopping)
        }.buttonStyle(.bordered).controlSize(.large)
      } else {
        Button("Start voice", systemImage: "waveform") { Task { await model.start() } }.buttonStyle(
          .borderedProminent
        ).controlSize(.large).disabled(!model.available)
      }
      Text("Audio is sent to OpenAI while connected. Tasks and approvals stay in QM.").font(
        .caption
      ).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 28)
        .padding(.bottom)
    }
    .background(QMTheme.paper).navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }
    .onDisappear { model.finish() }
    .onChange(of: phase) {
      if phase == .background {
        model.finish(
          reason: "Voice ended when QM moved to the background. Tasks continue in your history.")
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) {
      notification in
      if let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt {
        model.interruptAudio(
          type, options: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) {
      notification in
      model.updatePlaybackVolume()
      if notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
      {
        model.headphonesDisconnected()
      }
    }
  }
}
