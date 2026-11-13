import SwiftUI

struct NativeApp: Decodable, Identifiable {
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
  let embedAncestors: [String]?
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
  static func parseEmbedAncestors(_ text: String) -> [String] {
    var origins: [String] = []
    for line in text.split(whereSeparator: \.isNewline) {
      let origin = line.trimmingCharacters(in: .whitespaces)
      if !origin.isEmpty && !origins.contains(origin) { origins.append(origin) }
    }
    return origins
  }
}
struct NativeAppList: Decodable { let deployments: [NativeApp] }
struct NativeAppResult: Decodable { let deployment: NativeApp }

struct NativeAppsView: View {
  let client: APIClient
  let user: String
  var scope: String? = nil
  @State private var apps: [NativeApp] = []
  @State private var tab = "Yours"
  @State private var query = ""
  @State private var error: String?
  @State private var loading = true
  private var filtered: [NativeApp] {
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
        NativeAppCollectionLoading(label: "Loading apps…")
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
      let result: NativeAppList = try await client.fetch("api/apps")
      try Task.checkCancellation()
      apps = result.deployments
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeAppDetail: View {
  let client: APIClient
  let user: String
  let original: NativeApp
  @State private var current: NativeApp?
  @State private var loader = LoadGuard()
  @State private var error: String?
  @State private var busy = false
  @State private var mutationAction: String?
  @State private var name = ""
  @State private var editingName = false
  @State private var slug = ""
  @State private var editingSlug = false
  @State private var editingEmbed = false
  @State private var archive = false
  private var app: NativeApp { current ?? original }
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
            NativeActionLabel(
              title: "Edit display name", busyTitle: "Saving…",
              busy: busy && mutationAction == "display-name")
          }
          Button {
            if mutationAction != "name" { slug = app.name ?? app.id }
            editingSlug = true
          } label: {
            NativeActionLabel(
              title: "Change app URL", busyTitle: "Saving…",
              busy: busy && mutationAction == "name")
          }
          if app.ownerScopeId == "personal:\(user)" {
            NavigationLink("Permissions") { NativeAppPermissions(client: client, app: app) }
          }
          Button {
            editingEmbed = true
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              NativeActionLabel(
                title: "Allowed embedding sites", busyTitle: "Saving…",
                busy: busy && mutationAction == "embed-ancestors")
              Text(
                (app.embedAncestors ?? []).isEmpty
                  ? "Not embeddable" : (app.embedAncestors ?? []).joined(separator: ", ")
              )
              .font(.subheadline).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            }
          }
          Button(role: app.status == "archived" ? nil : .destructive) {
            archive = true
          } label: {
            NativeActionLabel(
              title: app.status == "archived" ? "Restore app" : "Archive app",
              busyTitle: mutationAction == "restore" ? "Restoring…" : "Archiving…",
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
            NativeAppCollectionLoading(label: "Loading version history…")
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
    .sheet(isPresented: $editingEmbed) {
      NativeAppEmbedSites(origins: app.embedAncestors ?? []) { origins in
        await mutate("embed-ancestors", body: ["embedAncestors": origins]) ? nil : error
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
      app.status == "archived" ? "Restore this app?" : "Archive this app?",
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
      try await client.fetch("api/apps/\(original.id.apiComponent)")
        as NativeAppResult
    } apply: { result in
      current = result.deployment
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  @discardableResult
  private func mutate(_ action: String, body: [String: Any] = [:]) async -> Bool {
    guard !busy else { return false }
    busy = true
    mutationAction = action
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/apps/\(app.id.apiComponent)/\(action)", body: body)
      if await load(afterMutation: true) { mutationAction = nil }
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

struct NativeAppGrant: Decodable, Identifiable {
  let scope: String
  let permission: String
  var id: String { scope }
}
struct NativeAppGrants: Decodable {
  let isPublic: Bool?
  let externalSharing: Bool?
  let grantees: [NativeAppGrant]
  enum CodingKeys: String, CodingKey {
    case isPublic = "public"
    case externalSharing
    case grantees
  }
}

@MainActor @Observable
final class AppPermissionsModel {
  let client: APIClient
  let app: NativeApp
  var grants: [NativeAppGrant] = []
  var isPublic = false
  var externalSharing = true
  var savingScope: String?
  var savingPublic = false
  var loaded = false
  var loading = true
  var error: String?
  var busy: Bool { savingScope != nil || savingPublic }
  private var saves = 0
  private var endpoint: String { "api/apps/\(app.id.apiComponent)/share" }
  init(client: APIClient, app: NativeApp) {
    self.client = client
    self.app = app
  }
  func load() async {
    loading = true
    defer { loading = false }
    let started = saves
    do {
      let result: NativeAppGrants = try await client.fetch(endpoint)
      try Task.checkCancellation()
      guard started == saves else { return }
      apply(result)
      loaded = true
    } catch {
      if !Task.isCancelled, started == saves { self.error = error.localizedDescription }
    }
  }
  @discardableResult
  func change(_ scope: String, access: String) async -> Bool {
    guard !busy else { return false }
    saves += 1
    savingScope = scope
    defer { savingScope = nil }
    do {
      apply(try await client.fetch(endpoint, body: ["scope": scope, "access": access]))
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
  func setPublic(_ value: Bool) async {
    guard !busy, value != isPublic else { return }
    let previous = isPublic
    saves += 1
    isPublic = value
    savingPublic = true
    defer { savingPublic = false }
    do {
      apply(try await client.fetch(endpoint, body: ["public": value]))
    } catch {
      isPublic = previous
      self.error = error.localizedDescription
    }
  }
  private func apply(_ result: NativeAppGrants) {
    grants = result.grantees
    if let isPublic = result.isPublic { self.isPublic = isPublic }
    if let externalSharing = result.externalSharing { self.externalSharing = externalSharing }
    error = nil
  }
}

struct NativeAppPermissions: View {
  @State private var model: AppPermissionsModel
  @State private var search: NativePeopleSearchModel
  @State private var selected: DirectoryPerson?
  @State private var access = "view"
  @State private var pending: (scope: String, access: String)?
  @State private var searchAttempt = 0
  private var searchTerm: String { search.query.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var matchingPeople: [DirectoryPerson] {
    search.matches.filter { person in
      "personal:\(person.id)" != model.app.ownerScopeId
        && !model.grants.contains(where: { $0.scope == "personal:\(person.id)" })
    }
  }
  init(client: APIClient, app: NativeApp) {
    _model = State(initialValue: AppPermissionsModel(client: client, app: app))
    _search = State(initialValue: NativePeopleSearchModel(client: client))
  }
  var body: some View {
    QMList {
      if let error = model.error { Text(error).foregroundStyle(.red) }
      Section("General access") {
        Picker(
          "General access",
          selection: Binding(
            get: { model.isPublic }, set: { value in Task { await model.setPublic(value) } })
        ) {
          Text("Restricted").tag(false)
          Text("Anyone with the link").tag(true)
        }.pickerStyle(.segmented).disabled(!model.loaded || !model.externalSharing)
        Text(
          !model.externalSharing
            ? "Sharing outside your organization is turned off for this workspace."
            : model.isPublic
              ? "Anyone on the internet with the link can open. No sign-in required."
              : "Only people with access can open."
        ).font(.caption).foregroundStyle(.secondary)
      }
      Section("People with access") {
        if model.loading && model.grants.isEmpty {
          NativePeopleSearchLoading(label: "Loading access…")
        } else if model.loaded && model.grants.isEmpty && model.error == nil {
          Text("No one else has access.").foregroundStyle(.secondary)
        }
        ForEach(model.grants) { grant in
          HStack {
            Text(grant.scope)
            Spacer()
            if model.savingScope == grant.scope {
              NativeActionLabel(title: "Access", busyTitle: "Saving…", busy: true)
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
          NativePeopleSearchLoading(label: "Searching people for \"\(searchTerm)\"…")
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
              title: "Grant access", busyTitle: "Saving…",
              busy: model.savingScope == "personal:\(selected.id)")
          }.disabled(!model.loaded)
        }
      }
    }
    .disabled(model.busy).navigationTitle("App permissions")
    .refreshable { if !model.busy { await model.load() } }
    .task { await model.load() }
    .task(id: "\(search.query)|\(searchAttempt)") { await search.search() }
    .onDisappear { search.cancel() }
    .confirmationDialog(
      "Update access?",
      isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
    ) {
      if let pending {
        Button("Confirm") {
          Task {
            if await model.change(pending.scope, access: pending.access) {
              selected = nil
              search.query = ""
            }
            self.pending = nil
          }
        }
      }
    } message: {
      if let pending {
        Text(
          "\(pending.scope) will \(pending.access == "none" ? "lose access to" : pending.access == "manage" ? "be able to manage" : "be able to view") this app."
        )
      }
    }
  }
}

struct NativeAppEmbedSites: View {
  let save: ([String]) async -> String?
  @Environment(\.dismiss) private var dismiss
  @State private var text: String
  @State private var busy = false
  @State private var error: String?
  init(origins: [String], save: @escaping ([String]) async -> String?) {
    self.save = save
    _text = State(initialValue: origins.joined(separator: "\n"))
  }
  var body: some View {
    NavigationStack {
      QMForm {
        Section("Allowed embedding sites") {
          TextEditor(text: $text).font(.body.monospaced()).frame(minHeight: 140)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Text(
            "One https origin per line, like https://tools.example.com or https://*.example.com. Leave empty to stop other sites from embedding this app."
          ).font(.caption)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .disabled(busy).navigationTitle("Embedding")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task {
              busy = true
              defer { busy = false }
              error = await save(NativeApp.parseEmbedAncestors(text))
              if error == nil { dismiss() }
            }
          } label: {
            NativeActionLabel(title: "Save", busyTitle: "Saving…", busy: busy, compact: true)
          }.disabled(busy)
        }
      }.interactiveDismissDisabled(busy)
    }
  }
}
