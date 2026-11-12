import SwiftUI
import os

struct SwarmMember: Decodable, Identifiable, Equatable {
  let id: String
  let parentId: String?
  let sessionId: String?
  let depth: Int
  let state: String
  let control: String?

  var label: String { depth == 0 ? "Root session" : "Worker \(id.prefix(8))" }
}

struct SwarmView: Decodable {
  let id: String
  let member: SwarmMember
  let peers: [SwarmMember]

  enum CodingKeys: String, CodingKey {
    case id, peers
    case member = "self"
  }

  var workers: [SwarmMember] { peers.filter { $0.depth > 0 } }
  var canControlAll: Bool { member.depth == 0 }

  var ordered: [SwarmMember] {
    guard let root = peers.first(where: { $0.id == id }) ?? peers.first else { return [] }
    var out: [SwarmMember] = []
    var seen = Set<String>()
    func walk(_ member: SwarmMember) {
      guard seen.insert(member.id).inserted else { return }
      out.append(member)
      for child in peers where child.parentId == member.id { walk(child) }
    }
    walk(root)
    return out
  }

  func status(of member: SwarmMember, seen: Set<String> = []) -> String {
    let parent = member.parentId.flatMap { parentID in
      seen.contains(parentID) ? nil : peers.first { $0.id == parentID }
    }
    let inherited = parent.map { status(of: $0, seen: seen.union([member.id])) } ?? "active"
    if member.control == "stopped" || inherited == "stopped" { return "stopped" }
    if member.state == "failed" { return "failed" }
    if member.control == "paused" || inherited == "paused" { return "paused" }
    return member.state == "reserved" ? "starting" : "active"
  }

  func canControl(_ peer: SwarmMember) -> Bool {
    peer.depth > 0 && peer.id != member.id && status(of: peer) != "stopped"
  }

  func targets(for state: String) -> [String] {
    peers.filter { $0.parentId == id }.filter {
      switch state {
      case "paused": $0.control == nil
      case "active": $0.control == "paused"
      default: $0.control != "stopped"
      }
    }.map(\.id)
  }
}

@MainActor @Observable
final class SwarmModel {
  let client: APIClient
  let sessionID: String
  private(set) var view: SwarmView?
  private(set) var error: String?
  private(set) var busy = false

  init(client: APIClient, sessionID: String) {
    self.client = client
    self.sessionID = sessionID
  }

  func load() async {
    do {
      let loaded: SwarmView = try await client.fetch("api/sessions/\(sessionID)/swarm")
      guard !Task.isCancelled else { return }
      view = loaded.workers.isEmpty ? nil : loaded
    } catch QMError.rejected {
      view = nil
    } catch {
      Log.background.failure("Swarm load", error)
    }
  }

  func control(_ memberIDs: [String], state: String) async {
    guard !memberIDs.isEmpty, !busy else { return }
    busy = true
    defer { busy = false }
    let failures = await withTaskGroup(of: Error?.self) { group in
      for memberID in memberIDs {
        group.addTask { await self.failure(setting: memberID, to: state) }
      }
      var failures: [Error] = []
      for await failure in group {
        if let failure { failures.append(failure) }
      }
      return failures
    }
    error = failures.first.map {
      "Could not update \(failures.count) of \(memberIDs.count) workers. \($0.localizedDescription)"
    }
    await load()
  }

  private func failure(setting memberID: String, to state: String) async -> Error? {
    do {
      struct Controlled: Decodable { let member: SwarmMember }
      let _: Controlled = try await client.fetch(
        "api/sessions/\(sessionID)/swarm",
        body: ["action": "control", "memberId": memberID, "state": state])
      return nil
    } catch {
      Log.background.failure("Swarm control", error)
      return error
    }
  }
}

struct NativeSwarmWorkers: View {
  let model: SwarmModel
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingStopAll = false

  var body: some View {
    QMList {
      if let swarm = model.view {
        if swarm.canControlAll {
          Section {
            HStack {
              Button("Pause all") { control(swarm.targets(for: "paused"), "paused") }
                .disabled(swarm.targets(for: "paused").isEmpty)
              Spacer()
              Button("Resume all") { control(swarm.targets(for: "active"), "active") }
                .disabled(swarm.targets(for: "active").isEmpty)
              Spacer()
              Button("Stop all", role: .destructive) { confirmingStopAll = true }
                .disabled(swarm.targets(for: "stopped").isEmpty)
            }
            .buttonStyle(.borderless).font(.footnote)
          }
        }
        Section("Workers") {
          ForEach(swarm.ordered) { member in
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(member.label)
                Text(swarm.status(of: member)).font(.caption).foregroundStyle(.secondary)
              }
              .padding(.leading, CGFloat(min(member.depth, 6)) * 12)
              Spacer(minLength: 0)
              if swarm.canControl(member) {
                Button(member.control == "paused" ? "Resume" : "Pause") {
                  control([member.id], member.control == "paused" ? "active" : "paused")
                }
                Button("Stop", role: .destructive) { control([member.id], "stopped") }
              }
            }
            .buttonStyle(.borderless).font(.footnote)
          }
        }
        if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red) }
      } else {
        Text("No workers are running.").foregroundStyle(.secondary)
      }
    }
    .disabled(model.busy)
    .navigationTitle("Workers").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
    }
    .confirmationDialog(
      "Stop all \(model.view?.targets(for: "stopped").count ?? 0) workers?",
      isPresented: $confirmingStopAll, titleVisibility: .visible
    ) {
      Button("Stop all", role: .destructive) {
        control(model.view?.targets(for: "stopped") ?? [], "stopped")
      }
    } message: {
      Text("Stopped workers cannot be resumed.")
    }
    .task { await model.load() }
  }

  private func control(_ memberIDs: [String], _ state: String) {
    Task { await model.control(memberIDs, state: state) }
  }
}
