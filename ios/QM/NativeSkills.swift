import SwiftUI

struct NativeSkill: Decodable, Identifiable {
  struct Pack: Decodable {
    let packId: String
    let commit: String
    let upstreamName: String
  }
  struct Asset: Decodable, Identifiable {
    let path: String
    let executable: Bool?
    var id: String { path }
  }
  let resourceID: String?
  let name: String
  let description: String
  let body: String?
  let scope: String
  let shadowed: Bool?
  let editable: Bool?
  let scopeId: String?
  let status: String?
  let version: Int?
  let source: String?
  let pack: Pack?
  let assetCount: Int?
  let requiredCapabilities: [String]?
  let files: [Asset]?
  var id: String { resourceID ?? "\(scopeId ?? scope):\(name)" }
  var canEdit: Bool { editable == true && !(resourceID ?? "").isEmpty }
  enum CodingKeys: String, CodingKey {
    case resourceID = "id"
    case name, description, body, scope, shadowed, editable, scopeId, status, version, source, pack,
      assetCount, requiredCapabilities, files
  }
}
struct NativeSkillList: Decodable { let skills: [NativeSkill] }
struct NativeSkillResult: Decodable { let skill: NativeSkill }

@MainActor @Observable
final class SkillsModel {
  let client: APIClient
  let user: String
  var skills: [NativeSkill] = []
  var contexts: [WorkspaceContext] = []
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  var revision: UUID { loader.revision }
  init(client: APIClient, user: String) {
    self.client = client
    self.user = user
  }
  var personalScope: String { "personal:\(user)" }
  var createContexts: [WorkspaceContext] {
    contexts.filter {
      $0.scopeId != personalScope
        && ($0.kind == "group" || ($0.kind == "channel" && $0.isPrivate == true))
    }
  }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      let result: NativeSkillList = try await client.fetch(
        "api/skills", query: [.init(name: "includeShadowed", value: "1")])
      let scopes: WorkspaceContexts = try await client.fetch("api/contexts")
      return (result, scopes)
    } apply: { result, scopes in
      skills = result.skills.sorted {
        $0.name.localizedStandardCompare($1.name) == .orderedAscending
      }
      contexts = scopes.contexts
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func mutate(path: String, method: String, body: [String: Any] = [:]) async -> Bool {
    guard !busy else { return false }
    busy = true
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(path, body: body, method: method)
      await load(afterMutation: true)
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

struct NativeSkillsView: View {
  @State private var model: SkillsModel
  @State private var query = ""
  @State private var status = "Active"
  @State private var scope = "all"
  @State private var source = "All sources"
  @State private var creating = false
  init(client: APIClient, user: String, scope: String? = nil) {
    _model = State(initialValue: SkillsModel(client: client, user: user))
    _scope = State(initialValue: scope ?? "all")
  }
  private var skills: [NativeSkill] {
    model.skills.filter {
      (status == "All" || ($0.status == "archived") == (status == "Archived"))
        && (scope == "all" || $0.scopeId == scope)
        && (source == "All sources"
          || (source == "Packs" ? $0.source == "pack" : $0.source != "pack"))
        && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
          || $0.description.localizedCaseInsensitiveContains(query))
    }
  }
  var body: some View {
    QMList {
      Section {
        Picker("Status", selection: $status) {
          ForEach(["Active", "Archived", "All"], id: \.self) { Text($0) }
        }.pickerStyle(.segmented)
        Picker("Scope", selection: $scope) {
          Text("All scopes").tag("all")
          Text("Personal").tag(model.personalScope)
          ForEach(model.createContexts) { Text($0.title).tag($0.scopeId) }
        }
        Picker("Source", selection: $source) {
          ForEach(["All sources", "Native", "Packs"], id: \.self) { Text($0) }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      ForEach(skills) { skill in
        NavigationLink {
          NativeSkillDetail(model: model, original: skill)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text("/\(skill.name)").font(.headline)
            Text(skill.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            Text(
              "\(skill.scope)\(skill.shadowed == true ? " · Overrides another version" : "")\(skill.status == "archived" ? " · Archived" : "")"
            ).font(.caption)
          }.padding(.vertical, 6)
        }
      }
      if skills.isEmpty && !model.loading {
        ContentUnavailableView(
          "No matching skills", systemImage: "shippingbox",
          description: Text("Create reusable instructions for QM or change your filters."))
      }
    }
    .navigationTitle("Skills").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .toolbar { Button("Create skill", systemImage: "plus") { creating = true } }
    .task { await model.load() }.refreshable { await model.load() }
    .sheet(isPresented: $creating) {
      NativeSkillEditor(
        model: model, skill: nil, initialScope: scope == "all" ? model.personalScope : scope)
    }
  }
}

struct NativeSkillDetail: View {
  @Bindable var model: SkillsModel
  let original: NativeSkill
  @State private var detail: NativeSkill?
  @State private var loader = LoadGuard()
  @State private var editing = false
  @State private var archive = false
  @State private var error: String?
  private var skill: NativeSkill {
    detail ?? model.skills.first { $0.id == original.id } ?? original
  }
  var body: some View {
    QMList {
      Section("Description") { Text(skill.description).textSelection(.enabled) }
      Section("Instructions") {
        if let body = skill.body {
          Text(body).textSelection(.enabled)
        } else if error == nil {
          Text("Instructions are not included in this skill listing.").foregroundStyle(.secondary)
        }
        if let error {
          Text(error).foregroundStyle(.red)
          Button("Try again") { Task { await load() } }
        }
      }
      Section("Details") {
        LabeledContent(
          "Scope",
          value: skill.scopeId.flatMap { scope in
            model.contexts.first { $0.scopeId == scope }?.title
          } ?? skill.scope)
        if let version = skill.version { LabeledContent("Version", value: String(version)) }
        LabeledContent("Status", value: skill.status ?? "Active")
        if skill.shadowed == true {
          Text("This skill takes precedence over a broader version with the same name.").font(
            .caption)
        }
        if let pack = skill.pack {
          LabeledContent("Pack", value: pack.packId)
          LabeledContent("Revision", value: pack.commit)
        }
        ForEach(skill.requiredCapabilities ?? [], id: \.self) { Text($0).font(.caption) }
      }
      if let files = skill.files, !files.isEmpty {
        Section("Assets") {
          ForEach(files) { file in
            Label(file.path, systemImage: file.executable == true ? "terminal" : "doc")
          }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      if skill.canEdit {
        Section {
          Button("Edit skill", systemImage: "pencil") { editing = true }.disabled(
            skill.body == nil || skill.status == "archived")
          Button(
            skill.status == "archived" ? "Restore skill" : "Archive skill",
            role: skill.status == "archived" ? nil : .destructive
          ) { archive = true }
        }.disabled(model.busy)
      }
    }
    .navigationTitle("/\(skill.name)").navigationBarTitleDisplayMode(.inline)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .task { await load() }.refreshable { await load() }
    .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
      NativeSkillEditor(
        model: model, skill: skill, initialScope: skill.scopeId ?? model.personalScope)
    }
    .confirmationDialog(
      skill.status == "archived" ? "Restore this skill?" : "Archive this skill?",
      isPresented: $archive
    ) {
      Button(
        skill.status == "archived" ? "Restore" : "Archive",
        role: skill.status == "archived" ? nil : .destructive
      ) {
        Task {
          guard let id = skill.resourceID else { return }
          let restore = skill.status == "archived"
          if await model.mutate(
            path: "api/skills/\(id.apiComponent)" + (restore ? "/restore" : ""),
            method: restore ? "POST" : "DELETE")
          {
            await load()
          }
        }
      }
    } message: {
      Text(
        skill.status == "archived"
          ? "This version will become available in its scope again."
          : "This version will stop being available in its scope. A broader version may take its place. Its history and assets are kept."
      )
    }
  }
  private func load() async {
    guard let id = original.resourceID else { return }
    let mutation = model.revision
    await loader.run {
      try await model.client.fetch("api/skills/\(id.apiComponent)") as NativeSkillResult
    } apply: { result in
      guard model.revision == mutation else { return }
      detail = result.skill
      error = nil
    } failed: {
      if model.revision == mutation { error = $0.localizedDescription }
    }
  }
}

struct NativeSkillEditor: View {
  @Bindable var model: SkillsModel
  let skill: NativeSkill?
  @Environment(\.dismiss) private var dismiss
  @State private var name: String
  @State private var description: String
  @State private var bodyText: String
  @State private var scope: String
  @State private var reviewing = false
  @State private var discard = false
  init(model: SkillsModel, skill: NativeSkill?, initialScope: String) {
    self.model = model
    self.skill = skill
    _name = State(initialValue: skill?.name ?? "")
    _description = State(initialValue: skill?.description ?? "")
    _bodyText = State(initialValue: skill?.body ?? "")
    _scope = State(initialValue: initialScope)
  }
  private var dirty: Bool {
    name != (skill?.name ?? "") || description != (skill?.description ?? "")
      || bodyText != (skill?.body ?? "")
  }
  private var shared: Bool { ScopeKind(scopeId: scope) != .personal }
  var body: some View {
    NavigationStack {
      QMForm {
        if reviewing {
          Section("Review shared instructions") {
            Text(
              "These instructions will be available to everyone with access to \(model.contexts.first { $0.scopeId == scope }?.title ?? scope)."
            )
            Text("/\(name)").font(.headline)
            Text(description)
            Text(bodyText).textSelection(.enabled)
          }
          Button("Back to editing") { reviewing = false }
        } else {
          Section("Skill") {
            TextField("Name", text: $name).textInputAutocapitalization(.never)
              .autocorrectionDisabled().disabled(skill != nil)
            TextField("Description", text: $description, axis: .vertical)
            if skill == nil {
              Picker("Scope", selection: $scope) {
                Text("Personal (only you)").tag(model.personalScope)
                ForEach(model.createContexts) { Text($0.title).tag($0.scopeId) }
              }
            }
          }
          Section("Instructions") { TextEditor(text: $bodyText).frame(minHeight: 250) }
        }
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }
      .disabled(model.busy).navigationTitle(skill == nil ? "Create skill" : "Edit skill")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { if dirty { discard = true } else { dismiss() } }.disabled(model.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(shared && !reviewing ? "Review" : "Save") {
            if shared && !reviewing { reviewing = true } else { Task { await save() } }
          }.disabled(
            model.busy
              || [name, description, bodyText].contains {
                $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              })
        }
      }
      .interactiveDismissDisabled(model.busy || dirty)
      .confirmationDialog("Discard your edits?", isPresented: $discard) {
        Button("Discard", role: .destructive) { dismiss() }
      }
    }
  }
  private func save() async {
    let path = skill?.resourceID.map { "api/skills/\($0.apiComponent)" } ?? "api/skills"
    var payload: [String: Any] = ["description": description, "body": bodyText]
    if skill == nil {
      payload["name"] = name.trimmingCharacters(in: .whitespacesAndNewlines)
      payload["scopeId"] = scope
    }
    if await model.mutate(path: path, method: skill == nil ? "POST" : "PUT", body: payload) {
      dismiss()
    }
  }
}

struct ComposerSkillsView: View {
  let client: APIClient
  let onSelect: (NativeSkill) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var skills: [NativeSkill] = []
  @State private var query = ""
  @State private var loading = true
  @State private var error: String?
  @State private var retry = 0

  private var matches: [NativeSkill] {
    skills.filter {
      query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
        || $0.description.localizedCaseInsensitiveContains(query)
    }
  }

  var body: some View {
    NavigationStack {
      QMList {
        ForEach(matches) { skill in
          Button {
            onSelect(skill)
            dismiss()
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text("/\(skill.name)").font(.body.weight(.medium))
              Text(skill.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }.padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
          }.listRowBackground(QMTheme.paper)
        }
      }
      .scrollContentBackground(.hidden).background(QMTheme.paper)
      .navigationTitle("Use a skill").navigationBarTitleDisplayMode(.inline)
      .searchable(text: $query, prompt: "Find a skill")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .overlay {
        if loading {
          ProgressView("Loading skills…")
        } else if let error {
          ContentUnavailableView {
            Label("Couldn’t load skills", systemImage: "wifi.exclamationmark")
          } description: {
            Text(error)
          } actions: {
            Button("Try again") { retry += 1 }
          }
        } else if matches.isEmpty {
          ContentUnavailableView(
            query.isEmpty ? "No skills available" : "No matching skills",
            systemImage: "text.book.closed",
            description: Text(
              query.isEmpty
                ? "Add skills from Browse to reuse instructions."
                : "Try another name or description."))
        }
      }
      .task(id: retry) {
        loading = true
        error = nil
        defer { loading = false }
        do {
          let response: NativeSkillList = try await client.fetch("api/skills")
          try Task.checkCancellation()
          skills = response.skills.filter { $0.status != "archived" }.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
          }
        } catch {
          if !Task.isCancelled { self.error = error.localizedDescription }
        }
      }
    }
  }
}

struct NativeSkillCompletion {
  static func query(in draft: String) -> String? {
    guard let range = draft.range(of: #"(^|\s)/[a-zA-Z0-9_-]*$"#, options: .regularExpression),
      let slash = draft[range].lastIndex(of: "/")
    else { return nil }
    return String(draft[draft.index(after: slash)...])
  }

  static func inserting(_ name: String, into draft: String) -> String {
    guard query(in: draft) != nil, let slash = draft.lastIndex(of: "/") else {
      return "/\(name) " + draft
    }
    return String(draft[..<slash]) + "/\(name) "
  }
}

struct NativeSkillSuggestions: View {
  let client: APIClient
  @Binding var draft: String
  @State private var skills: [NativeSkill]?
  @State private var loader = LoadGuard()
  @State private var failed = false
  @State private var retry = 0

  private var query: String? { NativeSkillCompletion.query(in: draft) }
  private var matches: [NativeSkill] {
    guard let query else { return [] }
    return (skills ?? []).filter {
      query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
    }.sorted {
      let first = $0.name.lowercased().hasPrefix(query.lowercased())
      let second = $1.name.lowercased().hasPrefix(query.lowercased())
      return first == second
        ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : first
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if query != nil {
        if loader.loading {
          ProgressView("Loading skills…").font(.footnote)
        } else if failed {
          HStack {
            Text("Couldn’t load skills").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("Try again") { retry += 1 }.font(.footnote)
          }.padding(12)
        } else if !matches.isEmpty {
          ScrollView {
            VStack(spacing: 0) {
              ForEach(matches.prefix(8)) { skill in
                Button {
                  draft = NativeSkillCompletion.inserting(skill.name, into: draft)
                } label: {
                  HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "text.book.closed").padding(.top, 2)
                    VStack(alignment: .leading, spacing: 3) {
                      Text("/\(skill.name)").font(.subheadline.weight(.medium))
                      Text(skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(
                        2)
                    }
                    Spacer(minLength: 0)
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(12).contentShape(Rectangle())
                }.buttonStyle(.plain)
              }
            }
          }
          .frame(maxHeight: 180)
          .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 16))
          .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(QMTheme.border))

        }
      }
    }
    .task(id: "\(query != nil):\(retry)") { await load() }
  }

  private func load() async {
    guard query != nil, skills == nil else {
      loader.cancel()
      return
    }
    failed = false
    await loader.run {
      try await client.fetch("api/skills") as NativeSkillList
    } apply: { result in
      skills = result.skills.filter { $0.status != "archived" && $0.shadowed != true }
    } failed: { _ in
      failed = true
    }
  }
}
