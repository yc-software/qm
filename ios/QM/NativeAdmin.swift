import Charts
import SwiftUI

struct NativeAdminScope: Decodable, Identifiable {
  let scopeId: String
  let label: String?
  let sessions: Int
  let backgroundSessions: Int
  let lastActivity: Double
  let lastMessage: String
  let crons: Int
  let deployments: Int
  let skills: Int
  var id: String { scopeId }
}
struct NativeAdminScopes: Decodable {
  let scopeId: String
  let scopes: [NativeAdminScope]
}
struct NativeAdminStatus: Decodable {
  let isAdmin: Bool
  let role: String?
  let scopeId: String?
}
struct NativeAdminUsers: Decodable {
  struct User: Decodable, Identifiable {
    let principalId: String
    let sessionCount: Int
    let turnCount: Int
    let lastSeenAt: Double?
    let admin: NativeAdminStatus
    var id: String { principalId }
  }
  struct Grant: Decodable, Identifiable {
    let principalId: String
    let scopeId: String
    let role: String
    let grantedBy: String?
    var id: String { principalId + "|" + scopeId + "|" + role }
  }
  struct External: Decodable, Identifiable {
    let email: String
    let role: String
    let kind: String?
    let status: String
    let expiresAt: Double?
    var id: String { email }
  }
  struct InviteEmail: Decodable {
    let configured: Bool
    let problem: String?
  }
  let scopeId: String
  let users: [User]
  let grants: [Grant]
  let externalUsers: [External]
  let inviteEmail: InviteEmail
}
struct NativeAdminMetrics: Decodable {
  struct Latency: Decodable {
    let count: Int
    let p50: Double?
    let p95: Double?
    let p99: Double?
  }
  struct Throughput: Decodable {
    let total: Int
    let done: Int
    let failed: Int
    let failureRate: Double
  }
  struct Day: Decodable, Identifiable {
    let day: String
    let turns: Int
    let ttftP50: Double?
    var id: String { day }
  }
  let ttft: Latency
  let turnLatency: Latency
  let runLatency: Latency
  let queueWait: Latency
  let throughput: Throughput
  let series: [Day]
}

struct NativeAdminView: View {
  let client: APIClient
  @State private var scopes: NativeAdminScopes?
  @State private var error: String?
  @State private var search = ""
  var body: some View {
    QMList {
      Section("Organization") {
        NavigationLink("People and access") { NativeAdminPeople(client: client) }
        NavigationLink("Model providers") { NativeAdminProviders(client: client) }
        NavigationLink("Model registry") { NativeModelRegistry(client: client) }
        NavigationLink("Keychain audit") { NativeAdminKeychain(client: client) }
        NavigationLink("MCP servers") { NativeAdminMCP(client: client) }
        if let scope = scopes?.scopeId {
          NavigationLink("Retention") { NativeAdminRetention(client: client, scope: scope) }
          NavigationLink("Network activity") { NativeAdminEgress(client: client, scope: scope) }
          NavigationLink("Performance") { NativeAdminPerformance(client: client, scope: scope) }
          NavigationLink("Audit log") { NativeAdminAudit(client: client, scope: scope) }
          NavigationLink("Session history") { NativeAdminSessions(client: client, scope: scope) }
          NavigationLink("Runs") { NativeAdminRuns(client: client, scope: scope) }
          NavigationLink("Errors") { NativeAdminErrors(client: client, scope: scope) }
          NavigationLink("Governance and settings") {
            NativeAdminSettings(client: client, scope: scope)
          }
        }
      }
      Section("Scopes") {
        ForEach(
          (scopes?.scopes ?? []).filter {
            search.isEmpty || ($0.label ?? $0.scopeId).localizedCaseInsensitiveContains(search)
              || $0.scopeId.localizedCaseInsensitiveContains(search)
          }
        ) { scope in
          NavigationLink {
            NativeAdminScopeView(client: client, scope: scope)
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text(scope.label ?? scope.scopeId).font(.headline)
              Text(
                "\(scope.sessions) conversations · \(scope.crons) crons · \(scope.skills) skills"
              )
              .font(.caption).foregroundStyle(.secondary)
              if !scope.lastMessage.isEmpty {
                Text(scope.lastMessage).font(.subheadline).lineLimit(2)
              }
            }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if scopes == nil && error == nil { ProgressView() }
    }
    .navigationTitle("Admin").searchable(text: $search, prompt: "Find a scope")
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      scopes = try await client.fetch("admin/api/scopes")
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminScopeView: View {
  let client: APIClient
  let scope: NativeAdminScope
  var body: some View {
    QMList {
      Section {
        LabeledContent("Scope", value: scope.scopeId).textSelection(.enabled)
        LabeledContent("Conversations", value: String(scope.sessions))
        LabeledContent("Background sessions", value: String(scope.backgroundSessions))
        LabeledContent("Apps", value: String(scope.deployments))
        LabeledContent("Crons", value: String(scope.crons))
        LabeledContent("Skills", value: String(scope.skills))
      }
      NavigationLink("Governance and settings") {
        NativeAdminSettings(client: client, scope: scope.id)
      }
      NavigationLink("Network activity") { NativeAdminEgress(client: client, scope: scope.id) }
      NavigationLink("Performance") { NativeAdminPerformance(client: client, scope: scope.id) }
      NavigationLink("Audit log") { NativeAdminAudit(client: client, scope: scope.id) }
      NavigationLink("Session history") { NativeAdminSessions(client: client, scope: scope.id) }
      NavigationLink("Runs") { NativeAdminRuns(client: client, scope: scope.id) }
      NavigationLink("Errors") { NativeAdminErrors(client: client, scope: scope.id) }
    }.navigationTitle(scope.label ?? scope.scopeId).navigationBarTitleDisplayMode(.inline)
  }
}

struct NativeAdminPerformance: View {
  let client: APIClient
  let scope: String
  @State private var metrics: NativeAdminMetrics?
  @State private var error: String?
  var body: some View {
    QMList {
      if let metrics {
        Section("Runs") {
          LabeledContent("Total", value: String(metrics.throughput.total))
          LabeledContent("Completed", value: String(metrics.throughput.done))
          LabeledContent("Failed", value: String(metrics.throughput.failed))
          LabeledContent(
            "Failure rate",
            value: metrics.throughput.failureRate.formatted(.percent.precision(.fractionLength(1))))
        }
        if !metrics.series.isEmpty {
          Section("Daily turns") {
            Chart(metrics.series) { day in
              BarMark(x: .value("Day", day.day), y: .value("Turns", day.turns)).foregroundStyle(
                QMTheme.navy)
            }.frame(height: 180)
          }
        }
        latency("First response", metrics.ttft)
        latency("Turn duration", metrics.turnLatency)
        latency("Run duration", metrics.runLatency)
        latency("Queue wait", metrics.queueWait)
      }
      if let error { Text(error).foregroundStyle(.red) }
      if metrics == nil && error == nil { ProgressView() }
    }.navigationTitle("Performance").task { await load() }.refreshable { await load() }
  }
  private func latency(_ title: String, _ value: NativeAdminMetrics.Latency) -> some View {
    Section(title) {
      LabeledContent("Samples", value: String(value.count))
      LabeledContent("Median", value: duration(value.p50))
      LabeledContent("95th percentile", value: duration(value.p95))
      LabeledContent("99th percentile", value: duration(value.p99))
    }
  }
  private func duration(_ ms: Double?) -> String {
    ms.map { ($0 / 1000).formatted(.number.precision(.fractionLength(2))) + " s" } ?? "No samples"
  }
  private func load() async {
    do {
      metrics = try await client.fetch(
        "admin/api/metrics", query: [.init(name: "scope", value: scope)])
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminAudit: View {
  struct Feed: Decodable {
    struct Event: Decodable {
      let ts: Double
      let principalId: String
      let action: String
      let scopeLabel: String
      let resource: String
      let status: String?
    }
    let events: [Event]
  }
  let client: APIClient
  let scope: String
  @State private var feed: Feed?
  @State private var action = ""
  @State private var resource = ""
  @State private var error: String?
  var body: some View {
    QMList {
      Section("Filter") {
        TextField("Action", text: $action).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        TextField("Resource contains", text: $resource).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Apply filters") { Task { await load() } }
      }
      Section("Recent events") {
        ForEach(Array((feed?.events ?? []).enumerated()), id: \.offset) { _, event in
          DisclosureGroup {
            LabeledContent("Actor", value: event.principalId)
            LabeledContent("Scope", value: event.scopeLabel)
            LabeledContent("Resource", value: event.resource)
            if let status = event.status { LabeledContent("Status", value: status) }
          } label: {
            VStack(alignment: .leading) {
              Text(event.action)
              Text(Date(timeIntervalSince1970: event.ts / 1000), style: .date).font(.caption)
              Text(Date(timeIntervalSince1970: event.ts / 1000), style: .time).font(.caption)
            }
          }.textSelection(.enabled)
        }
        if feed?.events.isEmpty == true { Text("No matching events.").foregroundStyle(.secondary) }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Audit log").task { await load() }.refreshable { await load() }
  }
  private func load() async {
    let currentAction = action
    let currentResource = resource
    do {
      var query = [URLQueryItem(name: "scope", value: scope)]
      if !action.isEmpty { query.append(.init(name: "action", value: action)) }
      if !resource.isEmpty { query.append(.init(name: "resource", value: resource)) }
      let result: Feed = try await client.fetch("admin/api/audit", query: query)
      guard action == currentAction && resource == currentResource else { return }
      feed = result
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

@MainActor @Observable
final class AdminPeopleModel {
  let client: APIClient
  var people: NativeAdminUsers?
  var busy = false
  var error: String?
  private var revision = UUID()
  init(client: APIClient) { self.client = client }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    let current = UUID()
    revision = current
    do {
      let result: NativeAdminUsers = try await client.fetch("admin/api/users")
      try Task.checkCancellation()
      guard current == revision else { return }
      people = result
      error = nil
    } catch { if current == revision { self.error = error.localizedDescription } }
  }
  func grant(_ user: NativeAdminUsers.User) async {
    guard let people, !busy else { return }
    busy = true
    revision = UUID()
    defer { busy = false }
    do {
      if user.admin.isAdmin {
        guard let scope = user.admin.scopeId, let role = user.admin.role else {
          throw QMError.message("Reload this person's access before changing it.")
        }
        let _: MutationReceipt = try await client.fetch(
          "admin/api/grants/\(user.id.apiComponent)",
          query: [.init(name: "scope", value: scope), .init(name: "role", value: role)],
          method: "DELETE")
      } else {
        let _: MutationReceipt = try await client.fetch(
          "admin/api/grants",
          body: [
            "principalId": user.id, "scopeId": people.scopeId, "role": "org_admin",
          ])
      }
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
  func revoke(_ member: NativeAdminUsers.External) async {
    guard !busy else { return }
    busy = true
    revision = UUID()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/external-users/\(member.email.apiComponent)", method: "DELETE")
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminPeople: View {
  @State private var model: AdminPeopleModel
  @State private var search = ""
  @State private var changing: NativeAdminUsers.User?
  @State private var revoking: NativeAdminUsers.External?
  @State private var inviting = false
  init(client: APIClient) { _model = State(initialValue: AdminPeopleModel(client: client)) }
  var body: some View {
    QMList {
      if let people = model.people {
        Section("People") {
          ForEach(
            people.users.filter { search.isEmpty || $0.id.localizedCaseInsensitiveContains(search) }
          ) { user in
            VStack(alignment: .leading, spacing: 8) {
              NavigationLink(user.id) {
                NativeAdminPerson(client: model.client, principal: user.id)
              }
              Text("\(user.sessionCount) conversations · \(user.turnCount) turns").font(.caption)
              if let last = user.lastSeenAt {
                Text(Date(timeIntervalSince1970: last / 1000), style: .relative).font(.caption)
                  .foregroundStyle(.secondary)
              }
              Button(user.admin.isAdmin ? "Remove admin access" : "Make organization admin") {
                changing = user
              }
              .foregroundStyle(user.admin.isAdmin ? .red : QMTheme.navy)
            }.padding(.vertical, 4)
          }
        }
        Section("Invited accounts") {
          ForEach(
            people.externalUsers.filter {
              search.isEmpty || $0.email.localizedCaseInsensitiveContains(search)
            }
          ) { member in
            VStack(alignment: .leading, spacing: 8) {
              Text(member.email).font(.headline)
              Text("\(member.kind ?? "Guest") · \(member.role) · \(member.status)").font(.caption)
              if let expires = member.expiresAt {
                Text("Expires \(Date(timeIntervalSince1970: expires / 1000).formatted())").font(
                  .caption)
              }
              Button("Revoke access", role: .destructive) { revoking = member }
            }
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if model.people == nil && model.error == nil { ProgressView() }
    }
    .disabled(model.busy).navigationTitle("People and access").searchable(text: $search)
    .toolbar {
      Button("Invite", systemImage: "person.badge.plus") { inviting = true }.disabled(
        model.people == nil || model.busy)
    }
    .task { await model.load() }.refreshable { await model.load() }
    .confirmationDialog(
      changing?.admin.isAdmin == true
        ? "Remove organization admin access?" : "Grant organization admin access?",
      isPresented: Binding(get: { changing != nil }, set: { if !$0 { changing = nil } })
    ) {
      if let user = changing {
        Button(
          user.admin.isAdmin ? "Remove admin" : "Make admin",
          role: user.admin.isAdmin ? .destructive : nil
        ) { Task { await model.grant(user) } }
      }
    } message: {
      Text("This changes \(changing?.id ?? "this person's") ability to govern the organization.")
    }
    .confirmationDialog(
      "Revoke account access?",
      isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
    ) {
      if let member = revoking {
        Button("Revoke access", role: .destructive) { Task { await model.revoke(member) } }
      }
    } message: {
      Text("\(revoking?.email ?? "This account") will lose access to QM.")
    }
    .sheet(
      isPresented: $inviting, onDismiss: { Task { await model.load() } },
      content: {
        NativeAdminInvite(client: model.client)
      })
  }
}

struct NativeAdminPerson: View {
  struct Detail: Decodable {
    struct Stats: Decodable { let sessions: Int }
    let principalId: String
    let scopeId: String
    let displayName: String?
    let admin: NativeAdminStatus
    let stats: Stats
    let onboarding: String?
  }
  let client: APIClient
  let principal: String
  @State private var detail: Detail?
  @State private var status = "pending"
  @State private var confirming = false
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    QMForm {
      if let detail {
        Section {
          LabeledContent("Name", value: detail.displayName ?? detail.principalId)
          LabeledContent("Account", value: detail.principalId)
          LabeledContent("Admin", value: detail.admin.isAdmin ? "Yes" : "No")
          LabeledContent("Conversations", value: String(detail.stats.sessions))
          NavigationLink("Scope settings") {
            NativeAdminSettings(client: client, scope: detail.scopeId)
          }
        }
        Section("Onboarding") {
          Picker("Status", selection: $status) {
            Text("Not started").tag("not_started")
            Text("Pending").tag("pending")
            Text("Completed").tag("completed")
            Text("Dismissed").tag("dismissed")
          }
          Button("Apply onboarding status") { confirming = true }.disabled(
            status == detail.onboarding)
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.disabled(busy).navigationTitle("Person").task { await load() }
      .confirmationDialog("Change onboarding status?", isPresented: $confirming) {
        Button("Apply") { Task { await save() } }
      } message: {
        Text(
          "Update onboarding for \(principal) to \(status.replacingOccurrences(of: "_", with: " "))."
        )
      }
  }
  private func load() async {
    do {
      detail = try await client.fetch("admin/api/users/\(principal.apiComponent)")
      status = detail?.onboarding ?? "not_started"
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/users/\(principal.apiComponent)/onboarding", body: ["status": status],
        method: "PUT")
      await load()
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminInvite: View {
  struct Receipt: Decodable {
    let emailSent: Bool?
    let emailProblem: String?
    let signInUrl: String?
  }
  let client: APIClient
  @Environment(\.dismiss) private var dismiss
  @State private var email = ""
  @State private var guest = false
  @State private var role = "member"
  @State private var expires = Date().addingTimeInterval(30 * 86400)
  @State private var busy = false
  @State private var confirming = false
  @State private var receipt: Receipt?
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMForm {
        if let receipt {
          Text(
            receipt.emailSent == true
              ? "Invitation email sent."
              : "Access granted. Share the sign-in link with this person.")
          if let problem = receipt.emailProblem { Text(problem).foregroundStyle(.orange) }
          if let raw = receipt.signInUrl, let url = URL(string: raw),
            ["http", "https"].contains(url.scheme ?? "")
          {
            ShareLink("Share sign-in link", item: url)
          }
        } else {
          TextField("Email address", text: $email).keyboardType(.emailAddress)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Toggle("Temporary guest", isOn: $guest)
          Picker("Role", selection: $role) {
            Text("Member").tag("member")
            Text("Organization admin").tag("org_admin")
          }
          if guest {
            DatePicker("Expires", selection: $expires, in: Date()..., displayedComponents: .date)
          }
          Text(
            "Inviting grants access and sends an invitation email when email delivery is configured."
          ).font(.caption)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.disabled(busy).navigationTitle("Invite person")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(receipt == nil ? "Cancel" : "Done") { dismiss() }.disabled(busy)
          }
          if receipt == nil {
            ToolbarItem(placement: .confirmationAction) {
              Button("Invite") { confirming = true }.disabled(busy || !email.contains("@"))
            }
          }
        }.interactiveDismissDisabled(busy)
        .confirmationDialog("Invite \(email)?", isPresented: $confirming) {
          Button("Grant access and invite") { Task { await invite() } }
        } message: {
          Text(
            role == "org_admin"
              ? "This person will be able to govern your organization."
              : "This person will receive member access to QM.")
        }
    }
  }
  private func invite() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      var body: [String: Any] = [
        "email": email.trimmingCharacters(in: .whitespacesAndNewlines), "role": role,
      ]
      if guest { body["expiresAt"] = expires.timeIntervalSince1970 * 1000 }
      receipt = try await client.fetch(
        guest ? "admin/api/external-users" : "admin/api/users/invite", body: body)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
