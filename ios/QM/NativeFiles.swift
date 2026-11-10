import SwiftUI
import UniformTypeIdentifiers

struct WorkspaceFile: Decodable, Identifiable, Hashable {
  let id: String
  let name: String
  let mimetype: String
  let sizeBytes: Int64
  let direction: String
  let createdAt: Double
  let createdInScope: String?
  let ownerScopeId: String?
  let openable: Bool
  var shared = false

  enum CodingKeys: String, CodingKey {
    case id, name, mimetype, sizeBytes, direction, createdAt, createdInScope, ownerScopeId, openable
  }

  var category: String {
    if mimetype.hasPrefix("image/") { return "Images" }
    if mimetype.hasPrefix("text/")
      || ["pdf", "document", "sheet", "presentation", "json", "xml", "csv"].contains(
        where: mimetype.contains)
    {
      return "Documents"
    }
    return "Other"
  }
  var icon: String {
    if category == "Images" { return "photo" }
    if mimetype.hasPrefix("audio/") { return "waveform" }
    if mimetype.hasPrefix("video/") { return "film" }
    return "doc"
  }
  var kind: String { shared ? "Shared" : direction == "in" ? "Uploaded" : "Created" }
}

struct WorkspaceFilePage: Decodable {
  let owned: [WorkspaceFile]?
  let shared: [WorkspaceFile]?
  let nextCursor: String?
  var files: [WorkspaceFile] {
    (owned ?? [])
      + (shared ?? []).map { file in
        var file = file
        file.shared = true
        return file
      }
  }
}

@MainActor @Observable
final class WorkspaceFilesModel {
  let client: APIClient
  let scope: String?
  var files: [WorkspaceFile] = []
  var nextCursor: String?
  var uploading = false
  var filtering = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool {
    get { loader.loading }
    set { loader.loading = newValue }
  }
  private var visited: Set<String> = []

  init(client: APIClient, scope: String?) {
    self.client = client
    self.scope = scope
  }

  func load(reset: Bool = false) async {
    if loading && !reset { return }
    if !reset && nextCursor == nil { return }
    if reset { visited = [] }
    let cursor = reset ? nil : nextCursor
    var query = [URLQueryItem(name: "limit", value: "60")]
    if let scope { query.append(.init(name: "scope", value: scope)) }
    if let cursor { query.append(.init(name: "cursor", value: cursor)) }
    let loaded = await loader.run(restart: reset) {
      try await client.fetch("api/files", query: query) as WorkspaceFilePage
    } apply: { result in
      if reset { files = [] }
      var ids = Set(files.map(\.id))
      files.append(contentsOf: result.files.filter { ids.insert($0.id).inserted })
      if let cursor { visited.insert(cursor) }
      if let next = result.nextCursor, visited.contains(next) {
        nextCursor = nil
        throw QMError.message("The file list did not advance. Pull to refresh and try again.")
      }
      nextCursor = result.nextCursor
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
    if loaded && filtering && reset { await loadAll() }
  }

  func loadAll() async {
    while !Task.isCancelled {
      if loading {
        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
        continue
      }
      guard nextCursor != nil else { return }
      await load()
      if error != nil { return }
    }
  }

  func upload(_ urls: [URL]) async {
    guard !uploading else { return }
    uploading = true
    let generation = client.generation
    defer { uploading = false }
    var count = 0
    do {
      for url in urls {
        try Task.checkCancellation()
        let prepared = try await AttachmentUpload.prepare(url)
        guard generation == client.generation, client.hasSession else { throw CancellationError() }
        try await client.storeFile(prepared, scope: scope)
        count += 1
      }
      await load(reset: true)
    } catch {
      if count > 0 { await load(reset: true) }
      self.error =
        "\(count > 0 ? "Uploaded \(count) of \(urls.count). " : "")\(error.localizedDescription)"
    }
  }
}

struct NativeFilesView: View {
  @State private var model: WorkspaceFilesModel
  @State private var query = ""
  @State private var category = "All types"
  @State private var ownership = "All files"
  @State private var importing = false
  @State private var preview: WorkspaceFile?

  init(client: APIClient, scope: String? = nil) {
    _model = State(initialValue: WorkspaceFilesModel(client: client, scope: scope))
  }

  private var hasFilters: Bool {
    !query.isEmpty || category != "All types" || ownership != "All files"
  }

  private var visible: [WorkspaceFile] {
    model.files.filter {
      (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
        && (category == "All types" || $0.category == category)
        && (ownership == "All files" || (ownership == "Shared" ? $0.shared : !$0.shared))
    }.sorted { $0.createdAt > $1.createdAt }
  }

  var body: some View {
    QMList {
      Section {
        Picker("Type", selection: $category) {
          ForEach(["All types", "Images", "Documents", "Other"], id: \.self) { Text($0) }
        }
        Picker("Ownership", selection: $ownership) {
          ForEach(["All files", "Owned", "Shared"], id: \.self) { Text($0) }
        }
      }
      if let error = model.error { Text(error).foregroundStyle(.red) }
      ForEach(visible) { file in
        Button {
          preview = file
        } label: {
          WorkspaceFileRow(file: file)
        }.disabled(!file.openable).listRowBackground(QMTheme.paper)
      }
      if model.nextCursor != nil {
        Button("Load more files") { Task { await model.load() } }.disabled(model.loading)
      }
      if visible.isEmpty && !model.loading && model.error == nil {
        ContentUnavailableView {
          Label(hasFilters ? "No matching files" : "No files here yet", systemImage: "doc.on.doc")
        } description: {
          Text(
            hasFilters
              ? "Try a different search or filter." : "Upload a file or create one with QM.")
        } actions: {
          if hasFilters {
            Button("Reset filters") {
              query = ""
              category = "All types"
              ownership = "All files"
            }
          }
        }
      }
    }
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .navigationTitle("Files").searchable(text: $query, prompt: "Find files")
    .toolbar {
      Button("Upload files", systemImage: "square.and.arrow.up") { importing = true }.disabled(
        model.uploading)
    }
    .safeAreaInset(edge: .bottom) {
      if model.loading || model.uploading {
        ProgressView(model.uploading ? "Uploading…" : "Loading files…").padding().frame(
          maxWidth: .infinity
        ).background(.regularMaterial)
      }
    }
    .refreshable { await model.load(reset: true) }
    .task { await model.load(reset: true) }
    .task(id: query + "|" + category + "|" + ownership) {
      model.filtering = hasFilters
      if model.filtering {
        await model.loadAll()
      }
    }
    .fileImporter(
      isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): Task { await model.upload(urls) }
      case .failure(let error): model.error = error.localizedDescription
      }
    }
    .sheet(item: $preview) { file in
      FilePreviewSheet(
        file: DeliveredFile(name: file.name, artifactId: file.id), client: model.client)
    }
  }
}

struct WorkspaceFileRow: View {
  let file: WorkspaceFile
  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: file.icon).font(.title2).frame(width: 30)
      VStack(alignment: .leading, spacing: 6) {
        Text(file.name).font(.body.weight(.medium)).lineLimit(2)
        Text(
          "\(file.kind) · \(ByteCountFormatter.string(fromByteCount: file.sizeBytes, countStyle: .file))"
        )
        .font(.caption).foregroundStyle(.secondary)
        Text(Date(timeIntervalSince1970: file.createdAt / 1000), style: .date)
          .font(.caption2).foregroundStyle(.secondary)
        if !file.openable { Text("Preview unavailable").font(.caption) }
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption)
    }.padding(.vertical, 6).foregroundStyle(QMTheme.ink)
  }
}

struct NativeFileLibrary: View {
  let client: APIClient
  @State private var scope = ""
  @State private var contexts: [WorkspaceContext] = []
  @State private var error: String?
  var body: some View {
    NativeFilesView(client: client, scope: scope.isEmpty ? nil : scope).id(scope)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Picker("Scope", selection: $scope) {
              Text("All accessible files").tag("")
              ForEach(contexts) { Text($0.title).tag($0.scopeId) }
            }
            if let error {
              Text(error)
              Button("Retry scopes") { Task { await load() } }
            }
          } label: {
            Label(
              contexts.first { $0.scopeId == scope }?.title ?? "All scopes",
              systemImage: "line.3.horizontal.decrease")
          }
        }
      }.task { await load() }
  }
  private func load() async {
    do {
      let result: WorkspaceContexts = try await client.fetch("api/contexts")
      contexts = result.contexts
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
