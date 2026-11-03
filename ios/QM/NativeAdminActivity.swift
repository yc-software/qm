import SwiftUI

struct NativeAdminSession: Decodable, Identifiable {
  let id: String
  let scopeId: String
  let threadRef: String
  let turns: Int
  let messages: Int
  let lastActivity: Double
  let firstMessage: String
  let lastMessage: String
  let category: String?
  let kind: String?
  var title: String { firstMessage.isEmpty ? threadRef : String(firstMessage.prefix(100)) }
}
struct NativeAdminSessionPage: Decodable {
  let sessions: [NativeAdminSession]
  let total: Int
  let nextCursor: String?
}

@MainActor @Observable
final class AdminSessionsModel {
  let client: APIClient
  let scope: String
  var sessions: [NativeAdminSession] = []
  var nextCursor: String?
  var total = 0
  var error: String?
  private let loader = LoadGuard()
  var busy: Bool { loader.loading }
  private var cursors: Set<String> = []
  init(client: APIClient, scope: String) {
    self.client = client
    self.scope = scope
  }
  func load(category: String, more: Bool = false) async {
    if more && (busy || nextCursor == nil) { return }
    if !more { cursors = [] }
    let cursor = more ? nextCursor : nil
    var query = [
      URLQueryItem(name: "scope", value: scope), .init(name: "category", value: category),
      .init(name: "limit", value: "50"),
    ]
    if let cursor { query.append(.init(name: "cursor", value: cursor)) }
    await loader.run(restart: !more) {
      try await client.fetch("admin/api/sessions", query: query) as NativeAdminSessionPage
    } apply: { page in
      if !more { sessions = [] }
      var ids = Set(sessions.map(\.id))
      sessions.append(contentsOf: page.sessions.filter { ids.insert($0.id).inserted })
      total = page.total
      if let cursor { cursors.insert(cursor) }
      nextCursor = page.nextCursor
      if let nextCursor, cursors.contains(nextCursor) {
        self.nextCursor = nil
        throw QMError.message("The conversation list did not advance. Refresh to try again.")
      }
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
}

struct NativeAdminSessions: View {
  @State private var model: AdminSessionsModel
  @State private var category = "conversation"
  init(client: APIClient, scope: String) {
    _model = State(initialValue: AdminSessionsModel(client: client, scope: scope))
  }
  var body: some View {
    QMList {
      Picker("Kind", selection: $category) {
        Text("Conversations").tag("conversation")
        Text("Background").tag("background")
        Text("All").tag("all")
      }.pickerStyle(.segmented)
      Text("\(model.total) sessions").font(.caption).foregroundStyle(.secondary)
      ForEach(model.sessions) { session in
        NavigationLink {
          NativeAdminTranscript(client: model.client, scope: model.scope, session: session)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(session.title).font(.headline).lineLimit(2)
            Text(session.lastMessage).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            Text("\(session.scopeId) · \(session.turns) turns").font(.caption)
            Text(Date(timeIntervalSince1970: session.lastActivity / 1000), style: .relative).font(
              .caption)
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.busy { ProgressView() }
      if model.nextCursor != nil {
        Button("Load more") { Task { await model.load(category: category, more: true) } }.disabled(
          model.busy)
      }
    }.navigationTitle("Session history").task(id: category) { await model.load(category: category) }
      .refreshable { await model.load(category: category) }
  }
}

struct NativeAdminTranscript: View {
  struct Page: Decodable {
    struct Delivery: Decodable {
      let type: String
      let deliveryId: String
      let text: String
      let createdAt: Double
      let shadow: Bool?
    }
    let entries: [Entry]
    let deliveryEvents: [Delivery]?
    let hasMore: Bool
  }
  let client: APIClient
  let scope: String
  let session: NativeAdminSession
  @State private var page: Page?
  @State private var limit = 500
  @State private var busy = false
  @State private var error: String?
  @State private var activity = false
  var body: some View {
    QMList {
      Section {
        Text(session.title).font(.headline)
        LabeledContent("Scope", value: session.scopeId)
        Text(session.threadRef).font(.caption).textSelection(.enabled)
        Toggle("Show all activity", isOn: $activity)
      }
      if page?.hasMore == true {
        Button("Load more history") {
          limit = min(50000, limit + 1000)
          Task { await load() }
        }.disabled(busy)
      }
      if activity {
        ForEach(page?.entries ?? []) { entry in NativeActivityRow(entry: entry) }
      } else {
        ForEach(chatMessages(page?.entries ?? [])) { message in
          VStack(alignment: .leading, spacing: 8) {
            Text(message.speaker ?? (message.role == "user" ? "User" : "QM")).font(.caption.bold())
              .foregroundStyle(.secondary)
            Text(message.text).textSelection(.enabled)
            ForEach(Array(message.files.enumerated()), id: \.offset) { _, file in
              Text(file.name ?? "Attachment").font(.caption)
            }
          }.padding(.vertical, 6)
        }
      }
      if let deliveries = page?.deliveryEvents, !deliveries.isEmpty {
        Section("Deliveries") {
          ForEach(deliveries, id: \.deliveryId) { delivery in
            DisclosureGroup(
              delivery.shadow == true
                ? "Shadow delivery" : delivery.type.replacingOccurrences(of: "_", with: " ")
            ) {
              Text(delivery.text).textSelection(.enabled)
              Text(Date(timeIntervalSince1970: delivery.createdAt / 1000), style: .date)
            }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if busy { ProgressView() }
    }.navigationTitle("Transcript").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      page = try await client.fetch(
        "admin/api/sessions/\(session.id.apiComponent)",
        query: [.init(name: "scope", value: scope), .init(name: "limit", value: String(limit))])
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeAdminErrors: View {
  struct Page: Decodable {
    struct Event: Decodable {
      let ts: Double
      let category: String
      let code: String
      let message: String
      let scopeLabel: String
      let sessionId: String?
    }
    let errors: [Event]
    let total: Int
    let limit: Int
    let offset: Int
  }
  let client: APIClient
  let scope: String
  @State private var page: Page?
  @State private var offset = 0
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    QMList {
      ForEach(Array((page?.errors ?? []).enumerated()), id: \.offset) { _, event in
        DisclosureGroup {
          Text(event.message).textSelection(.enabled)
          LabeledContent("Scope", value: event.scopeLabel)
          if let session = event.sessionId {
            LabeledContent("Session", value: session).textSelection(.enabled)
          }
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(event.code).font(.headline)
            Text(event.category).font(.caption)
            Text(Date(timeIntervalSince1970: event.ts / 1000), style: .relative).font(.caption)
          }
        }
      }
      if let page {
        if page.total == 0 { Text("No errors recorded.") }
        HStack {
          Button("Newer") {
            offset = max(0, page.offset - page.limit)
            Task { await load() }
          }.disabled(page.offset == 0 || busy)
          Spacer()
          Text(
            "\(page.offset + (page.total == 0 ? 0 : 1))–\(min(page.total, page.offset + page.errors.count)) of \(page.total)"
          ).font(.caption)
          Spacer()
          Button("Older") {
            offset = page.offset + page.limit
            Task { await load() }
          }.disabled(page.offset + page.limit >= page.total || busy)
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if busy { ProgressView() }
    }.navigationTitle("Errors").task { await load() }.refreshable {
      offset = 0
      await load()
    }
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      page = try await client.fetch(
        "admin/api/errors",
        query: [
          .init(name: "scope", value: scope), .init(name: "offset", value: String(offset)),
          .init(name: "limit", value: "50"),
        ])
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeAdminRuns: View {
  struct Feed: Decodable {
    struct Run: Decodable, Identifiable {
      let id: String
      let status: String
      let sessionScope: String?
      let threadRef: String
      let attempts: Int
      let maxAttempts: Int
      let workerId: String?
      let leaseExpiresAt: Double?
      let createdAt: Double
      let startedAt: Double?
      let finishedAt: Double?
    }
    let active: Int
    let runs: [Run]
  }
  let client: APIClient
  let scope: String
  @State private var feed: Feed?
  @State private var error: String?
  @Environment(\.scenePhase) private var phase
  var body: some View {
    QMList {
      if let feed { Text("\(feed.active) active runs").font(.headline) }
      ForEach(feed?.runs ?? []) { run in
        DisclosureGroup {
          LabeledContent("Run", value: run.id)
          LabeledContent("Conversation", value: run.threadRef)
          LabeledContent("Attempts", value: "\(run.attempts) / \(run.maxAttempts)")
          if let worker = run.workerId { LabeledContent("Worker", value: worker) }
          if let started = run.startedAt {
            LabeledContent(
              "Started", value: Date(timeIntervalSince1970: started / 1000).formatted())
          }
          if let finished = run.finishedAt {
            LabeledContent(
              "Finished", value: Date(timeIntervalSince1970: finished / 1000).formatted())
          }
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(run.status.capitalized).font(.headline)
            Text(run.sessionScope ?? run.threadRef).font(.caption)
            Text(Date(timeIntervalSince1970: run.createdAt / 1000), style: .relative).font(.caption)
          }
        }.textSelection(.enabled)
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Runs").refreshable { await load() }
      .task(id: phase == .active) {
        guard phase == .active else { return }
        while !Task.isCancelled {
          await load()
          do { try await Task.sleep(for: .seconds(10)) } catch { return }
        }
      }
  }
  private func load() async {
    do {
      let result: Feed = try await client.fetch(
        "admin/api/runs", query: [.init(name: "scope", value: scope)])
      try Task.checkCancellation()
      feed = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
