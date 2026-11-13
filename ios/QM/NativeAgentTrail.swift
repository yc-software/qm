import SwiftUI

struct NativeAgentTrail: View {
  let client: APIClient
  let user: String
  let conversationID: String
  let promptStartedAt: Double?
  let agentActivity: [NativeWorkItem]
  @Binding var isExpanded: Bool
  let onOpen: (Conversation) -> Void

  private struct Identity: Hashable {
    let client: ObjectIdentifier
    let generation: UUID
    let user: String
    let conversation: String
  }

  var body: some View {
    NativeAgentTrailContent(
      client: client, user: user, conversationID: conversationID,
      promptStartedAt: promptStartedAt,
      agentActivity: agentActivity,
      isExpanded: $isExpanded, onOpen: onOpen
    )
    .id(
      Identity(
        client: ObjectIdentifier(client), generation: client.generation,
        user: user, conversation: conversationID))
  }
}

private struct NativeAgentTrailContent: View {
  @Binding var isExpanded: Bool
  @State private var model: NativeAgentTrailModel
  @State private var selectedConversation: Conversation?
  @State private var retry = 0
  @Environment(\.scenePhase) private var phase
  @Environment(\.dynamicTypeSize) private var typeSize
  let client: APIClient
  let user: String
  let promptStartedAt: Double?
  let agentActivity: [NativeWorkItem]
  let onOpen: (Conversation) -> Void

  init(
    client: APIClient, user: String, conversationID: String,
    promptStartedAt: Double?,
    agentActivity: [NativeWorkItem],
    isExpanded: Binding<Bool>, onOpen: @escaping (Conversation) -> Void
  ) {
    _isExpanded = isExpanded
    self.client = client
    self.user = user
    self.promptStartedAt = promptStartedAt
    self.agentActivity = agentActivity
    self.onOpen = onOpen
    _model = State(
      initialValue: NativeAgentTrailModel(client: client, conversationID: conversationID))
  }

  private var polling: Bool { phase == .active }
  private var current: [NativeAgentBranch] {
    NativeAgentBranch.current(model.branches, since: promptStartedAt)
  }
  private var previous: [NativeAgentBranch] {
    let currentIDs = Set(current.map(\.id))
    return model.branches.filter { !currentIDs.contains($0.id) }
  }
  private var pendingLaunches: [NativeWorkItem] {
    NativeAgentBranch.pendingLaunches(agentActivity, listed: model.branches)
  }
  private var launchActivityID: String {
    agentActivity.filter { $0.opensAgents && $0.entry.body?.action == "open" }
      .map { "\($0.id):\($0.result?.id ?? "")" }.joined(separator: "|")
  }
  private var summary: String {
    if model.stale { return "Updates unavailable" }
    let working = current.filter { $0.state == .working }.count
    let waiting = current.filter { $0.state == .waiting }.count
    let failed = current.filter { $0.state == .failed }.count
    let done = current.filter { $0.state == .returned }.count
    let starting = pendingLaunches.filter { $0.result == nil }.count
    let started = pendingLaunches.count - starting
    return [
      starting > 0 ? "\(starting) starting" : nil,
      started > 0 ? "\(started) started" : nil,
      working > 0 ? "\(working) working" : nil,
      waiting > 0 ? "\(waiting) need attention" : nil,
      failed > 0 ? "\(failed) failed" : nil,
      done > 0 ? "\(done) done" : nil,
    ].compactMap { $0 }.joined(separator: " · ")
  }

  var body: some View {
    VStack(spacing: 0) {
      if !current.isEmpty || !pendingLaunches.isEmpty {
        dock.padding(.bottom, 10)
      }
    }
    .foregroundStyle(QMTheme.ink)
    .sheet(
      isPresented: $isExpanded,
      onDismiss: {
        guard let conversation = selectedConversation else { return }
        selectedConversation = nil
        onOpen(conversation)
      }
    ) {
      roster
    }
    .task(id: "\(polling)-\(retry)-\(isExpanded)-\(launchActivityID)") {
      guard polling else { return }
      while !Task.isCancelled {
        await model.refresh()
        guard
          isExpanded || !pendingLaunches.isEmpty
            || model.branches.contains(where: { $0.state == .working || $0.state == .waiting })
        else { return }
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
  }

  private var dock: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        isExpanded = true
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Agents").font(.subheadline.weight(.medium))
            Text(summary).font(.caption).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0)
          if !typeSize.isAccessibilitySize {
            Text("All agents").font(.caption)
          }
          Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(current.count + pendingLaunches.count) agents, \(summary)")
      .accessibilityHint("Show all agents and their progress")
      .accessibilityIdentifier("agentDock")

      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(current) { branch in
            Button {
              onOpen(branch.conversation)
            } label: {
              HStack(spacing: 8) {
                avatar(branch)
                VStack(alignment: .leading, spacing: 3) {
                  Text(branch.name).font(.subheadline.weight(.medium)).lineLimit(1)
                  Text(model.stale ? "Updates unavailable" : branch.state.rawValue)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
              }
              .padding(8)
              .frame(width: typeSize.isAccessibilitySize ? 320 : 190, alignment: .leading)
              .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 16))
              .contentShape(RoundedRectangle(cornerRadius: 16))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
              "\(branch.name), \(model.stale ? "last known: " : "")\(branch.state.rawValue)"
            )
            .accessibilityHint("View agent conversation")
            .accessibilityIdentifier("agentShortcut-\(branch.id)")
          }
          ForEach(pendingLaunches) { item in
            launchRow(item)
              .padding(8)
              .frame(width: typeSize.isAccessibilitySize ? 320 : 190, alignment: .leading)
              .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 16))
          }
        }
      }
      .scrollIndicators(.hidden)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func avatar(_ branch: NativeAgentBranch) -> some View {
    NativeAgentAvatar(sessionID: branch.id, returned: branch.state == .returned)
      .frame(width: 40, height: 40)
      .overlay(alignment: .bottomTrailing) {
        Group {
          if branch.state == .working, !model.stale {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: model.stale ? "wifi.slash" : branch.state.symbol)
              .font(.system(size: 10, weight: .bold))
          }
        }
        .padding(3)
        .background(QMTheme.paper, in: Circle())
      }
      .accessibilityHidden(true)
  }

  @ViewBuilder private func launchRow(_ item: NativeWorkItem) -> some View {
    if let sessionID = item.agentSessionID, item.result != nil {
      NavigationLink {
        NativeConversationDestination(client: client, user: user, sessionID: sessionID)
      } label: {
        launchLabel(item)
      }
      .buttonStyle(.plain)
      .accessibilityHint("View agent conversation")
    } else {
      launchLabel(item)
    }
  }

  private func launchLabel(_ item: NativeWorkItem) -> some View {
    let name =
      [item.entry.body?.name, item.result?.details?["title"]?.string]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty } ?? "Agent"
    return HStack(spacing: 8) {
      Group {
        if let sessionID = item.agentSessionID, item.result != nil {
          NativeAgentAvatar(sessionID: sessionID)
        } else {
          ProgressView().controlSize(.small)
        }
      }
      .frame(width: 40, height: 40)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(name).font(.subheadline.weight(.medium)).lineLimit(1)
        Text(item.result == nil ? "Starting…" : "Started")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(
      item.result == nil ? "agentStarting-\(item.id)" : "agentStarted-\(item.id)")
  }

  private var roster: some View {
    NavigationStack {
      Group {
        if model.updatedAt == nil, model.error == nil, pendingLaunches.isEmpty {
          ProgressView("Loading agents…")
            .accessibilityIdentifier("agentRosterLoading")
        } else if model.branches.isEmpty, model.error == nil, pendingLaunches.isEmpty {
          ContentUnavailableView(
            "No agents yet", systemImage: "point.3.connected.trianglepath.dotted",
            description: Text("Delegated work will appear here."))
        } else {
          List {
            if let error = model.error {
              Section { connectionNotice(error) }
            }
            if !current.isEmpty || !pendingLaunches.isEmpty {
              Section("Current work") {
                rows(current)
                ForEach(pendingLaunches) { item in launchRow(item) }
              }
            }
            if !previous.isEmpty {
              Section("Earlier work") { rows(previous) }
            }
            Section {
            } footer: {
              Text("Agent conversations update automatically.")
                .font(.footnote).foregroundStyle(.secondary)
            }
          }
          .listStyle(.plain)
          .refreshable { await model.refresh() }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .navigationTitle("Agents")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { isExpanded = false }
        }
      }
      .accessibilityIdentifier("agentRoster")
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
  }

  private func rows(_ branches: [NativeAgentBranch]) -> some View {
    ForEach(branches) { branch in
      Button {
        selectedConversation = branch.conversation
        isExpanded = false
      } label: {
        HStack(spacing: 12) {
          avatar(branch)
          VStack(alignment: .leading, spacing: 4) {
            Text(branch.name).font(.body).foregroundStyle(QMTheme.ink)
            if let purpose = branch.conversation.purpose, purpose != branch.name,
              !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
              Text(purpose).font(.subheadline).foregroundStyle(.secondary)
            }
            if let parent = branch.parentName {
              Text("Via \(parent)").font(.caption).foregroundStyle(.secondary)
            }
            Label(
              model.stale ? "Last known: \(branch.state.rawValue)" : branch.state.rawValue,
              systemImage: branch.state.symbol
            )
            .font(.caption).foregroundStyle(.secondary)
          }
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.leading)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityHint("View agent conversation")
      .accessibilityIdentifier("agentBranch-\(branch.id)")
    }
  }

  private func connectionNotice(_ error: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(
        model.branches.isEmpty
          ? "Couldn’t load agents" : "Updates unavailable · showing last known state",
        systemImage: "wifi.slash")
      Text(error).font(.caption)
      if let updatedAt = model.updatedAt {
        Text("Last checked \(updatedAt, style: .relative) ago").font(.caption)
      }
      Button {
        retry += 1
      } label: {
        HStack {
          Text("Retry")
          if model.loading { ProgressView() }
        }
        .frame(minHeight: 44)
      }
      .disabled(model.loading)
    }
    .foregroundStyle(.secondary)
  }
}
