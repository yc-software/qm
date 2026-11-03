import SwiftUI

struct NativeRetentionReport: Decodable {
  struct Active: Decodable {
    let dau: Int
    let wau: Int
    let mau: Int
    let stickiness: Double
  }
  struct Returning: Decodable {
    let window: String
    let newUsers: Int
    let returning: Int
  }
  struct Cohort: Decodable, Identifiable {
    let week: String
    let size: Int
    let retained: [Double]
    var id: String { week }
    func observed(_ offset: Int, at generatedAt: Double) -> Bool {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withFullDate]
      formatter.timeZone = TimeZone(secondsFromGMT: 0)
      guard let start = formatter.date(from: week), offset >= 0 else { return false }
      return start.timeIntervalSince1970 + Double(offset) * 7 * 86400 <= generatedAt / 1000
    }
  }
  struct Distribution: Decodable {
    let p50: Double
    let p95: Double
  }
  struct PerUser: Decodable {
    let sessions: Distribution
    let turns: Distribution
  }
  struct Totals: Decodable {
    let users: Int
    let sessions: Int
  }
  let generatedAt: Double
  let active: Active
  let newVsReturning: Returning
  let cohorts: [Cohort]
  let perUser: PerUser
  let totals: Totals
  let attribution: String
}

struct NativeAdminRetention: View {
  let client: APIClient
  let scope: String
  @State private var report: NativeRetentionReport?
  @State private var error: String?
  var body: some View {
    QMList {
      if let report {
        Section("Active people") {
          LabeledContent("Today", value: String(report.active.dau))
          LabeledContent("Last 7 days", value: String(report.active.wau))
          LabeledContent("Last 30 days", value: String(report.active.mau))
          LabeledContent(
            "Daily / monthly active", value: "\(report.active.stickiness.formatted())%")
        }
        Section("New and returning · \(report.newVsReturning.window)") {
          LabeledContent("New people", value: String(report.newVsReturning.newUsers))
          LabeledContent("Returning people", value: String(report.newVsReturning.returning))
        }
        Section("Weekly cohorts") {
          if report.cohorts.isEmpty { Text("No cohorts yet.").foregroundStyle(.secondary) }
          ForEach(report.cohorts) { cohort in
            DisclosureGroup(
              "\(cohort.week) · \(cohort.size) \(cohort.size == 1 ? "person" : "people")"
            ) {
              ForEach(Array(cohort.retained.enumerated()), id: \.offset) { offset, retained in
                LabeledContent(
                  "Week \(offset)",
                  value: cohort.observed(offset, at: report.generatedAt)
                    ? "\(retained.formatted())%" : "Not yet observed")
              }
            }
          }
          Text(
            "Each percentage is the share of that cohort active in the week. Future weeks are not yet observed."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Section("Per person") {
          LabeledContent("Median conversations", value: report.perUser.sessions.p50.formatted())
          LabeledContent(
            "95th percentile conversations", value: report.perUser.sessions.p95.formatted())
          LabeledContent("Median turns", value: report.perUser.turns.p50.formatted())
          LabeledContent("95th percentile turns", value: report.perUser.turns.p95.formatted())
        }
        Section("Coverage") {
          LabeledContent("People", value: String(report.totals.users))
          LabeledContent("Conversations", value: String(report.totals.sessions))
          Text(report.attribution).font(.caption).foregroundStyle(.secondary)
          Text("Updated \(Date(timeIntervalSince1970: report.generatedAt / 1000).formatted())")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if report == nil && error == nil { ProgressView() }
    }.navigationTitle("Retention").task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      let result: NativeRetentionReport = try await client.fetch(
        "admin/api/retention", query: [.init(name: "scope", value: scope)])
      try Task.checkCancellation()
      report = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeEgressReport: Decodable {
  struct Record: Decodable {
    let ts: Double
    let source: String
    let host: String
    let scopeLabel: String
    let principalId: String?
    let allowed: Bool
    let status: String
    let slug: String?
    let upstreamStatus: Int?
    let port: Int?
    let via: String?
    let peerIp: String?
  }
  let records: [Record]
  let total: Int
  let denied: Int
  let hosts: Int
}

struct NativeAdminEgress: View {
  let client: APIClient
  let scope: String
  @State private var report: NativeEgressReport?
  @State private var error: String?
  @State private var deniedOnly = false
  @State private var search = ""
  private var records: [NativeEgressReport.Record] {
    (report?.records ?? []).filter {
      (!deniedOnly || !$0.allowed)
        && (search.isEmpty || $0.host.localizedCaseInsensitiveContains(search)
          || ($0.principalId ?? "").localizedCaseInsensitiveContains(search))
    }
  }
  var body: some View {
    QMList {
      if let report {
        Section("Recent network activity") {
          LabeledContent("Recorded requests", value: String(report.total))
          LabeledContent("Denied", value: String(report.denied))
          LabeledContent("Hosts", value: String(report.hosts))
          Text("This is the server’s recent activity window, not a complete history.")
            .font(.caption).foregroundStyle(.secondary)
          Toggle("Denied only", isOn: $deniedOnly)
        }
        Section("Requests") {
          if records.isEmpty { Text("No matching requests.").foregroundStyle(.secondary) }
          ForEach(Array(records.enumerated()), id: \.offset) { _, record in
            DisclosureGroup {
              LabeledContent("Status", value: record.status)
              LabeledContent("Source", value: record.source)
              LabeledContent("Scope", value: record.scopeLabel)
              if let principal = record.principalId { LabeledContent("Person", value: principal) }
              if let slug = record.slug { LabeledContent("Credential", value: slug) }
              if let code = record.upstreamStatus {
                LabeledContent("HTTP status", value: String(code))
              }
              if let port = record.port { LabeledContent("Port", value: String(port)) }
              if let via = record.via { LabeledContent("Via", value: via) }
              if let ip = record.peerIp { LabeledContent("Peer", value: ip) }
              Text(Date(timeIntervalSince1970: record.ts / 1000).formatted()).font(.caption)
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Label(
                  record.host.isEmpty ? "Unknown host" : record.host,
                  systemImage: record.allowed ? "checkmark.circle" : "hand.raised"
                )
                .foregroundStyle(record.allowed ? Color.primary : Color.red)
                Text("\(record.allowed ? "Allowed" : "Denied") · \(record.source)")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }.textSelection(.enabled)
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if report == nil && error == nil { ProgressView() }
    }.navigationTitle("Network activity").searchable(text: $search, prompt: "Host or person")
      .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      let result: NativeEgressReport = try await client.fetch(
        "admin/api/egress", query: [.init(name: "scope", value: scope)])
      try Task.checkCancellation()
      report = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
