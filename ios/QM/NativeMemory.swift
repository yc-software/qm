import SwiftUI

struct NotebookHead: Decodable {
  let content: String?
  let revision: String?
  let error: String?
}

struct NotebookRevision: Decodable, Identifiable {
  let revision: String
  let content: String
  let operation: String
  let author: String?
  let at: Double
  var id: String { revision }
}
struct NotebookHistory: Decodable { let revisions: [NotebookRevision] }

struct NotebookFact: Identifiable {
  let line: Int
  let text: String
  var id: Int { line }

  static func parse(_ content: String) -> [Self] {
    content.components(separatedBy: "\n").enumerated().compactMap { line, raw in
      let value = raw.trimmingCharacters(in: .whitespaces)
      guard value.hasPrefix("- ") || value.hasPrefix("* ") else { return nil }
      let text = String(value.dropFirst(2)).trimmingCharacters(in: .whitespaces)
      return text.isEmpty ? nil : Self(line: line, text: text)
    }
  }
}

@MainActor @Observable
final class NotebookModel {
  let client: APIClient
  var content = ""
  var draft = ""
  var revision = ""
  var history: [NotebookRevision] = []
  var loaded = false
  var busy = false
  var error: String?
  var dirty: Bool { draft != content }

  init(client: APIClient) { self.client = client }

  func load() async {
    guard !busy, !dirty else { return }
    busy = true
    defer { busy = false }
    do {
      let head: NotebookHead = try await client.fetch("api/memory")
      try Task.checkCancellation()
      try accept(head)
      loaded = true
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }

  func save(restoring: String? = nil) async -> Bool {
    guard !busy, loaded, !revision.isEmpty else { return false }
    busy = true
    defer { busy = false }
    do {
      let head: NotebookHead
      if let restoring {
        head = try await client.fetch(
          "api/memory/restore", body: ["revision": restoring, "expectedRevision": revision],
          accepting: [409])
      } else {
        head = try await client.fetch(
          "api/memory", body: ["content": draft, "revision": revision], method: "PUT",
          accepting: [409])
      }
      try Task.checkCancellation()
      if head.error == "conflict" {
        throw QMError.message(
          "Memory changed elsewhere. Your draft is still here. Copy it before loading the latest version, then merge your changes."
        )
      }
      try accept(head)
      error = nil
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }

  func loadHistory() async {
    do {
      let result: NotebookHistory = try await client.fetch("api/memory/history")
      try Task.checkCancellation()
      history = result.revisions
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }

  private func accept(_ head: NotebookHead) throws {
    guard head.error == nil, let content = head.content, let revision = head.revision else {
      throw QMError.message("QM did not return a complete notebook. Your draft has been kept.")
    }
    self.content = content
    self.draft = content
    self.revision = revision
  }
}

struct NativeMemoryView: View {
  @State private var model: NotebookModel
  @State private var editing = false
  @State private var history = false
  init(client: APIClient) { _model = State(initialValue: NotebookModel(client: client)) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("Your notebook").font(
          .custom("IowanOldStyle-Roman", size: 32, relativeTo: .largeTitle))
        Text("What QM remembers for your future conversations.").foregroundStyle(.secondary)
        if let error = model.error {
          Text(error).foregroundStyle(.red)
          Button("Try again") { Task { await model.load() } }
        }
        if model.loaded && model.content.isEmpty {
          ContentUnavailableView(
            "A fresh notebook", systemImage: "book.closed",
            description: Text("Add preferences, facts, and instructions you want QM to remember."))
        } else {
          MessageMarkdown(text: model.content, client: model.client)
        }
      }.padding(24).frame(maxWidth: QMTheme.conversationWidth).frame(
        maxWidth: .infinity, alignment: .center)
    }
    .background(QMTheme.paper).navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
    .overlay { if model.busy { ProgressView() } }
    .toolbar {
      Button("History", systemImage: "clock.arrow.circlepath") { history = true }.disabled(
        !model.loaded)
      Button("Edit notebook", systemImage: "pencil") { editing = true }.disabled(
        !model.loaded || model.busy)
    }
    .refreshable { await model.load() }.task { await model.load() }
    .sheet(isPresented: $editing) { NotebookEditor(model: model) }
    .sheet(isPresented: $history) { NotebookHistoryView(model: model) }
  }
}

struct NotebookEditor: View {
  @Bindable var model: NotebookModel
  @Environment(\.dismiss) private var dismiss
  @State private var facts = false
  @State private var query = ""
  @State private var discarding = false
  @State private var reloading = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 12) {
        Picker("Editor", selection: $facts) {
          Text("Notebook").tag(false)
          Text("Facts").tag(true)
        }.pickerStyle(.segmented).padding(.horizontal)
        if let error = model.error {
          Text(error).font(.callout).foregroundStyle(.red).padding(.horizontal)
        }
        if facts {
          QMList {
            ForEach(
              NotebookFact.parse(model.draft).filter {
                query.isEmpty || $0.text.localizedCaseInsensitiveContains(query)
              }
            ) { fact in
              Text(fact.text).swipeActions {
                Button("Remove", role: .destructive) {
                  var lines = model.draft.components(separatedBy: "\n")
                  lines.remove(at: fact.line)
                  model.draft = lines.joined(separator: "\n")
                }
              }
            }
          }.searchable(text: $query, prompt: "Find a fact")
        } else {
          TextEditor(text: $model.draft).font(.system(.body, design: .monospaced))
            .padding(.horizontal, 12).accessibilityLabel("Notebook content")
        }
        HStack {
          ShareLink(item: model.draft) {
            Label("Copy or share draft", systemImage: "square.and.arrow.up")
          }
          Spacer()
          Button("Load latest") { reloading = true }
        }.font(.footnote).padding()
      }
      .disabled(model.busy)
      .navigationTitle("Edit notebook").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { if model.dirty { discarding = true } else { dismiss() } }.disabled(
            model.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.busy ? "Saving…" : "Save") { Task { if await model.save() { dismiss() } } }
            .disabled(model.busy || !model.dirty || model.revision.isEmpty)
        }
      }
      .interactiveDismissDisabled(model.dirty || model.busy)
      .confirmationDialog("Discard your unsaved changes?", isPresented: $discarding) {
        Button("Discard changes", role: .destructive) {
          model.draft = model.content
          dismiss()
        }
      }
      .confirmationDialog("Replace your draft with the latest notebook?", isPresented: $reloading) {
        Button("Load latest", role: .destructive) {
          model.draft = model.content
          Task { await model.load() }
        }
      } message: {
        Text("Copy or share your draft first if you want to keep it.")
      }
    }
  }
}

struct NotebookHistoryView: View {
  @Bindable var model: NotebookModel
  @Environment(\.dismiss) private var dismiss
  @State private var restoring: NotebookRevision?

  var body: some View {
    NavigationStack {
      QMList {
        if let error = model.error { Text(error).foregroundStyle(.red) }
        ForEach(model.history) { revision in
          NavigationLink {
            ScrollView {
              VStack(alignment: .leading, spacing: 18) {
                Text(Date(timeIntervalSince1970: revision.at / 1000), style: .date).font(.headline)
                MessageMarkdown(text: revision.content, client: model.client)
              }.padding()
            }.navigationTitle("Notebook revision")
              .toolbar {
                Button("Restore") { restoring = revision }.disabled(
                  model.busy || revision.id == model.revision)
              }
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text(Date(timeIntervalSince1970: revision.at / 1000), style: .date)
              Text("\(revision.operation) · \(revision.author ?? "QM")").font(.caption)
                .foregroundStyle(.secondary)
              if revision.id == model.revision { Text("Current version").font(.caption) }
            }
          }
        }
        if model.history.isEmpty { Text("No previous versions.").foregroundStyle(.secondary) }
      }
      .navigationTitle("Memory history")
      .toolbar { Button("Done") { dismiss() }.disabled(model.busy) }
      .task { await model.loadHistory() }
      .refreshable { await model.loadHistory() }
      .confirmationDialog(
        "Restore this version?",
        isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } })
      ) {
        if let restoring {
          Button("Restore version") {
            Task {
              if await model.save(restoring: restoring.revision) {
                await model.loadHistory()
                dismiss()
              }
            }
          }
        }
      } message: {
        Text("The current notebook remains available in history.")
      }
      .interactiveDismissDisabled(model.busy)
    }
  }
}
