import SwiftUI

struct NativeAdminKeychainReport: Decodable {
  struct Person: Decodable, Identifiable {
    let principalId: String
    let displayName: String?
    let credentialCount: Int
    let activeGrantCount: Int
    let pendingAskCount: Int
    var id: String { principalId }
  }
  let enabled: Bool
  let people: [Person]
  let credentials: [NativeCredential]
  let grants: [NativeCredentialGrant]
  let asks: [NativeCredentialAsk]
}

struct NativeAdminKeychain: View {
  let client: APIClient
  @State private var report: NativeAdminKeychainReport?
  @State private var error: String?
  @State private var search = ""
  var body: some View {
    QMList {
      if let report {
        if report.enabled {
          Section {
            Text(
              "Credential metadata, grants and access requests across the organization. Secret values are never displayed."
            )
            .font(.subheadline).foregroundStyle(.secondary)
            LabeledContent("Credentials", value: String(report.credentials.count))
            LabeledContent("Grants", value: String(report.grants.count))
            NavigationLink("Inspect credentials and access") {
              NativeAdminKeychainRecords(report: report)
            }
          }
          Section("People") {
            ForEach(
              report.people.filter {
                search.isEmpty || $0.principalId.localizedCaseInsensitiveContains(search)
                  || ($0.displayName ?? "").localizedCaseInsensitiveContains(search)
              }
            ) { person in
              VStack(alignment: .leading, spacing: 6) {
                Text(person.displayName ?? person.principalId).font(.headline)
                Text(
                  "\(person.credentialCount) credentials · \(person.activeGrantCount) active grants"
                )
                .font(.caption).foregroundStyle(.secondary)
                if person.pendingAskCount > 0 {
                  Text("\(person.pendingAskCount) pending requests").font(.caption)
                }
              }
            }
            if report.people.isEmpty {
              Text("No keychain activity yet.").foregroundStyle(.secondary)
            }
          }
        } else {
          ContentUnavailableView(
            "Keychain unavailable", systemImage: "key",
            description: Text("Keychain is not enabled for this deployment."))
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if report == nil && error == nil { ProgressView() }
    }.navigationTitle("Keychain audit").searchable(text: $search, prompt: "Find a person")
      .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      let result: NativeAdminKeychainReport = try await client.fetch("admin/api/keychain")
      try Task.checkCancellation()
      report = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

private struct NativeAdminKeychainRecords: View {
  let report: NativeAdminKeychainReport
  private func credentialName(_ id: String) -> String {
    report.credentials.first(where: { $0.id == id })?.service ?? id
  }
  var body: some View {
    QMList {
      Section("Credentials") {
        ForEach(report.credentials) { credential in
          DisclosureGroup(credential.service) {
            LabeledContent("ID", value: credential.id)
            if let owner = credential.ownerId { LabeledContent("Owner", value: owner) }
            if let account = credential.accountLabel { LabeledContent("Account", value: account) }
            if let kind = credential.kind { LabeledContent("Kind", value: kind) }
            if let host = credential.host { LabeledContent("Host", value: host) }
            if let env = credential.envKey { LabeledContent("Environment key", value: env) }
            if let fingerprint = credential.fingerprint {
              LabeledContent("Fingerprint", value: fingerprint)
            }
            if let expiry = credential.expiresAt {
              LabeledContent(
                "Expires", value: Date(timeIntervalSince1970: expiry / 1000).formatted())
            }
          }.textSelection(.enabled)
        }
      }
      Section("Grants") {
        ForEach(report.grants) { grant in
          DisclosureGroup {
            if let owner = grant.ownerId { LabeledContent("Owner", value: owner) }
            LabeledContent("Audience", value: grant.audienceScopeId)
            LabeledContent("Mode", value: grant.mode)
            Text(grant.purpose).textSelection(.enabled)
            if let count = grant.useCount { LabeledContent("Uses", value: String(count)) }
            if let usedBy = grant.usedBy { LabeledContent("Used by", value: usedBy) }
            if let expiry = grant.expiresAt {
              LabeledContent(
                "Expires", value: Date(timeIntervalSince1970: expiry / 1000).formatted())
            }
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(credentialName(grant.credentialId)).font(.headline)
              Text(grant.status).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      Section("Access requests") {
        ForEach(report.asks) { ask in
          DisclosureGroup {
            if let owner = ask.ownerId { LabeledContent("Owner", value: owner) }
            LabeledContent("Requested by", value: ask.requesterId)
            if let scope = ask.requesterScopeId { LabeledContent("Scope", value: scope) }
            Text(ask.purpose).textSelection(.enabled)
            LabeledContent(
              "Expires", value: Date(timeIntervalSince1970: ask.expiresAt / 1000).formatted())
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(credentialName(ask.credentialId)).font(.headline)
              Text(ask.status ?? "Unknown").font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
    }.navigationTitle("Credentials and access")
  }
}
