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
  @State private var loading = true
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
      if let error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await load() } }.disabled(loading)
      }
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
      if loading && apps.isEmpty {
        NativeAppCollectionLoading(label: "Loading apps...")
      } else if filtered.isEmpty && !loading && error == nil {
        if !query.isEmpty {
          ContentUnavailableView.search(text: query)
        } else {
          ContentUnavailableView(
            tab == "Shared"
              ? "No shared apps"
              : tab == "Archived" ? "No archived apps" : "No apps here yet",
            systemImage: "square.stack.3d.up",
            description: Text(
              tab == "Shared"
                ? "Apps shared with you will appear here."
                : tab == "Archived"
                  ? "Archived apps will appear here."
                  : "Apps you create with QM will appear here."))
        }
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
  @State private var mutationAction: String?
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
          Button {
            if mutationAction != "display-name" { name = app.displayName ?? "" }
            editingName = true
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              NativeActionLabel(
                title: "Edit display name", busyTitle: "Saving...",
                busy: busy && mutationAction == "display-name")
              if busy && mutationAction == "display-name" {
                Text(name.isEmpty ? app.name ?? app.id : name)
                  .font(.subheadline).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          Button {
            if mutationAction != "name" { slug = app.name ?? app.id }
            editingSlug = true
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              NativeActionLabel(
                title: "Change app URL", busyTitle: "Saving...",
                busy: busy && mutationAction == "name")
              if busy && mutationAction == "name" {
                Text(slug).font(.subheadline).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          if app.ownerScopeId == "personal:\(user)" {
            NavigationLink("Permissions") { NativeAppPermissions(client: client, app: app) }
          }
          Button(role: app.status == "archived" ? nil : .destructive) {
            archive = true
          } label: {
            NativeActionLabel(
              title: app.status == "archived" ? "Restore deployment" : "Archive deployment",
              busyTitle: mutationAction == "restore" ? "Restoring..." : "Archiving...",
              busy: busy && (mutationAction == "restore" || mutationAction == "archive"))
          }
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
        if app.versions?.isEmpty != false && error == nil {
          if loader.loading || current == nil {
            NativeAppCollectionLoading(label: "Loading version history...")
          } else {
            Text("No version history available.").foregroundStyle(.secondary)
          }
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
  @discardableResult
  private func load(afterMutation: Bool = false) async -> Bool {
    guard !busy || afterMutation else { return false }
    return await loader.run {
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
    mutationAction = action
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/deployments/\(app.id.apiComponent)/\(action)", body: body)
      if await load(afterMutation: true) { mutationAction = nil }
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
  @State private var search: NativePeopleSearchModel
  @State private var selected: DirectoryPerson?
  @State private var access = "view"
  @State private var pending: (scope: String, access: String)?
  @State private var savingScope: String?
  @State private var loaded = false
  @State private var error: String?
  @State private var loading = true
  @State private var searchAttempt = 0
  private var busy: Bool { savingScope != nil }
  private var endpoint: String { "api/deployments/\(app.id.apiComponent)/share" }
  private var searchTerm: String { search.query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var matchingPeople: [DirectoryPerson] {
    search.matches.filter { person in
      "personal:\(person.id)" != app.ownerScopeId
        && !grants.contains(where: { $0.scope == "personal:\(person.id)" })
    }
  }
  init(client: APIClient, app: NativeDeployment) {
    self.client = client
    self.app = app
    _search = State(initialValue: NativePeopleSearchModel(client: client))
  }
  var body: some View {
    QMList {
      if let error { Text(error).foregroundStyle(.red) }
      Section("People with access") {
        if loading && grants.isEmpty {
          NativePeopleSearchLoading(label: "Loading access...")
        } else if loaded && grants.isEmpty && error == nil {
          Text("No one else has access.").foregroundStyle(.secondary)
        }
        ForEach(grants) { grant in
          HStack {
            Text(grant.scope)
            Spacer()
            if savingScope == grant.scope {
              NativeActionLabel(title: "Access", busyTitle: "Saving...", busy: true)
            } else {
              Menu(grant.permission == "write" ? "Can manage" : "Can view") {
                Button("Can view") { pending = (grant.scope, "view") }
                Button("Can manage") { pending = (grant.scope, "manage") }
                Button("Remove access", role: .destructive) { pending = (grant.scope, "none") }
              }
            }
          }
        }
      }
      Section("Add people") {
        TextField("Name or email", text: $search.query)
        ForEach(matchingPeople) { person in
          Button(person.displayName) { selected = person }
        }
        if search.searching {
          NativePeopleSearchLoading(label: "Searching people for \"\(searchTerm)\"...")
        } else if let searchError = search.error {
          Text(searchError).foregroundStyle(.red)
          Button("Try search again") { searchAttempt += 1 }
        } else if search.completed && matchingPeople.isEmpty {
          Text(
            search.matches.isEmpty ? "No matching people." : "Everyone found already has access."
          ).foregroundStyle(.secondary)
        }
        if let selected {
          LabeledContent("Person", value: selected.displayName)
          Picker("Access", selection: $access) {
            Text("Can view").tag("view")
            Text("Can manage").tag("manage")
          }
          Button {
            pending = ("personal:\(selected.id)", access)
          } label: {
            NativeActionLabel(
              title: "Grant access", busyTitle: "Saving...",
              busy: savingScope == "personal:\(selected.id)")
          }.disabled(!loaded)
        }
      }
    }
    .disabled(busy).navigationTitle("App permissions")
    .refreshable { if !busy { await load() } }
    .task { await load() }
    .task(id: "\(search.query)|\(searchAttempt)") { await search.search() }
    .onDisappear { search.cancel() }
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
    loading = true
    defer { loading = false }
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
    savingScope = scope
    defer { savingScope = nil }
    do {
      let result: NativeAppGrants = try await client.fetch(
        endpoint, body: ["scope": scope, "access": access])
      grants = result.grantees
      selected = nil
      search.query = ""
      pending = nil
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
