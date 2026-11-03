import SwiftUI

struct NativeDeployment: Decodable, Identifiable {
  struct Version: Decodable, Identifiable {
    let version: Int
    let createdAt: Double
    let commit: String?
    var id: Int { version }
  }
  let id: String
  let status: String?
  let ownerScopeId: String?
  let createdBy: String?
  let createdInScope: String?
  let currentVersion: Int?
  let appliedVersion: Int?
  let webUrl: String?
  let name: String?
  let displayName: String?
  let permission: String?
  let versions: [Version]?
  var title: String {
    [displayName, name].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first {
      !$0.isEmpty
    } ?? id
  }
  var canManage: Bool { permission == "write" }
  func tab(user: String) -> String {
    if status == "archived" { return "Archived" }
    return ownerScopeId == "personal:\(user)"
      || (ownerScopeId.flatMap(ScopeKind.init(scopeId:)) != .personal && createdBy == user)
      ? "Yours" : "Shared"
  }
  func url(base: URL) -> URL? {
    guard let webUrl, let url = URL(string: webUrl, relativeTo: base)?.absoluteURL,
      ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil
    else { return nil }
    return url
  }
}
struct NativeDeployments: Decodable { let deployments: [NativeDeployment] }
struct NativeDeploymentResult: Decodable { let deployment: NativeDeployment }

struct NativeAppsView: View {
  let client: APIClient
  let user: String
  var scope: String? = nil
  @State private var apps: [NativeDeployment] = []
  @State private var tab = "Yours"
  @State private var query = ""
  @State private var error: String?
  @State private var loading = false
  private var filtered: [NativeDeployment] {
    apps.filter {
      $0.tab(user: user) == tab
        && (scope == nil || $0.ownerScopeId == scope || $0.createdInScope == scope)
        && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query))
    }
    .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
  }
  var body: some View {
    QMList {
      Picker("Show", selection: $tab) {
        ForEach(["Yours", "Shared", "Archived"], id: \.self) { Text($0) }
      }.pickerStyle(.segmented)
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(filtered) { app in
        NavigationLink {
          NativeAppDetail(client: client, user: user, original: app)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(app.title).font(.headline)
            Text("\(app.status ?? "Unknown") · \(app.canManage ? "Can manage" : "Can view")").font(
              .caption
            ).foregroundStyle(.secondary)
          }.padding(.vertical, 8)
        }
      }
      if filtered.isEmpty && !loading {
        ContentUnavailableView(
          "No apps here yet", systemImage: "square.stack.3d.up",
          description: Text("Apps you create with QM will appear here."))
      }
    }
    .navigationTitle("Apps").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    loading = true
    defer { loading = false }
    do {
      let result: NativeDeployments = try await client.fetch("api/deployments")
      try Task.checkCancellation()
      apps = result.deployments
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeAppDetail: View {
  let client: APIClient
  let user: String
  let original: NativeDeployment
  @State private var current: NativeDeployment?
  @State private var loader = LoadGuard()
  @State private var error: String?
  @State private var busy = false
  @State private var name = ""
  @State private var editingName = false
  @State private var slug = ""
  @State private var editingSlug = false
  @State private var archive = false
  private var app: NativeDeployment { current ?? original }
  var body: some View {
    QMList {
      Section {
        LabeledContent("Status", value: app.status ?? "Unknown")
        if let version = app.appliedVersion ?? app.currentVersion {
          LabeledContent("Live version", value: String(version))
        }
        if let url = app.url(base: client.baseURL) {
          if app.status == "running" { Link("Open app in browser", destination: url) }
          ShareLink("Share app URL", item: url)
        }
        if let owner = app.ownerScopeId { LabeledContent("Owner", value: owner) }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if app.canManage {
        Section("Settings") {
          Button("Edit display name") {
            name = app.displayName ?? ""
            editingName = true
          }
          Button("Change app URL") {
            slug = app.name ?? app.id
            editingSlug = true
          }
          if app.ownerScopeId == "personal:\(user)" {
            NavigationLink("Permissions") { NativeAppPermissions(client: client, app: app) }
          }
          Button(
            app.status == "archived" ? "Restore deployment" : "Archive deployment",
            role: app.status == "archived" ? nil : .destructive
          ) { archive = true }
        }.disabled(busy)
      }
      Section("Version history") {
        ForEach((app.versions ?? []).sorted { $0.version > $1.version }) { version in
          VStack(alignment: .leading, spacing: 6) {
            Text("v\(version.version)\(version.version == app.appliedVersion ? " · Live" : "")")
              .font(.headline)
            Text(Date(timeIntervalSince1970: version.createdAt / 1000), style: .date).font(.caption)
            if let commit = version.commit {
              Text(commit).font(.caption.monospaced()).textSelection(.enabled)
            }
          }
        }
        if app.versions?.isEmpty != false {
          Text("No version history available.").foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle(app.title).navigationBarTitleDisplayMode(.inline)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await load() }.refreshable { await load() }
    .alert("Display name", isPresented: $editingName) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        Task {
          await mutate(
            "display-name",
            body: ["displayName": name.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
      }
    }
    .alert("Change app URL", isPresented: $editingSlug) {
      TextField("URL slug", text: $slug).textInputAutocapitalization(.never)
        .autocorrectionDisabled()
      Button("Cancel", role: .cancel) {}
      Button("Change URL") {
        Task {
          await mutate("name", body: ["name": slug.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
      }.disabled(slug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    } message: {
      Text("Existing links will stop working. They do not redirect to the new URL.")
    }
    .confirmationDialog(
      app.status == "archived" ? "Restore this deployment?" : "Archive this deployment?",
      isPresented: $archive
    ) {
      Button(
        app.status == "archived" ? "Restore" : "Archive",
        role: app.status == "archived" ? nil : .destructive
      ) { Task { await mutate(app.status == "archived" ? "restore" : "archive") } }
    } message: {
      Text(
        app.status == "archived"
          ? "The app will be available again."
          : "The app will stop being available. You can restore it later.")
    }
  }
  private func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      try await client.fetch("api/deployments/\(original.id.apiComponent)")
        as NativeDeploymentResult
    } apply: { result in
      current = result.deployment
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  private func mutate(_ action: String, body: [String: Any] = [:]) async {
    guard !busy else { return }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/deployments/\(app.id.apiComponent)/\(action)", body: body)
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAppGrant: Decodable, Identifiable {
  let scope: String
  let permission: String
  var id: String { scope }
}
struct NativeAppGrants: Decodable { let grantees: [NativeAppGrant] }
struct NativeAppPermissions: View {
  let client: APIClient
  let app: NativeDeployment
  @State private var grants: [NativeAppGrant] = []
  @State private var query = ""
  @State private var matches: [DirectoryPerson] = []
  @State private var selected: DirectoryPerson?
  @State private var access = "view"
  @State private var pending: (scope: String, access: String)?
  @State private var busy = false
  @State private var loaded = false
  @State private var error: String?
  private var endpoint: String { "api/deployments/\(app.id.apiComponent)/share" }
  var body: some View {
    QMList {
      if let error { Text(error).foregroundStyle(.red) }
      Section("People with access") {
        ForEach(grants) { grant in
          HStack {
            Text(grant.scope)
            Spacer()
            Menu(grant.permission == "write" ? "Can manage" : "Can view") {
              Button("Can view") { pending = (grant.scope, "view") }
              Button("Can manage") { pending = (grant.scope, "manage") }
              Button("Remove access", role: .destructive) { pending = (grant.scope, "none") }
            }
          }
        }
      }
      Section("Add people") {
        TextField("Name or email", text: $query)
        ForEach(
          matches.filter { person in
            "personal:\(person.id)" != app.ownerScopeId
              && !grants.contains(where: { $0.scope == "personal:\(person.id)" })
          }
        ) { person in
          Button(person.displayName) { selected = person }
        }
        if let selected {
          LabeledContent("Person", value: selected.displayName)
          Picker("Access", selection: $access) {
            Text("Can view").tag("view")
            Text("Can manage").tag("manage")
          }
          Button("Grant access") { pending = ("personal:\(selected.id)", access) }.disabled(!loaded)
        }
      }
    }
    .disabled(busy).navigationTitle("App permissions")
    .refreshable { if !busy { await load() } }
    .task { await load() }
    .task(id: query) {
      matches = []
      guard query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else { return }
      do {
        try await Task.sleep(for: .milliseconds(250))
        let result: DirectoryMatches = try await client.fetch(
          "api/directory/resolve", query: [.init(name: "q", value: query)])
        try Task.checkCancellation()
        matches = result.matches
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    .confirmationDialog(
      "Update access?",
      isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
    ) {
      if let pending {
        Button("Confirm") { Task { await change(pending.scope, access: pending.access) } }
      }
    } message: {
      if let pending {
        Text(
          "\(pending.scope) will \(pending.access == "none" ? "lose access to" : pending.access == "manage" ? "be able to manage" : "be able to view") this app."
        )
      }
    }
  }
  private func load() async {
    do {
      let result: NativeAppGrants = try await client.fetch(endpoint)
      try Task.checkCancellation()
      grants = result.grantees
      loaded = true
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func change(_ scope: String, access: String) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: NativeAppGrants = try await client.fetch(
        endpoint, body: ["scope": scope, "access": access])
      grants = result.grantees
      selected = nil
      query = ""
      pending = nil
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
